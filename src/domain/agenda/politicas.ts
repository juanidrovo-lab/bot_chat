/** Parámetros del motor de agenda (§6). */
export interface Politica {
  /** Duración de la consulta. */
  duracionMin: number;
  /** Descanso entre citas: separa los huecos y protege los ya reservados. */
  bufferMin: number;
  /** Antelación mínima: nadie reserva para dentro de diez minutos. */
  antelacionMin: number;
  /** Cuántos días hacia adelante se ofrecen. */
  horizonteDias: number;
  /** Tope de filas de una lista de WhatsApp. */
  maxOpciones: number;
}

export const POLITICA: Politica = {
  duracionMin: 45,
  bufferMin: 15,
  antelacionMin: 180,
  horizonteDias: 14,
  maxOpciones: 10,
};

/** Paso efectivo entre inicios: 45 + 15 = 60 min, o sea en punto. */
export function pasoMin(politica: Politica): number {
  return politica.duracionMin + politica.bufferMin;
}

/** Tramo de trabajo, en minutos locales desde la medianoche. */
export interface TramoLocal {
  desdeMin: number;
  hastaMin: number;
}

/** Horario semanal del despacho. La clave es el día de la semana, 0 = domingo. */
export type HorarioSemanal = Readonly<Record<string, readonly TramoLocal[]>>;

export const MINUTOS_POR_DIA = 1440;

/**
 * `HH:MM` a minutos desde la medianoche. Devuelve `null` en vez de `NaN` ante basura: un
 * horario mal escrito en la configuración de un despacho debe dejarlo sin huecos, no
 * generar slots en instantes imposibles.
 */
export function minutosDeHora(hhmm: string): number | null {
  const partes = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  if (partes === null) return null;
  const horas = Number(partes[1]);
  const minutos = Number(partes[2]);
  if (horas > 23 || minutos > 59) return null;
  return horas * 60 + minutos;
}

export function tramosDelDia(horario: HorarioSemanal, diaSemana: number): readonly TramoLocal[] {
  return (horario[String(diaSemana)] ?? []).filter((t) => t.hastaMin > t.desdeMin);
}
