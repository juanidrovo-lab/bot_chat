import { sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  LimiteMensualError,
  SlotTomadoError,
  YaTieneCitaError,
} from '../../src/domain/agenda/errores.ts';
import { LIMITE_RESERVAS_MES, reservar } from '../../src/adapters/postgres/reservas.ts';
import { enTenant } from '../../src/adapters/postgres/tenantContext.ts';
import { crearBaseDatos } from '../../src/adapters/postgres/db.ts';
import {
  abrirApp,
  limpiar,
  sembrarContacto,
  sembrarDespacho,
  urlApp,
  type Despacho,
} from './ayuda.ts';

const db = abrirApp();
let a: Despacho;

const SLOT = new Date('2026-10-15T14:00:00Z');
const otroSlot = (horas: number) => new Date(SLOT.getTime() + horas * 3_600_000);

function entrada(d: Despacho, contactoId: string, inicia: Date) {
  return {
    tenantId: d.tenantId,
    abogadoId: d.abogadoId,
    contactoId,
    materia: 'laboral',
    modalidad: 'presencial' as const,
    iniciaAt: inicia,
    terminaAt: new Date(inicia.getTime() + 45 * 60_000),
    honorarioUsd: '40.00',
  };
}

async function reservarCon(base = db, contactoId = a.contactoId, inicia = SLOT, pausaMs = 0) {
  return enTenant(base, a.tenantId, async (tx) => {
    if (pausaMs > 0) await new Promise((r) => setTimeout(r, pausaMs));
    return reservar(tx, entrada(a, contactoId, inicia));
  });
}

async function cancelar(citaId: string): Promise<void> {
  await enTenant(db, a.tenantId, (tx) =>
    tx.execute(sql`
      UPDATE citas SET estado = 'cancelada', cancelada_at = now(), cancelada_por = 'contacto'
      WHERE id = ${citaId}::uuid
    `),
  );
}

beforeEach(async () => {
  await limpiar();
  a = await sembrarDespacho('despacho-a');
});

afterEach(limpiar);
afterAll(() => db.cerrar());

describe('reserva · doble reserva', () => {
  it('dos reservas simultáneas al mismo horario: una gana, la otra recibe SlotTomadoError', async () => {
    const otro = await sembrarContacto(db, a.tenantId, '593988888888');
    // Pools distintos para garantizar conexiones distintas, y una pausa dentro de cada
    // transacción para que ambas estén realmente abiertas a la vez.
    const db2 = crearBaseDatos(urlApp());
    try {
      const resultados = await Promise.allSettled([
        reservarCon(db, a.contactoId, SLOT, 60),
        reservarCon(db2, otro, SLOT, 60),
      ]);

      const cumplidas = resultados.filter((r) => r.status === 'fulfilled');
      const rechazadas = resultados.filter((r) => r.status === 'rejected');
      expect(cumplidas).toHaveLength(1);
      expect(rechazadas).toHaveLength(1);
      expect((rechazadas[0] as PromiseRejectedResult).reason).toBeInstanceOf(SlotTomadoError);
    } finally {
      await db2.cerrar();
    }

    const { rows } = await enTenant(db, a.tenantId, (tx) =>
      tx.execute<{ n: string }>(sql`SELECT count(*)::text AS n FROM citas WHERE estado <> 'cancelada'`),
    );
    expect(rows[0]!.n).toBe('1');
  });

  it('cancelar libera el horario: el índice parcial deja de cubrir la fila cancelada', async () => {
    const primera = await reservarCon();
    await expect(reservarCon(db, await sembrarContacto(db, a.tenantId, '593977777777')))
      .rejects.toBeInstanceOf(SlotTomadoError);

    await cancelar(primera.id);
    const segunda = await reservarCon(db, await sembrarContacto(db, a.tenantId, '593966666666'));
    expect(segunda.id).not.toBe(primera.id);
  });
});

