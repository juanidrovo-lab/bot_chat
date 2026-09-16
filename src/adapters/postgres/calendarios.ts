/**
 * Los calendarios conectados de cada abogado.
 *
 * El `state` de OAuth se guarda en `retos`, que ya es la tabla de retos de un solo uso con
 * caducidad y bajo RLS: no hacía falta otra con las mismas reglas y las mismas formas de
 * equivocarse.
 */
import { sql } from 'drizzle-orm';
import type {
  AbogadoConCalendario,
  RepoCalendarios,
  StateConsumido,
} from '../../app/puertos/RepoCalendarios.ts';
import type { BaseDatos } from './db.ts';
import { enTenant } from './tenantContext.ts';

const aAbogado = (r: Record<string, unknown>): AbogadoConCalendario => ({
  id: String(r['id']),
  nombre: String(r['nombre']),
  calendarId: r['gcal_calendar_id'] === null ? null : String(r['gcal_calendar_id']),
});

export function crearRepoCalendarios(db: BaseDatos): RepoCalendarios {
  return {
    async listar(tenantId) {
      const { rows } = await enTenant(db, tenantId, (tx) =>
        tx.execute<Record<string, unknown>>(sql`
          SELECT id, nombre, gcal_calendar_id FROM abogados
           WHERE tenant_id = ${tenantId}::uuid AND activo
           ORDER BY nombre
        `),
      );
      return rows.map(aAbogado);
    },

    async abogado(tenantId, abogadoId) {
      const { rows } = await enTenant(db, tenantId, (tx) =>
        tx.execute<Record<string, unknown>>(sql`
          SELECT id, nombre, gcal_calendar_id FROM abogados
           WHERE tenant_id = ${tenantId}::uuid AND id = ${abogadoId}::uuid AND activo
        `),
      );
      const fila = rows[0];
      return fila === undefined ? null : aAbogado(fila);
    },

    async guardarState(tenantId, state, abogadoId, expiraAt) {
      await enTenant(db, tenantId, (tx) =>
        tx.execute(sql`
          INSERT INTO retos (tenant_id, reto, proposito, datos, expira_at)
          VALUES (${tenantId}::uuid, ${state}, 'google'::proposito_reto,
                  ${JSON.stringify({ abogadoId })}::jsonb, ${expiraAt})
        `),
      );
    },

    async consumirState(tenantId, state) {
      // Leer y borrar en la misma sentencia: en dos, la ventana intermedia permite
      // responder dos veces al mismo `state`.
      const { rows } = await enTenant(db, tenantId, (tx) =>
        tx.execute<{ datos: { abogadoId?: string } }>(sql`
          DELETE FROM retos
           WHERE tenant_id = ${tenantId}::uuid AND reto = ${state}
             AND proposito = 'google'::proposito_reto AND expira_at > now()
          RETURNING datos
        `),
      );
      const abogadoId = rows[0]?.datos.abogadoId;
      return abogadoId === undefined ? null : ({ abogadoId } satisfies StateConsumido);
    },

    async guardarCalendario(tenantId, abogadoId, calendarId, refreshTokenCifrado) {
      await enTenant(db, tenantId, (tx) =>
        tx.execute(sql`
          UPDATE abogados
             SET gcal_calendar_id = ${calendarId},
                 gcal_refresh_token_enc = ${refreshTokenCifrado},
                 updated_at = now()
           WHERE tenant_id = ${tenantId}::uuid AND id = ${abogadoId}::uuid
        `),
      );
    },

    async olvidarCalendario(tenantId, abogadoId) {
      await enTenant(db, tenantId, (tx) =>
        tx.execute(sql`
          UPDATE abogados
             SET gcal_calendar_id = NULL, gcal_refresh_token_enc = NULL, updated_at = now()
           WHERE tenant_id = ${tenantId}::uuid AND id = ${abogadoId}::uuid
        `),
      );
    },
  };
}
