import { sql } from 'drizzle-orm';
import type { RepoConversaciones } from '../../app/puertos/RepoConversaciones.ts';
import { normalizar, MensajeEntrante } from '../whatsapp/esquemas.ts';
import type { BaseDatos } from './db.ts';
import { bloquearConversacion, renovarVentana } from './inbox.ts';
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

          async leerMensaje(waMessageId) {
            const { rows } = await tx.execute<{ payload: unknown }>(sql`
              SELECT payload FROM mensajes
               WHERE tenant_id = ${tenantId}::uuid AND wa_message_id = ${waMessageId}
            `);
            const fila = rows[0];
            if (fila === undefined) return null;
            // El payload se guardó ya validado, pero se revalida al leerlo: una fila vieja
            // pudo escribirse con otra versión del esquema.
            const analizado = MensajeEntrante.safeParse(fila.payload);
            return analizado.success ? normalizar(analizado.data) : null;
          },

          async guardar(estado, contexto, fallosConsecutivos) {
            await tx.execute(sql`
              UPDATE conversaciones
                 SET estado = ${estado},
                     contexto = ${JSON.stringify(contexto)}::jsonb,
                     fallos_consecutivos = ${fallosConsecutivos},
                     updated_at = now()
               WHERE id = ${conversacionId}::uuid
            `);
          },

          async guardarDatosContacto(datos) {
            // `COALESCE` en vez de sobrescribir: si el Flow no trae correo o cédula, no se
            // borra lo que ya hubiera de una cita anterior.
            await tx.execute(sql`
              UPDATE contactos
                 SET nombre = ${datos.nombre},
                     email = COALESCE(${datos.email ?? null}, email),
                     cedula = COALESCE(${datos.cedula ?? null}, cedula),
                     updated_at = now()
               WHERE tenant_id = ${tenantId}::uuid
                 AND id = (SELECT contacto_id FROM conversaciones WHERE id = ${conversacionId}::uuid)
            `);
          },

          async derivar(motivo) {
            await tx.execute(sql`
              UPDATE conversaciones
                 SET derivada_at = now(), derivada_motivo = ${motivo}::motivo_derivacion,
                     updated_at = now()
               WHERE id = ${conversacionId}::uuid AND derivada_at IS NULL
            `);
          },

          async cerrar() {
            await tx.execute(sql`
              UPDATE conversaciones SET cerrada_at = now(), updated_at = now()
               WHERE id = ${conversacionId}::uuid AND cerrada_at IS NULL
            `);
          },

          async renovarVentana() {
            await renovarVentana(tx, conversacionId);
          },

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
