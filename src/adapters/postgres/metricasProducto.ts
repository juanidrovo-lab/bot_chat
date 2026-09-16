/**
 * Las métricas de §9, leídas de las tablas de negocio.
 *
 * No hay tabla de analítica: sería una segunda copia de los mismos datos, con una segunda
 * forma de quedarse desincronizada. Son cuatro consultas sobre `conversaciones` y `citas`,
 * todas acotadas por `tenant_id` y por fecha, y todas usan índices que ya existen.
 */
import { sql } from 'drizzle-orm';
import type { AbandonoPorEstado, Metricas, RepoMetricas } from '../../app/puertos/RepoMetricas.ts';
import type { BaseDatos } from './db.ts';
import { enTenant } from './tenantContext.ts';

/**
 * Estados en los que una conversación no es un abandono.
 *
 * `CITA_OK` acabó bien, `DERIVADA` se cuenta aparte, y las de cierre son finales
 * deliberados: quien dijo «solo consultaba» no abandonó el flujo, lo terminó.
 */
const NO_ES_ABANDONO = ['CITA_OK', 'DERIVADA', 'CIERRE_SIN_CITA', 'DESPEDIDA'];

export function crearRepoMetricas(db: BaseDatos): RepoMetricas {
  return {
    async resumen(tenantId, desdeMs, hastaMs) {
      const desde = new Date(desdeMs);
      const hasta = new Date(hastaMs);

      return enTenant(db, tenantId, async (tx) => {
        const { rows: conversaciones } = await tx.execute<{
          total: string;
          derivadas: string;
        }>(sql`
          SELECT count(*)::text AS total,
                 count(*) FILTER (WHERE derivada_at IS NOT NULL)::text AS derivadas
            FROM conversaciones
           WHERE tenant_id = ${tenantId}::uuid
             AND created_at >= ${desde} AND created_at < ${hasta}
        `);

        /**
         * Una conversación «con cita» es la que llegó a reservar, aunque después se
         * cancelara: lo que mide es si el guion funciona, no si el cliente cambió de idea.
         */
        const { rows: conCita } = await tx.execute<{ total: string }>(sql`
          SELECT count(DISTINCT cv.id)::text AS total
            FROM conversaciones cv
            JOIN citas t ON t.tenant_id = cv.tenant_id AND t.contacto_id = cv.contacto_id
           WHERE cv.tenant_id = ${tenantId}::uuid
             AND cv.created_at >= ${desde} AND cv.created_at < ${hasta}
             AND t.created_at >= cv.created_at
        `);

        const { rows: abandono } = await tx.execute<{ estado: string; total: string }>(sql`
          SELECT estado, count(*)::text AS total
            FROM conversaciones
           WHERE tenant_id = ${tenantId}::uuid
             AND created_at >= ${desde} AND created_at < ${hasta}
             AND derivada_at IS NULL
             AND estado <> ALL(${sql.param(NO_ES_ABANDONO)}::text[])
           GROUP BY estado
           ORDER BY count(*) DESC, estado
        `);

        /**
         * Solo citas que **ya pasaron**: una de mañana no está sin marcar, está por
         * ocurrir. La comparación va con el reloj de la base, como todas.
         */
        const { rows: citas } = await tx.execute<{
          marcadas: string;
          ausentes: string;
          sin_marcar: string;
        }>(sql`
          SELECT count(*) FILTER (WHERE estado IN ('atendida', 'ausente'))::text AS marcadas,
                 count(*) FILTER (WHERE estado = 'ausente')::text AS ausentes,
                 count(*) FILTER (WHERE estado IN ('reservada', 'confirmada'))::text AS sin_marcar
            FROM citas
           WHERE tenant_id = ${tenantId}::uuid
             AND inicia_at >= ${desde} AND inicia_at < ${hasta}
             AND inicia_at < now()
        `);

        const n = (valor: string | undefined): number => Number(valor ?? 0);

        return {
          conversaciones: n(conversaciones[0]?.total),
          derivadas: n(conversaciones[0]?.derivadas),
          conCita: n(conCita[0]?.total),
          abandono: abandono.map<AbandonoPorEstado>((r) => ({
            estado: r.estado,
            total: Number(r.total),
          })),
          citasMarcadas: n(citas[0]?.marcadas),
          citasAusentes: n(citas[0]?.ausentes),
          citasSinMarcar: n(citas[0]?.sin_marcar),
        } satisfies Metricas;
      });
    },
  };
}
