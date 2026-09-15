/**
 * El dominio de agenda trabaja en **milisegundos UTC** y no sabe nada de zonas horarias.
 *
 * Toda la conversión entre la hora local de Cuenca y los instantes ocurre en el adaptador,
 * que es quien puede importar `platform/time.ts`. Aquí solo hay aritmética de intervalos:
 * así se prueba el motor entero sin Docker y sin depender del reloj de la máquina.
 *
 * Cada ventana y cada slot llevan además el día local al que pertenecen, ya resuelto por
 * el adaptador. Agrupar por día es entonces trivial y no vuelve a tocar el calendario.
 */
export interface Intervalo {
  inicioMs: number;
  finMs: number;
}

/** Tramo de trabajo de un abogado en un día local concreto. */
export interface Ventana extends Intervalo {
  abogadoId: string;
  /** `YYYY-MM-DD` en hora local. */
  dia: string;
}

/** Hueco ofrecible. */
export interface Slot extends Intervalo {
  abogadoId: string;
  dia: string;
}

/** Lo que bloquea un hueco: una cita ya reservada o un bloqueo importado del calendario. */
export interface Ocupado extends Intervalo {
  abogadoId: string;
}

/**
 * Identificador opaco de un slot.
 *
 * La máquina de estados lo guarda sin interpretarlo: no debe saber que dentro viajan un
 * abogado y un instante. Codificar y decodificar vive aquí, junto al tipo.
 */
export function idDeSlot(slot: Slot): string {
  return `${slot.abogadoId}@${slot.inicioMs}`;
}

export function leerIdDeSlot(id: string): { abogadoId: string; inicioMs: number } | null {
  const corte = id.lastIndexOf('@');
  if (corte <= 0) return null;
  const sufijo = id.slice(corte + 1);
  // Dígitos explícitos: `Number('')` es 0, así que un id truncado como «abogado@» se
  // colaría como un instante válido —la época— en vez de rechazarse.
  if (!/^\d+$/.test(sufijo)) return null;
  const inicioMs = Number(sufijo);
  if (!Number.isSafeInteger(inicioMs)) return null;
  return { abogadoId: id.slice(0, corte), inicioMs };
}
