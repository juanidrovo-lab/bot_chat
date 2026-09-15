/**
 * Lo que sostiene las dos alertas de negocio de §9 y el rastro de los salientes.
 *
 * El día local se calcula **en SQL**, con la zona del despacho que ya está en `tenants`:
 * agrupar por día en JavaScript metería la deriva entre el reloj del proceso y el de la
 * base justo en la comparación que decide si hoy hubo silencio.
 */
import { sql } from 'drizzle-orm';
import type { EntrantesDelDia, RepoAlertas } from '../../app/puertos/RepoAlertas.ts';
import type { RegistroSalientes } from '../../app/puertos/RegistroSalientes.ts';
import type { BaseDatos } from './db.ts';
import { enTenant } from './tenantContext.ts';

export function crearRegistroSalientes(db: BaseDatos): RegistroSalientes {
  return {
    async anotar(saliente) {
      await enTenant(db, saliente.tenantId, (tx) =>
        tx.execute(sql`
          INSERT INTO mensajes (tenant_id, conversacion_id, wa_message_id, direccion, tipo, payload)
          VALUES (${saliente.tenantId}::uuid, ${saliente.conversacionId}::uuid,
                  ${saliente.waMessageId}, 'saliente', ${saliente.tipo},
                  ${JSON.stringify(
                    saliente.error === null ? { ok: true } : { ok: false, error: saliente.error },
                  )}::jsonb)
        `),
      );
    },
  };
}

export function crearRepoAlertas(db: BaseDatos): RepoAlertas {
  return {
    async enviosRecientes(tenantId, minutos) {
      /**
       * Un saliente sin `wa_message_id` es un envío que no llegó a Meta: el cliente anota
       * el intento igual, justamente para que la tasa de error sea visible.
       */
      const { rows } = await enTenant(db, tenantId, (tx) =>
        tx.execute<{ total: string; fallidos: string }>(sql`
          SELECT count(*)::text AS total,
                 count(*) FILTER (WHERE wa_message_id IS NULL)::text AS fallidos
            FROM mensajes
           WHERE tenant_id = ${tenantId}::uuid AND direccion = 'saliente'
             AND created_at > now() - make_interval(mins => ${minutos})
        `),
      );
      const fila = rows[0];
      return { total: Number(fila?.total ?? 0), fallidos: Number(fila?.fallidos ?? 0) };
    },

    async entrantesPorDia(tenantId, dias) {
      const { rows } = await enTenant(db, tenantId, (tx) =>
        tx.execute<{ dia: string; total: string }>(sql`
          SELECT to_char(m.created_at AT TIME ZONE t.tz, 'YYYY-MM-DD') AS dia,
                 count(*)::text AS total
            FROM mensajes m
            JOIN tenants t ON t.id = m.tenant_id
           WHERE m.tenant_id = ${tenantId}::uuid AND m.direccion = 'entrante'
             AND m.created_at > now() - make_interval(days => ${dias})
           GROUP BY 1
           ORDER BY 1
        `),
      );
      return rows.map<EntrantesDelDia>((r) => ({ dia: r.dia, total: Number(r.total) }));
    },
  };
}
