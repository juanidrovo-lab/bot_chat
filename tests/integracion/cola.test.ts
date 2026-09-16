import { sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { crearCola, type ColaPgBoss } from '../../src/adapters/cola/pgboss.ts';
import { FLOW_VERSION } from '../../src/domain/conversacion/version.ts';
import { enTenant } from '../../src/adapters/postgres/tenantContext.ts';
import { crearProcesarMensajeEntrante } from '../../src/app/procesarMensajeEntrante.ts';
import {
  COLA_APLICAR_RETENCION,
  COLA_ENVIAR_RECORDATORIOS,
  COLA_MENSAJE_ENTRANTE,
  COLA_REFRESCAR_MEDIA,
  COLA_RELAY_OUTBOX,
  COLA_SINCRONIZAR_AGENDA,
  CRON_PROGRAMADO,
} from '../../src/app/puertos/Cola.ts';
import { ZONA } from '../../src/platform/time.ts';
import { abrirApp, limpiar, sembrarDespacho, urlApp, type Despacho } from './ayuda.ts';
import { clasificadorFijo, dependencias, gestorMediaFalso, mensajeriaFalsa } from './dobles.ts';

const db = abrirApp();
let cola: ColaPgBoss;
let a: Despacho;

const COLA_PRUEBA = 'prueba.orden';
const COLA_PROGRAMADA = 'prueba.programada';
/**
 * Cola aparte para la política: la de los crones queda con un `schedule` registrado, y el
 * relojero de pg-boss puede encolarle una pasada en cualquier momento. Mezclar las dos
 * haría que este test fallara según el segundo en que corriera.
 */
const COLA_EXCLUSIVA = 'prueba.exclusiva';

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
  await cola.arrancar([
    { nombre: COLA_MENSAJE_ENTRANTE, politica: 'key_strict_fifo' },
    { nombre: COLA_PRUEBA, politica: 'key_strict_fifo' },
    { nombre: COLA_PROGRAMADA, politica: 'exclusive' },
    { nombre: COLA_EXCLUSIVA, politica: 'exclusive' },
  ]);

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
  /**
   * El cron queda guardado en Postgres y sobrevive a la suite: sin quitarlo, la base local
   * sigue encolando trabajos para una cola que ya nadie atiende, y la siguiente corrida
   * empieza con basura que no es suya.
   */
  await cola.desprogramar(COLA_PROGRAMADA);
  await cola.vaciar(COLA_PROGRAMADA);
  await cola.vaciar(COLA_EXCLUSIVA);
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

async function abrirConversacion(contactoId: string, estado = 'INICIO'): Promise<string> {
  return enTenant(db, a.tenantId, async (tx) => {
    const { rows } = await tx.execute<{ id: string }>(sql`
      INSERT INTO conversaciones (tenant_id, contacto_id, estado, flow_version, expira_at)
      VALUES (${a.tenantId}::uuid, ${contactoId}::uuid, ${estado}, ${FLOW_VERSION},
              now() + interval '24 hours')
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

  /** Guarda un mensaje entrante como lo dejaría el webhook, y devuelve su wa_message_id. */
  async function entrante(conversacionId: string, waMessageId: string, cuerpo: string): Promise<string> {
    await enTenant(db, a.tenantId, (tx) =>
      tx.execute(sql`
        INSERT INTO mensajes (tenant_id, conversacion_id, wa_message_id, direccion, tipo, payload)
        VALUES (${a.tenantId}::uuid, ${conversacionId}::uuid, ${waMessageId}, 'entrante', 'text',
                ${JSON.stringify({
                  from: '593990000000',
                  id: waMessageId,
                  timestamp: '1757000000',
                  type: 'text',
                  text: { body: cuerpo },
                })}::jsonb)
      `),
    );
    return waMessageId;
  }

  function trabajoDe(conversacionId: string, waMessageId: string) {
    return { tenantId: a.tenantId, conversacionId, contactoId: a.contactoId, waMessageId };
  }

  it('el primer mensaje saluda, se identifica como sistema y pide consentimiento', async () => {
    const conversacionId = await abrirConversacion(a.contactoId);
    await entrante(conversacionId, 'wamid.1', 'hola');

    const correo = mensajeriaFalsa();
    // Con gestor de media: la bienvenida lleva nota de voz, y lo que va en el mensaje es el
    // `media_id` que devolvió WhatsApp, no la clave con la que la llamamos nosotros.
    const { mediaDe } = gestorMediaFalso();
    const procesar = crearProcesarMensajeEntrante(
      dependencias(db, correo.puerto, clasificadorFijo(null), undefined, mediaDe),
    );
    await procesar(trabajoDe(conversacionId, 'wamid.1'));

    expect(correo.envios.map((e) => e.tipo)).toEqual(['texto', 'audio', 'botones']);
    expect(correo.envios[1]!.cuerpo).toBe('media-de-bienvenida');
    // §0: el bot se identifica como tal en el primer mensaje.
    expect(correo.envios[0]!.cuerpo).toMatch(/automático|no una persona/);
    expect(correo.envios[0]!.cuerpo).toContain('Estudio despacho-a');
    expect(correo.envios[2]!.opciones).toEqual(['acepto', 'no_acepto']);

    const { rows } = await enTenant(db, a.tenantId, (tx) =>
      tx.execute<{ estado: string }>(sql`SELECT estado FROM conversaciones WHERE id = ${conversacionId}::uuid`),
    );
    expect(rows[0]!.estado).toBe('CONSENTIMIENTO');
    expect(await eventosDe(conversacionId)).toEqual(['mensaje.procesado']);
  });

  it('el menú ofrece las materias del despacho más la salida a una persona', async () => {
    const conversacionId = await abrirConversacion(a.contactoId, 'CONSENTIMIENTO');
    await entrante(conversacionId, 'wamid.2', 'acepto');

    const correo = mensajeriaFalsa();
    const procesar = crearProcesarMensajeEntrante(dependencias(db, correo.puerto, clasificadorFijo('acepto')));
    await procesar(trabajoDe(conversacionId, 'wamid.2'));

    const lista = correo.envios.find((e) => e.tipo === 'lista');
    expect(lista?.opciones).toEqual(['laboral', 'transito', 'persona']);
  });

  it('al tercer fallo consecutivo deriva a una persona y deja de responder', async () => {
    const conversacionId = await abrirConversacion(a.contactoId, 'CONSENTIMIENTO');
    const correo = mensajeriaFalsa();
    // El clasificador nunca entiende: es el caso que el escalado existe para cortar.
    const procesar = crearProcesarMensajeEntrante(dependencias(db, correo.puerto, clasificadorFijo(null)));

    for (const n of [1, 2, 3]) {
      await entrante(conversacionId, `wamid.f${n}`, 'ashdkjashd');
      await procesar(trabajoDe(conversacionId, `wamid.f${n}`));
    }

    const { rows } = await enTenant(db, a.tenantId, (tx) =>
      tx.execute<{ estado: string; derivada_motivo: string | null }>(
        sql`SELECT estado, derivada_motivo FROM conversaciones WHERE id = ${conversacionId}::uuid`,
      ),
    );
    expect(rows[0]!.estado).toBe('DERIVADA');
    expect(rows[0]!.derivada_motivo).toBe('tres_fallos');

    // Cuarto mensaje: el bot ya no contesta.
    const antes = correo.envios.length;
    await entrante(conversacionId, 'wamid.f4', 'sigo aquí');
    await procesar(trabajoDe(conversacionId, 'wamid.f4'));
    expect(correo.envios).toHaveLength(antes);
    expect(await eventosDe(conversacionId)).toContain('mensaje.ignorado_por_derivacion');
  });

  it('pedir una persona deriva en cualquier momento, sin pasar por el modelo', async () => {
    const conversacionId = await abrirConversacion(a.contactoId, 'MENU');
    await entrante(conversacionId, 'wamid.p', 'persona');

    const correo = mensajeriaFalsa();
    // Clasificador que devolvería otra cosa: el intent global no debe consultarlo.
    const procesar = crearProcesarMensajeEntrante(dependencias(db, correo.puerto, clasificadorFijo('laboral')));
    await procesar(trabajoDe(conversacionId, 'wamid.p'));

    const { rows } = await enTenant(db, a.tenantId, (tx) =>
      tx.execute<{ estado: string; derivada_motivo: string | null }>(
        sql`SELECT estado, derivada_motivo FROM conversaciones WHERE id = ${conversacionId}::uuid`,
      ),
    );
    expect(rows[0]!.estado).toBe('DERIVADA');
    expect(rows[0]!.derivada_motivo).toBe('peticion_usuario');
  });

  it('la ventana vencida reinicia al menú en vez de fallar', async () => {
    const conversacionId = await abrirConversacion(a.contactoId, 'ELEGIR_HORA');
    await enTenant(db, a.tenantId, (tx) =>
      tx.execute(sql`UPDATE conversaciones SET expira_at = now() - interval '1 hour' WHERE id = ${conversacionId}::uuid`),
    );
    await entrante(conversacionId, 'wamid.v', 'las tres');

    const correo = mensajeriaFalsa();
    const procesar = crearProcesarMensajeEntrante(dependencias(db, correo.puerto));
    await procesar(trabajoDe(conversacionId, 'wamid.v'));

    expect(correo.cuerpos()[0]).toContain('24 horas');
    const { rows } = await enTenant(db, a.tenantId, (tx) =>
      tx.execute<{ estado: string; expirada: boolean }>(
        sql`SELECT estado, expira_at < now() AS expirada FROM conversaciones WHERE id = ${conversacionId}::uuid`,
      ),
    );
    expect(rows[0]!.estado).toBe('MENU');
    // Y la ventana quedó renovada: si no, cada mensaje siguiente reiniciaría otra vez.
    expect(rows[0]!.expirada).toBe(false);
  });

  it('una conversación abierta con otra versión del guion se reinicia limpiamente', async () => {
    const conversacionId = await abrirConversacion(a.contactoId, 'ELEGIR_HORA');
    await enTenant(db, a.tenantId, (tx) =>
      tx.execute(sql`UPDATE conversaciones SET flow_version = 999 WHERE id = ${conversacionId}::uuid`),
    );
    await entrante(conversacionId, 'wamid.g', 'las tres');

    const correo = mensajeriaFalsa();
    const procesar = crearProcesarMensajeEntrante(dependencias(db, correo.puerto));
    await procesar(trabajoDe(conversacionId, 'wamid.g'));

    expect(correo.cuerpos()[0]).toContain('Actualizamos');
  });

  it('el FOR UPDATE serializa aunque dos trabajadores coincidan', async () => {
    const conversacionId = await abrirConversacion(a.contactoId, 'CONSENTIMIENTO');
    await entrante(conversacionId, 'wamid.c1', 'acepto');
    await entrante(conversacionId, 'wamid.c2', 'acepto');

    // La demora ocurre dentro del bloqueo: si se solaparan, los envíos se intercalarían.
    const correo = mensajeriaFalsa(200);
    const procesar = crearProcesarMensajeEntrante(dependencias(db, correo.puerto, clasificadorFijo('acepto')));

    const inicio = Date.now();
    await Promise.all([
      procesar(trabajoDe(conversacionId, 'wamid.c1')),
      procesar(trabajoDe(conversacionId, 'wamid.c2')),
    ]);

    expect(Date.now() - inicio).toBeGreaterThanOrEqual(400);
    // Dos turnos, cada uno con su evento de turno. Se cuentan esos y no el total: el
    // primero registra además el consentimiento, y eso no dice nada sobre la serialización.
    const deTurno = (await eventosDe(conversacionId)).filter((t) => t !== 'consentimiento');
    expect(deTurno).toHaveLength(2);
  });

  it('una conversación que ya no existe no revienta el trabajador', async () => {
    const correo = mensajeriaFalsa();
    const procesar = crearProcesarMensajeEntrante(dependencias(db, correo.puerto));
    await expect(
      procesar({
        tenantId: a.tenantId,
        conversacionId: '00000000-0000-4000-8000-000000000000',
        contactoId: a.contactoId,
        waMessageId: 'wamid.X',
      }),
    ).resolves.toBeUndefined();
    expect(correo.envios).toHaveLength(0);
  });
});

describe('cola · trabajos programados (fase 6)', () => {
  async function horarios(): Promise<{ name: string; cron: string; timezone: string }[]> {
    const { rows } = await db.execute<{ name: string; cron: string; timezone: string }>(
      sql`SELECT name, cron, timezone FROM pgboss.schedule WHERE name = ${COLA_PROGRAMADA}`,
    );
    return rows;
  }

  it('programar deja el cron guardado en Postgres, con su zona', async () => {
    await cola.programar(COLA_PROGRAMADA, '0 9 * * *', ZONA);

    expect(await horarios()).toEqual([
      { name: COLA_PROGRAMADA, cron: '0 9 * * *', timezone: ZONA },
    ]);
  });

  it('volver a programar sustituye, no duplica: el arranque es idempotente', async () => {
    // Un despliegue vuelve a llamar a `programar` en cada arranque, y dos procesos a la vez
    // lo hacen dos veces. Si eso apilara entradas, el job correría por duplicado.
    await cola.programar(COLA_PROGRAMADA, '0 9 * * *', ZONA);
    await cola.programar(COLA_PROGRAMADA, '*/5 * * * *', ZONA);

    const guardados = await horarios();
    expect(guardados).toHaveLength(1);
    expect(guardados[0]!.cron).toBe('*/5 * * * *');
  });

  it('la política exclusive impide que dos pasadas del mismo job se apilen', async () => {
    // La cola vive en Postgres y sobrevive a la suite: sin vaciarla, un trabajo colgado de
    // una ejecución anterior haría fallar ya el primer encolado.
    await cola.vaciar(COLA_EXCLUSIVA);

    const primero = await cola.encolar(COLA_EXCLUSIVA, {}, { clave: COLA_EXCLUSIVA });
    const segundo = await cola.encolar(COLA_EXCLUSIVA, {}, { clave: COLA_EXCLUSIVA });

    expect(primero).not.toBeNull();
    // Si la pasada anterior sigue en cola, la siguiente no entra: es justo lo que evita que
    // un relay lento acabe con sesenta copias encoladas en una hora.
    expect(segundo).toBeNull();
  });

  it('todas las colas programadas tienen cron, y ninguno es más frecuente que el minuto', () => {
    for (const nombre of [
      COLA_RELAY_OUTBOX,
      COLA_SINCRONIZAR_AGENDA,
      COLA_ENVIAR_RECORDATORIOS,
      COLA_APLICAR_RETENCION,
      COLA_REFRESCAR_MEDIA,
    ]) {
      const cron = CRON_PROGRAMADO[nombre];
      expect(cron, nombre).toBeDefined();
      expect(cron!.split(' ')).toHaveLength(5);
    }
  });
});
