/**
 * Arranque: servidor HTTP y trabajadores en el mismo proceso (D2).
 *
 * El puente con `node:http` está escrito a mano en vez de usar `@hono/node-server` porque
 * ese paquete no está en el stack de §2 y la regla del proyecto es preguntar antes de
 * añadir dependencias. Son treinta líneas y el webhook es la única ruta que recibe cuerpo;
 * si el panel de la fase 7 necesita algo más (streaming, ficheros), toca revisarlo.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { Hono } from 'hono';
import { crearCola } from '../cola/pgboss.ts';
import { crearBaseDatos } from '../postgres/db.ts';
import { crearRepoConversaciones } from '../postgres/repoConversaciones.ts';
import { crearProcesarMensajeEntrante } from '../../app/procesarMensajeEntrante.ts';
import { COLA_MENSAJE_ENTRANTE, type TrabajoMensajeEntrante } from '../../app/puertos/Cola.ts';
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

  await cola.arrancar([COLA_MENSAJE_ENTRANTE]);
  await cola.trabajar<TrabajoMensajeEntrante>(
    COLA_MENSAJE_ENTRANTE,
    crearProcesarMensajeEntrante(crearRepoConversaciones(db)),
  );

  const app = crearWebhook({
    db,
    cola,
    claveCifradoHex: config.CLAVE_CIFRADO_HEX,
    verifyToken: config.WA_VERIFY_TOKEN ?? '',
  });

  const puerto = Number(process.env.PUERTO ?? 3000);
  servir(app, puerto);
  logger.info({ puerto }, 'providencia en marcha');
}

if (process.env.NODE_ENV !== 'test') {
  await main();
}
