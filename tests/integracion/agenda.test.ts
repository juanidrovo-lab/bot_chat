import { sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { crearCatalogos } from '../../src/adapters/postgres/catalogos.ts';
import { crearRepoCitas } from '../../src/adapters/postgres/reservas.ts';
import { enTenant } from '../../src/adapters/postgres/tenantContext.ts';
import { crearReloj } from '../../src/adapters/reloj.ts';
import { slotsDisponibles } from '../../src/app/disponibilidad.ts';
import { reservarCita } from '../../src/app/reservarCita.ts';
import { cancelarCita } from '../../src/app/cancelarCita.ts';
import { idDeSlot } from '../../src/domain/agenda/Slot.ts';
import { POLITICA } from '../../src/domain/agenda/politicas.ts';
import { formatearFechaHora, fechaLocalISO } from '../../src/platform/time.ts';
import {
  abrirApp,
  configurarHorario,
  limpiar,
  sembrarAbogado,
  sembrarBloqueo,
  sembrarDespacho,
  type Despacho,
} from './ayuda.ts';

const db = abrirApp();
const repo = crearRepoCitas(db);
let a: Despacho;

/** Martes 20 de octubre de 2026, 08:00 local (13:00 UTC). Fijo, para no depender del reloj. */
const AHORA_MS = Date.UTC(2026, 9, 20, 13, 0, 0);
const reloj = crearReloj(() => AHORA_MS);
const deps = { repo, reloj, politica: POLITICA };

const DATOS = { nombre: 'Ana Pérez', email: 'ana@ejemplo.ec' };

beforeEach(async () => {
  await limpiar();
  a = await sembrarDespacho('despacho-a');
});

afterEach(limpiar);
afterAll(() => db.cerrar());

describe('agenda · generación de huecos', () => {
  it('ofrece los horarios del despacho, en la rejilla y con la antelación mínima', async () => {
    const slots = await slotsDisponibles(deps, a.tenantId, 'laboral');
    expect(slots.length).toBeGreaterThan(0);

    // Son las 08:00 y la antelación es de 3 h: el primer hueco de hoy es el de las 11:00.
    const deHoy = slots.filter((s) => s.dia === '2026-10-20');
    expect(reloj.formatearHora(deHoy[0]!.inicioMs)).toBe('11:00');
    // 09:00–13:00 y 15:00–18:00: nada fuera de esas franjas.
    for (const slot of deHoy) {
      const hora = Number(reloj.formatearHora(slot.inicioMs).slice(0, 2));
      expect(hora === 11 || hora === 12 || (hora >= 15 && hora <= 17)).toBe(true);
    }
  });

  it('el fin de semana no aparece', async () => {
    const slots = await slotsDisponibles(deps, a.tenantId, 'laboral');
    for (const dia of new Set(slots.map((s) => s.dia))) {
      expect([0, 6], `${dia} es fin de semana`).not.toContain(reloj.diaSemana(dia));
    }
  });

  it('una materia que ningún abogado atiende no ofrece nada', async () => {
    expect(await slotsDisponibles(deps, a.tenantId, 'penal')).toEqual([]);
  });

  it('un despacho sin horarios configurados no ofrece nada, en vez de fallar', async () => {
    await configurarHorario(a.tenantId, {});
    expect(await slotsDisponibles(deps, a.tenantId, 'laboral')).toEqual([]);
  });

  it('un horario mal escrito deja ese día sin huecos y no inventa horas imposibles', async () => {
    await configurarHorario(a.tenantId, {
      '2': [{ desde: 'nueve', hasta: '13:00' }, { desde: '15:00', hasta: '18:00' }],
    });
    const slots = await slotsDisponibles(deps, a.tenantId, 'laboral');
    const horas = slots.map((s) => reloj.formatearHora(s.inicioMs));
    expect(horas.every((h) => h >= '15:00' && h <= '17:00')).toBe(true);
  });
});

describe('agenda · lo ocupado', () => {
  it('una cita reservada quita su hueco', async () => {
    const antes = await slotsDisponibles(deps, a.tenantId, 'laboral');
    const elegido = antes[0]!;

    await reservarCita(repo, POLITICA, {
      tenantId: a.tenantId,
      contactoId: a.contactoId,
      materia: 'laboral',
      modalidad: 'presencial',
      slotId: idDeSlot(elegido),
      honorarioUsd: '40.00',
      datos: DATOS,
    });

    const despues = await slotsDisponibles(deps, a.tenantId, 'laboral');
    expect(despues.map((s) => s.inicioMs)).not.toContain(elegido.inicioMs);
  });

  it('un bloqueo elimina el slot igual que una cita', async () => {
    // Aceptación (b): lo que importa el sincronizador de Google entra por la misma puerta.
    const antes = await slotsDisponibles(deps, a.tenantId, 'laboral');
    const elegido = antes[0]!;

    await sembrarBloqueo(db, a.tenantId, a.abogadoId, new Date(elegido.inicioMs), new Date(elegido.finMs));

    const despues = await slotsDisponibles(deps, a.tenantId, 'laboral');
    expect(despues.map((s) => s.inicioMs)).not.toContain(elegido.inicioMs);
    expect(despues.length).toBe(antes.length - 1);
  });

  it('citas y bloqueos se leen en una sola consulta', async () => {
    const slots = await slotsDisponibles(deps, a.tenantId, 'laboral');
    await sembrarBloqueo(db, a.tenantId, a.abogadoId, new Date(slots[0]!.inicioMs), new Date(slots[0]!.finMs));
    await reservarCita(repo, POLITICA, {
      tenantId: a.tenantId,
      contactoId: a.contactoId,
      materia: 'laboral',
      modalidad: 'presencial',
      slotId: idDeSlot(slots[1]!),
      honorarioUsd: '40.00',
      datos: DATOS,
    });

    const ocupados = await repo.ocupados(a.tenantId, [a.abogadoId], slots[0]!.inicioMs, slots[5]!.finMs);
    expect(ocupados).toHaveLength(2);
  });

  it('la agenda de un abogado no tapa la del otro', async () => {
    const segundo = await sembrarAbogado(db, a.tenantId, ['laboral']);
    const conDos = await slotsDisponibles(deps, a.tenantId, 'laboral');

    await sembrarBloqueo(db, a.tenantId, a.abogadoId, new Date(conDos[0]!.inicioMs), new Date(conDos[0]!.finMs));

    const despues = await slotsDisponibles(deps, a.tenantId, 'laboral');
    // El hueco sigue ofreciéndose, ahora a cargo del segundo abogado.
    const mismoInicio = despues.filter((s) => s.inicioMs === conDos[0]!.inicioMs);
    expect(mismoInicio).toHaveLength(1);
    expect(mismoInicio[0]!.abogadoId).toBe(segundo);
  });
});

describe('agenda · husos horarios', () => {
  it('una cita a las 23:30 locales queda en el día local correcto', async () => {
    // Aceptación (c). 23:30 del 20 de octubre en Cuenca son las 04:30 UTC del 21.
    await configurarHorario(a.tenantId, { '2': [{ desde: '23:00', hasta: '23:59' }] });

    const slots = await slotsDisponibles(deps, a.tenantId, 'laboral');
    const tarde = slots.find((s) => reloj.formatearHora(s.inicioMs) === '23:00');
    expect(tarde).toBeDefined();
    expect(tarde!.dia).toBe('2026-10-20');
    // En UTC ya es el día siguiente: ahí está la trampa.
    expect(new Date(tarde!.inicioMs).toISOString()).toBe('2026-10-21T04:00:00.000Z');

    const reservada = await reservarCita(repo, POLITICA, {
      tenantId: a.tenantId,
      contactoId: a.contactoId,
      materia: 'laboral',
      modalidad: 'presencial',
      slotId: idDeSlot(tarde!),
      honorarioUsd: '40.00',
      datos: DATOS,
    });
    expect(reservada.estado).toBe('reservada');

    const { rows } = await enTenant(db, a.tenantId, (tx) =>
      tx.execute<{ inicia_at: unknown }>(sql`SELECT inicia_at FROM citas`),
    );
    const guardada = new Date(String(rows[0]!.inicia_at));
    expect(fechaLocalISO(guardada)).toBe('2026-10-20');
    expect(formatearFechaHora(guardada)).toContain('20 de octubre');
  });
});

describe('agenda · reagendar', () => {
  async function reservarPrimera() {
    const slots = await slotsDisponibles(deps, a.tenantId, 'laboral');
    const resultado = await reservarCita(repo, POLITICA, {
      tenantId: a.tenantId,
      contactoId: a.contactoId,
      materia: 'laboral',
      modalidad: 'presencial',
      slotId: idDeSlot(slots[0]!),
      honorarioUsd: '40.00',
      datos: DATOS,
    });
    if (resultado.estado !== 'reservada') throw new Error('no se pudo reservar la primera');
    return { cita: resultado.cita, slots };
  }

  it('cancela la anterior y reserva la nueva en la misma operación', async () => {
    const { cita, slots } = await reservarPrimera();

    const movida = await reservarCita(repo, POLITICA, {
      tenantId: a.tenantId,
      contactoId: a.contactoId,
      materia: 'laboral',
      modalidad: 'presencial',
      slotId: idDeSlot(slots[3]!),
      honorarioUsd: '40.00',
      datos: DATOS,
      citaOrigenId: cita.id,
    });
    expect(movida.estado).toBe('reservada');

    const { rows } = await enTenant(db, a.tenantId, (tx) =>
      tx.execute<{ id: string; estado: string; cita_origen_id: string | null }>(
        sql`SELECT id, estado, cita_origen_id FROM citas ORDER BY created_at`,
      ),
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]!.estado).toBe('cancelada');
    expect(rows[1]!.estado).toBe('reservada');
    // El enlace permite medir cuánta gente reagenda en vez de ausentarse.
    expect(rows[1]!.cita_origen_id).toBe(cita.id);
  });

  it('reagendar no gasta cupo mensual', async () => {
    const { cita, slots } = await reservarPrimera();
    await reservarCita(repo, POLITICA, {
      tenantId: a.tenantId,
      contactoId: a.contactoId,
      materia: 'laboral',
      modalidad: 'presencial',
      slotId: idDeSlot(slots[3]!),
      honorarioUsd: '40.00',
      datos: DATOS,
      citaOrigenId: cita.id,
    });

    const { rows } = await enTenant(db, a.tenantId, (tx) =>
      tx.execute<{ total: number }>(sql`SELECT total FROM reservas_mes`),
    );
    // Mover una cita no es pedir otra: el tope frena el spam, no a quien avisa.
    expect(rows[0]!.total).toBe(1);
  });

  it('si el horario nuevo se ocupa, la cita original sobrevive', async () => {
    const { cita, slots } = await reservarPrimera();
    const otro = await sembrarAbogado(db, a.tenantId, ['laboral']);
    void otro;

    // Un tercero se queda con el horario de destino.
    await enTenant(db, a.tenantId, (tx) =>
      tx.execute(sql`
        INSERT INTO citas (tenant_id, abogado_id, contacto_id, materia, modalidad,
                           inicia_at, termina_at, estado, honorario_usd)
        VALUES (${a.tenantId}::uuid, ${slots[3]!.abogadoId}::uuid, ${a.contactoId}::uuid,
                'laboral', 'presencial', ${new Date(slots[3]!.inicioMs)},
                ${new Date(slots[3]!.finMs)}, 'atendida', 40.00)
      `),
    );

    const intento = await reservarCita(repo, POLITICA, {
      tenantId: a.tenantId,
      contactoId: a.contactoId,
      materia: 'laboral',
      modalidad: 'presencial',
      slotId: idDeSlot(slots[3]!),
      honorarioUsd: '40.00',
      datos: DATOS,
      citaOrigenId: cita.id,
    });
    expect(intento.estado).toBe('ocupado');

    // Lo importante: el rollback devolvió la cita original, no dejó al contacto sin nada.
    const { rows } = await enTenant(db, a.tenantId, (tx) =>
      tx.execute<{ estado: string }>(sql`SELECT estado FROM citas WHERE id = ${cita.id}::uuid`),
    );
    expect(rows[0]!.estado).toBe('reservada');
  });
});

