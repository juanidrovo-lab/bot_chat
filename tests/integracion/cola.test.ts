import { sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { crearCola, type ColaPgBoss } from '../../src/adapters/cola/pgboss.ts';
import { crearRepoConversaciones } from '../../src/adapters/postgres/repoConversaciones.ts';
import { enTenant } from '../../src/adapters/postgres/tenantContext.ts';
import { crearProcesarMensajeEntrante } from '../../src/app/procesarMensajeEntrante.ts';
import { COLA_MENSAJE_ENTRANTE } from '../../src/app/puertos/Cola.ts';
import { abrirApp, limpiar, sembrarContacto, sembrarDespacho, urlApp, type Despacho } from './ayuda.ts';

const db = abrirApp();
let cola: ColaPgBoss;
let a: Despacho;

const COLA_PRUEBA = 'prueba.orden';

interface Tramo {
  id: string;
  clave: string;
  inicio: number;
  fin: number;
}

/**
 * Un solo trabajador registrado para todo el archivo. Registrar uno por test dejaría
 * varios escuchando la misma cola y los trabajos irían a parar al manejador de otro test.
 */
const tramos: Tramo[] = [];
let activos = 0;
let maxActivos = 0;

beforeAll(async () => {
  cola = crearCola(urlApp(), { sondeoSegundos: 0.5 });
  await cola.arrancar([COLA_MENSAJE_ENTRANTE, COLA_PRUEBA]);

  await cola.trabajar<{ id: string; clave: string }>(COLA_PRUEBA, async (datos) => {
    activos++;
    maxActivos = Math.max(maxActivos, activos);
    const inicio = Date.now();
    await new Promise((r) => setTimeout(r, 250));
    tramos.push({ id: datos.id, clave: datos.clave, inicio, fin: Date.now() });
    activos--;
  });
});

afterAll(async () => {
  await cola.parar();
  await db.cerrar();
});

beforeEach(async () => {
  await limpiar();
  tramos.length = 0;
  maxActivos = 0;
  a = await sembrarDespacho('despacho-a');
});

afterEach(limpiar);

async function abrirConversacion(contactoId: string): Promise<string> {
  return enTenant(db, a.tenantId, async (tx) => {
    const { rows } = await tx.execute<{ id: string }>(sql`
      INSERT INTO conversaciones (tenant_id, contacto_id, estado, flow_version, expira_at)
      VALUES (${a.tenantId}::uuid, ${contactoId}::uuid, 'INICIO', 1, now() + interval '24 hours')
      RETURNING id
    `);
    return rows[0]!.id;
  });
}

/** Espera activa acotada: la cola no avisa de «ya terminé todo». */
async function esperarHasta(condicion: () => boolean, ms = 20_000): Promise<void> {
  const limite = Date.now() + ms;
  while (Date.now() < limite) {
    if (condicion()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('la cola no llegó a procesar lo esperado a tiempo');
}

describe('cola · serialización por conversación (D10)', () => {
  it('tres mensajes de la misma conversación se procesan en orden y sin solaparse', async () => {
    const clave = 'conversacion-unica';
    for (const id of ['primero', 'segundo', 'tercero']) {
      await cola.encolar(COLA_PRUEBA, { id, clave }, { clave });
    }

    await esperarHasta(() => tramos.length === 3);

    expect(tramos.map((t) => t.id)).toEqual(['primero', 'segundo', 'tercero']);
    expect(maxActivos).toBe(1);
    // Sin solape: cada uno empieza después de que el anterior terminó.
    expect(tramos[1]!.inicio).toBeGreaterThanOrEqual(tramos[0]!.fin);
    expect(tramos[2]!.inicio).toBeGreaterThanOrEqual(tramos[1]!.fin);
  });

  it('con varias conversaciones mezcladas, cada una conserva su propio orden', async () => {
    /**
     * El trabajador toma los trabajos de uno en uno (`batchSize: 1`), así que no hay
     * paralelismo dentro de un proceso: para tres abogados sobra, y mantiene la garantía
     * de orden sin depender de nada más. Escalar es levantar más procesos, y entonces la
     * política de la cola y el `SELECT ... FOR UPDATE` siguen sosteniendo el orden por
     * conversación. Lo que este test fija es eso: mezclar conversaciones no desordena
     * ninguna.
     */
    await cola.encolar(COLA_PRUEBA, { id: 'a1', clave: 'conv-a' }, { clave: 'conv-a' });
    await cola.encolar(COLA_PRUEBA, { id: 'b1', clave: 'conv-b' }, { clave: 'conv-b' });
    await cola.encolar(COLA_PRUEBA, { id: 'a2', clave: 'conv-a' }, { clave: 'conv-a' });
    await cola.encolar(COLA_PRUEBA, { id: 'b2', clave: 'conv-b' }, { clave: 'conv-b' });

    await esperarHasta(() => tramos.length === 4);

    const soloDe = (clave: string) => tramos.filter((t) => t.clave === clave).map((t) => t.id);
    expect(soloDe('conv-a')).toEqual(['a1', 'a2']);
    expect(soloDe('conv-b')).toEqual(['b1', 'b2']);
    expect(maxActivos).toBe(1);
  });
});

describe('trabajador · procesarMensajeEntrante', () => {
  async function eventosDe(conversacionId: string): Promise<string[]> {
    const { rows } = await enTenant(db, a.tenantId, (tx) =>
      tx.execute<{ tipo: string }>(sql`
        SELECT tipo FROM eventos WHERE entidad_id = ${conversacionId} ORDER BY id
      `),
    );
    return rows.map((r) => r.tipo);
  }

  it('deja rastro de auditoría del mensaje procesado', async () => {
    const conversacionId = await abrirConversacion(a.contactoId);
    const procesar = crearProcesarMensajeEntrante(crearRepoConversaciones(db));

    await procesar({
      tenantId: a.tenantId,
      conversacionId,
      contactoId: a.contactoId,
      waMessageId: 'wamid.1',
    });

    expect(await eventosDe(conversacionId)).toEqual(['mensaje.procesado']);
  });

  it('en una conversación derivada el bot se calla', async () => {
    const conversacionId = await abrirConversacion(a.contactoId);
    await enTenant(db, a.tenantId, (tx) =>
      tx.execute(sql`
        UPDATE conversaciones SET derivada_at = now(), derivada_motivo = 'tres_fallos'
         WHERE id = ${conversacionId}::uuid
      `),
    );

    let avanzo = false;
    const procesar = crearProcesarMensajeEntrante(crearRepoConversaciones(db), async () => {
      avanzo = true;
    });
    await procesar({ tenantId: a.tenantId, conversacionId, contactoId: a.contactoId, waMessageId: 'wamid.2' });

    expect(avanzo).toBe(false);
    expect(await eventosDe(conversacionId)).toEqual(['mensaje.ignorado_por_derivacion']);
  });

  it('el FOR UPDATE serializa aunque dos trabajadores coincidan', async () => {
    const conversacionId = await abrirConversacion(a.contactoId);
    const repo = crearRepoConversaciones(db);

    let activos = 0;
    let maxActivos = 0;
    const procesar = crearProcesarMensajeEntrante(repo, async () => {
      activos++;
      maxActivos = Math.max(maxActivos, activos);
      await new Promise((r) => setTimeout(r, 250));
      activos--;
    });

    const trabajo = { tenantId: a.tenantId, conversacionId, contactoId: a.contactoId };
    await Promise.all([
      procesar({ ...trabajo, waMessageId: 'wamid.1' }),
      procesar({ ...trabajo, waMessageId: 'wamid.2' }),
    ]);

    expect(maxActivos).toBe(1);
    expect(await eventosDe(conversacionId)).toHaveLength(2);
  });

  it('dos conversaciones distintas no se bloquean entre sí', async () => {
    const otro = await sembrarContacto(db, a.tenantId, '593988888888');
    const unaId = await abrirConversacion(a.contactoId);
    const otraId = await abrirConversacion(otro);

    let activos = 0;
    let maxActivos = 0;
    const procesar = crearProcesarMensajeEntrante(crearRepoConversaciones(db), async () => {
      activos++;
      maxActivos = Math.max(maxActivos, activos);
      await new Promise((r) => setTimeout(r, 250));
      activos--;
    });

    await Promise.all([
      procesar({ tenantId: a.tenantId, conversacionId: unaId, contactoId: a.contactoId, waMessageId: 'w1' }),
      procesar({ tenantId: a.tenantId, conversacionId: otraId, contactoId: otro, waMessageId: 'w2' }),
    ]);

    expect(maxActivos).toBe(2);
  });

  it('una conversación que ya no existe no revienta el trabajador', async () => {
    const procesar = crearProcesarMensajeEntrante(crearRepoConversaciones(db));
    await expect(
      procesar({
        tenantId: a.tenantId,
        conversacionId: '00000000-0000-4000-8000-000000000000',
        contactoId: a.contactoId,
        waMessageId: 'wamid.X',
      }),
    ).resolves.toBeUndefined();
  });
});
