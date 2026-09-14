import { sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { enTenant } from '../../src/adapters/postgres/tenantContext.ts';
import { abrirApp, limpiar, sembrarDespacho, type Despacho } from './ayuda.ts';

const db = abrirApp();
let a: Despacho;
let b: Despacho;

beforeEach(async () => {
  await limpiar();
  a = await sembrarDespacho('despacho-a');
  b = await sembrarDespacho('despacho-b');
});

afterEach(limpiar);
afterAll(() => db.cerrar());

/** Rellena la agenda con citas ya atendidas para que el planificador tenga qué decidir. */
async function llenarAgenda(d: Despacho, cuantas: number): Promise<void> {
  await enTenant(db, d.tenantId, (tx) =>
    tx.execute(sql`
      INSERT INTO citas (tenant_id, abogado_id, contacto_id, materia, modalidad,
                         inicia_at, termina_at, estado, honorario_usd)
      SELECT ${d.tenantId}::uuid, ${d.abogadoId}::uuid, ${d.contactoId}::uuid,
             'laboral', 'presencial',
             timestamptz '2026-01-01 14:00:00+00' + (n * interval '1 hour'),
             timestamptz '2026-01-01 14:45:00+00' + (n * interval '1 hour'),
             'atendida', 40.00
        FROM generate_series(1, ${cuantas}) AS n
    `),
  );
}

describe('índices · la política de RLS es el primer predicado del plan', () => {
  it('la consulta de agenda usa índice y no recorre la tabla entera', async () => {
    await llenarAgenda(a, 4000);
    await llenarAgenda(b, 4000);
    await enTenant(db, a.tenantId, (tx) => tx.execute(sql`ANALYZE citas`));

    const plan = await enTenant(db, a.tenantId, (tx) =>
      tx.execute<{ 'QUERY PLAN': string }>(sql`
        EXPLAIN ANALYZE
        SELECT id FROM citas
         WHERE inicia_at >= timestamptz '2026-02-01 00:00:00+00'
           AND inicia_at <  timestamptz '2026-02-03 00:00:00+00'
      `),
    );
    const texto = plan.rows.map((r) => r['QUERY PLAN']).join('\n');

    expect(texto).toMatch(/Index (Only )?Scan|Bitmap Index Scan/);
    expect(texto).not.toMatch(/Seq Scan on citas/);
  });

  it('todo índice de escaneo sobre tablas multi-tenant empieza por tenant_id', async () => {
    // Se exceptúan las claves primarias subrogadas: son únicas globalmente y solo se usan
    // para búsquedas puntuales por id, nunca para recorrer.
    const { rows } = await enTenant(db, a.tenantId, (tx) =>
      tx.execute<{ tabla: string; indice: string; primera: string }>(sql`
        SELECT t.relname AS tabla,
               i.relname AS indice,
               (SELECT attname FROM pg_attribute
                 WHERE attrelid = t.oid AND attnum = x.indkey[0]) AS primera
          FROM pg_index x
          JOIN pg_class i ON i.oid = x.indexrelid
          JOIN pg_class t ON t.oid = x.indrelid
          JOIN pg_namespace n ON n.oid = t.relnamespace
         WHERE n.nspname = 'public'
           AND NOT x.indisprimary
           AND EXISTS (SELECT 1 FROM pg_attribute
                        WHERE attrelid = t.oid AND attname = 'tenant_id' AND attnum > 0)
      `),
    );

    expect(rows.length).toBeGreaterThan(0);
    const infractores = rows.filter((r) => r.primera !== 'tenant_id');
    expect(infractores).toEqual([]);
  });
});

describe('deduplicación de mensajes · patrón inbox', () => {
  async function insertarMensaje(d: Despacho, waMessageId: string) {
    return enTenant(db, d.tenantId, async (tx) => {
      const conversacion = await tx.execute<{ id: string }>(sql`
        INSERT INTO conversaciones (tenant_id, contacto_id, estado, flow_version, expira_at)
        VALUES (${d.tenantId}::uuid, ${d.contactoId}::uuid, 'INICIO', 1, now() + interval '24 hours')
        ON CONFLICT (tenant_id, contacto_id) WHERE cerrada_at IS NULL
        DO UPDATE SET ultimo_inbound_at = now()
        RETURNING id
      `);
      return tx.execute<{ id: string }>(sql`
        INSERT INTO mensajes (tenant_id, conversacion_id, wa_message_id, direccion, tipo, payload)
        VALUES (${d.tenantId}::uuid, ${conversacion.rows[0]!.id}::uuid, ${waMessageId},
                'entrante', 'text', '{}'::jsonb)
        ON CONFLICT (tenant_id, wa_message_id) WHERE wa_message_id IS NOT NULL
        DO NOTHING
        RETURNING id
      `);
    });
  }

  it('el mismo mensaje dos veces solo se encola una vez', async () => {
    const primera = await insertarMensaje(a, 'wamid.ABC');
    const segunda = await insertarMensaje(a, 'wamid.ABC');
    expect(primera.rows).toHaveLength(1);
    expect(segunda.rows).toHaveLength(0);
  });

  it('un identificador que ya existe en otro despacho NO se descarta como duplicado', async () => {
    // Este es el motivo de acotar el índice al tenant. Con un UNIQUE global sobre
    // wa_message_id, la fila en conflicto sería invisible bajo RLS y el DO NOTHING
    // habría descartado un mensaje legítimo del despacho B sin dejar rastro.
    const enA = await insertarMensaje(a, 'wamid.COMPARTIDO');
    const enB = await insertarMensaje(b, 'wamid.COMPARTIDO');
    expect(enA.rows).toHaveLength(1);
    expect(enB.rows).toHaveLength(1);
  });

  it('un contacto no puede tener dos conversaciones abiertas a la vez', async () => {
    await insertarMensaje(a, 'wamid.1');
    await insertarMensaje(a, 'wamid.2');
    const { rows } = await enTenant(db, a.tenantId, (tx) =>
      tx.execute<{ n: string }>(
        sql`SELECT count(*)::text AS n FROM conversaciones WHERE cerrada_at IS NULL`,
      ),
    );
    expect(rows[0]!.n).toBe('1');
  });
});
