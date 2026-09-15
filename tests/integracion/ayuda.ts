import { createHash } from 'node:crypto';
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

/** Tarifario de pruebas: dos materias, una con triaje y otra sin él. */
export const TARIFARIO = {
  laboral: {
    titulo: 'Laboral',
    honorarioUsd: '40.00',
    triaje: [
      {
        pregunta: '¿Se trata de un despido o de una liquidación?',
        opciones: [
          { id: 'despido', titulo: 'Despido' },
          { id: 'liquidacion', titulo: 'Liquidación' },
        ],
      },
    ],
  },
  transito: { titulo: 'Tránsito', honorarioUsd: '35.00', triaje: [] },
};

/** Lunes a viernes, 09:00–13:00 y 15:00–18:00 en hora local. */
export const HORARIOS = {
  '1': [{ desde: '09:00', hasta: '13:00' }, { desde: '15:00', hasta: '18:00' }],
  '2': [{ desde: '09:00', hasta: '13:00' }, { desde: '15:00', hasta: '18:00' }],
  '3': [{ desde: '09:00', hasta: '13:00' }, { desde: '15:00', hasta: '18:00' }],
  '4': [{ desde: '09:00', hasta: '13:00' }, { desde: '15:00', hasta: '18:00' }],
  '5': [{ desde: '09:00', hasta: '13:00' }, { desde: '15:00', hasta: '18:00' }],
};

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
      `INSERT INTO tenant_config (tenant_id, wa_waba_id, wa_token_enc, wa_app_secret_enc, tarifario, horarios)
       VALUES ($1, 'waba', $2, $3, $4::jsonb, $5::jsonb)`,
      [
        tenantId,
        cifrar(WA_TOKEN, CLAVE_HEX),
        cifrar(APP_SECRET, CLAVE_HEX),
        JSON.stringify(TARIFARIO),
        JSON.stringify(HORARIOS),
      ],
    );
    const abogado = await cliente.query<{ id: string }>(
      `INSERT INTO abogados (tenant_id, nombre, materias)
       VALUES ($1, 'Abg. Prueba', ARRAY['laboral','transito']) RETURNING id`,
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

/** Segundo abogado del mismo despacho, para probar solapamientos entre agendas. */
export async function sembrarAbogado(
  db: BaseDatos,
  tenantId: string,
  materias: readonly string[],
): Promise<string> {
  return enTenant(db, tenantId, async (tx) => {
    const { rows } = await tx.execute<{ id: string }>(sql`
      INSERT INTO abogados (tenant_id, nombre, materias)
      VALUES (${tenantId}::uuid, 'Abg. Segundo', ${sql.param([...materias])}::text[])
      RETURNING id
    `);
    return rows[0]!.id;
  });
}

/** Bloqueo de agenda, como el que importa el sincronizador de Google. */
export async function sembrarBloqueo(
  db: BaseDatos,
  tenantId: string,
  abogadoId: string,
  inicia: Date,
  termina: Date,
): Promise<void> {
  await enTenant(db, tenantId, (tx) =>
    tx.execute(sql`
      INSERT INTO bloqueos (tenant_id, abogado_id, inicia_at, termina_at, origen, external_id)
      VALUES (${tenantId}::uuid, ${abogadoId}::uuid, ${inicia}, ${termina}, 'gcal', ${'ev-' + inicia.getTime()})
    `),
  );
}

/**
 * Cambia el horario de un despacho. Va por `app_owner` porque `tenant_config` es de solo
 * lectura para la aplicación: configurar un despacho es una tarea administrativa.
 */
export async function configurarHorario(tenantId: string, horarios: unknown): Promise<void> {
  const cliente = new pg.Client({ connectionString: urlOwner() });
  await cliente.connect();
  try {
    // Con FORCE ROW LEVEL SECURITY, app_owner también queda sujeto a la política: sin
    // fijar el tenant este UPDATE no toca ninguna fila y no avisa de nada.
    await cliente.query('BEGIN');
    await cliente.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantId]);
    await cliente.query('UPDATE tenant_config SET horarios = $2::jsonb WHERE tenant_id = $1', [
      tenantId,
      JSON.stringify(horarios),
    ]);
    await cliente.query('COMMIT');
  } finally {
    await cliente.end();
  }
}

/**
 * Usuario del panel. Va por `app_owner` porque dar de alta a alguien es administrativo y la
 * migración le revoca el INSERT a la aplicación — igual que con `tenants` y `tenant_config`.
 */
export async function sembrarUsuario(
  tenantId: string,
  email: string,
  abogadoId: string | null = null,
): Promise<string> {
  const cliente = new pg.Client({ connectionString: urlOwner() });
  await cliente.connect();
  try {
    // Con FORCE ROW LEVEL SECURITY el dueño también queda sujeto: sin fijar el tenant este
    // INSERT fallaría por la política, no por permisos.
    await cliente.query('BEGIN');
    await cliente.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantId]);
    const { rows } = await cliente.query<{ id: string }>(
      `INSERT INTO usuarios (tenant_id, email, nombre, abogado_id)
       VALUES ($1, $2, 'Abg. Panel', $3) RETURNING id`,
      [tenantId, email, abogadoId],
    );
    await cliente.query('COMMIT');
    return rows[0]!.id;
  } finally {
    await cliente.end();
  }
}

/**
 * Acuña una invitación para un usuario del panel, como hace `scripts/invitar.ts`.
 *
 * Por `app_owner` y con el tenant fijado: es una tarea administrativa, y con FORCE RLS el
 * dueño también está sujeto a la política.
 */
export async function sembrarInvitacion(
  tenantId: string,
  usuarioId: string,
  token: string,
  expiraAt: Date = new Date(Date.now() + 7 * 86_400_000),
): Promise<void> {
  const cliente = new pg.Client({ connectionString: urlOwner() });
  await cliente.connect();
  try {
    await cliente.query('BEGIN');
    await cliente.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantId]);
    await cliente.query(
      `UPDATE usuarios SET invitacion_hash = $2, invitacion_expira_at = $3
        WHERE tenant_id = $1 AND id = $4`,
      [tenantId, createHash('sha256').update(token).digest('hex'), expiraAt, usuarioId],
    );
    await cliente.query('COMMIT');
  } finally {
    await cliente.end();
  }
}
