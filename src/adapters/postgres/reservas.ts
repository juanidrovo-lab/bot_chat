import { sql } from 'drizzle-orm';
import {
  LimiteMensualError,
  SlotTomadoError,
  YaTieneCitaError,
} from '../../domain/agenda/errores.ts';
import type { CitaReservada, RepoCitas, ReservaInput } from '../../app/puertos/RepoCitas.ts';
import type { Ocupado } from '../../domain/agenda/Slot.ts';
import { minutosDeHora, type HorarioSemanal, type TramoLocal } from '../../domain/agenda/politicas.ts';
import { z } from 'zod';
import type { BaseDatos } from './db.ts';
import { enTenant } from './tenantContext.ts';
import { periodoMensual } from '../../platform/time.ts';
import type { Tx } from './tenantContext.ts';
import { aInstante } from './tipos.ts';

/** §6: máximo 3 reservas por número al mes. */
export const LIMITE_RESERVAS_MES = 3;

/**
 * Busca el error original de Postgres en la cadena de causas.
 *
 * Drizzle envuelve el fallo en un Error propio cuyo mensaje es «Failed query: ...», así
 * que `code` y `constraint` no están en el error que se recibe sino en su `cause`. Mirar
 * solo el nivel de arriba hace que una violación de restricción se escape como error
 * genérico y acabe en un 500 en vez de en la rama del guion que le toca.
 */
export function esViolacionUnica(error: unknown, restriccion: string): boolean {
  // Corre dentro de un `catch`: no puede lanzar ella misma pase lo que pase, y la cadena
  // de causas podría venir en ciclo si alguien la construye a mano.
  const vistos = new Set<unknown>();
  let actual: unknown = error;
  while (typeof actual === 'object' && actual !== null && !vistos.has(actual)) {
    vistos.add(actual);
    const candidato = actual as { code?: unknown; constraint?: unknown; cause?: unknown };
    if (candidato.code === '23505' && candidato.constraint === restriccion) return true;
    actual = candidato.cause;
  }
  return false;
}

/**
 * La reserva, en SQL crudo y en una sola transacción.
 *
 * Va en SQL crudo por dos motivos. El conocido es el bug abierto de Drizzle con
 * `onConflictDoNothing` sobre índices parciales (issue #1628): coloca el `WHERE` detrás
 * del `DO NOTHING` y genera SQL inválido. El de fondo es que la única consulta de la que
 * depende la corrección del sistema no debería depender de que un ORM la traduzca bien.
 *
 * Las tres garantías son del motor, no del programador, y ninguna consulta antes de
 * escribir:
 *
 *   1. Cupo mensual — incremento condicional sobre `reservas_mes`. El `DO UPDATE` toma el
 *      bloqueo de la fila, así que dos intentos simultáneos del mismo contacto se ponen en
 *      fila en vez de leer ambos el mismo total.
 *   2. Horario libre — `citas_slot_unico`. Se infiere por el índice parcial, de modo que
 *      la fila perdedora sale por `DO NOTHING` sin devolver nada.
 *   3. Una cita activa por contacto — `citas_una_activa_por_contacto`. Esta NO se puede
 *      inferir en el mismo `ON CONFLICT` (Postgres admite un solo árbitro), así que llega
 *      como excepción 23505 y se distingue por el nombre de la restricción.
 *
 * El orden importa: el cupo primero, porque rechaza al spam antes de tocar el índice
 * caliente de la agenda; y las tres comprobaciones comparten transacción, así que un fallo
 * en la segunda devuelve el cupo consumido en la primera.
 */
