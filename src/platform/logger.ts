import { pino } from 'pino';

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

export const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  redact: { paths: CAMPOS_REDACTADOS, censor: '[redactado]' },
});
