import { sql } from 'drizzle-orm';
import type { ConversacionBloqueada } from '../../app/puertos/RepoConversaciones.ts';
import type { Tx } from './tenantContext.ts';

export interface EntranteInput {
  tenantId: string;
  waId: string;
  waMessageId: string;
  tipo: string;
  payload: unknown;
  flowVersion: number;
}

export interface EntranteRegistrado {
  contactoId: string;
  conversacionId: string;
  /** true si este `wa_message_id` ya estaba: Meta reintentó y no hay que encolar de nuevo. */
  duplicado: boolean;
}

/** Ventana de servicio de WhatsApp: 24 horas desde el último mensaje del usuario. */
export const VENTANA_HORAS = 24;

/**
 * Registra un mensaje entrante y dice si es nuevo. Tres sentencias en una transacción.
 *
 * El orden no es negociable y tampoco es gratis: deduplicar «antes de encolar» exige
 * conocer la conversación, porque `mensajes.conversacion_id` es obligatorio y porque el
 * `singletonKey` de la cola es precisamente ese id. No es un round-trip, son tres; siguen
 * cabiendo de sobra en el presupuesto de un segundo del webhook.
 *
 * Lo que NO se hace aquí es bloquear la fila de conversación: ese `SELECT ... FOR UPDATE`
 * pertenece al trabajador (§D10). Tomarlo en el webhook serializaría el propio webhook y
 * es justo lo que no puede pasar.
 *
 * Tampoco se renueva `expira_at`. Renovarlo aquí hacía que el trabajador nunca pudiera ver
 * la ventana vencida —la acababa de refrescar el propio webhook— y `SESION_EXPIRADA` no
 * llegaba a dispararse jamás. La ventana la lee y la renueva el trabajador, ya con la fila
 * bloqueada y después de haber decidido si expiró.
 */
export async function registrarEntrante(
  tx: Tx,
  input: EntranteInput,
): Promise<EntranteRegistrado> {
  const contacto = await tx.execute<{ id: string }>(sql`
    INSERT INTO contactos (tenant_id, wa_id, ultimo_inbound_at)
    VALUES (${input.tenantId}::uuid, ${input.waId}, now())
    ON CONFLICT (tenant_id, wa_id)
    DO UPDATE SET ultimo_inbound_at = now(), updated_at = now()
    RETURNING id
  `);
  const contactoId = contacto.rows[0]!.id;

  /**
   * `ON CONFLICT` sobre el índice parcial de conversación abierta: si ya hay una, se toca
   * y se devuelve; si no, se crea. Sin ese índice, dos mensajes simultáneos de un usuario
   * nuevo abrirían dos conversaciones y la serialización por `singletonKey` dejaría de
   * serializar nada.
   */
  const conversacion = await tx.execute<{ id: string }>(sql`
    INSERT INTO conversaciones (tenant_id, contacto_id, estado, flow_version, ultimo_inbound_at, expira_at)
    VALUES (${input.tenantId}::uuid, ${contactoId}::uuid, 'INICIO', ${input.flowVersion},
            now(), now() + ${`${VENTANA_HORAS} hours`}::interval)
    ON CONFLICT (tenant_id, contacto_id) WHERE cerrada_at IS NULL
    DO UPDATE SET ultimo_inbound_at = now(), updated_at = now()
    RETURNING id
  `);
  const conversacionId = conversacion.rows[0]!.id;

  // Patrón inbox. El índice está acotado por tenant: uno global se evaluaría por debajo de
  // la RLS y descartaría como duplicado un mensaje legítimo de otro despacho.
  const mensaje = await tx.execute<{ id: string }>(sql`
    INSERT INTO mensajes (tenant_id, conversacion_id, wa_message_id, direccion, tipo, payload)
    VALUES (${input.tenantId}::uuid, ${conversacionId}::uuid, ${input.waMessageId},
            'entrante', ${input.tipo}, ${JSON.stringify(input.payload)}::jsonb)
    ON CONFLICT (tenant_id, wa_message_id) WHERE wa_message_id IS NOT NULL
    DO NOTHING
    RETURNING id
  `);

  return { contactoId, conversacionId, duplicado: mensaje.rows.length === 0 };
}

/**
 * Toma la fila de conversación en exclusiva. Es lo primero que hace el trabajador (§D10):
 * aunque la cola ya ordena por clave, dos procesos solapados durante un despliegue no
 * comparten esa garantía. El bloqueo sí.
 */
/**
 * Toma la conversación bloqueada para el turno.
 *
 * El modo es `FOR NO KEY UPDATE` y **no** `FOR UPDATE`. El bloqueo fuerte también excluye
 * el `KEY SHARE` que Postgres toma sobre la fila padre al comprobar una clave ajena, así
 * que cualquier INSERT en `mensajes` desde otra transacción —el rastro de un mensaje
 * saliente, por ejemplo— se quedaría esperando al COMMIT del turno, y el turno esperando a
 * que ese INSERT termine. Este modo sigue excluyendo a otro trabajador, que es lo único que
 * hacía falta: dos `FOR NO KEY UPDATE` sí chocan entre sí, y nadie cambia la clave primaria
 * de una conversación.
 *
 * (El comentario va aquí y no dentro de la plantilla porque un backtick dentro de un
 * literal de SQL cierra el literal de JavaScript, aunque esté en un comentario SQL.)
 */
export async function bloquearConversacion(
  tx: Tx,
  conversacionId: string,
): Promise<ConversacionBloqueada | null> {
  const { rows } = await tx.execute<{
    id: string;
    estado: string;
    contexto: unknown;
    flow_version: number;
    fallos_consecutivos: number;
    contacto_id: string;
    wa_id: string;
    derivada: boolean;
    ventana_expirada: boolean;
  }>(sql`
    SELECT c.id, c.estado, c.contexto, c.flow_version, c.fallos_consecutivos,
           c.contacto_id, k.wa_id,
           c.derivada_at IS NOT NULL AS derivada,
           -- La comparacion va en SQL: expira_at llega como string en una consulta cruda,
           -- y ademas el reloj que manda es el de la base, no el de la aplicacion.
           c.expira_at < now() AS ventana_expirada
      FROM conversaciones c
      JOIN contactos k ON k.tenant_id = c.tenant_id AND k.id = c.contacto_id
     WHERE c.id = ${conversacionId}::uuid
       FOR NO KEY UPDATE OF c
  `);

  const fila = rows[0];
  if (fila === undefined) return null;

  return {
    id: fila.id,
    estado: fila.estado,
    contexto: fila.contexto,
    flowVersion: fila.flow_version,
    fallosConsecutivos: fila.fallos_consecutivos,
    contactoId: fila.contacto_id,
    waId: fila.wa_id,
    derivada: fila.derivada,
    ventanaExpirada: fila.ventana_expirada,
  };
}

/**
 * Renueva la ventana de servicio. La llama el trabajador DESPUÉS de haber leído si estaba
 * vencida, nunca el webhook.
 */
export async function renovarVentana(tx: Tx, conversacionId: string): Promise<void> {
  await tx.execute(sql`
    UPDATE conversaciones
       SET expira_at = now() + ${`${VENTANA_HORAS} hours`}::interval, updated_at = now()
     WHERE id = ${conversacionId}::uuid
  `);
}