export async function reservar(tx: Tx, input: ReservaInput): Promise<CitaReservada> {
  if (input.consumeCupo) {
    const periodo = periodoMensual(input.iniciaAt);
    const cupo = await tx.execute<{ total: number }>(sql`
      INSERT INTO reservas_mes (tenant_id, contacto_id, periodo, total)
      VALUES (${input.tenantId}::uuid, ${input.contactoId}::uuid, ${periodo}, 1)
      ON CONFLICT (tenant_id, contacto_id, periodo)
      DO UPDATE SET total = reservas_mes.total + 1, actualizado_at = now()
      WHERE reservas_mes.total < ${LIMITE_RESERVAS_MES}
      RETURNING total
    `);
    if (cupo.rows.length === 0) throw new LimiteMensualError(LIMITE_RESERVAS_MES);
  }

  /**
   * Reagendar: la cita que se reemplaza se cancela AQUÍ, en la misma transacción. El
   * `UPDATE` la saca del índice parcial antes de que se compruebe la nueva, así que la
   * restricción de «una cita activa por contacto» no choca consigo misma; y si la inserción
   * siguiente falla, el rollback devuelve la cita original intacta.
   */
  if (input.citaOrigenId !== undefined) {
    await tx.execute(sql`
      UPDATE citas
         SET estado = 'cancelada', cancelada_at = now(), cancelada_por = 'contacto',
             updated_at = now()
       WHERE tenant_id = ${input.tenantId}::uuid AND id = ${input.citaOrigenId}::uuid
         AND estado IN ('reservada', 'confirmada')
    `);
  }

  let cita;
  try {
    cita = await tx.execute<{ id: string; inicia_at: unknown; termina_at: unknown }>(sql`
      INSERT INTO citas (tenant_id, abogado_id, contacto_id, materia, modalidad,
                         inicia_at, termina_at, estado, honorario_usd, cita_origen_id)
      VALUES (${input.tenantId}::uuid, ${input.abogadoId}::uuid, ${input.contactoId}::uuid,
              ${input.materia}, ${input.modalidad}::modalidad,
              ${input.iniciaAt}, ${input.terminaAt}, 'reservada', ${input.honorarioUsd}::numeric,
              ${input.citaOrigenId ?? null})
      ON CONFLICT (tenant_id, abogado_id, inicia_at) WHERE estado <> 'cancelada'
      DO NOTHING
      RETURNING id, inicia_at, termina_at
    `);
  } catch (error) {
    if (esViolacionUnica(error, 'citas_una_activa_por_contacto')) throw new YaTieneCitaError();
    throw error;
  }
  const fila = cita.rows[0];
  if (fila === undefined) throw new SlotTomadoError();

  /**
   * El efecto externo se escribe aquí, en la misma transacción que la cita. Si Google está
   * caído la reserva vale igual: Postgres es la fuente de verdad y el relay reintenta.
   * La `idempotency_key` deriva del id de la cita, así que publicar dos veces no crea dos
   * eventos.
   */
  await tx.execute(sql`
    INSERT INTO outbox (tenant_id, tipo, payload, idempotency_key)
    VALUES (${input.tenantId}::uuid, 'gcal.crear',
            ${JSON.stringify({ citaId: fila.id })}::jsonb,
            ${'gcal.crear:' + fila.id})
    ON CONFLICT (tenant_id, idempotency_key) DO NOTHING
  `);

  // `inicia_at` y `termina_at` llegan como string: Drizzle desactiva los analizadores de
  // node-postgres en las consultas crudas (ver `tipos.ts`).
  return { id: fila.id, iniciaAt: aInstante(fila.inicia_at), terminaAt: aInstante(fila.termina_at) };
}

const TramoConfig = z.object({ desde: z.string(), hasta: z.string() });
const HorariosConfig = z.record(z.string(), z.array(TramoConfig));

/** `{"1":[{"desde":"09:00","hasta":"13:00"}]}` a tramos en minutos locales. */
export function leerHorario(crudo: unknown): HorarioSemanal {
  const analizado = HorariosConfig.safeParse(crudo ?? {});
  if (!analizado.success) return {};

  const horario: Record<string, TramoLocal[]> = {};
  for (const [dia, tramos] of Object.entries(analizado.data)) {
    const validos: TramoLocal[] = [];
    for (const tramo of tramos) {
      const desdeMin = minutosDeHora(tramo.desde);
      const hastaMin = minutosDeHora(tramo.hasta);
      // Un tramo mal escrito deja ese día sin huecos, no genera horarios imposibles.
      if (desdeMin !== null && hastaMin !== null) validos.push({ desdeMin, hastaMin });
    }
    horario[dia] = validos;
  }
  return horario;
}

