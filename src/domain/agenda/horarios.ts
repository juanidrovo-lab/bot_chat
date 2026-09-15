import type { Slot, Ventana } from './Slot.ts';
import { pasoMin, type Politica } from './politicas.ts';

const MS_POR_MIN = 60_000;

/**
 * Genera los inicios candidatos dentro de cada ventana de trabajo.
 *
 * Los inicios van en rejilla, separados por el paso efectivo (duración + buffer). Que la
 * rejilla sea fija es lo que hace que dos candidatos nunca choquen entre sí, y que ofrecer
 * «las 15:00» signifique lo mismo en toda la agenda.
 *
 * Un candidato solo existe si la consulta **entera** cabe en la ventana: ofrecer un hueco
 * que se sale del horario es peor que no ofrecerlo.
 */
export function generarCandidatos(
  ventanas: readonly Ventana[],
  politica: Politica,
): Slot[] {
  const duracionMs = politica.duracionMin * MS_POR_MIN;
  const pasoMs = pasoMin(politica) * MS_POR_MIN;
  const slots: Slot[] = [];

  for (const ventana of ventanas) {
    for (let inicio = ventana.inicioMs; inicio + duracionMs <= ventana.finMs; inicio += pasoMs) {
      slots.push({
        abogadoId: ventana.abogadoId,
        dia: ventana.dia,
        inicioMs: inicio,
        finMs: inicio + duracionMs,
      });
    }
  }

  return slots.sort((a, b) => a.inicioMs - b.inicioMs || a.abogadoId.localeCompare(b.abogadoId));
}
