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
const VENTANA_HORAS = 24;

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
    DO UPDATE SET ultimo_inbound_at = now(),
                  expira_at = now() + ${`${VENTANA_HORAS} hours`}::interval,
                  updated_at = now()
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
    derivada: boolean;
    ventana_expirada: boolean;
  }>(sql`
    SELECT id, estado, contexto, flow_version, fallos_consecutivos,
           derivada_at IS NOT NULL AS derivada,
           -- La comparacion va en SQL: expira_at llega como string en una consulta cruda,
           -- y ademas el reloj que manda es el de la base, no el de la aplicacion.
           expira_at < now() AS ventana_expirada
      FROM conversaciones
     WHERE id = ${conversacionId}::uuid
       FOR UPDATE
  `);

  const fila = rows[0];
  if (fila === undefined) return null;

  return {
    id: fila.id,
    estado: fila.estado,
    contexto: fila.contexto,
    flowVersion: fila.flow_version,
    fallosConsecutivos: fila.fallos_consecutivos,
    derivada: fila.derivada,
    ventanaExpirada: fila.ventana_expirada,
  };
}
