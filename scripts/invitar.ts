/**
 * Acuña la invitación con la que un usuario del panel registra su primera passkey.
 *
 * Es una tarea administrativa y corre como `app_owner`, como dar de alta un despacho: la
 * aplicación no puede crear usuarios ni repartir invitaciones a sí misma.
 *
 *   node --env-file-if-exists=.env scripts/invitar.ts <slug> <email>
 *
 * Imprime la URL **una sola vez**. En la base queda el hash, igual que con la sesión: quien
 * tenga el testigo puede registrar una credencial, y por eso caduca y se quema al usarlo.
 */
import { createHash, randomBytes } from 'node:crypto';
import pg from 'pg';

/** Una semana: suficiente para que el abogado lo abra sin dejarlo vivo para siempre. */
const DIAS_VIGENCIA = 7;

async function main(): Promise<void> {
  const [slug, email] = process.argv.slice(2);
  if (slug === undefined || email === undefined) {
    throw new Error('Uso: node scripts/invitar.ts <slug> <email>');
  }

  const url = process.env.DATABASE_URL_OWNER;
  if (url === undefined) throw new Error('Falta DATABASE_URL_OWNER (rol app_owner)');

  const origen = process.env.PANEL_ORIGEN;
  if (origen === undefined) throw new Error('Falta PANEL_ORIGEN');

  const cliente = new pg.Client({ connectionString: url });
  await cliente.connect();
  try {
    const { rows: despachos } = await cliente.query<{ id: string }>(
      'SELECT id FROM tenants WHERE slug = $1 AND activo',
      [slug],
    );
    const tenantId = despachos[0]?.id;
    if (tenantId === undefined) throw new Error(`No hay despacho activo con slug «${slug}»`);

    const token = randomBytes(32).toString('base64url');
    const hash = createHash('sha256').update(token).digest('hex');
    const expira = new Date(Date.now() + DIAS_VIGENCIA * 86_400_000);

    /**
     * Con FORCE ROW LEVEL SECURITY el dueño también está sujeto a la política: sin fijar el
     * tenant este UPDATE no tocaría ninguna fila y no avisaría de nada.
     */
    await cliente.query('BEGIN');
    await cliente.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantId]);
    const { rowCount } = await cliente.query(
      `UPDATE usuarios SET invitacion_hash = $2, invitacion_expira_at = $3, updated_at = now()
        WHERE tenant_id = $1 AND email = $4 AND activo`,
      [tenantId, hash, expira, email],
    );
    if (rowCount === 0) {
      await cliente.query('ROLLBACK');
      throw new Error(`No hay usuario activo «${email}» en el despacho «${slug}»`);
    }
    await cliente.query('COMMIT');

    // El testigo solo existe aquí y ahora: en la base queda el hash.
    process.stdout.write(`${origen}/panel/${slug}/alta/${token}\n`);
    process.stdout.write(`Caduca el ${expira.toISOString()}. Entréguelo en mano.\n`);
  } finally {
    await cliente.end();
  }
}

await main();
