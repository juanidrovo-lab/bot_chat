/**
 * El filtro de PII para el reportador de errores (§2: Sentry con `beforeSend`).
 *
 * Está separado del SDK a propósito. La regla —qué no puede salir del proceso— es del
 * proyecto, no de la herramienta: escrita aquí se prueba sin red y sigue valiendo el día que
 * Sentry se cambie por otra cosa. Conectarlo es una línea:
 *
 * ```ts
 * Sentry.init({ dsn, beforeSend: filtrarEvento });
 * ```
 *
 * El envío en sí es de la fase 8, con el DSN y el entorno del despliegue.
 */
import { redactar } from './redaccion.ts';

export function filtrarEvento<T extends object>(evento: T): T {
  return redactar(evento);
}
