/**
 * Cifrado de secretos en reposo · AES-256-GCM.
 *
 * Se usa para los tokens de WhatsApp y los refresh token de Google. Nunca para PII de
 * contactos: eso hay que poder buscarlo y borrarlo, y va por retención y anonimización.
 */
import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from 'node:crypto';

const ALGORITMO = 'aes-256-gcm';
const BYTES_IV = 12;
const BYTES_TAG = 16;
const PREFIJO = 'v1.';

export class CifradoInvalidoError extends Error {}

function clave(claveHex: string): Buffer {
  const buf = Buffer.from(claveHex, 'hex');
  if (buf.length !== 32) {
    throw new CifradoInvalidoError('La clave de cifrado debe ser de 32 bytes en hexadecimal');
  }
  return buf;
}

export function cifrar(claro: string, claveHex: string): string {
  const iv = randomBytes(BYTES_IV);
  const cipher = createCipheriv(ALGORITMO, clave(claveHex), iv);
  const datos = Buffer.concat([cipher.update(claro, 'utf8'), cipher.final()]);
  return PREFIJO + Buffer.concat([iv, cipher.getAuthTag(), datos]).toString('base64url');
}

export function descifrar(cifrado: string, claveHex: string): string {
  if (!cifrado.startsWith(PREFIJO)) {
    throw new CifradoInvalidoError('Formato de cifrado desconocido');
  }
  const bruto = Buffer.from(cifrado.slice(PREFIJO.length), 'base64url');
  if (bruto.length < BYTES_IV + BYTES_TAG) {
    throw new CifradoInvalidoError('Texto cifrado truncado');
  }
  const decipher = createDecipheriv(ALGORITMO, clave(claveHex), bruto.subarray(0, BYTES_IV));
  decipher.setAuthTag(bruto.subarray(BYTES_IV, BYTES_IV + BYTES_TAG));
  try {
    return Buffer.concat([
      decipher.update(bruto.subarray(BYTES_IV + BYTES_TAG)),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    throw new CifradoInvalidoError('No se pudo descifrar: clave incorrecta o dato alterado');
  }
}

/**
 * Comparación en tiempo constante para la firma `X-Hub-Signature-256`.
 *
 * `timingSafeEqual` lanza si los búferes tienen longitudes distintas, y esa excepción se
 * convertiría en un 500 donde corresponde un 401. La comprobación de longitud va antes y
 * no filtra nada útil: la longitud de un HMAC-SHA256 es pública.
 */
export function firmaCoincide(esperada: Buffer, recibida: Buffer): boolean {
  if (esperada.length !== recibida.length) return false;
  return timingSafeEqual(esperada, recibida);
}
