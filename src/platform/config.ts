import { z } from 'zod';

const Esquema = z.object({
  DATABASE_URL: z.string().min(1),
  DATABASE_URL_OWNER: z.string().min(1).optional(),
  CLAVE_CIFRADO_HEX: z.string().regex(/^[0-9a-fA-F]{64}$/, 'Deben ser 32 bytes en hexadecimal'),
  WA_VERIFY_TOKEN: z.string().min(1).optional(),
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
