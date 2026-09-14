import { sql } from 'drizzle-orm';
import pg from 'pg';
import { crearBaseDatos, type BaseDatos } from '../../src/adapters/postgres/db.ts';
import { cifrar } from '../../src/platform/crypto.ts';
import { enTenant } from '../../src/adapters/postgres/tenantContext.ts';

export function urlApp(): string {
  const url = process.env.DATABASE_URL;
  if (url === undefined) throw new Error('Falta DATABASE_URL: corre con `npm run test:integration`');
  return url;
}

export function urlOwner(): string {
  const url = process.env.DATABASE_URL_OWNER;
  if (url === undefined) throw new Error('Falta DATABASE_URL_OWNER');
  return url;
}

export function urlDump(): string {
  const url = process.env.DATABASE_URL_DUMP;
  if (url === undefined) throw new Error('Falta DATABASE_URL_DUMP');
  return url;
}

export interface Despacho {
  tenantId: string;
  abogadoId: string;
  contactoId: string;
  phoneNumberId: string;
}

/** Clave AES de pruebas. 32 bytes en hexadecimal. */
export const CLAVE_HEX = 'a'.repeat(64);
export const APP_SECRET = 'app-secret-del-despacho';
export const WA_TOKEN = 'token-de-whatsapp';

/**
 * Da de alta un despacho con un abogado y un contacto.
 *
 * Corre como `app_owner` porque `tenants` es de solo lectura para la aplicación, pero
 * incluso así tiene que fijar `app.tenant_id`: con FORCE ROW LEVEL SECURITY el dueño de
 * las tablas también queda sujeto a la política.
 */
export async function sembrarDespacho(slug: string): Promise<Despacho> {
  const cliente = new pg.Client({ connectionString: urlOwner() });
  await cliente.connect();
  try {
    const { rows } = await cliente.query<{ id: string }>(
      `INSERT INTO tenants (slug, nombre, wa_phone_number_id)
       VALUES ($1, $2, $3) RETURNING id`,
      [slug, `Estudio ${slug}`, `phone-${slug}`],
    );
    const tenantId = rows[0]!.id;

    await cliente.query('BEGIN');
    await cliente.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantId]);
    await cliente.query(
      `INSERT INTO tenant_config (tenant_id, wa_waba_id, wa_token_enc, wa_app_secret_enc)
       VALUES ($1, 'waba', $2, $3)`,
      [tenantId, cifrar(WA_TOKEN, CLAVE_HEX), cifrar(APP_SECRET, CLAVE_HEX)],
    );
    const abogado = await cliente.query<{ id: string }>(
      `INSERT INTO abogados (tenant_id, nombre, materias)
       VALUES ($1, 'Abg. Prueba', ARRAY['laboral']) RETURNING id`,
      [tenantId],
    );
    const contacto = await cliente.query<{ id: string }>(
      `INSERT INTO contactos (tenant_id, wa_id, nombre)
       VALUES ($1, '593990000000', 'Contacto Prueba') RETURNING id`,
      [tenantId],
    );
    await cliente.query('COMMIT');

    return {
      tenantId,
      abogadoId: abogado.rows[0]!.id,
      contactoId: contacto.rows[0]!.id,
      phoneNumberId: `phone-${slug}`,
    };
  } finally {
    await cliente.end();
  }
}

/** Un contacto adicional dentro del mismo despacho. */
export async function sembrarContacto(db: BaseDatos, tenantId: string, waId: string): Promise<string> {
  return enTenant(db, tenantId, async (tx) => {
    const { rows } = await tx.execute<{ id: string }>(sql`
      INSERT INTO contactos (tenant_id, wa_id) VALUES (${tenantId}::uuid, ${waId}) RETURNING id
    `);
    return rows[0]!.id;
  });
}

export function abrirApp(): BaseDatos {
  return crearBaseDatos(urlApp());
}

/** Borra los datos de prueba dejando el esquema en pie. */
export async function limpiar(): Promise<void> {
  const cliente = new pg.Client({ connectionString: urlOwner() });
  await cliente.connect();
  try {
    // El borrado en cascada desde `tenants` arrastra todo lo demás.
    await cliente.query('DELETE FROM tenants');
  } finally {
    await cliente.end();
  }
}

/**
 * Texto de todos los errores de la cadena de causas.
 *
 * Drizzle envuelve los fallos de Postgres, así que el motivo real («new row violates
 * row-level security policy», «permission denied for table») está en `cause` y no en el
 * mensaje de arriba.
 */
export function mensajeCompleto(error: unknown): string {
  const partes: string[] = [];
  for (let actual: unknown = error; actual !== undefined && actual !== null; ) {
    const e = actual as { message?: string; cause?: unknown };
    if (typeof e.message === 'string') partes.push(e.message);
    actual = e.cause;
  }
  return partes.join(' | ');
}
