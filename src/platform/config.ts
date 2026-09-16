import { z } from 'zod';

/**
 * Opcional de verdad: **la cadena vacía cuenta como ausente**.
 *
 * `.optional()` a secas solo admite `undefined`, y en un fichero `.env` nadie escribe eso:
 * se escribe `SENTRY_DSN=` y se deja en blanco, que es como se apunta «esta no la uso» sin
 * borrar la línea que recuerda que existe. Sin esta conversión, el proceso no arranca y el
 * error señala justo las tres variables que el despliegue había decidido no usar.
 */
const opcional = <T extends z.ZodType>(esquema: T) =>
  z.preprocess((valor) => (valor === '' ? undefined : valor), esquema.optional());

const Esquema = z.object({
  DATABASE_URL: z.string().min(1),
  DATABASE_URL_OWNER: opcional(z.string().min(1)),
  CLAVE_CIFRADO_HEX: z.string().regex(/^[0-9a-fA-F]{64}$/, 'Deben ser 32 bytes en hexadecimal'),
  WA_VERIFY_TOKEN: opcional(z.string().min(1)),
  // Opcionales: un despliegue sin Google simplemente no mantiene el espejo de la agenda.
  // La cita se guarda igual, que es lo que importa (D4).
  GOOGLE_CLIENT_ID: opcional(z.string().min(1)),
  GOOGLE_CLIENT_SECRET: opcional(z.string().min(1)),
  /**
   * Origen público del panel, p. ej. `https://panel.estudio.ec`. De aquí salen el `rpId` de
   * WebAuthn y el origen que el navegador firma en `clientDataJSON`: si no coinciden
   * exactamente, ninguna passkey valida.
   */
  PANEL_ORIGEN: opcional(z.url()),
  /** Sin DSN no se reporta nada a nadie: un despliegue sin Sentry es válido. */
  SENTRY_DSN: opcional(z.string().min(1)),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
});

export type Config = z.infer<typeof Esquema>;

export function cargarConfig(entorno: NodeJS.ProcessEnv = process.env): Config {
  const resultado = Esquema.safeParse(entorno);
  if (!resultado.success) {
    // Se enumeran las claves que fallan, nunca sus valores: son secretos.
    const claves = resultado.error.issues.map((i) => i.path.join('.')).join(', ');
    throw new Error(`Configuración inválida en: ${claves}`);
  }
  return resultado.data;
}
