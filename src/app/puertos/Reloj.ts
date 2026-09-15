/**
 * Tiempo y calendario local.
 *
 * Existe porque `app` no puede importar `platform` igual que `domain` no puede: la regla de
 * anillos vale para los dos. El dominio de agenda hace aritmética sobre milisegundos y no
 * sabe qué es America/Guayaquil; los casos de uso necesitan traducir entre día local e
 * instante, y lo piden por aquí.
 */
export interface Reloj {
  ahoraMs(): number;
  /** `YYYY-MM-DD` del día local al que pertenece un instante. */
  diaLocal(ms: number): string;
  /** Instante UTC de una hora local (minutos desde la medianoche) en un día local. */
  instanteLocal(dia: string, minutosDelDia: number): number;
  /** Día de la semana de un día local. 0 = domingo. */
  diaSemana(dia: string): number;
  /** Los `n` días locales a partir de hoy, incluido hoy. */
  diasDesdeHoy(n: number): string[];
  /** «martes 20 de octubre, 15:00» */
  formatearFechaHora(ms: number): string;
  /** «15:00» */
  formatearHora(ms: number): string;
  /** «martes 20 de octubre» */
  formatearDia(dia: string): string;
}
