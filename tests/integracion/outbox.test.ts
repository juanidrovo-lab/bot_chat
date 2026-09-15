import { sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { crearRepoBloqueos } from '../../src/adapters/postgres/bloqueos.ts';
import { crearRepoOutbox } from '../../src/adapters/postgres/outbox.ts';
import { crearRepoCitas } from '../../src/adapters/postgres/reservas.ts';
import { enTenant } from '../../src/adapters/postgres/tenantContext.ts';
import { crearReloj } from '../../src/adapters/reloj.ts';
import { crearBaseDatos } from '../../src/adapters/postgres/db.ts';
import { crearManejadoresGoogle } from '../../src/app/efectosGoogle.ts';
import { importarBloqueos } from '../../src/app/importarBloqueos.ts';
import { MAX_INTENTOS, relayOutbox } from '../../src/app/relayOutbox.ts';
import { slotsDisponibles } from '../../src/app/disponibilidad.ts';
import { reservarCita } from '../../src/app/reservarCita.ts';
import { cancelarCita } from '../../src/app/cancelarCita.ts';
import type { Calendario, EventoCalendario } from '../../src/app/puertos/Calendario.ts';
import { idDeSlot } from '../../src/domain/agenda/Slot.ts';
import { POLITICA } from '../../src/domain/agenda/politicas.ts';
import { abrirApp, limpiar, sembrarDespacho, urlApp, type Despacho } from './ayuda.ts';

const db = abrirApp();
const repoCitas = crearRepoCitas(db);
const repoOutbox = crearRepoOutbox(db);
const repoBloqueos = crearRepoBloqueos(db);
const AHORA_MS = Date.UTC(2026, 9, 20, 13, 0, 0);
const reloj = crearReloj(() => AHORA_MS);
const REGISTRO = { warn: () => {}, error: () => {} };
const DATOS = { nombre: 'Ana Pérez', email: 'ana@ejemplo.ec' };

let a: Despacho;

/** Calendario de mentira: cuenta lo que se le pide y puede fingir que Google está caído. */
function calendarioFalso(opciones: { caido?: boolean; ocupados?: { inicioMs: number; finMs: number }[] } = {}) {
  const creados: EventoCalendario[] = [];
  const borrados: string[] = [];

  const calendario: Calendario = {
    async crearEvento(evento) {
      if (opciones.caido === true) throw new Error('503 de Google');
      creados.push(evento);
      return evento.id;
    },
    async borrarEvento(id) {
      if (opciones.caido === true) throw new Error('503 de Google');
      borrados.push(id);
    },
    async ocupados() {
      if (opciones.caido === true) throw new Error('503 de Google');
      return opciones.ocupados ?? [];
    },
  };

  return { calendario, creados, borrados, calendarioDe: async () => calendario };
}

function manejadoresCon(calendarioDe: () => Promise<Calendario | null>) {
  return crearManejadoresGoogle({
    repoCitas,
    calendarioDe,
    idDeEvento: (id) => id.replace(/-/g, ''),
  });
}

async function reservarUna() {
  const slots = await slotsDisponibles({ repo: repoCitas, reloj, politica: POLITICA }, a.tenantId, 'laboral');
  const r = await reservarCita(repoCitas, POLITICA, {
    tenantId: a.tenantId,
    contactoId: a.contactoId,
    materia: 'laboral',
    modalidad: 'presencial',
    slotId: idDeSlot(slots[0]!),
    honorarioUsd: '40.00',
    datos: DATOS,
  });
  if (r.estado !== 'reservada') throw new Error(`no se pudo reservar: ${r.estado}`);
  return r.cita;
}

async function filasOutbox() {
  const { rows } = await enTenant(db, a.tenantId, (tx) =>
    tx.execute<{
      id: string;
      tipo: string;
      intentos: number;
      publicado: boolean;
      ultimo_error: string | null;
    }>(sql`
      SELECT id::text AS id, tipo, intentos, publicado_at IS NOT NULL AS publicado, ultimo_error
        FROM outbox ORDER BY id
    `),
  );
  return rows;
}

beforeEach(async () => {
  await limpiar();
  a = await sembrarDespacho('despacho-a');
});

afterEach(limpiar);
afterAll(() => db.cerrar());

describe('relay · idempotencia', () => {
  it('correr el relay dos veces no crea dos eventos en Google', async () => {
    // Aceptación de la fase.
    await reservarUna();
    const google = calendarioFalso();
    const manejadores = manejadoresCon(google.calendarioDe);

    const primera = await relayOutbox({ repo: repoOutbox, manejadores, registro: REGISTRO });
    const segunda = await relayOutbox({ repo: repoOutbox, manejadores, registro: REGISTRO });

    expect(primera.publicados).toBe(1);
    // La segunda pasada no encuentra nada pendiente.
    expect(segunda).toEqual({ publicados: 0, fallidos: 0, archivados: 0 });
    expect(google.creados).toHaveLength(1);
  });

  it('aunque el trabajo se reintente, la cita ya reflejada no se duplica', async () => {
    const cita = await reservarUna();
    const google = calendarioFalso();
    const manejadores = manejadoresCon(google.calendarioDe);

    await relayOutbox({ repo: repoOutbox, manejadores, registro: REGISTRO });

    // Se simula una entrega repetida: el arriendo venció y el trabajo vuelve a estar libre.
    await enTenant(db, a.tenantId, (tx) =>
      tx.execute(sql`UPDATE outbox SET publicado_at = NULL, proximo_intento_at = now(), intentos = 1`),
    );
    await relayOutbox({ repo: repoOutbox, manejadores, registro: REGISTRO });

    // El manejador ve que la cita ya tiene `gcal_event_id` y no vuelve a llamar a Google.
    expect(google.creados).toHaveLength(1);
    const { rows } = await enTenant(db, a.tenantId, (tx) =>
      tx.execute<{ gcal_event_id: string }>(sql`SELECT gcal_event_id FROM citas WHERE id = ${cita.id}::uuid`),
    );
    expect(rows[0]!.gcal_event_id).toBe(cita.id.replace(/-/g, ''));
  });
});

describe('relay · Google caído', () => {
  it('la reserva funciona igual con la API apagada', async () => {
    // Aceptación de la fase: Postgres es la fuente de verdad (D4).
    const cita = await reservarUna();
    expect(cita.id).toBeTruthy();

    const google = calendarioFalso({ caido: true });
    const resumen = await relayOutbox({
      repo: repoOutbox,
      manejadores: manejadoresCon(google.calendarioDe),
      registro: REGISTRO,
    });

    expect(resumen.fallidos).toBe(1);

    // La cita sigue ahí, ocupando su horario.
    const { rows } = await enTenant(db, a.tenantId, (tx) =>
      tx.execute<{ estado: string }>(sql`SELECT estado FROM citas`),
    );
    expect(rows[0]!.estado).toBe('reservada');

    const libres = await slotsDisponibles({ repo: repoCitas, reloj, politica: POLITICA }, a.tenantId, 'laboral');
    expect(libres.map((s) => new Date(s.inicioMs).toISOString())).not.toContain(
      cita.iniciaAt.toISOString(),
    );
  });

  it('el fallo programa un reintento futuro y guarda el motivo, sin PII', async () => {
    await reservarUna();
    const google = calendarioFalso({ caido: true });

    await relayOutbox({
      repo: repoOutbox,
      manejadores: manejadoresCon(google.calendarioDe),
      registro: REGISTRO,
    });

    const [fila] = await filasOutbox();
    expect(fila!.publicado).toBe(false);
    expect(fila!.intentos).toBe(1);
    expect(fila!.ultimo_error).toContain('503');

    const { rows } = await enTenant(db, a.tenantId, (tx) =>
      tx.execute<{ futuro: boolean }>(sql`SELECT proximo_intento_at > now() AS futuro FROM outbox`),
    );
    expect(rows[0]!.futuro).toBe(true);
  });

  it('cuando Google vuelve, el trabajo se publica', async () => {
    await reservarUna();
    const caido = calendarioFalso({ caido: true });
    await relayOutbox({ repo: repoOutbox, manejadores: manejadoresCon(caido.calendarioDe), registro: REGISTRO });

    // Pasa la espera del backoff.
    await enTenant(db, a.tenantId, (tx) => tx.execute(sql`UPDATE outbox SET proximo_intento_at = now()`));

    const vivo = calendarioFalso();
    const resumen = await relayOutbox({ repo: repoOutbox, manejadores: manejadoresCon(vivo.calendarioDe), registro: REGISTRO });

    expect(resumen.publicados).toBe(1);
    expect(vivo.creados).toHaveLength(1);
  });

  it('tras agotar los intentos se archiva y queda visible para la alerta del estudio', async () => {
    await reservarUna();
    const google = calendarioFalso({ caido: true });
    const manejadores = manejadoresCon(google.calendarioDe);

    for (let vuelta = 0; vuelta < MAX_INTENTOS + 1; vuelta++) {
      await enTenant(db, a.tenantId, (tx) => tx.execute(sql`UPDATE outbox SET proximo_intento_at = now()`));
      await relayOutbox({ repo: repoOutbox, manejadores, registro: REGISTRO });
    }

    const [fila] = await filasOutbox();
    expect(fila!.intentos).toBe(MAX_INTENTOS);
    // Sigue sin publicar: es lo que busca la alerta de §9 para que el estudio se entere.
    expect(fila!.publicado).toBe(false);

    // Y ya no se vuelve a reclamar, por mucho que venza la espera.
    await enTenant(db, a.tenantId, (tx) => tx.execute(sql`UPDATE outbox SET proximo_intento_at = now()`));
    expect(await repoOutbox.reclamar(a.tenantId, 10)).toEqual([]);
  });
});

describe('relay · reclamo concurrente', () => {
  it('dos relays a la vez no toman el mismo trabajo', async () => {
    await reservarUna();
    const cita = await enTenant(db, a.tenantId, (tx) =>
      tx.execute<{ id: string }>(sql`SELECT id FROM citas`),
    );
    // Un par de trabajos más para que haya algo que repartir.
    await enTenant(db, a.tenantId, (tx) =>
      tx.execute(sql`
        INSERT INTO outbox (tenant_id, tipo, payload, idempotency_key)
        SELECT ${a.tenantId}::uuid, 'gcal.crear',
               ${JSON.stringify({ citaId: cita.rows[0]!.id })}::jsonb, 'extra-' || n
          FROM generate_series(1, 5) AS n
      `),
    );

    const otra = crearBaseDatos(urlApp());
    try {
      const [unos, otros] = await Promise.all([
        repoOutbox.reclamar(a.tenantId, 10),
        crearRepoOutbox(otra).reclamar(a.tenantId, 10),
      ]);

      const ids = [...unos, ...otros].map((t) => t.id);
      // `FOR UPDATE SKIP LOCKED`: se reparten, no se duplican.
      expect(new Set(ids).size).toBe(ids.length);
      expect(ids).toHaveLength(6);
    } finally {
      await otra.cerrar();
    }
  });

  it('el reclamo arrienda: lo tomado no se vuelve a tomar enseguida', async () => {
    await reservarUna();

    expect(await repoOutbox.reclamar(a.tenantId, 10)).toHaveLength(1);
    // Sin esperar a que venza el arriendo, no hay nada que reclamar.
    expect(await repoOutbox.reclamar(a.tenantId, 10)).toEqual([]);
  });
});

describe('relay · cancelación', () => {
  it('cancelar publica el borrado del evento espejo', async () => {
    const cita = await reservarUna();
    const google = calendarioFalso();
    const manejadores = manejadoresCon(google.calendarioDe);

    await relayOutbox({ repo: repoOutbox, manejadores, registro: REGISTRO });
    await cancelarCita(repoCitas, a.tenantId, cita.id);
    await relayOutbox({ repo: repoOutbox, manejadores, registro: REGISTRO });

    expect(google.borrados).toEqual([cita.id.replace(/-/g, '')]);
    const filas = await filasOutbox();
    expect(filas.map((f) => f.tipo)).toEqual(['gcal.crear', 'gcal.borrar']);
    expect(filas.every((f) => f.publicado)).toBe(true);
  });
});

describe('bloqueos importados de Google', () => {
  async function bloqueosDe(origen?: string) {
    const { rows } = await enTenant(db, a.tenantId, (tx) =>
      tx.execute<{ origen: string; inicia_at: unknown; external_id: string | null }>(sql`
        SELECT origen, inicia_at, external_id FROM bloqueos ORDER BY inicia_at
      `),
    );
    return origen === undefined ? rows : rows.filter((r) => r.origen === origen);
  }

  async function conectarGoogle() {
    const cliente = await import('pg');
    const { urlOwner } = await import('./ayuda.ts');
    const c = new cliente.default.Client({ connectionString: urlOwner() });
    await c.connect();
    try {
      await c.query('BEGIN');
      await c.query(`SELECT set_config('app.tenant_id', $1, true)`, [a.tenantId]);
      await c.query(
        `UPDATE abogados SET gcal_calendar_id = 'abogado@ejemplo.ec',
                             gcal_refresh_token_enc = 'v1.loquesea'
          WHERE tenant_id = $1 AND id = $2`,
        [a.tenantId, a.abogadoId],
      );
      await c.query('COMMIT');
    } finally {
      await c.end();
    }
  }

  it('sustituye la ventana: lo que Google ya no reporta deja de bloquear', async () => {
    await conectarGoogle();
    const inicio = AHORA_MS + 2 * 3_600_000;

    const primero = calendarioFalso({ ocupados: [{ inicioMs: inicio, finMs: inicio + 3_600_000 }] });
    await importarBloqueos(
      { repo: repoBloqueos, calendarioDe: primero.calendarioDe, reloj, politica: POLITICA, registro: REGISTRO },
      a.tenantId,
    );
    expect(await bloqueosDe('gcal')).toHaveLength(1);

    // Google ya no reporta esa franja: el bloqueo tiene que desaparecer.
    const segundo = calendarioFalso({ ocupados: [] });
    await importarBloqueos(
      { repo: repoBloqueos, calendarioDe: segundo.calendarioDe, reloj, politica: POLITICA, registro: REGISTRO },
      a.tenantId,
    );
    expect(await bloqueosDe('gcal')).toHaveLength(0);
  });

  it('no pisa los bloqueos que el estudio puso a mano', async () => {
    await conectarGoogle();
    const inicio = AHORA_MS + 2 * 3_600_000;
    await enTenant(db, a.tenantId, (tx) =>
      tx.execute(sql`
        INSERT INTO bloqueos (tenant_id, abogado_id, inicia_at, termina_at, origen)
        VALUES (${a.tenantId}::uuid, ${a.abogadoId}::uuid,
                ${new Date(inicio)}, ${new Date(inicio + 3_600_000)}, 'manual')
      `),
    );

    const google = calendarioFalso({ ocupados: [] });
    await importarBloqueos(
      { repo: repoBloqueos, calendarioDe: google.calendarioDe, reloj, politica: POLITICA, registro: REGISTRO },
      a.tenantId,
    );

    expect(await bloqueosDe('manual')).toHaveLength(1);
  });

  it('repetir la importación es idempotente', async () => {
    await conectarGoogle();
    const inicio = AHORA_MS + 2 * 3_600_000;
    const google = calendarioFalso({ ocupados: [{ inicioMs: inicio, finMs: inicio + 3_600_000 }] });
    const deps = { repo: repoBloqueos, calendarioDe: google.calendarioDe, reloj, politica: POLITICA, registro: REGISTRO };

    await importarBloqueos(deps, a.tenantId);
    await importarBloqueos(deps, a.tenantId);

    expect(await bloqueosDe('gcal')).toHaveLength(1);
  });

  it('un bloqueo importado quita el hueco de la agenda', async () => {
    await conectarGoogle();
    const antes = await slotsDisponibles({ repo: repoCitas, reloj, politica: POLITICA }, a.tenantId, 'laboral');
    const objetivo = antes[0]!;

    const google = calendarioFalso({ ocupados: [{ inicioMs: objetivo.inicioMs, finMs: objetivo.finMs }] });
    await importarBloqueos(
      { repo: repoBloqueos, calendarioDe: google.calendarioDe, reloj, politica: POLITICA, registro: REGISTRO },
      a.tenantId,
    );

    const despues = await slotsDisponibles({ repo: repoCitas, reloj, politica: POLITICA }, a.tenantId, 'laboral');
    expect(despues.map((s) => s.inicioMs)).not.toContain(objetivo.inicioMs);
  });

  it('un abogado sin Google conectado no aparece en la sincronización', async () => {
    expect(await repoBloqueos.conCalendario(a.tenantId)).toEqual([]);
  });
});