describe('agenda · cancelar', () => {
  async function reservarUna() {
    const slots = await slotsDisponibles(deps, a.tenantId, 'laboral');
    const r = await reservarCita(repo, POLITICA, {
      tenantId: a.tenantId,
      contactoId: a.contactoId,
      materia: 'laboral',
      modalidad: 'presencial',
      slotId: idDeSlot(slots[0]!),
      honorarioUsd: '40.00',
      datos: DATOS,
    });
    if (r.estado !== 'reservada') throw new Error('no se pudo reservar');
    return { cita: r.cita, slot: slots[0]! };
  }

  it('libera el horario', async () => {
    const { cita, slot } = await reservarUna();
    expect(await cancelarCita(repo, a.tenantId, cita.id)).toBe(true);

    const libres = await slotsDisponibles(deps, a.tenantId, 'laboral');
    expect(libres.map((s) => s.inicioMs)).toContain(slot.inicioMs);
  });

  it('cancelar dos veces no es un error', async () => {
    const { cita } = await reservarUna();
    expect(await cancelarCita(repo, a.tenantId, cita.id)).toBe(true);
    expect(await cancelarCita(repo, a.tenantId, cita.id)).toBe(false);
  });

  it('sin evento de Google no escribe un borrado en la outbox', async () => {
    const { cita } = await reservarUna();
    await cancelarCita(repo, a.tenantId, cita.id);

    const { rows } = await enTenant(db, a.tenantId, (tx) =>
      tx.execute<{ tipo: string }>(sql`SELECT tipo FROM outbox ORDER BY id`),
    );
    expect(rows.map((r) => r.tipo)).toEqual(['gcal.crear']);
  });

  it('con evento de Google escribe el borrado en la misma transacción', async () => {
    const { cita } = await reservarUna();
    await enTenant(db, a.tenantId, (tx) =>
      tx.execute(sql`UPDATE citas SET gcal_event_id = 'ev-123' WHERE id = ${cita.id}::uuid`),
    );

    await cancelarCita(repo, a.tenantId, cita.id);

    const { rows } = await enTenant(db, a.tenantId, (tx) =>
      tx.execute<{ tipo: string; idempotency_key: string }>(
        sql`SELECT tipo, idempotency_key FROM outbox WHERE tipo = 'gcal.borrar'`,
      ),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.idempotency_key).toBe(`gcal.borrar:${cita.id}`);
  });
});