describe('reserva · una cita activa por contacto', () => {
  it('un contacto con cita activa no puede reservar otra', async () => {
    await reservarCon(db, a.contactoId, SLOT);
    await expect(reservarCon(db, a.contactoId, otroSlot(2))).rejects.toBeInstanceOf(YaTieneCitaError);
  });

  it('tras cancelar, el mismo contacto puede volver a reservar', async () => {
    const primera = await reservarCon(db, a.contactoId, SLOT);
    await cancelar(primera.id);
    await expect(reservarCon(db, a.contactoId, otroSlot(2))).resolves.toBeDefined();
  });

  it('reagendar en una sola transacción no choca consigo mismo', async () => {
    const primera = await reservarCon(db, a.contactoId, SLOT);

    // Cancelar y volver a reservar dentro de la misma transacción: la fila cancelada sale
    // del índice parcial antes de que se compruebe la nueva.
    const segunda = await enTenant(db, a.tenantId, async (tx) => {
      await tx.execute(sql`
        UPDATE citas SET estado = 'cancelada', cancelada_at = now(), cancelada_por = 'contacto'
        WHERE id = ${primera.id}::uuid
      `);
      return reservar(tx, entrada(a, a.contactoId, otroSlot(3)));
    });

    expect(segunda.id).not.toBe(primera.id);
  });
});

describe('reserva · cupo mensual', () => {
  it(`la reserva número ${LIMITE_RESERVAS_MES + 1} del mes se rechaza`, async () => {
    for (let i = 0; i < LIMITE_RESERVAS_MES; i++) {
      const cita = await reservarCon(db, a.contactoId, otroSlot(i));
      await cancelar(cita.id); // liberar la restricción de «una activa» sin liberar cupo
    }
    await expect(reservarCon(db, a.contactoId, otroSlot(10))).rejects.toBeInstanceOf(
      LimiteMensualError,
    );
  });

  it('el cupo es por mes local: una reserva de noviembre no consume el de octubre', async () => {
    for (let i = 0; i < LIMITE_RESERVAS_MES; i++) {
      const cita = await reservarCon(db, a.contactoId, otroSlot(i));
      await cancelar(cita.id);
    }
    await expect(
      reservarCon(db, a.contactoId, new Date('2026-11-05T14:00:00Z')),
    ).resolves.toBeDefined();
  });

  it('un rechazo por horario ocupado devuelve el cupo consumido', async () => {
    const otro = await sembrarContacto(db, a.tenantId, '593955555555');
    await reservarCon(db, a.contactoId, SLOT);

    await expect(reservarCon(db, otro, SLOT)).rejects.toBeInstanceOf(SlotTomadoError);

    // La transacción entera se deshizo: el contador del segundo contacto sigue a cero.
    const { rows } = await enTenant(db, a.tenantId, (tx) =>
      tx.execute<{ n: string }>(
        sql`SELECT count(*)::text AS n FROM reservas_mes WHERE contacto_id = ${otro}::uuid`,
      ),
    );
    expect(rows[0]!.n).toBe('0');
  });
});

describe('reserva · tipos devueltos', () => {
  it('las fechas vuelven como Date, no como el string crudo de Postgres', async () => {
    // Drizzle desactiva los analizadores de node-postgres en consultas crudas: sin la
    // conversión explícita, esto sería un string tipado como Date y reventaría en la
    // primera llamada a `.getTime()`, ya en producción.
    const cita = await reservarCon();
    expect(cita.iniciaAt).toBeInstanceOf(Date);
    expect(cita.terminaAt).toBeInstanceOf(Date);
    expect(cita.iniciaAt.toISOString()).toBe(SLOT.toISOString());
    expect(cita.terminaAt.getTime() - cita.iniciaAt.getTime()).toBe(45 * 60_000);
  });
});

describe('reserva · outbox', () => {
  it('el efecto externo se escribe en la misma transacción que la cita', async () => {
    const cita = await reservarCon();
    const { rows } = await enTenant(db, a.tenantId, (tx) =>
      tx.execute<{ tipo: string; idempotency_key: string; publicado_at: Date | null }>(
        sql`SELECT tipo, idempotency_key, publicado_at FROM outbox`,
      ),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.tipo).toBe('gcal.crear');
    expect(rows[0]!.idempotency_key).toBe(`gcal.crear:${cita.id}`);
    expect(rows[0]!.publicado_at).toBeNull();
  });

  it('si la reserva falla no queda rastro en la outbox', async () => {
    const otro = await sembrarContacto(db, a.tenantId, '593944444444');
    await reservarCon(db, a.contactoId, SLOT);
    await expect(reservarCon(db, otro, SLOT)).rejects.toBeInstanceOf(SlotTomadoError);

    const { rows } = await enTenant(db, a.tenantId, (tx) =>
      tx.execute<{ n: string }>(sql`SELECT count(*)::text AS n FROM outbox`),
    );
    expect(rows[0]!.n).toBe('1'); // solo la de la reserva que sí prosperó
  });
});
