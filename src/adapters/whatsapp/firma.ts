import { createHmac } from 'node:crypto';
import { firmaCoincide } from '../../platform/crypto.ts';

const PREFIJO = 'sha256=';

/**
 * Verifica `X-Hub-Signature-256` contra el **cuerpo crudo**.
 *
 * El cuerpo llega como `Buffer` y no como `string` a propósito: el HMAC es sobre los bytes
 * que Meta envió. Reserializar el JSON, o incluso decodificarlo y volver a codificarlo,
 * cambia el resultado en cuanto hay un carácter no ASCII —y los hay: los mensajes vienen
 * en español—.
 *
 * La comparación es en tiempo constante y con comprobación de longitud previa, porque
 * `timingSafeEqual` lanza si los búferes miden distinto y eso convertiría un 401 en un 500.
 */
export function verificarFirma(
  cuerpoCrudo: Buffer,
  cabecera: string | undefined,
  appSecret: string,
): boolean {
  if (cabecera === undefined || !cabecera.startsWith(PREFIJO)) return false;

  const hex = cabecera.slice(PREFIJO.length);
  // Buffer.from(..., 'hex') trunca en silencio ante un carácter inválido; la comprobación
  // de longitud de `firmaCoincide` lo convierte en un rechazo limpio.
  if (!/^[0-9a-f]+$/i.test(hex)) return false;

  const recibida = Buffer.from(hex, 'hex');
  const esperada = createHmac('sha256', appSecret).update(cuerpoCrudo).digest();
  return firmaCoincide(esperada, recibida);
}
