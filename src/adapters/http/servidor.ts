/**
 * Arranque: servidor HTTP y trabajadores en el mismo proceso (D2).
 *
 * El puente con `node:http` está escrito a mano en vez de usar `@hono/node-server` porque
 * ese paquete no está en el stack de §2 y la regla del proyecto es preguntar antes de
 * añadir dependencias. Son treinta líneas y el webhook es la única ruta que recibe cuerpo;
 * si el panel de la fase 7 necesita algo más (streaming, ficheros), toca revisarlo.
 */
import { createHash, randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { pathToFileURL } from 'node:url';
import { sql } from 'drizzle-orm';
import type { Hono } from 'hono';
import { crearClasificador } from '../anthropic/clasificador.ts';
import { crearCola, type EspecificacionCola } from '../cola/pgboss.ts';
import { crearCatalogos } from '../postgres/catalogos.ts';
import { crearCredencialesDe, crearRepoBloqueos } from '../postgres/bloqueos.ts';
import { crearRepoOutbox } from '../postgres/outbox.ts';
import { crearRepoMantenimiento, crearRepoRecordatorios } from '../postgres/mantenimiento.ts';
import { crearAuditoria, crearRepoPanel } from '../postgres/panel.ts';
import { crearRepoAuth } from '../postgres/auth.ts';
import { crearRepoExportacion } from '../postgres/exportacion.ts';
import { crearPasskeysNoDisponible } from '../webauthn/passkeys.ts';
import { crearCalendarioDe, idDeEvento } from '../google/calendario.ts';
import { crearManejadoresGoogle } from '../../app/efectosGoogle.ts';
import { importarBloqueos } from '../../app/importarBloqueos.ts';
import { relayOutbox } from '../../app/relayOutbox.ts';
import { crearManejadoresWhatsApp } from '../../app/efectosWhatsApp.ts';
import { enviarRecordatorios } from '../../app/enviarRecordatorios.ts';
import { refrescarMedia } from '../../app/refrescarMedia.ts';
import { aplicarRetencion } from '../../app/retencion.ts';
import type { CalendarioDe } from '../../app/puertos/Calendario.ts';
import { crearRepoCitas } from '../postgres/reservas.ts';
import { crearReloj } from '../reloj.ts';
import { POLITICA } from '../../domain/agenda/politicas.ts';
import { crearBaseDatos } from '../postgres/db.ts';
import { crearRepoConversaciones } from '../postgres/repoConversaciones.ts';
import { crearDespachos, credencialesDe } from '../postgres/tenants.ts';
import { crearMensajeria } from '../whatsapp/cliente.ts';
import { crearMediaDe } from '../whatsapp/media.ts';
import { crearProcesarMensajeEntrante } from '../../app/procesarMensajeEntrante.ts';
import { contenidoDe } from '../../app/content.ts';
import {
  COLA_APLICAR_RETENCION,
  COLA_ENVIAR_RECORDATORIOS,
  COLA_MENSAJE_ENTRANTE,
  COLA_REFRESCAR_MEDIA,
  COLA_RELAY_OUTBOX,
  COLA_SINCRONIZAR_AGENDA,
  CRON_PROGRAMADO,
  type TrabajoMensajeEntrante,
} from '../../app/puertos/Cola.ts';
import type { Mensajeria } from '../../app/puertos/Mensajeria.ts';
import { FLOW_VERSION } from '../../domain/conversacion/version.ts';
import { cargarConfig } from '../../platform/config.ts';
import { logger } from '../../platform/logger.ts';
import { ZONA } from '../../platform/time.ts';
import { crearWebhook } from './webhook.ts';
import { crearPanel } from './panel/rutas.ts';
import { crearEstaticos } from './panel/estaticos.ts';

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
   * Credenciales de WhatsApp de un despacho. Se resuelven en cada uso porque rotar un token
   * no debe exigir reiniciar el proceso; si el volumen lo pidiera, aquí es donde iría una
   * caché con expiración corta.
   */
  async function credencialesWhatsApp(
    tenantId: string,
  ): Promise<{ phoneNumberId: string; token: string } | null> {
    const { rows } = await db.execute(
      sql`SELECT wa_phone_number_id FROM tenants WHERE id = ${tenantId}::uuid`,
    );
    const phoneNumberId = (rows[0] as { wa_phone_number_id?: string } | undefined)?.wa_phone_number_id;
    if (phoneNumberId === undefined) return null;

    const credenciales = await credencialesDe(db, tenantId, phoneNumberId, config.CLAVE_CIFRADO_HEX);
    if (credenciales === null) return null;

    return { phoneNumberId, token: credenciales.token };
  }

  /**
   * Para el camino conversacional sí es un error no poder responder: el usuario está
   * esperando. Los trabajos programados usan la versión que devuelve `null`.
   */
  async function mensajeriaDe(tenantId: string): Promise<Mensajeria> {
    const credenciales = await credencialesWhatsApp(tenantId);
    if (credenciales === null) throw new Error(`Despacho sin credenciales de WhatsApp: ${tenantId}`);
    return crearMensajeria(credenciales);
  }

  const reloj = crearReloj();
  const repoCitas = crearRepoCitas(db);
  const repoOutbox = crearRepoOutbox(db);
  const repoBloqueos = crearRepoBloqueos(db);
  const repoMantenimiento = crearRepoMantenimiento(db);
  const auditoria = crearAuditoria(db);
  const repoAuth = crearRepoAuth(db);
  const repoRecordatorios = crearRepoRecordatorios(db);
  const despachos = crearDespachos(db);
  const mediaDe = crearMediaDe({ db, credencialesDe: credencialesWhatsApp });

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

  /**
   * Un solo mapa de manejadores para el relay: el tipo del trabajo decide a dónde va. Que
   * el recordatorio de WhatsApp salga por el mismo camino que el espejo de Google no es
   * casualidad — es la regla de que **todo** efecto externo pasa por `outbox`.
   */
  const manejadores = {
    ...crearManejadoresGoogle({ repoCitas, calendarioDe, idDeEvento }),
    ...crearManejadoresWhatsApp({ repoCitas, mensajeriaDe, reloj }),
  };

  const especificaciones: readonly EspecificacionCola[] = [
    { nombre: COLA_MENSAJE_ENTRANTE, politica: 'key_strict_fifo' },
    ...Object.keys(CRON_PROGRAMADO).map<EspecificacionCola>((nombre) => ({
      nombre,
      politica: 'exclusive',
    })),
  ];

  await cola.arrancar(especificaciones);
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
   * El panel (§9). Se monta sobre la misma aplicación que el webhook: son tres abogados y
   * un proceso, y separarlos solo añadiría un contenedor que mantener.
   *
   * WebAuthn va detrás de un puerto y **falla cerrado** mientras `@simplewebauthn/server` no
   * esté instalado: el panel se sirve y nadie entra. Un «mientras tanto» que dejara pasar
   * sería peor que no tener panel.
   */
  app.route(
    '/',
    crearPanel({
      db,
      panel: { repo: crearRepoPanel(db), auditoria, reloj },
      auth: {
        repo: repoAuth,
        passkeys: crearPasskeysNoDisponible(),
        reloj,
        auditoria,
        // 32 bytes de aleatoriedad criptográfica: el testigo de sesión es lo único que
        // separa a un desconocido de la agenda del estudio.
        generarToken: () => randomBytes(32).toString('hex'),
        hashear: (token) => createHash('sha256').update(token).digest('hex'),
      },
      exportacion: crearRepoExportacion(db),
      reloj,
      // Sobre http en local el navegador descarta una cookie `Secure` y nadie entra nunca.
      cookieSegura: config.NODE_ENV === 'production',
      estaticos: crearEstaticos(),
    }),
  );

  /**
   * Los cinco trabajos programados (§8).
   *
   * Todos recorren los despachos uno a uno: bajo RLS no existe una consulta que los vea a
   * todos, y fijar `app.tenant_id` es lo que hace que cada vuelta solo toque sus datos. Un
   * despacho que falle no puede llevarse por delante a los demás, así que cada vuelta va en
   * su propio `try`.
   */
  async function porCadaDespacho(
    etiqueta: string,
    hacer: (tenantId: string) => Promise<void>,
  ): Promise<void> {
    for (const tenantId of await despachos.activos()) {
      try {
        await hacer(tenantId);
      } catch (error) {
        logger.error({ err: error, tenantId, trabajo: etiqueta }, 'el trabajo programado falló');
      }
    }
  }

  // El relay ya recorre los despachos por dentro y solo visita los que tienen pendientes.
  await cola.trabajar(COLA_RELAY_OUTBOX, async () => {
    await relayOutbox({ repo: repoOutbox, manejadores, registro: logger });
  });

  await cola.trabajar(COLA_SINCRONIZAR_AGENDA, () =>
    porCadaDespacho(COLA_SINCRONIZAR_AGENDA, (tenantId) =>
      importarBloqueos(
        { repo: repoBloqueos, calendarioDe, reloj, politica: POLITICA, registro: logger },
        tenantId,
      ).then(() => undefined),
    ),
  );

  await cola.trabajar(COLA_ENVIAR_RECORDATORIOS, () =>
    porCadaDespacho(COLA_ENVIAR_RECORDATORIOS, async (tenantId) => {
      const encolados = await enviarRecordatorios(
        { repo: repoRecordatorios, outbox: repoOutbox, reloj },
        tenantId,
      );
      if (encolados > 0) logger.info({ tenantId, encolados }, 'recordatorios encolados');
    }),
  );

  await cola.trabajar(COLA_APLICAR_RETENCION, () =>
    porCadaDespacho(COLA_APLICAR_RETENCION, async (tenantId) => {
      const resumen = await aplicarRetencion({ repo: repoMantenimiento, reloj }, tenantId);
      // Retos vencidos y sesiones caducadas: no son datos personales, pero dejarlos crecer
      // convierte dos tablas pequeñas en dos tablas grandes sin que nadie lo note.
      const purgado = await repoAuth.purgar(tenantId);
      logger.info({ tenantId, ...resumen, ...purgado }, 'retención aplicada');
    }),
  );

  await cola.trabajar(COLA_REFRESCAR_MEDIA, () =>
    porCadaDespacho(COLA_REFRESCAR_MEDIA, async (tenantId) => {
      const renovados = await refrescarMedia(
        { repo: repoMantenimiento, mediaDe, reloj, registro: logger },
        tenantId,
      );
      if (renovados > 0) logger.info({ tenantId, renovados }, 'media_id renovados');
    }),
  );

  /**
   * El cron lo guarda pg-boss en Postgres, así que sobrevive al reinicio y no se duplica
   * aunque arranquen dos procesos: volver a programar la misma cola sustituye la entrada.
   */
  for (const [nombre, cron] of Object.entries(CRON_PROGRAMADO)) {
    await cola.programar(nombre, cron, ZONA);
  }

  const puerto = Number(process.env.PUERTO ?? 3000);
  servir(app, puerto);
  logger.info(
    {
      puerto,
      google: config.GOOGLE_CLIENT_ID !== undefined,
      programados: Object.keys(CRON_PROGRAMADO).length,
    },
    'providencia en marcha',
  );
}

/**
 * Arrancar solo cuando este archivo ES el programa, no cuando alguien lo importa. La
 * versión anterior miraba `NODE_ENV`, así que bastaba con que un test olvidara ponerlo a
 * `test` para levantar un servidor y abrir un pool de verdad al importar el módulo.
 */
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
