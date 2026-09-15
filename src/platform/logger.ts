import { pino, stdSerializers } from 'pino';
import { redactarTexto } from './redaccion.ts';

/**
 * Campos que nunca pueden salir en un log. Los mensajes llevan consultas jurídicas: un
 * stack trace con el texto de una consulta de familia es una brecha, no una molestia.
 */
export const CAMPOS_REDACTADOS = [
  'payload',
  'nombre',
  'email',
  'cedula',
  '*.payload',
  '*.nombre',
  '*.email',
  '*.cedula',
  '*.wa_token_enc',
  '*.wa_app_secret_enc',
  '*.gcal_refresh_token_enc',
  'req.headers.authorization',
  'req.headers["x-hub-signature-256"]',
];

/**
 * La redacción por rutas no alcanza al mensaje de un error, y ahí es donde se filtra de
 * verdad: Drizzle pega los parámetros de la consulta al `message`, así que el texto de un
 * mensaje de WhatsApp acaba en el log sin que ninguna clave se llame `payload`.
 */
export const serializarError = (error: Error): Record<string, unknown> => {
  const serializado = stdSerializers.err(error) as Record<string, unknown>;
  if (typeof serializado['message'] === 'string') {
    serializado['message'] = redactarTexto(serializado['message']);
  }
  if (typeof serializado['stack'] === 'string') {
    serializado['stack'] = redactarTexto(serializado['stack']);
  }
  return serializado;
};

export const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  redact: { paths: CAMPOS_REDACTADOS, censor: '[redactado]' },
  serializers: { err: serializarError, error: serializarError },
});
