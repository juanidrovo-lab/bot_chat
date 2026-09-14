import { sql } from 'drizzle-orm';
import {
  LimiteMensualError,
  SlotTomadoError,
  YaTieneCitaError,
} from '../../domain/agenda/errores.ts';
import type { CitaReservada, ReservaInput } from '../../app/puertos/RepoCitas.ts';
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

  let cita;
  try {
    cita = await tx.execute<{ id: string; inicia_at: unknown; termina_at: unknown }>(sql`
      INSERT INTO citas (tenant_id, abogado_id, contacto_id, materia, modalidad,
                         inicia_at, termina_at, estado, honorario_usd)
      VALUES (${input.tenantId}::uuid, ${input.abogadoId}::uuid, ${input.contactoId}::uuid,
              ${input.materia}, ${input.modalidad}::modalidad,
              ${input.iniciaAt}, ${input.terminaAt}, 'reservada', ${input.honorarioUsd}::numeric)
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
