import { sql } from 'drizzle-orm';
import type { RepoConversaciones } from '../../app/puertos/RepoConversaciones.ts';
import type { BaseDatos } from './db.ts';
import { bloquearConversacion } from './inbox.ts';
import { enTenant } from './tenantContext.ts';

export function crearRepoConversaciones(db: BaseDatos): RepoConversaciones {
  return {
    async enConversacionBloqueada(tenantId, conversacionId, trabajo) {
      return enTenant(db, tenantId, async (tx) => {
        // `FOR UPDATE`: desde aquí y hasta el COMMIT, ningún otro trabajador toca esta
        // conversación. La cola ya ordena por clave, pero dos procesos solapados durante
        // un despliegue no comparten esa garantía.
        const conversacion = await bloquearConversacion(tx, conversacionId);
        if (conversacion === null) return null;

        return trabajo({
          conversacion,
          async registrarEvento(tipo, payload) {
            await tx.execute(sql`
              INSERT INTO eventos (tenant_id, actor, tipo, entidad, entidad_id, payload)
              VALUES (${tenantId}::uuid, 'bot', ${tipo}, 'conversacion', ${conversacionId},
                      ${JSON.stringify(payload)}::jsonb)
            `);
          },
        });
      });
    },
  };
}
