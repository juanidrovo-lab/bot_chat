/**
 * Tiempo · America/Guayaquil (UTC−5, sin horario de verano).
 *
 * En la base de datos todo es UTC. Este módulo es el único sitio donde se pasa a hora
 * local, y existe para que nadie escriba `new Date().getHours()` y acierte por casualidad
 * porque el servidor está en Europa.
 */
export const ZONA = 'America/Guayaquil';

const partesFmt = new Intl.DateTimeFormat('es-EC', {
  timeZone: ZONA,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

export interface PartesLocales {
  anio: number;
  mes: number;
  dia: number;
  hora: number;
  minuto: number;
}

export function partesLocales(instante: Date): PartesLocales {
  const partes = Object.fromEntries(
    partesFmt.formatToParts(instante).map((p) => [p.type, p.value]),
  );
  return {
    anio: Number(partes.year),
    mes: Number(partes.month),
    dia: Number(partes.day),
    // Intl devuelve «24» para la medianoche con hour12:false en algunas versiones de ICU.
    hora: Number(partes.hour) % 24,
    minuto: Number(partes.minute),
  };
}

/** `YYYY-MM-DD` del día local. El día del calendario de Cuenca, no el de UTC. */
export function fechaLocalISO(instante: Date): string {
  const { anio, mes, dia } = partesLocales(instante);
  return `${anio}-${String(mes).padStart(2, '0')}-${String(dia).padStart(2, '0')}`;
}

/**
 * `YYYY-MM` del mes local. Es la clave de `reservas_mes`: el tope de tres reservas es por
 * mes del calendario ecuatoriano, así que una reserva del 31 de enero a las 21:00 local
 * (1 de febrero en UTC) tiene que contar en enero.
 */
export function periodoMensual(instante: Date): string {
  const { anio, mes } = partesLocales(instante);
  return `${anio}-${String(mes).padStart(2, '0')}`;
}

const DIAS = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
const MESES = [
  'enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio',
  'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre',
];

/** Día de la semana local, 0 = domingo. */
export function diaSemanaLocal(instante: Date): number {
  const { anio, mes, dia } = partesLocales(instante);
  return new Date(Date.UTC(anio, mes - 1, dia)).getUTCDay();
}

/** «martes 16 de septiembre, 15:30» — para los textos de `content.ts`. */
export function formatearFechaHora(instante: Date): string {
  const { anio, mes, dia, hora, minuto } = partesLocales(instante);
  const nombreDia = DIAS[new Date(Date.UTC(anio, mes - 1, dia)).getUTCDay()];
  return `${nombreDia} ${dia} de ${MESES[mes - 1]}, ${String(hora).padStart(2, '0')}:${String(minuto).padStart(2, '0')}`;
}

/** «15:30» */
export function formatearHora(instante: Date): string {
  const { hora, minuto } = partesLocales(instante);
  return `${String(hora).padStart(2, '0')}:${String(minuto).padStart(2, '0')}`;
}

/**
 * Convierte una fecha y hora locales al instante UTC correspondiente.
 * Vale el desplazamiento fijo porque Ecuador no aplica horario de verano; si algún día
 * lo aplicara, este es el único punto a cambiar.
 */
const DESPLAZAMIENTO_MINUTOS = -300;

export function desdeLocal(
  anio: number,
  mes: number,
  dia: number,
  hora = 0,
  minuto = 0,
): Date {
  return new Date(Date.UTC(anio, mes - 1, dia, hora, minuto) - DESPLAZAMIENTO_MINUTOS * 60_000);
}