export function crearRepoCitas(db: BaseDatos): RepoCitas {
  return {
    async reservar(input) {
      return enTenant(db, input.tenantId, (tx) => reservar(tx, input));
    },

    async cancelar(tenantId, citaId, por) {
      return enTenant(db, tenantId, async (tx) => {
        const { rows } = await tx.execute<{ id: string; gcal_event_id: string | null }>(sql`
          UPDATE citas
             SET estado = 'cancelada', cancelada_at = now(),
                 cancelada_por = ${por}::cancelada_por, updated_at = now()
           WHERE tenant_id = ${tenantId}::uuid AND id = ${citaId}::uuid
             AND estado IN ('reservada', 'confirmada')
          RETURNING id, gcal_event_id
        `);
        const fila = rows[0];
        // Cancelar dos veces no es un error: el recordatorio con botones y el panel pueden
        // llegar a la vez, y el segundo simplemente no encuentra nada que cancelar.
        if (fila === undefined) return false;

        // El borrado del evento de Google va en la MISMA transacción, como todo efecto
        // externo, y es idempotente por su clave.
        if (fila.gcal_event_id !== null) {
          await tx.execute(sql`
            INSERT INTO outbox (tenant_id, tipo, payload, idempotency_key)
            VALUES (${tenantId}::uuid, 'gcal.borrar',
                    ${JSON.stringify({ citaId, gcalEventId: fila.gcal_event_id })}::jsonb,
                    ${'gcal.borrar:' + citaId})
            ON CONFLICT (tenant_id, idempotency_key) DO NOTHING
          `);
        }
        return true;
      });
    },

    async confirmarAsistencia(tenantId, citaId) {
      const { rows } = await enTenant(db, tenantId, (tx) =>
        tx.execute<{ id: string }>(sql`
          UPDATE citas SET estado = 'confirmada', confirmada_at = now(), updated_at = now()
           WHERE tenant_id = ${tenantId}::uuid AND id = ${citaId}::uuid AND estado = 'reservada'
          RETURNING id
        `),
      );
      return rows.length > 0;
    },

    async paraCalendario(tenantId, citaId) {
      const { rows } = await enTenant(db, tenantId, (tx) =>
        tx.execute<{
          id: string;
          abogado_id: string;
          materia: string;
          modalidad: 'presencial' | 'virtual';
          inicia_at: unknown;
          termina_at: unknown;
          estado: string;
          gcal_event_id: string | null;
          nombre: string | null;
          wa_id: string;
        }>(sql`
          SELECT c.id, c.abogado_id, c.materia, c.modalidad, c.inicia_at, c.termina_at,
                 c.estado, c.gcal_event_id, k.nombre, k.wa_id
            FROM citas c
            JOIN contactos k ON k.tenant_id = c.tenant_id AND k.id = c.contacto_id
           WHERE c.tenant_id = ${tenantId}::uuid AND c.id = ${citaId}::uuid
        `),
      );
      const fila = rows[0];
      if (fila === undefined) return null;

      return {
        id: fila.id,
        abogadoId: fila.abogado_id,
        materia: fila.materia,
        modalidad: fila.modalidad,
        iniciaAt: aInstante(fila.inicia_at),
        terminaAt: aInstante(fila.termina_at),
        estado: fila.estado,
        gcalEventId: fila.gcal_event_id,
        nombreContacto: fila.nombre,
        waIdContacto: fila.wa_id,
      };
    },

    async anotarEventoGoogle(tenantId, citaId, eventId) {
      await enTenant(db, tenantId, (tx) =>
        tx.execute(sql`
          UPDATE citas SET gcal_event_id = ${eventId}, updated_at = now()
           WHERE tenant_id = ${tenantId}::uuid AND id = ${citaId}::uuid
             AND gcal_event_id IS NULL
        `),
      );
    },

    async abogadosDe(tenantId, materia) {
      const { rows } = await enTenant(db, tenantId, (tx) =>
        tx.execute<{ id: string }>(sql`
          SELECT id FROM abogados
           WHERE tenant_id = ${tenantId}::uuid AND activo AND ${materia} = ANY(materias)
           ORDER BY id
        `),
      );
      return rows.map((r) => r.id);
    },

    async horarioSemanal(tenantId) {
      const { rows } = await enTenant(db, tenantId, (tx) =>
        tx.execute<{ horarios: unknown }>(sql`
          SELECT horarios FROM tenant_config WHERE tenant_id = ${tenantId}::uuid
        `),
      );
      return leerHorario(rows[0]?.horarios);
    },

    async ocupados(tenantId, abogadoIds, desdeMs, hastaMs) {
      if (abogadoIds.length === 0) return [];

      /**
       * Citas y bloqueos en una sola consulta. Separarlas serían dos transacciones para
       * responder una pregunta, y el `UNION ALL` deja que cada rama use su propio índice
       * —`citas_por_estado` y `bloqueos_por_abogado`, ambos empezando por `tenant_id`—.
       */
      const { rows } = await enTenant(db, tenantId, (tx) =>
        tx.execute<{ abogado_id: string; inicia_at: unknown; termina_at: unknown }>(sql`
          SELECT abogado_id, inicia_at, termina_at
            FROM citas
           WHERE tenant_id = ${tenantId}::uuid
             AND abogado_id = ANY(${sql.param([...abogadoIds])}::uuid[])
             AND estado <> 'cancelada'
             AND termina_at > ${new Date(desdeMs)} AND inicia_at < ${new Date(hastaMs)}
          UNION ALL
          SELECT abogado_id, inicia_at, termina_at
            FROM bloqueos
           WHERE tenant_id = ${tenantId}::uuid
             AND abogado_id = ANY(${sql.param([...abogadoIds])}::uuid[])
             AND termina_at > ${new Date(desdeMs)} AND inicia_at < ${new Date(hastaMs)}
        `),
      );

      return rows.map<Ocupado>((fila) => ({
        abogadoId: fila.abogado_id,
        inicioMs: aInstante(fila.inicia_at).getTime(),
        finMs: aInstante(fila.termina_at).getTime(),
      }));
    },
  };
}
