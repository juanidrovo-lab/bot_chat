/**
 * Las sondas concretas de `/health`.
 *
 * Cada una toca lo que de verdad puede fallar, no lo que es fácil de comprobar.
 */
import { sql } from 'drizzle-orm';
import type { Sonda } from '../../app/puertos/Salud.ts';
import type { BaseDatos } from './db.ts';
import { enTenant, sinTenant } from './tenantContext.ts';

/**
 * Postgres, y no con un `SELECT 1`.
 *
 * Un `SELECT 1` lo responde una réplica en modo lectura, una base con el disco lleno y una
 * conexión a la que le revocaron los permisos: las tres formas reales en que esto se rompe.
 * Esta sonda lee una tabla de verdad —así prueba también que los `GRANT` siguen ahí— y
 * comprueba que la sesión puede escribir.
 */
export function sondaPostgres(db: BaseDatos): Sonda {
  return {
    nombre: 'postgres',
    async comprobar() {
      const { rows } = await sinTenant(db, (tx) =>
        tx.execute<{ replica: boolean; solo_lectura: string }>(sql`
          SELECT pg_is_in_recovery() AS replica,
                 current_setting('transaction_read_only') AS solo_lectura,
                 (SELECT count(*) FROM tenants) AS despachos
        `),
      );
      const fila = rows[0];
      if (fila === undefined) throw new Error('la consulta de salud no devolvió nada');
      if (fila.replica) throw new Error('la base está en modo réplica');
      if (fila.solo_lectura === 'on') throw new Error('la base está en solo lectura');
    },
  };
}

/**
 * pg-boss: que su esquema exista y que la cola esté avanzando.
 *
 * Que el objeto `PgBoss` esté construido no dice nada; lo que importa es que haya un
 * trabajador vivo consumiendo. Si el trabajo más viejo lleva demasiado tiempo en cola, la
 * cola está atascada aunque todo lo demás responda.
 */
export function sondaCola(db: BaseDatos, esquema = 'pgboss', atascoSegundos = 300): Sonda {
  return {
    nombre: 'cola',
    async comprobar() {
      const { rows } = await sinTenant(db, (tx) =>
        tx.execute<{ atascados: string }>(sql`
          SELECT count(*)::text AS atascados
            FROM ${sql.identifier(esquema)}.job
           WHERE state = 'created'
             AND start_after < now() - make_interval(secs => ${atascoSegundos})
        `),
      );
      const atascados = Number(rows[0]?.atascados ?? 0);
      if (atascados > 0) {
        throw new Error(`${atascados} trabajos llevan más de ${atascoSegundos} s sin tomarse`);
      }
    },
  };
}

/**
 * La outbox (alerta 2 de §9): entradas con más de quince minutos sin publicar.
 *
 * Va aquí y no en un panel de métricas porque es la señal de que un efecto externo —la cita
 * que no llegó a Google, el recordatorio que no salió— lleva un cuarto de hora sin ocurrir,
 * y eso el estudio tiene que saberlo antes que el cliente.
 */
export function sondaOutbox(db: BaseDatos, minutos = 15): Sonda {
  return {
    nombre: 'outbox',
    async comprobar() {
      /**
       * Despacho por despacho, como el relay: bajo RLS no existe una consulta que vea la
       * outbox de todos, y `tenants` es la única tabla legible sin fijar el tenant.
       */
      const { rows } = await sinTenant(db, (tx) =>
        tx.execute<{ id: string }>(sql`SELECT id FROM tenants WHERE activo`),
      );

      const atrasados: string[] = [];
      for (const { id } of rows) {
        const { rows: cuenta } = await enTenant(db, id, (tx) =>
          tx.execute<{ n: string }>(sql`
            SELECT count(*)::text AS n FROM outbox
             WHERE tenant_id = ${id}::uuid AND publicado_at IS NULL
               AND created_at < now() - make_interval(mins => ${minutos})
          `),
        );
        if (Number(cuenta[0]?.n ?? 0) > 0) atrasados.push(id);
      }

      if (atrasados.length > 0) {
        // Ids de despacho, no de contactos ni de citas: el cuerpo de `/health` puede acabar
        // en el panel de cualquier monitor.
        throw new Error(`${atrasados.length} despacho(s) con efectos sin publicar`);
      }
    },
  };
}
