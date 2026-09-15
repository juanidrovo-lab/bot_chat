/**
 * Reporte de errores con redacción de PII (§2).
 *
 * El filtro está separado del SDK a propósito: la regla —qué no puede salir del proceso— es
 * del proyecto, no de la herramienta, y escrita aquí se prueba sin red y sigue valiendo el
 * día que Sentry se cambie por otra cosa.
 *
 * `beforeSend` es lo único que separa un panel de errores útil de una segunda copia de las
 * consultas jurídicas alojada fuera del país. Por eso el arranque **no** llama a
 * `Sentry.init` por su cuenta en ningún otro sitio: se pasa por aquí o no se reporta.
 */
import * as Sentry from '@sentry/node';
import { redactar } from './redaccion.ts';

export function filtrarEvento<T extends object>(evento: T): T {
  return redactar(evento);
}

export interface OpcionesErrores {
  dsn?: string | undefined;
  entorno: string;
  registro: { info(datos: object, mensaje: string): void };
}

/** Devuelve `true` si quedó activo. Sin DSN no es un fallo: es un despliegue sin Sentry. */
export function iniciarReporteErrores(opciones: OpcionesErrores): boolean {
  if (opciones.dsn === undefined || opciones.dsn === '') {
    opciones.registro.info({}, 'sin SENTRY_DSN: los errores solo van al log');
    return false;
  }

  Sentry.init({
    dsn: opciones.dsn,
    environment: opciones.entorno,
    /**
     * `sendDefaultPii` en falso **y** el filtro: la opción sola no basta, porque la PII de
     * este sistema no viaja en las cabeceras que Sentry conoce, sino dentro del mensaje de
     * un error de Drizzle.
     */
    sendDefaultPii: false,
    // Tres abogados no generan volumen: no hace falta muestrear, y un error perdido es un
    // error que nadie arregla.
    tracesSampleRate: 0,
    beforeSend: (evento) => filtrarEvento(evento),
    beforeSendTransaction: (transaccion) => filtrarEvento(transaccion),
  });

  return true;
}
