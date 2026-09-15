import { sql } from 'drizzle-orm';
import { descifrar } from '../../platform/crypto.ts';
import type { Despachos } from '../../app/puertos/Despachos.ts';
import type { BaseDatos } from './db.ts';
import { enTenant, sinTenant } from './tenantContext.ts';

export interface TenantResuelto {
  id: string;
  slug: string;
  tz: string;
}

/**
 * Resuelve el despacho a partir del `phone_number_id` que viene en el webhook.
 *
 * Es la única consulta legítima sin `app.tenant_id` fijado, y por eso `tenants` no lleva
 * RLS: hay que saber de qué despacho es el mensaje ANTES de poder fijar el tenant y leer
 * su secreto para verificar la firma. Aquí no hay nada sensible: identidad y enrutamiento.
 */
export async function resolverPorPhoneNumberId(
  db: BaseDatos,
  phoneNumberId: string,
): Promise<TenantResuelto | null> {
  const { rows } = await sinTenant(db, (tx) =>
    tx.execute<{ id: string; slug: string; tz: string }>(sql`
      SELECT id, slug, tz FROM tenants
       WHERE wa_phone_number_id = ${phoneNumberId} AND activo
    `),
  );
  return rows[0] ?? null;
}

export interface CredencialesTenant {
  appSecret: string;
  token: string;
  waPhoneNumberId: string;
}

/** Lee y descifra las credenciales del despacho. Ya con el tenant fijado y bajo RLS. */
export async function credencialesDe(
  db: BaseDatos,
  tenantId: string,
  phoneNumberId: string,
  claveHex: string,
): Promise<CredencialesTenant | null> {
  const { rows } = await enTenant(db, tenantId, (tx) =>
    tx.execute<{ wa_token_enc: string; wa_app_secret_enc: string }>(sql`
      SELECT wa_token_enc, wa_app_secret_enc FROM tenant_config WHERE tenant_id = ${tenantId}::uuid
    `),
  );
  const fila = rows[0];
  if (fila === undefined) return null;

  return {
    appSecret: descifrar(fila.wa_app_secret_enc, claveHex),
    token: descifrar(fila.wa_token_enc, claveHex),
    waPhoneNumberId: phoneNumberId,
  };
}

/**
 * Los despachos que los trabajos programados tienen que recorrer.
 *
 * Sin tenant fijado a propósito: es la única lectura que puede hacerse así, y es la que
 * permite que el resto del job sí vaya bajo RLS, despacho por despacho.
 */
export function crearDespachos(db: BaseDatos): Despachos {
  return {
    async activos() {
      const { rows } = await sinTenant(db, (tx) =>
        tx.execute<{ id: string }>(sql`SELECT id FROM tenants WHERE activo ORDER BY id`),
      );
      return rows.map((r) => r.id);
    },
  };
}
