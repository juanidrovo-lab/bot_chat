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
        // Bloqueo de fila: desde aquí y hasta el COMMIT, ningún otro trabajador toca esta
        // conversación. La cola ya ordena por clave, pero dos procesos solapados durante
        // un despliegue no comparten esa garantía. Es `FOR NO KEY UPDATE` a propósito;
        // el porqué está en `inbox.ts`.
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

          async registrarConsentimiento(aceptado, version) {
            /**
             * Aceptar sella `consent_at` con la versión que vio; rechazar sella
             * `consent_revocado_at`. No se pisa un consentimiento anterior más nuevo: quien
             * ya aceptó y vuelve a escribir no reinicia su fecha, que es la que prueba
             * desde cuándo.
             */
            await tx.execute(sql`
              UPDATE contactos
                 SET consent_at = CASE
                       WHEN ${aceptado} THEN COALESCE(consent_at, now())
                       ELSE consent_at
                     END,
                     consent_version = CASE
                       WHEN ${aceptado} AND consent_at IS NULL THEN ${version}
                       ELSE consent_version
                     END,
                     consent_revocado_at = CASE
                       WHEN ${aceptado} THEN NULL
                       ELSE COALESCE(consent_revocado_at, now())
                     END,
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
