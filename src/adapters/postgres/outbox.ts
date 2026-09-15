/**
 * Acceso a la `outbox` para el relay.
 *
 * Dos cosas que la RLS obliga y que no son negociables:
 *
 *  1. **El relay recorre despacho por despacho.** No existe una consulta que vea la outbox
 *     de todos: con `FORCE ROW LEVEL SECURITY` y sin `app.tenant_id` fijado se ven cero
 *     filas. La lista de despachos sale de `tenants`, que es la única tabla sin RLS —y por
 *     eso no guarda secretos—.
 *  2. **Nada se lee ni se escribe fuera de `enTenant()`**, ni siquiera desde un proceso de
 *     fondo que "sabe" a qué despacho pertenece cada fila.
 */
import { sql } from 'drizzle-orm';
import type { RepoOutbox, TrabajoOutbox } from '../../app/puertos/RepoOutbox.ts';
import { MAX_INTENTOS } from '../../app/relayOutbox.ts';
import type { BaseDatos } from './db.ts';
import { enTenant, sinTenant } from './tenantContext.ts';

/**
 * Cuánto se reserva un trabajo mientras se ejecuta. Si el proceso muere a mitad, pasado
 * este tiempo otro relay lo vuelve a tomar; de ahí que la entrega sea *at-least-once*.
 */
const ARRENDAMIENTO = '5 minutes';

export function crearRepoOutbox(db: BaseDatos): RepoOutbox {
  return {
    async tenantsConPendientes(limite) {
      /**
       * `tenants` no lleva RLS, así que esta es la única consulta del relay que puede ver
       * más de un despacho. Ni siquiera mira la outbox: pedir aquí «cuáles tienen
       * pendientes» exigiría leer una tabla protegida sin tenant fijado, que es justo lo
       * que no se puede hacer. Se recorren los activos y el reclamo de cada uno decide.
       */
      const { rows } = await sinTenant(db, (tx) =>
        tx.execute<{ id: string }>(sql`
          SELECT id FROM tenants WHERE activo ORDER BY created_at LIMIT ${limite}
        `),
      );
      return rows.map((r) => r.id);
    },

    async reclamar(tenantId, limite) {
      /**
       * Reclamo con arriendo, en una sola sentencia.
       *
       * `FOR UPDATE SKIP LOCKED` evita que dos relays tomen la misma fila; el arriendo
       * —empujar `proximo_intento_at` al futuro— evita que la vuelvan a tomar mientras se
       * ejecuta, **sin** mantener abierta la transacción durante la llamada de red. Una
       * transacción abierta esperando a Google retiene una conexión del pool y un bloqueo
       * de fila durante segundos.
       *
       * `intentos` se incrementa aquí y no al fallar: así un proceso que muere a mitad
       * también consume intento y un trabajo venenoso no gira para siempre.
       */
      const { rows } = await enTenant(db, tenantId, (tx) =>
        tx.execute<{
          id: string;
          tipo: string;
          payload: unknown;
          idempotency_key: string;
          intentos: number;
        }>(sql`
          WITH candidatos AS (
            SELECT id FROM outbox
             WHERE tenant_id = ${tenantId}::uuid
               AND publicado_at IS NULL
               AND intentos < ${MAX_INTENTOS}
               AND proximo_intento_at <= now()
             ORDER BY id
             LIMIT ${limite}
             FOR UPDATE SKIP LOCKED
          )
          UPDATE outbox o
             SET intentos = o.intentos + 1,
                 proximo_intento_at = now() + ${ARRENDAMIENTO}::interval
            FROM candidatos c
           WHERE o.id = c.id
          RETURNING o.id::text AS id, o.tipo, o.payload, o.idempotency_key, o.intentos
        `),
      );

      return rows.map<TrabajoOutbox>((fila) => ({
        id: fila.id,
        tenantId,
        tipo: fila.tipo,
        payload: fila.payload,
        idempotencyKey: fila.idempotency_key,
        intentos: fila.intentos,
      }));
    },

    async marcarPublicado(tenantId, id) {
      await enTenant(db, tenantId, (tx) =>
        tx.execute(sql`
          UPDATE outbox SET publicado_at = now(), ultimo_error = NULL
           WHERE tenant_id = ${tenantId}::uuid AND id = ${id}::bigint AND publicado_at IS NULL
        `),
      );
    },

    async marcarFallido(tenantId, id, esperaMs, error) {
      await enTenant(db, tenantId, (tx) =>
        tx.execute(sql`
          UPDATE outbox
             SET proximo_intento_at = now() + make_interval(secs => ${esperaMs / 1000}),
                 ultimo_error = ${error}
           WHERE tenant_id = ${tenantId}::uuid AND id = ${id}::bigint
        `),
      );
    },

    async archivar(tenantId, id, error) {
      /**
       * Archivar es dejar de reintentar sin borrar la evidencia: `intentos` al tope hace
       * que el reclamo ya no lo tome, y la fila sigue sin `publicado_at`, que es
       * exactamente lo que busca la alerta de §9 —«entradas con más de 15 minutos sin
       * publicar»— para que el estudio se entere.
       */
      await enTenant(db, tenantId, (tx) =>
        tx.execute(sql`
          UPDATE outbox
             SET intentos = GREATEST(intentos, ${MAX_INTENTOS}), ultimo_error = ${error}
           WHERE tenant_id = ${tenantId}::uuid AND id = ${id}::bigint
        `),
      );
    },
  };
}
