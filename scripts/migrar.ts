/**
 * Aplicador de migraciones. Corre como `app_owner`, nunca como la conexión de la
 * aplicación.
 *
 * Cada archivo se envía entero y en una sola transacción, sin trocearlo por `;`: la
 * migración de RLS usa bloques `DO $$ ... $$` con literales anidados, y cualquier troceo
 * ingenuo los parte por la mitad.
 */
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

// fileURLToPath y no `.pathname`: este último deja los caracteres escapados (%20) tal cual
// y devuelve rutas inválidas si el repo cuelga de un directorio con espacios.
const DIRECTORIO = fileURLToPath(new URL('../drizzle/', import.meta.url));

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL_OWNER;
  if (url === undefined) throw new Error('Falta DATABASE_URL_OWNER (rol app_owner)');

  const cliente = new pg.Client({ connectionString: url });
  await cliente.connect();
  try {
    await cliente.query(`
      CREATE TABLE IF NOT EXISTS _migraciones (
        archivo text PRIMARY KEY,
        aplicada_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    const { rows } = await cliente.query<{ archivo: string }>('SELECT archivo FROM _migraciones');
    const aplicadas = new Set(rows.map((r) => r.archivo));

    const archivos = (await readdir(DIRECTORIO))
      .filter((f) => f.endsWith('.sql'))
      .sort();

    for (const archivo of archivos) {
      if (aplicadas.has(archivo)) continue;
      const sql = await readFile(join(DIRECTORIO, archivo), 'utf8');
      await cliente.query('BEGIN');
      try {
        await cliente.query(sql);
        await cliente.query('INSERT INTO _migraciones (archivo) VALUES ($1)', [archivo]);
        await cliente.query('COMMIT');
        process.stdout.write(`aplicada ${archivo}\n`);
      } catch (error) {
        await cliente.query('ROLLBACK');
        throw new Error(`Falló ${archivo}: ${(error as Error).message}`, { cause: error });
      }
    }
  } finally {
    await cliente.end();
  }
}

await main();
