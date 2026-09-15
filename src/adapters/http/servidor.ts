/**
 * Arranque: servidor HTTP y trabajadores en el mismo proceso (D2).
 *
 * El puente con `node:http` está escrito a mano en vez de usar `@hono/node-server` porque
 * ese paquete no está en el stack de §2 y la regla del proyecto es preguntar antes de
 * añadir dependencias. Son treinta líneas y el webhook es la única ruta que recibe cuerpo;
 * si el panel de la fase 7 necesita algo más (streaming, ficheros), toca revisarlo.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { pathToFileURL } from 'node:url';
import { sql } from 'drizzle-orm';
import type { Hono } from 'hono';
import { crearClasificador } from '../anthropic/clasificador.ts';
import { crearCola } from '../cola/pgboss.ts';
import { crearCatalogos } from '../postgres/catalogos.ts';
import { crearCredencialesDe, crearRepoBloqueos } from '../postgres/bloqueos.ts';
import { crearRepoOutbox } from '../postgres/outbox.ts';
import { crearCalendarioDe, idDeEvento } from '../google/calendario.ts';
import { crearManejadoresGoogle } from '../../app/efectosGoogle.ts';
import { importarBloqueos } from '../../app/importarBloqueos.ts';
import { relayOutbox } from '../../app/relayOutbox.ts';
import type { CalendarioDe } from '../../app/puertos/Calendario.ts';
import { crearRepoCitas } from '../postgres/reservas.ts';
import { crearReloj } from '../reloj.ts';
import { POLITICA } from '../../domain/agenda/politicas.ts';
import { crearBaseDatos } from '../postgres/db.ts';
import { crearRepoConversaciones } from '../postgres/repoConversaciones.ts';
import { credencialesDe } from '../postgres/tenants.ts';
import { crearMensajeria } from '../whatsapp/cliente.ts';
import { crearProcesarMensajeEntrante } from '../../app/procesarMensajeEntrante.ts';
import { contenidoDe } from '../../app/content.ts';
import { COLA_MENSAJE_ENTRANTE, type TrabajoMensajeEntrante } from '../../app/puertos/Cola.ts';
import type { Mensajeria } from '../../app/puertos/Mensajeria.ts';
import { FLOW_VERSION } from '../../domain/conversacion/version.ts';
import { cargarConfig } from '../../platform/config.ts';
import { logger } from '../../platform/logger.ts';
import { crearWebhook } from './webhook.ts';

async function aRequest(peticion: IncomingMessage, origen: string): Promise<Request> {
  const url = new URL(peticion.url ?? '/', origen);
  const metodo = peticion.method ?? 'GET';
  const cabeceras = new Headers();
  for (const [clave, valor] of Object.entries(peticion.headers)) {
    if (typeof valor === 'string') cabeceras.set(clave, valor);
    else if (Array.isArray(valor)) for (const v of valor) cabeceras.append(clave, v);
  }

  if (metodo === 'GET' || metodo === 'HEAD') {
    return new Request(url, { method: metodo, headers: cabeceras });
  }
  const trozos: Buffer[] = [];
  for await (const trozo of peticion) trozos.push(trozo as Buffer);
  return new Request(url, { method: metodo, headers: cabeceras, body: Buffer.concat(trozos) });
}

async function responder(respuesta: Response, salida: ServerResponse): Promise<void> {
  salida.writeHead(respuesta.status, Object.fromEntries(respuesta.headers));
  salida.end(Buffer.from(await respuesta.arrayBuffer()));
}

export function servir(app: Hono, puerto: number) {
  return createServer((peticion, salida) => {
    void (async () => {
      try {
        const respuesta = await app.fetch(await aRequest(peticion, `http://localhost:${puerto}`));
        await responder(respuesta, salida);
      } catch (error) {
        logger.error({ err: error }, 'fallo sirviendo la peticion');
        salida.writeHead(500).end();
      }
    })();
  }).listen(puerto);
}

async function main(): Promise<void> {
  const config = cargarConfig();
  const db = crearBaseDatos(config.DATABASE_URL);
  const cola = crearCola(config.DATABASE_URL);

  /**
   * Mensajería por despacho: el token y el `phone_number_id` son de cada uno. Se resuelve
   * en cada turno porque rotar un token no debe exigir reiniciar el proceso; si el volumen
   * lo pidiera, aquí es donde iría una caché con expiración corta.
   */
  async function mensajeriaDe(tenantId: string): Promise<Mensajeria> {
    const { rows } = await db.execute(
      sql`SELECT wa_phone_number_id FROM tenants WHERE id = ${tenantId}::uuid`,
    );
    const phoneNumberId = (rows[0] as { wa_phone_number_id?: string } | undefined)?.wa_phone_number_id;
    if (phoneNumberId === undefined) throw new Error(`Despacho desconocido: ${tenantId}`);

    const credenciales = await credencialesDe(db, tenantId, phoneNumberId, config.CLAVE_CIFRADO_HEX);
    if (credenciales === null) throw new Error(`Despacho sin credenciales: ${tenantId}`);

    return crearMensajeria({ phoneNumberId, token: credenciales.token });
  }

  const reloj = crearReloj();
  const repoCitas = crearRepoCitas(db);
  const repoOutbox = crearRepoOutbox(db);
  const repoBloqueos = crearRepoBloqueos(db);

  /**
   * Sin credenciales de Google no hay espejo que mantener, y eso no impide operar: la
   * agenda vive en Postgres (D4). El calendario nulo hace que los efectos de `outbox` se
   * publiquen sin hacer nada en vez de fallar cinco veces y alertar al estudio por algo que
   * no está mal configurado, sino que no está configurado.
   */
  const calendarioDe: CalendarioDe =
    config.GOOGLE_CLIENT_ID === undefined || config.GOOGLE_CLIENT_SECRET === undefined
      ? async () => null
      : crearCalendarioDe({
          clientId: config.GOOGLE_CLIENT_ID,
          clientSecret: config.GOOGLE_CLIENT_SECRET,
          credencialesDe: crearCredencialesDe(db, config.CLAVE_CIFRADO_HEX),
        });

  const manejadores = crearManejadoresGoogle({ repoCitas, calendarioDe, idDeEvento });

  await cola.arrancar([COLA_MENSAJE_ENTRANTE]);
  await cola.trabajar<TrabajoMensajeEntrante>(
    COLA_MENSAJE_ENTRANTE,
    crearProcesarMensajeEntrante({
      repo: crearRepoConversaciones(db),
      mensajeria: mensajeriaDe,
      clasificador: crearClasificador(),
      catalogos: crearCatalogos({ db, repo: repoCitas, reloj, politica: POLITICA }),
      repoCitas,
      politica: POLITICA,
      // Fase 7: los textos propios de cada despacho saldrán de su configuración.
      contenido: async () => contenidoDe(),
      flowVersion: FLOW_VERSION,
      registro: logger,
    }),
  );

  const app = crearWebhook({
    db,
    cola,
    claveCifradoHex: config.CLAVE_CIFRADO_HEX,
    verifyToken: config.WA_VERIFY_TOKEN ?? '',
  });

  /**
   * Relay e importación de bloqueos en bucle. La fase 6 los mueve a trabajos programados de
   * pg-boss; mientras tanto esto es lo que hace que la `outbox` se publique de verdad.
   *
   * `enCurso` evita que una pasada lenta se solape con la siguiente: dos relays a la vez no
   * romperían nada —el `FOR UPDATE SKIP LOCKED` y el arriendo están para eso— pero sí
   * gastarían intentos por duplicado.
   */
  let enCurso = false;
  const cadaMinuto = setInterval(() => {
    if (enCurso) return;
    enCurso = true;
    void relayOutbox({ repo: repoOutbox, manejadores, registro: logger })
      .catch((error: unknown) => logger.error({ err: error }, 'el relay del outbox falló'))
      .finally(() => {
        enCurso = false;
      });
  }, 60_000);
  cadaMinuto.unref();

  const cadaCincoMinutos = setInterval(() => {
    void (async () => {
      for (const tenantId of await repoOutbox.tenantsConPendientes(50)) {
        await importarBloqueos(
          { repo: repoBloqueos, calendarioDe, reloj, politica: POLITICA, registro: logger },
          tenantId,
        );
      }
    })().catch((error: unknown) => logger.error({ err: error }, 'la importación de bloqueos falló'));
  }, 5 * 60_000);
  cadaCincoMinutos.unref();

  const puerto = Number(process.env.PUERTO ?? 3000);
  servir(app, puerto);
  logger.info({ puerto, google: config.GOOGLE_CLIENT_ID !== undefined }, 'providencia en marcha');
}

/**
 * Arrancar solo cuando este archivo ES el programa, no cuando alguien lo importa. La
 * versión anterior miraba `NODE_ENV`, así que bastaba con que un test olvidara ponerlo a
 * `test` para levantar un servidor y abrir un pool de verdad al importar el módulo.
 */
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