describe('agenda · catálogos que ve la conversación', () => {
  const catalogos = () => crearCatalogos({ db, repo, reloj, politica: POLITICA });

  it('los días ofrecidos no pasan de diez y todos tienen hueco', async () => {
    const opciones = await catalogos().opciones('dias', {
      tenantId: a.tenantId,
      contactoId: a.contactoId,
      contexto: { materia: 'laboral' },
    });
    expect(opciones.length).toBeLessThanOrEqual(POLITICA.maxOpciones);
    expect(opciones[0]!.titulo).toMatch(/^(lunes|martes|miércoles|jueves|viernes)/);
  });

  it('las horas de un día salen con su identificador de hueco', async () => {
    const peticion = { tenantId: a.tenantId, contactoId: a.contactoId, contexto: { materia: 'laboral', dia: '2026-10-21' } };
    const opciones = await catalogos().opciones('horas', peticion);

    expect(opciones.length).toBeGreaterThan(0);
    expect(opciones.length).toBeLessThanOrEqual(POLITICA.maxOpciones);
    expect(opciones[0]!.titulo).toMatch(/^\d{2}:\d{2}$/);
    expect(opciones[0]!.id).toContain('@');
  });

  it('un día con forma inválida no revienta: no hay horas y el texto no falla', async () => {
    // La máquina guarda el id de la opción sin interpretarlo, así que en `contexto.dia`
    // puede acabar cualquier cosa: un botón viejo, un id manipulado, un error de guion.
    // Antes esto llegaba al formateador de fechas y tumbaba el turno con un RangeError.
    const peticion = {
      tenantId: a.tenantId,
      contactoId: a.contactoId,
      contexto: { materia: 'laboral', dia: 'presencial' },
    };
    expect(await catalogos().opciones('horas', peticion)).toEqual([]);

    const datos = await catalogos().datosDeTexto(peticion);
    expect(datos.fecha).toBeUndefined();
    expect(datos.materia).toBe('Laboral');
  });

  it('un identificador de hueco corrupto tampoco rompe el texto', async () => {
    const datos = await catalogos().datosDeTexto({
      tenantId: a.tenantId,
      contactoId: a.contactoId,
      contexto: { materia: 'laboral', slotId: 'abogado@' },
    });
    expect(datos.fecha).toBeUndefined();
  });

  it('sin día elegido no hay horas que ofrecer', async () => {
    const opciones = await catalogos().opciones('horas', {
      tenantId: a.tenantId,
      contactoId: a.contactoId,
      contexto: { materia: 'laboral' },
    });
    expect(opciones).toEqual([]);
  });
});
