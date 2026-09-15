import { sql } from 'drizzle-orm';
import { z } from 'zod';
import type { BaseDatos } from './db.ts';

const Uuid = z.uuid();

export type Tx = Parameters<Parameters<BaseDatos['transaction']>[0]>[0];

export class TenantInvalidoError extends Error {
  constructor(motivo: string) {
    super(motivo);
    // El `name` no es cosmético: el mensaje se redacta antes de llegar al log —puede traer
    // los parámetros de una consulta— y esto es lo único que sobrevive para saber qué pasó.
    this.name = 'TenantInvalidoError';
  }
}

/**
 * Única puerta de entrada a la base de datos. Abre una transacción, fija el tenant y
 * ejecuta el trabajo dentro.
 *
 * Dos detalles que el plan traía mal y que aquí importan:
 *
 *  1. `SET LOCAL app.tenant_id = $1` NO existe: `SET` no admite parámetros enlazados, así
 *     que la versión del plan fallaba con un error de sintaxis. La forma parametrizable es
 *     `set_config(nombre, valor, true)`, donde ese tercer argumento es lo que la hace
 *     local a la transacción. Concatenar el uuid en el texto de la sentencia sería la otra
 *     salida, y es una inyección esperando a que alguien pase algo que no sea un uuid.
 *  2. `SET` a secas (no local) sobrevive a la transacción y, con pool de conexiones, se
 *     filtra a la petición siguiente: el despacho B leyendo con el tenant de A.
 */
export async function enTenant<T>(
  db: BaseDatos,
  tenantId: string,
  trabajo: (tx: Tx) => Promise<T>,
): Promise<T> {
  if (!Uuid.safeParse(tenantId).success) {
    throw new TenantInvalidoError('El identificador de tenant no es un uuid');
  }
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT set_config('app.tenant_id', ${tenantId}, true)`);
    return trabajo(tx);
  });
}

/**
 * Transacción sin tenant fijado, para lo poco que es legítimamente global: resolver el
 * despacho a partir del `wa_phone_number_id` que llega en el webhook y recorrer la lista
 * de despachos activos en los jobs programados. Solo alcanza a `tenants`, porque el resto
 * de tablas devuelve cero filas sin `app.tenant_id`.
 */
export async function sinTenant<T>(db: BaseDatos, trabajo: (tx: Tx) => Promise<T>): Promise<T> {
  return db.transaction(trabajo);
}
