/**
 * Redacción de datos personales antes de que un error salga del proceso.
 *
 * pino ya redacta por rutas (`logger.ts`), pero un evento de Sentry no es un objeto de log:
 * trae `request`, `contexts`, `extra`, `breadcrumbs` y un mensaje de excepción que puede
 * arrastrar el texto de una consulta jurídica dentro de un `Failed query: ... params: ...`
 * de Drizzle. Recorrer el evento entero y podar por nombre de clave es lo único que cubre
 * los sitios que nadie previó.
 *
 * Es una función pura a propósito: así se prueba sin Sentry, y así la regla —qué se borra—
 * deja de depender de que alguien configure bien el SDK.
 */
export const CENSURA = '[redactado]';

/** Claves cuyo valor nunca sale, sea cual sea su lugar en el árbol. */
export const CLAVES_PROHIBIDAS: readonly string[] = [
  'payload',
  'nombre',
  'email',
  'cedula',
  'telefono',
  'wa_id',
  'waid',
  'authorization',
  'cookie',
  'token',
  'password',
  'secret',
  'wa_token_enc',
  'wa_app_secret_enc',
  'gcal_refresh_token_enc',
  'clave_cifrado_hex',
  'x-hub-signature-256',
];

const PROHIBIDAS = new Set(CLAVES_PROHIBIDAS);

/**
 * Los parámetros de una consulta fallida de node-postgres. Drizzle los pega al mensaje del
 * error, así que el texto de un mensaje de WhatsApp puede acabar en un `Error.message` sin
 * que ninguna clave se llame `payload`.
 */
const PARAMS_DE_CONSULTA = /(\nparams:\s)[\s\S]*$/;

export function redactarTexto(texto: string): string {
  return texto.replace(PARAMS_DE_CONSULTA, `$1${CENSURA}`);
}

/** Profundidad máxima. Un evento de Sentry con ciclos no puede colgar el `beforeSend`. */
const PROFUNDIDAD_MAXIMA = 12;

export function redactar<T>(valor: T): T {
  return podar(valor, 0, new WeakSet()) as T;
}

function podar(valor: unknown, nivel: number, vistos: WeakSet<object>): unknown {
  if (typeof valor === 'string') return redactarTexto(valor);
  if (valor === null || typeof valor !== 'object') return valor;
  if (nivel >= PROFUNDIDAD_MAXIMA) return CENSURA;

  // Un evento puede traer referencias circulares: sin esto, `beforeSend` no vuelve.
  if (vistos.has(valor)) return CENSURA;
  vistos.add(valor);

  if (Array.isArray(valor)) return valor.map((v) => podar(v, nivel + 1, vistos));

  const salida: Record<string, unknown> = {};
  for (const [clave, v] of Object.entries(valor as Record<string, unknown>)) {
    salida[clave] = PROHIBIDAS.has(clave.toLowerCase()) ? CENSURA : podar(v, nivel + 1, vistos);
  }
  return salida;
}
