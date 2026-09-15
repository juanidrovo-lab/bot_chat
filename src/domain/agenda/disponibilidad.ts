import type { Ocupado, Slot } from './Slot.ts';
import type { Politica } from './politicas.ts';

const MS_POR_MIN = 60_000;

/**
 * Candidatos menos citas, menos bloqueos, menos lo que ya no da tiempo a preparar.
 *
 * El buffer se aplica **alrededor de lo ocupado**, no solo entre candidatos: una cita
 * antigua a las 14:30, fuera de la rejilla actual, tiene que seguir protegiendo su
 * descanso. Con la rejilla de 60 minutos esto no descarta huecos legítimos —una cita de
 * 14:00 a 14:45 más 15 de buffer llega justo a las 15:00, que es el candidato siguiente—.
 */
export function disponibles(
  candidatos: readonly Slot[],
  ocupados: readonly Ocupado[],
  ahoraMs: number,
  politica: Politica,
): Slot[] {
  const bufferMs = politica.bufferMin * MS_POR_MIN;
  const desdeMs = ahoraMs + politica.antelacionMin * MS_POR_MIN;

  // Agrupar por abogado evita comparar cada candidato contra los ocupados de los demás.
  const porAbogado = new Map<string, Ocupado[]>();
  for (const ocupado of ocupados) {
    const lista = porAbogado.get(ocupado.abogadoId);
    if (lista === undefined) porAbogado.set(ocupado.abogadoId, [ocupado]);
    else lista.push(ocupado);
  }

  return candidatos.filter((slot) => {
    if (slot.inicioMs < desdeMs) return false;
    const ocupadosDelAbogado = porAbogado.get(slot.abogadoId);
    if (ocupadosDelAbogado === undefined) return true;
    return !ocupadosDelAbogado.some(
      (o) => o.inicioMs - bufferMs < slot.finMs && slot.inicioMs < o.finMs + bufferMs,
    );
  });
}

/** Días locales que tienen algún hueco, en orden y hasta el tope de la lista. */
export function diasConCupo(slots: readonly Slot[], politica: Politica): string[] {
  const dias: string[] = [];
  for (const slot of slots) {
    if (!dias.includes(slot.dia)) dias.push(slot.dia);
    if (dias.length === politica.maxOpciones) break;
  }
  return dias;
}

/**
 * Huecos de un día concreto, uno por hora de inicio.
 *
 * Si dos abogados están libres a la misma hora se ofrece uno solo: al usuario se le pide
 * un horario, no que elija abogado, y dos filas idénticas en la lista solo confunden.
 */
export function slotsDelDia(slots: readonly Slot[], dia: string, politica: Politica): Slot[] {
  const vistos = new Set<number>();
  const delDia: Slot[] = [];

  for (const slot of slots) {
    if (slot.dia !== dia || vistos.has(slot.inicioMs)) continue;
    vistos.add(slot.inicioMs);
    delDia.push(slot);
    if (delDia.length === politica.maxOpciones) break;
  }

  return delDia;
}
