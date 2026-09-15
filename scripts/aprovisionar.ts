/**
 * Aprovisiona una base de datos para Providencia: los tres roles de §4.3, la propiedad del
 * esquema y la casa de pg-boss.
 *
 * Es el paso previo a las migraciones y corre como **superusuario**. Existe una sola vez y
 * lo usan los tres caminos —el Postgres del compose, el de CI y un clúster local— porque
 * dos implementaciones del mismo aprovisionamiento acaban divergiendo, y la que diverge es
 * siempre la que no se ejecuta a diario.
 *
 * Es idempotente: se puede correr sobre una base ya aprovisionada sin romper nada.
 *
 * Lo que NO hace es crear tablas. Eso es `db:migrate`, como `app_owner`. La aplicación
 * nunca es dueña de nada, porque si lo fuera las políticas de RLS se ignorarían en silencio.
 */
import pg from 'pg';

const PASSWORDS = {
  app_owner: process.env.APP_OWNER_PASSWORD,
  app_user: process.env.APP_USER_PASSWORD,
  app_dump: process.env.APP_DUMP_PASSWORD,
};

/** `app_dump` necesita BYPASSRLS o `pg_dump` exporta cero filas (§4.3). */
const ATRIBUTOS: Record<string, string> = { app_dump: 'BYPASSRLS' };

function urlDeMantenimiento(url: string): { mantenimiento: string; baseDatos: string } {
  const partes = new URL(url);
  const baseDatos = decodeURIComponent(partes.pathname.replace(/^\//, ''));
  if (baseDatos === '') throw new Error('DATABASE_URL_SUPERUSER debe incluir el nombre de la base');
  partes.pathname = '/postgres';
  return { mantenimiento: partes.toString(), baseDatos };
}

async function conCliente<T>(url: string, trabajo: (c: pg.Client) => Promise<T>): Promise<T> {
  const cliente = new pg.Client({ connectionString: url });
  await cliente.connect();
  try {
    return await trabajo(cliente);
  } finally {
    await cliente.end();
  }
}

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL_SUPERUSER;
  if (url === undefined) throw new Error('Falta DATABASE_URL_SUPERUSER (rol superusuario)');

  const faltantes = Object.entries(PASSWORDS)
    .filter(([, valor]) => valor === undefined || valor === '')
    .map(([rol]) => `${rol.toUpperCase()}_PASSWORD`);
  if (faltantes.length > 0) throw new Error(`Faltan contraseñas: ${faltantes.join(', ')}`);

  const { mantenimiento, baseDatos } = urlDeMantenimiento(url);

  await conCliente(mantenimiento, async (cliente) => {
    for (const [rol, password] of Object.entries(PASSWORDS)) {
      // CREATE ROLE no admite IF NOT EXISTS; y la contraseña se fija siempre, para que
      // rotarla sea volver a correr esto.
      await cliente.query(`
        DO $$
        BEGIN
          IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${rol}') THEN
            CREATE ROLE ${cliente.escapeIdentifier(rol)} LOGIN ${ATRIBUTOS[rol] ?? ''};
          END IF;
        END
        $$;
      `);
      /**
       * `ALTER ROLE ... PASSWORD $1` **no existe**: como `SET`, esta sentencia no admite
       * parámetros enlazados. La contraseña se escapa con `escapeLiteral`, que es lo que
       * hay que usar, y no concatenando comillas a mano —una contraseña con un apóstrofo
       * convertiría eso en una inyección—.
       */
      await cliente.query(
        `ALTER ROLE ${cliente.escapeIdentifier(rol)} WITH LOGIN PASSWORD ${cliente.escapeLiteral(password!)}`,
      );
    }

    // CREATE DATABASE no puede ir dentro de una transacción ni admite IF NOT EXISTS.
    const existe = await cliente.query('SELECT 1 FROM pg_database WHERE datname = $1', [baseDatos]);
    if (existe.rowCount === 0) {
      await cliente.query(`CREATE DATABASE ${cliente.escapeIdentifier(baseDatos)} OWNER app_owner`);
    } else {
      await cliente.query(`ALTER DATABASE ${cliente.escapeIdentifier(baseDatos)} OWNER TO app_owner`);
    }
    await cliente.query(
      `GRANT CONNECT ON DATABASE ${cliente.escapeIdentifier(baseDatos)} TO app_user, app_dump`,
    );
  });

  await conCliente(url, async (cliente) => {
    await cliente.query('ALTER SCHEMA public OWNER TO app_owner');

    /**
     * Casa de pg-boss. Pertenece a app_user porque la cola gestiona sus propias tablas: las
     * crea, las migra y las particiona. No rompe el principio de que la aplicación no es
     * dueña de nada, porque aquí no hay datos de despachos —los trabajos no llevan
     * `tenant_id` ni RLS— y la alternativa, dar CREATE sobre la base a app_user, es mucho
     * peor. Va aquí y no en una migración porque ceder la propiedad exige poder hacer
     * SET ROLE al destino, y app_owner no es miembro de app_user a propósito.
     */
    await cliente.query('CREATE SCHEMA IF NOT EXISTS pgboss AUTHORIZATION app_user');
  });

  process.stdout.write(`aprovisionada ${baseDatos}\n`);
}

await main();
