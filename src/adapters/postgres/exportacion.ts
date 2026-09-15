/**
 * El expediente completo de un contacto, para el derecho de acceso y portabilidad.
 *
 * Todo en una transacción: un export cuyas cuatro consultas vean instantes distintos puede
 * entregar una cita cuya conversación no aparece, y explicar eso a un titular de datos es
 * peor que tardar unos milisegundos más.
 */
import { sql } from 'drizzle-orm';
import type {
  ExpedienteContacto,
  RepoExportacion,
} from '../../app/puertos/RepoExportacion.ts';
import type { BaseDatos } from './db.ts';
import { enTenant } from './tenantContext.ts';
import { aInstante, aInstanteOpcional } from './tipos.ts';

const iso = (valor: unknown): string => aInstante(valor).toISOString();
const isoOpcional = (valor: unknown): string | null => aInstanteOpcional(valor)?.toISOString() ?? null;

export function crearRepoExportacion(db: BaseDatos): RepoExportacion {
  return {
    async expedienteDe(tenantId, contactoId) {
      return enTenant(db, tenantId, async (tx) => {
        const { rows: contactos } = await tx.execute<Record<string, unknown>>(sql`
          SELECT id, wa_id, nombre, email, cedula, consent_at, consent_version,
                 consent_revocado_at, anonimizado_at, created_at
            FROM contactos
           WHERE tenant_id = ${tenantId}::uuid AND id = ${contactoId}::uuid
        `);
        const contacto = contactos[0];
        if (contacto === undefined) return null;

        const { rows: conversaciones } = await tx.execute<Record<string, unknown>>(sql`
          SELECT id, estado, derivada_at, created_at FROM conversaciones
           WHERE tenant_id = ${tenantId}::uuid AND contacto_id = ${contactoId}::uuid
           ORDER BY created_at
        `);

        /**
         * `wa_message_id` no sale: es un identificador de Meta, no un dato del titular, y
         * entregarlo solo serviría para correlacionar su expediente con los sistemas de un
         * tercero.
         */
        const { rows: mensajes } = await tx.execute<Record<string, unknown>>(sql`
          SELECT m.conversacion_id, m.direccion, m.tipo, m.payload, m.created_at
            FROM mensajes m
            JOIN conversaciones c ON c.tenant_id = m.tenant_id AND c.id = m.conversacion_id
           WHERE m.tenant_id = ${tenantId}::uuid AND c.contacto_id = ${contactoId}::uuid
           ORDER BY m.created_at
        `);

        const { rows: citas } = await tx.execute<Record<string, unknown>>(sql`
          SELECT id, materia, modalidad, inicia_at, termina_at, estado, honorario_usd,
                 cancelada_por, cancelada_at, created_at
            FROM citas
           WHERE tenant_id = ${tenantId}::uuid AND contacto_id = ${contactoId}::uuid
           ORDER BY inicia_at
        `);

        return {
          generadoAt: new Date().toISOString(),
          contacto: {
            id: String(contacto['id']),
            waId: String(contacto['wa_id']),
            nombre: contacto['nombre'] === null ? null : String(contacto['nombre']),
            email: contacto['email'] === null ? null : String(contacto['email']),
            cedula: contacto['cedula'] === null ? null : String(contacto['cedula']),
            consentAt: isoOpcional(contacto['consent_at']),
            consentVersion:
              contacto['consent_version'] === null ? null : String(contacto['consent_version']),
            consentRevocadoAt: isoOpcional(contacto['consent_revocado_at']),
            anonimizadoAt: isoOpcional(contacto['anonimizado_at']),
            createdAt: iso(contacto['created_at']),
          },
          conversaciones: conversaciones.map((r) => ({
            id: String(r['id']),
            estado: String(r['estado']),
            derivadaAt: isoOpcional(r['derivada_at']),
            createdAt: iso(r['created_at']),
          })),
          mensajes: mensajes.map((r) => ({
            conversacionId: String(r['conversacion_id']),
            direccion: String(r['direccion']),
            tipo: String(r['tipo']),
            payload: r['payload'],
            createdAt: iso(r['created_at']),
          })),
          citas: citas.map((r) => ({
            id: String(r['id']),
            materia: String(r['materia']),
            modalidad: String(r['modalidad']),
            iniciaAt: iso(r['inicia_at']),
            terminaAt: iso(r['termina_at']),
            estado: String(r['estado']),
            honorarioUsd: String(r['honorario_usd']),
            canceladaPor: r['cancelada_por'] === null ? null : String(r['cancelada_por']),
            canceladaAt: isoOpcional(r['cancelada_at']),
            createdAt: iso(r['created_at']),
          })),
        } satisfies ExpedienteContacto;
      });
    },
  };
}
