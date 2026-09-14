import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as esquema from './esquema.ts';

export type BaseDatos = ReturnType<typeof crearBaseDatos>;

/**
 * La aplicación se conecta como `app_user`, que no es dueña de las tablas. Si esta
 * conexión usara el rol dueño, las políticas de RLS se ignorarían sin avisar.
 */
export function crearBaseDatos(url: string, maxConexiones = 10) {
  const pool = new pg.Pool({ connectionString: url, max: maxConexiones });
  return Object.assign(drizzle(pool, { schema: esquema, casing: 'snake_case' }), {
    cerrar: () => pool.end(),
  });
}
