import { sql } from 'drizzle-orm';
import pg from 'pg';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { enTenant, sinTenant, TenantInvalidoError } from '../../src/adapters/postgres/tenantContext.ts';
import { reservar } from '../../src/adapters/postgres/reservas.ts';
import {
  abrirApp,
  limpiar,
  mensajeCompleto,
  sembrarDespacho,
  urlDump,
  urlOwner,
  type Despacho,
} from './ayuda.ts';

const db = abrirApp();
let a: Despacho;
let b: Despacho;

const enUnaHora = () => new Date(Date.now() + 3_600_000);

async function reservarEn(d: Despacho, inicia: Date) {
  return enTenant(db, d.tenantId, (tx) =>
    reservar(tx, {
      tenantId: d.tenantId,
      abogadoId: d.abogadoId,
      contactoId: d.contactoId,
      materia: 'laboral',
      modalidad: 'presencial',
      iniciaAt: inicia,
      terminaAt: new Date(inicia.getTime() + 45 * 60_000),
      honorarioUsd: '40.00',
    }),
  );
}

beforeEach(async () => {
  await limpiar();
  a = await sembrarDespacho('despacho-a');
  b = await sembrarDespacho('despacho-b');
});

afterEach(limpiar);
afterAll(() => db.cerrar());

describe('RLS · aislamiento entre despachos', () => {
  it('con el tenant de B no se ve ninguna cita de A', async () => {
    await reservarEn(a, enUnaHora());

    const vistoPorA = await enTenant(db, a.tenantId, (tx) =>
      tx.execute<{ n: string }>(sql`SELECT count(*)::text AS n FROM citas`),
    );
    const vistoPorB = await enTenant(db, b.tenantId, (tx) =>
      tx.execute<{ n: string }>(sql`SELECT count(*)::text AS n FROM citas`),
    );

    expect(vistoPorA.rows[0]!.n).toBe('1');
    expect(vistoPorB.rows[0]!.n).toBe('0');
  });

  it('sin app.tenant_id fijado no se ve nada: el comportamiento por defecto es cerrado', async () => {
    await reservarEn(a, enUnaHora());

    const sinContexto = await sinTenant(db, (tx) =>
      tx.execute<{ n: string }>(sql`SELECT count(*)::text AS n FROM citas`),
    );
    expect(sinContexto.rows[0]!.n).toBe('0');
  });

  it('el WITH CHECK impide escribir con el tenant de otro despacho', async () => {
    const error = await enTenant(db, b.tenantId, (tx) =>
      tx.execute(sql`
        INSERT INTO contactos (tenant_id, wa_id) VALUES (${a.tenantId}::uuid, '593911111111')
      `),
    ).catch((e: unknown) => e);

    expect(mensajeCompleto(error)).toMatch(/row-level security/i);
  });

  it('el valor del tenant no sobrevive a la transacción: SET LOCAL, no SET', async () => {
    await reservarEn(a, enUnaHora());
    await enTenant(db, a.tenantId, (tx) =>
      tx.execute(sql`SELECT count(*) FROM citas`),
    );

    // Misma conexión del pool, transacción nueva y sin tenant: no debe arrastrar el de A.
    const despues = await sinTenant(db, (tx) =>
      tx.execute<{ v: string | null }>(
        sql`SELECT NULLIF(current_setting('app.tenant_id', true), '') AS v`,
      ),
    );
    expect(despues.rows[0]!.v).toBeNull();
  });

  it('FORCE alcanza también al dueño de las tablas', async () => {
    await reservarEn(a, enUnaHora());

    const owner = new pg.Client({ connectionString: urlOwner() });
    await owner.connect();
    try {
      // app_owner es dueño de `citas`. Sin FORCE, ignoraría la política en silencio.
      const sinContexto = await owner.query<{ n: string }>('SELECT count(*)::text AS n FROM citas');
      expect(sinContexto.rows[0]!.n).toBe('0');

      await owner.query('BEGIN');
      await owner.query(`SELECT set_config('app.tenant_id', $1, true)`, [a.tenantId]);
      const conContexto = await owner.query<{ n: string }>('SELECT count(*)::text AS n FROM citas');
      await owner.query('COMMIT');
      expect(conContexto.rows[0]!.n).toBe('1');
    } finally {
      await owner.end();
    }
  });

  it('app_dump sí lo ve todo: sin BYPASSRLS el backup exportaría cero filas', async () => {
    await reservarEn(a, enUnaHora());
    await reservarEn(b, enUnaHora());

    const dump = new pg.Client({ connectionString: urlDump() });
    await dump.connect();
    try {
      const { rows } = await dump.query<{ n: string }>('SELECT count(*)::text AS n FROM citas');
      expect(rows[0]!.n).toBe('2');
    } finally {
      await dump.end();
    }
  });

  it('la aplicación no puede dar de alta despachos ni tocar sus credenciales', async () => {
    const altaTenant = await sinTenant(db, (tx) =>
      tx.execute(sql`
        INSERT INTO tenants (slug, nombre, wa_phone_number_id)
        VALUES ('intruso', 'Intruso', 'phone-intruso')
      `),
    ).catch((e: unknown) => e);
    expect(mensajeCompleto(altaTenant)).toMatch(/permission denied/i);

    const rotarToken = await enTenant(db, a.tenantId, (tx) =>
      tx.execute(sql`UPDATE tenant_config SET wa_token_enc = 'robado'`),
    ).catch((e: unknown) => e);
    expect(mensajeCompleto(rotarToken)).toMatch(/permission denied/i);
  });

  it('un identificador de tenant que no es uuid se rechaza antes de tocar la base', async () => {
    await expect(
      enTenant(db, "' OR true --", async () => undefined),
    ).rejects.toThrow(TenantInvalidoError);
  });
});

describe('RLS · toda tabla con tenant_id está protegida', () => {
  it('no queda ninguna sin ENABLE y FORCE', async () => {
    const owner = new pg.Client({ connectionString: urlOwner() });
    await owner.connect();
    try {
      const { rows } = await owner.query<{ relname: string }>(`
        SELECT c.relname
          FROM pg_class c
          JOIN pg_namespace n ON n.oid = c.relnamespace
          JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'tenant_id' AND a.attnum > 0
         WHERE n.nspname = 'public'
           AND c.relkind = 'r'
           AND NOT (c.relrowsecurity AND c.relforcerowsecurity)
      `);
      expect(rows.map((r) => r.relname)).toEqual([]);
    } finally {
      await owner.end();
    }
  });
});
