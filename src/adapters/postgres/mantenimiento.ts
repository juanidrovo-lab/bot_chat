import { sql } from 'drizzle-orm';
import type { RepoMantenimiento } from '../../app/puertos/RepoMantenimiento.ts';
import type { CitaRecordable, RepoRecordatorios } from '../../app/enviarRecordatorios.ts';
import type { BaseDatos } from './db.ts';
import { enTenant } from './tenantContext.ts';

export function crearRepoMantenimiento(db: BaseDatos): RepoMantenimiento {
  return {
    async borrarMensajesAntiguos(tenantId, antesDeMs) {
      const { rowCount } = await enTenant(db, tenantId, (tx) =>
        tx.execute(sql`
          DELETE FROM mensajes
           WHERE tenant_id = ${tenantId}::uuid AND created_at < ${new Date(antesDeMs)}
        `),
      );
      return rowCount ?? 0;
    },

    async anonimizarContactosInactivos(tenantId, antesDeMs) {
      const { rowCount } = await enTenant(db, tenantId, (tx) =>
        tx.execute(sql`
          UPDATE contactos c
             SET nombre = NULL, email = NULL, cedula = NULL,
                 anonimizado_at = now(), updated_at = now()
           WHERE c.tenant_id = ${tenantId}::uuid
             AND c.anonimizado_at IS NULL
             AND COALESCE(c.ultimo_inbound_at, c.created_at) < ${new Date(antesDeMs)}
             -- Nunca a quien tiene una cita por delante: se presentaría y el estudio no
             -- sabría quién es.
             AND NOT EXISTS (
               SELECT 1 FROM citas t
                WHERE t.tenant_id = c.tenant_id AND t.contacto_id = c.id
                  AND t.estado IN ('reservada', 'confirmada')
             )
        `),
      );
      return rowCount ?? 0;
    },

    async audiosParaRefrescar(tenantId, antesDeMs) {
      const { rows } = await enTenant(db, tenantId, (tx) =>
        tx.execute<{ clave: string }>(sql`
          SELECT clave FROM audios
           WHERE tenant_id = ${tenantId}::uuid
             AND (wa_media_id IS NULL OR subido_at IS NULL OR subido_at < ${new Date(antesDeMs)})
           ORDER BY clave
        `),
      );
      return rows.map((r) => r.clave);
    },
  };
}

export function crearRepoRecordatorios(db: BaseDatos): RepoRecordatorios {
  return {
    async citasEntre(tenantId, desdeMs, hastaMs) {
      const { rows } = await enTenant(db, tenantId, (tx) =>
        tx.execute<{ id: string }>(sql`
          SELECT id FROM citas
           WHERE tenant_id = ${tenantId}::uuid
             AND estado IN ('reservada', 'confirmada')
             AND inicia_at >= ${new Date(desdeMs)} AND inicia_at < ${new Date(hastaMs)}
           ORDER BY inicia_at
        `),
      );
      return rows.map<CitaRecordable>((r) => ({ id: r.id }));
    },
  };
}
