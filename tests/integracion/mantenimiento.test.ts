/**
 * Retención, recordatorios y refresco de media contra Postgres de verdad.
 *
 * Aquí lo que se comprueba no se puede comprobar con dobles: que las sentencias respetan la
 * RLS —un job que recorre despachos no puede tocar los de otro— y que lo que borran y
 * anonimizan es exactamente lo que dicen, ni una fila más.
 */
import { sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { crearRepoMantenimiento, crearRepoRecordatorios } from '../../src/adapters/postgres/mantenimiento.ts';
import { crearDespachos } from '../../src/adapters/postgres/tenants.ts';
import { enTenant } from '../../src/adapters/postgres/tenantContext.ts';
import { abrirApp, limpiar, sembrarContacto, sembrarDespacho, type Despacho } from './ayuda.ts';

const db = abrirApp();
const mantenimiento = crearRepoMantenimiento(db);
const recordatorios = crearRepoRecordatorios(db);
const despachos = crearDespachos(db);

const DIA_MS = 86_400_000;
const AHORA = Date.now();

let a: Despacho;
let b: Despacho;

beforeEach(async () => {
  await limpiar();
  a = await sembrarDespacho('despacho-a');
  b = await sembrarDespacho('despacho-b');
});

afterEach(limpiar);
afterAll(() => db.cerrar());

async function abrirConversacion(d: Despacho): Promise<string> {
  return enTenant(db, d.tenantId, async (tx) => {
    const { rows } = await tx.execute<{ id: string }>(sql`
      INSERT INTO conversaciones (tenant_id, contacto_id, estado, contexto, flow_version, expira_at)
      VALUES (${d.tenantId}::uuid, ${d.contactoId}::uuid, 'INICIO', '{}'::jsonb, 1, now() + interval '24 hours')
      RETURNING id
    `);
    return rows[0]!.id;
  });
}

async function sembrarMensaje(d: Despacho, conversacionId: string, haceDias: number): Promise<void> {
  const cuando = new Date(AHORA - haceDias * DIA_MS);
  await enTenant(db, d.tenantId, (tx) =>
    tx.execute(sql`
      INSERT INTO mensajes (tenant_id, conversacion_id, direccion, tipo, payload, created_at)
      VALUES (${d.tenantId}::uuid, ${conversacionId}::uuid, 'entrante', 'text',
              ${JSON.stringify({ texto: 'consulta privada' })}::jsonb, ${cuando})
    `),
  );
}

async function contarMensajes(d: Despacho): Promise<number> {
  const { rows } = await enTenant(db, d.tenantId, (tx) =>
    tx.execute<{ n: string }>(sql`
      SELECT count(*)::text AS n FROM mensajes WHERE tenant_id = ${d.tenantId}::uuid
    `),
  );
  return Number(rows[0]!.n);
}

async function sembrarCita(
  d: Despacho,
  contactoId: string,
  inicia: Date,
  estado = 'reservada',
): Promise<string> {
  return enTenant(db, d.tenantId, async (tx) => {
    const { rows } = await tx.execute<{ id: string }>(sql`
      INSERT INTO citas (tenant_id, abogado_id, contacto_id, materia, modalidad,
                         inicia_at, termina_at, estado, honorario_usd,
                         cancelada_at, cancelada_por)
      VALUES (${d.tenantId}::uuid, ${d.abogadoId}::uuid, ${contactoId}::uuid,
              'laboral', 'presencial', ${inicia}, ${new Date(inicia.getTime() + 45 * 60_000)},
              ${estado}, '40.00',
              ${estado === 'cancelada' ? new Date() : null},
              ${estado === 'cancelada' ? 'contacto' : null})
      RETURNING id
    `);
    return rows[0]!.id;
  });
}

async function envejecerContacto(d: Despacho, contactoId: string, haceDias: number): Promise<void> {
  await enTenant(db, d.tenantId, (tx) =>
    tx.execute(sql`
      UPDATE contactos SET ultimo_inbound_at = ${new Date(AHORA - haceDias * DIA_MS)}
       WHERE tenant_id = ${d.tenantId}::uuid AND id = ${contactoId}::uuid
    `),
  );
}

async function leerContacto(
  d: Despacho,
  contactoId: string,
): Promise<{ nombre: string | null; anonimizado: boolean }> {
  const { rows } = await enTenant(db, d.tenantId, (tx) =>
    tx.execute<{ nombre: string | null; anonimizado_at: string | null }>(sql`
      SELECT nombre, anonimizado_at FROM contactos
       WHERE tenant_id = ${d.tenantId}::uuid AND id = ${contactoId}::uuid
    `),
  );
  return { nombre: rows[0]!.nombre, anonimizado: rows[0]!.anonimizado_at !== null };
}

describe('borrarMensajesAntiguos', () => {
  it('borra los viejos, deja los recientes y no toca al otro despacho', async () => {
    const convA = await abrirConversacion(a);
    const convB = await abrirConversacion(b);
    await sembrarMensaje(a, convA, 120);
    await sembrarMensaje(a, convA, 100);
    await sembrarMensaje(a, convA, 10);
    await sembrarMensaje(b, convB, 200);

    const borrados = await mantenimiento.borrarMensajesAntiguos(a.tenantId, AHORA - 90 * DIA_MS);

    expect(borrados).toBe(2);
    expect(await contarMensajes(a)).toBe(1);
    // La RLS es lo que impide que el job de un despacho arrastre los datos de otro.
    expect(await contarMensajes(b)).toBe(1);
  });

  it('correrlo dos veces no es un error: la segunda no borra nada', async () => {
    const conv = await abrirConversacion(a);
    await sembrarMensaje(a, conv, 120);

    expect(await mantenimiento.borrarMensajesAntiguos(a.tenantId, AHORA - 90 * DIA_MS)).toBe(1);
    expect(await mantenimiento.borrarMensajesAntiguos(a.tenantId, AHORA - 90 * DIA_MS)).toBe(0);
  });
});

describe('anonimizarContactosInactivos', () => {
  it('borra los datos personales pero conserva la fila', async () => {
    await envejecerContacto(a, a.contactoId, 400);

    expect(await mantenimiento.anonimizarContactosInactivos(a.tenantId, AHORA - 360 * DIA_MS)).toBe(1);

    const contacto = await leerContacto(a, a.contactoId);
    expect(contacto.nombre).toBeNull();
    expect(contacto.anonimizado).toBe(true);
  });

  it('nunca anonimiza a quien tiene una cita por delante', async () => {
    await envejecerContacto(a, a.contactoId, 400);
    // Escribió hace más de un año y volvió a aparecer con una cita: si se anonimizara, el
    // estudio lo tendría en la agenda de mañana sin saber quién es.
    await sembrarCita(a, a.contactoId, new Date(AHORA + 3 * DIA_MS));

    expect(await mantenimiento.anonimizarContactosInactivos(a.tenantId, AHORA - 360 * DIA_MS)).toBe(0);
    expect((await leerContacto(a, a.contactoId)).nombre).not.toBeNull();
  });

  it('una cita cancelada no lo protege', async () => {
    const otro = await sembrarContacto(db, a.tenantId, '593991111111');
    await envejecerContacto(a, otro, 400);
    await sembrarCita(a, otro, new Date(AHORA + 3 * DIA_MS), 'cancelada');

    expect(await mantenimiento.anonimizarContactosInactivos(a.tenantId, AHORA - 360 * DIA_MS)).toBe(1);
  });

  it('es idempotente: al anonimizado no lo vuelve a contar', async () => {
    await envejecerContacto(a, a.contactoId, 400);

    expect(await mantenimiento.anonimizarContactosInactivos(a.tenantId, AHORA - 360 * DIA_MS)).toBe(1);
    expect(await mantenimiento.anonimizarContactosInactivos(a.tenantId, AHORA - 360 * DIA_MS)).toBe(0);
  });
});

describe('audiosParaRefrescar', () => {
  async function sembrarAudio(
    d: Despacho,
    clave: string,
    subidoAt: Date | null,
    mediaId: string | null,
  ): Promise<void> {
    await enTenant(db, d.tenantId, (tx) =>
      tx.execute(sql`
        INSERT INTO audios (tenant_id, clave, ruta, wa_media_id, subido_at)
        VALUES (${d.tenantId}::uuid, ${clave}, ${'/audio/' + clave + '.ogg'}, ${mediaId}, ${subidoAt})
      `),
    );
  }

  it('devuelve los caducos y los que nunca se subieron, no los frescos', async () => {
    await sembrarAudio(a, 'nunca', null, null);
    await sembrarAudio(a, 'caduco', new Date(AHORA - 26 * DIA_MS), 'media-viejo');
    await sembrarAudio(a, 'fresco', new Date(AHORA - 2 * DIA_MS), 'media-nuevo');
    await sembrarAudio(b, 'del-otro', null, null);

    const claves = await mantenimiento.audiosParaRefrescar(a.tenantId, AHORA - 25 * DIA_MS);

    expect(claves).toEqual(['caduco', 'nunca']);
  });
});

describe('citasEntre', () => {
  it('trae solo las citas vigentes de la ventana pedida', async () => {
    const manana = new Date(AHORA + DIA_MS);
    const vigente = await sembrarCita(a, a.contactoId, manana);
    const otroContacto = await sembrarContacto(db, a.tenantId, '593992222222');
    await sembrarCita(a, otroContacto, new Date(manana.getTime() + 60 * 60_000), 'cancelada');
    const tercero = await sembrarContacto(db, a.tenantId, '593993333333');
    await sembrarCita(a, tercero, new Date(AHORA + 5 * DIA_MS));

    const citas = await recordatorios.citasEntre(a.tenantId, AHORA + DIA_MS - 60_000, AHORA + 2 * DIA_MS);

    expect(citas.map((c) => c.id)).toEqual([vigente]);
  });
});

describe('crearDespachos', () => {
  it('lista los despachos activos sin fijar tenant: es la única lectura que puede', async () => {
    const activos = await despachos.activos();

    expect(activos).toContain(a.tenantId);
    expect(activos).toContain(b.tenantId);
  });
});
