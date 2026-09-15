/**
 * Sondas, métricas y alertas contra Postgres real.
 *
 * Aquí lo que se prueba es que las consultas existen y dicen la verdad. Una sonda que
 * siempre devuelve verde porque su consulta está mal es peor que no tener sonda.
 */
import { sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { crearRegistroSalientes, crearRepoAlertas } from '../../src/adapters/postgres/metricas.ts';
import { sondaCola, sondaOutbox, sondaPostgres } from '../../src/adapters/postgres/sondas.ts';
import { enTenant, sinTenant } from '../../src/adapters/postgres/tenantContext.ts';
import { comprobarSalud } from '../../src/app/salud.ts';
import { abrirApp, limpiar, sembrarDespacho, type Despacho } from './ayuda.ts';

const db = abrirApp();
const salientes = crearRegistroSalientes(db);
const alertas = crearRepoAlertas(db);

let a: Despacho;

beforeEach(async () => {
  await limpiar();
  /**
   * La cola vive en el mismo Postgres y sobrevive a la suite: un trabajo abandonado por una
   * corrida anterior haría fallar la sonda por algo que no es del test. Se borran solo los
   * que ya están atascados, que por definición no los espera nadie.
   */
  await sinTenant(db, (tx) =>
    tx.execute(sql`
      DELETE FROM pgboss.job WHERE state = 'created' AND start_after < now() - interval '5 minutes'
    `),
  );
  a = await sembrarDespacho('despacho-a');
});

afterEach(limpiar);
afterAll(() => db.cerrar());

async function abrirConversacion(d: Despacho): Promise<string> {
  return enTenant(db, d.tenantId, async (tx) => {
    const { rows } = await tx.execute<{ id: string }>(sql`
      INSERT INTO conversaciones (tenant_id, contacto_id, estado, flow_version, expira_at)
      VALUES (${d.tenantId}::uuid, ${d.contactoId}::uuid, 'INICIO', 1, now() + interval '24 hours')
      RETURNING id
    `);
    return rows[0]!.id;
  });
}

describe('sondas', () => {
  it('con la base sana, las tres pasan', async () => {
    const resultado = await comprobarSalud([sondaPostgres(db), sondaCola(db), sondaOutbox(db)]);

    expect(resultado.ok).toBe(true);
    expect(resultado.comprobaciones.map((c) => c.nombre)).toEqual(['postgres', 'cola', 'outbox']);
  });

  it('la de postgres lee una tabla de verdad: cazaría un GRANT revocado', async () => {
    // Un `SELECT 1` pasaría igual con los permisos quitados, que es una de las formas reales
    // en que esto se rompe.
    await expect(sondaPostgres(db).comprobar()).resolves.toBeUndefined();
  });

  it('la de la outbox se enciende con un efecto viejo sin publicar', async () => {
    await enTenant(db, a.tenantId, (tx) =>
      tx.execute(sql`
        INSERT INTO outbox (tenant_id, tipo, payload, idempotency_key, created_at)
        VALUES (${a.tenantId}::uuid, 'gcal.crear', '{}'::jsonb, 'viejo',
                now() - interval '30 minutes')
      `),
    );

    await expect(sondaOutbox(db).comprobar()).rejects.toThrow(/sin publicar/);
  });

  it('un efecto reciente todavía no alarma: el backoff necesita margen', async () => {
    await enTenant(db, a.tenantId, (tx) =>
      tx.execute(sql`
        INSERT INTO outbox (tenant_id, tipo, payload, idempotency_key)
        VALUES (${a.tenantId}::uuid, 'gcal.crear', '{}'::jsonb, 'nuevo')
      `),
    );

    await expect(sondaOutbox(db).comprobar()).resolves.toBeUndefined();
  });

  it('uno ya publicado no cuenta aunque sea viejo', async () => {
    await enTenant(db, a.tenantId, (tx) =>
      tx.execute(sql`
        INSERT INTO outbox (tenant_id, tipo, payload, idempotency_key, created_at, publicado_at)
        VALUES (${a.tenantId}::uuid, 'gcal.crear', '{}'::jsonb, 'hecho',
                now() - interval '2 hours', now() - interval '2 hours')
      `),
    );

    await expect(sondaOutbox(db).comprobar()).resolves.toBeUndefined();
  });

  it('la de la cola consulta el esquema de pg-boss de verdad', async () => {
    // Si el nombre de la tabla o de la columna cambiara con una versión nueva, esto lo dice
    // aquí y no en producción a las tres de la mañana.
    await expect(sondaCola(db).comprobar()).resolves.toBeUndefined();
  });
});

describe('registro de salientes', () => {
  it('anota el envío que salió y el que falló', async () => {
    const conversacionId = await abrirConversacion(a);

    await salientes.anotar({
      tenantId: a.tenantId,
      conversacionId,
      tipo: 'texto',
      waMessageId: 'wamid.1',
      error: null,
    });
    await salientes.anotar({
      tenantId: a.tenantId,
      conversacionId,
      tipo: 'lista',
      waMessageId: null,
      error: 'HttpError',
    });

    expect(await alertas.enviosRecientes(a.tenantId, 10)).toEqual({ total: 2, fallidos: 1 });
  });

  it('no guarda el texto que salió: es el mismo para todos y sale de content.ts', async () => {
    const conversacionId = await abrirConversacion(a);
    await salientes.anotar({
      tenantId: a.tenantId,
      conversacionId,
      tipo: 'texto',
      waMessageId: 'wamid.2',
      error: null,
    });

    const { rows } = await enTenant(db, a.tenantId, (tx) =>
      tx.execute<{ payload: unknown }>(sql`
        SELECT payload FROM mensajes
         WHERE tenant_id = ${a.tenantId}::uuid AND direccion = 'saliente'
      `),
    );
    expect(rows[0]!.payload).toEqual({ ok: true });
  });

  it('los entrantes se agrupan por día LOCAL, no por día UTC', async () => {
    const conversacionId = await abrirConversacion(a);
    // 2026-09-17T03:00Z son las 22:00 del 16 en Guayaquil. Agrupado por UTC, el día del
    // silencio saldría cambiado y la alerta se dispararía sola.
    await enTenant(db, a.tenantId, (tx) =>
      tx.execute(sql`
        INSERT INTO mensajes (tenant_id, conversacion_id, direccion, tipo, payload, created_at)
        VALUES (${a.tenantId}::uuid, ${conversacionId}::uuid, 'entrante', 'text', '{}'::jsonb,
                '2026-09-17T03:00:00Z')
      `),
    );

    const historia = await alertas.entrantesPorDia(a.tenantId, 3650);

    expect(historia).toContainEqual({ dia: '2026-09-16', total: 1 });
  });
});
