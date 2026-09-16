/**
 * El panel (§9): una bandeja, no un tablero.
 *
 * Tres decisiones que explican la forma de este archivo:
 *
 *  - **El despacho va en la URL** (`/panel/<slug>`), igual que el `phone_number_id` va en el
 *    cuerpo del webhook: la página de acceso tiene que saber de qué estudio es antes de que
 *    exista una sesión de la que deducirlo. `tenants` es la única tabla legible sin fijar el
 *    tenant, y resolver un slug es exactamente para lo que existe esa excepción.
 *  - **Nada se lee sin sesión.** El middleware la resuelve una vez y la deja en el contexto;
 *    las rutas no vuelven a preguntar. Lo que no pasa por él —los estáticos— no toca la base.
 *  - **Toda lectura de datos personales va por un caso de uso**, no por el repositorio: es
 *    lo que garantiza que quede auditada. Si la ruta pudiera leer directo, algún día leería.
 */
import { Hono } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { html } from 'hono/html';
import {
  AccesoDenegado,
  cerrarSesion,
  iniciarAcceso,
  iniciarRegistro,
  sesionDe,
  terminarAcceso,
  terminarRegistro,
} from '../../../app/autenticar.ts';
import type { DependenciasAuth } from '../../../app/autenticar.ts';
import {
  GRACIA_MS,
  buscarContactos,
  cancelarDesdePanel,
  cerrarConversacion,
  deshacerCancelacion,
  hoyManana,
  marcarAsistencia,
  verFicha,
} from '../../../app/panel.ts';
import type { DependenciasPanel } from '../../../app/panel.ts';
import { exportarDatosContacto } from '../../../app/exportarDatosContacto.ts';
import { ContactoDesconocidoError } from '../../../app/exportarDatosContacto.ts';
import type { RepoExportacion } from '../../../app/puertos/RepoExportacion.ts';
import type { SesionPanel } from '../../../app/puertos/RepoAuth.ts';
import type { Reloj } from '../../../app/puertos/Reloj.ts';
import type { BaseDatos } from '../../postgres/db.ts';
import { resolverPorSlug } from '../../postgres/tenants.ts';
import { logger } from '../../../platform/logger.ts';
import {
  avisoCancelada,
  fichaContacto,
  filaAsistencia,
  resultadosBusqueda,
  filaNoSePudo,
  filaRestaurada,
  pantallaAcceso,
  pantallaAlta,
  pantallaAltaHecha,
  pantallaAltaUsada,
  pantallaHoyManana,
} from './vistas.ts';

export const COOKIE_SESION = 'providencia_panel';
export const PREFIJO = '/panel';

export interface DependenciasRutas {
  db: BaseDatos;
  panel: DependenciasPanel;
  auth: DependenciasAuth;
  exportacion: RepoExportacion;
  reloj: Reloj;
  /** `false` en desarrollo sobre http: sin esto el navegador descarta la cookie. */
  cookieSegura: boolean;
  estaticos: (nombre: string) => Promise<{ cuerpo: string; tipo: string } | null>;
}

interface Estado {
  Variables: { tenantId: string; slug: string; sesion: SesionPanel };
}

/**
 * Cabeceras de seguridad. Van aquí y no solo en Caddy porque el panel puede servirse detrás
 * de otra cosa el día de mañana, y una política que depende del proxy es una política que
 * se pierde en la primera mudanza.
 */
function cabecerasDeSeguridad(cabeceras: Headers): void {
  cabeceras.set(
    'content-security-policy',
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
  );
  cabeceras.set('x-content-type-options', 'nosniff');
  cabeceras.set('referrer-policy', 'no-referrer');
  cabeceras.set('permissions-policy', 'geolocation=(), camera=(), microphone=()');
  // El panel no se cachea: las páginas llevan nombres y cédulas de personas.
  cabeceras.set('cache-control', 'no-store');
}

export function crearPanel(deps: DependenciasRutas): Hono<Estado> {
  const app = new Hono<Estado>();

  app.use('*', async (c, siguiente) => {
    await siguiente();
    cabecerasDeSeguridad(c.res.headers);
  });

  /**
   * Los estáticos se sirven antes de resolver nada: no dependen del despacho, no tocan la
   * base y son los mismos para todos.
   */
  app.get(`${PREFIJO}/estatico/:nombre`, async (c) => {
    const archivo = await deps.estaticos(c.req.param('nombre'));
    if (archivo === null) return c.text('no encontrado', 404);
    return c.body(archivo.cuerpo, 200, {
      'content-type': archivo.tipo,
      // Vendorizados y con versión fija: se pueden cachear de verdad.
      'cache-control': 'public, max-age=86400',
    });
  });

  app.use(`${PREFIJO}/:slug/*`, async (c, siguiente) => {
    const slug = c.req.param('slug');
    const tenant = await resolverPorSlug(deps.db, slug);
    if (tenant === null) return c.text('no encontrado', 404);

    c.set('tenantId', tenant.id);
    c.set('slug', slug);
    await siguiente();
  });

  const base = (c: { get(k: 'slug'): string }): string => `${PREFIJO}/${c.get('slug')}`;

  // --- Acceso ---------------------------------------------------------------

  app.post(`${PREFIJO}/:slug/acceso/inicio`, async (c) => {
    try {
      const opciones = await iniciarAcceso(deps.auth, { tenantId: c.get('tenantId') });
      // El reto viaja al navegador para que lo devuelva: en el servidor ya está guardado
      // con su caducidad, y se consume al responder.
      return c.json({ opciones, reto: (opciones as { challenge: string }).challenge });
    } catch (error) {
      if (error instanceof AccesoDenegado) return c.json({ error: 'no se pudo entrar' }, 401);
      throw error;
    }
  });

  app.post(`${PREFIJO}/:slug/acceso/fin`, async (c) => {
    const cuerpo = (await c.req.json()) as {
      reto?: unknown;
      credencialId?: unknown;
      respuesta?: unknown;
    };
    if (typeof cuerpo.reto !== 'string' || typeof cuerpo.credencialId !== 'string') {
      return c.json({ error: 'peticion invalida' }, 400);
    }

    try {
      const acceso = await terminarAcceso(deps.auth, {
        tenantId: c.get('tenantId'),
        reto: cuerpo.reto,
        credencialId: cuerpo.credencialId,
        respuesta: cuerpo.respuesta,
      });

      setCookie(c, COOKIE_SESION, acceso.token, {
        httpOnly: true,
        secure: deps.cookieSegura,
        // `Strict` y no `Lax`: al panel se entra escribiendo la dirección, nunca desde un
        // enlace de fuera, así que no hay nada que se rompa y sí un CSRF que se evita.
        sameSite: 'Strict',
        path: base(c),
        expires: acceso.expiraAt,
      });

      return c.json({ ok: true });
    } catch (error) {
      if (error instanceof AccesoDenegado) {
        // Sin detalle y sin distinguir el motivo: un mensaje preciso convierte esto en un
        // comprobador de quién trabaja en el estudio.
        logger.warn({ tenantId: c.get('tenantId') }, 'acceso al panel denegado');
        return c.json({ error: 'no se pudo entrar' }, 401);
      }
      throw error;
    }
  });

  app.get(`${PREFIJO}/:slug/salir`, async (c) => {
    const token = getCookie(c, COOKIE_SESION);
    if (token !== undefined) await cerrarSesion(deps.auth, c.get('tenantId'), token);
    deleteCookie(c, COOKIE_SESION, { path: base(c) });
    return c.redirect(base(c));
  });

  // --- Alta de la primera passkey -------------------------------------------

  /**
   * El testigo va en la URL porque el abogado llega aquí desde un enlace que le pasó el
   * administrador. `Referrer-Policy: no-referrer` —arriba— es lo que impide que se escape
   * en la cabecera del primer enlace que pulse después.
   */
  app.get(`${PREFIJO}/:slug/alta/hecho`, (c) => c.html(pantallaAltaHecha(base(c))));

  app.get(`${PREFIJO}/:slug/alta/:token`, async (c) => {
    const token = c.req.param('token');
    const usuario = await deps.auth.repo.usuarioPorInvitacion(
      c.get('tenantId'),
      deps.auth.hashear(token),
    );
    // Una invitación gastada o caducada no dice si existió: solo que ya no sirve.
    if (usuario === null) return c.html(pantallaAltaUsada(base(c)), 404);

    return c.html(pantallaAlta(base(c), token, usuario.nombre));
  });

  app.post(`${PREFIJO}/:slug/alta/inicio`, async (c) => {
    const cuerpo = (await c.req.json()) as { invitacion?: unknown };
    if (typeof cuerpo.invitacion !== 'string') return c.json({ error: 'peticion invalida' }, 400);

    try {
      const opciones = await iniciarRegistro(deps.auth, {
        tenantId: c.get('tenantId'),
        invitacion: cuerpo.invitacion,
      });
      return c.json({ opciones, reto: (opciones as { challenge: string }).challenge });
    } catch (error) {
      if (error instanceof AccesoDenegado) return c.json({ error: 'no se pudo registrar' }, 401);
      throw error;
    }
  });

  app.post(`${PREFIJO}/:slug/alta/fin`, async (c) => {
    const cuerpo = (await c.req.json()) as { reto?: unknown; respuesta?: unknown };
    if (typeof cuerpo.reto !== 'string') return c.json({ error: 'peticion invalida' }, 400);

    try {
      await terminarRegistro(deps.auth, {
        tenantId: c.get('tenantId'),
        reto: cuerpo.reto,
        respuesta: cuerpo.respuesta,
      });
      return c.json({ ok: true });
    } catch (error) {
      if (error instanceof AccesoDenegado) {
        logger.warn({ tenantId: c.get('tenantId') }, 'alta de passkey denegada');
        return c.json({ error: 'no se pudo registrar' }, 401);
      }
      throw error;
    }
  });

  // --- A partir de aquí, sesión obligatoria ---------------------------------

  app.use(`${PREFIJO}/:slug/*`, async (c, siguiente) => {
    /**
     * Las rutas públicas del despacho: entrar, salir y darse de alta. La lista es explícita
     * y no un patrón: una ruta nueva bajo `/panel/:slug/` queda protegida por omisión, que
     * es el sentido en el que conviene equivocarse.
     */
    const ruta = c.req.path;
    const publica =
      ruta.includes('/acceso/') || ruta.includes('/alta/') || ruta.endsWith('/salir');
    if (publica) return siguiente();

    const token = getCookie(c, COOKIE_SESION);
    const sesion = token === undefined ? null : await sesionDe(deps.auth, c.get('tenantId'), token);

    if (sesion === null) {
      // Una petición de HTMX no puede recibir una página de acceso completa: la metería
      // dentro de una fila de la tabla. El 401 con esta cabecera hace que el navegador
      // navegue de verdad.
      if (c.req.header('hx-request') === 'true') {
        c.header('hx-redirect', base(c));
        return c.body(null, 401);
      }
      return c.html(pantallaAcceso(base(c)), 401);
    }

    c.set('sesion', sesion);
    await siguiente();
  });

  const actorDe = (c: { get(k: 'sesion'): SesionPanel }): string => `usuario:${c.get('sesion').usuario.id}`;

  // --- Pantalla principal ---------------------------------------------------

  app.get(`${PREFIJO}/:slug`, async (c) => {
    const datos = await hoyManana(deps.panel, {
      tenantId: c.get('tenantId'),
      actor: actorDe(c),
    });

    return c.html(
      pantallaHoyManana(
        base(c),
        datos,
        {
          hora: (ms) => deps.reloj.formatearHora(ms),
          fechaHora: (ms) => deps.reloj.formatearFechaHora(ms),
        },
        c.get('sesion').usuario.nombre,
      ),
    );
  });

  /** Destino del temporizador que borra el aviso de «deshacer» pasados los diez segundos. */
  app.get(`${PREFIJO}/:slug/vacio`, (c) => c.html(html``));

  /**
   * Buscador. Alcanza a quien no tiene cita hoy ni mañana, que es justo la llamada que
   * entra: «habló el señor Pérez, ¿cuándo viene?».
   */
  app.get(`${PREFIJO}/:slug/buscar`, async (c) => {
    const texto = c.req.query('q') ?? '';
    const encontrados = await buscarContactos(deps.panel, {
      tenantId: c.get('tenantId'),
      actor: actorDe(c),
      texto,
    });

    return c.html(
      resultadosBusqueda(base(c), encontrados, texto, (ms) => deps.reloj.formatearFechaHora(ms)),
    );
  });

  /**
   * Asistencia. Sin esto la tasa de ausencias no existe, y es la métrica con la que el
   * estudio decidirá si renueva.
   */
  app.post(`${PREFIJO}/:slug/citas/:citaId/asistencia`, async (c) => {
    const citaId = c.req.param('citaId');
    const vino = c.req.query('vino') === 'si';

    const marcada = await marcarAsistencia(deps.panel, {
      tenantId: c.get('tenantId'),
      actor: actorDe(c),
      citaId,
      vino,
    });

    if (!marcada) {
      return c.html(filaNoSePudo(citaId, 'Esa cita no se puede marcar todavía.'));
    }
    return c.html(filaAsistencia(citaId, vino));
  });

  // --- Ficha del contacto ---------------------------------------------------

  app.get(`${PREFIJO}/:slug/contactos/:contactoId`, async (c) => {
    const ficha = await verFicha(deps.panel, {
      tenantId: c.get('tenantId'),
      actor: actorDe(c),
      contactoId: c.req.param('contactoId'),
    });
    if (ficha === null) return c.html(html`<p class="vacio">Ese contacto ya no existe.</p>`, 404);

    return c.html(fichaContacto(base(c), ficha, (ms) => deps.reloj.formatearFechaHora(ms)));
  });

  /** Portabilidad LOPDP. Se descarga como archivo y queda auditada. */
  app.get(`${PREFIJO}/:slug/contactos/:contactoId/export.json`, async (c) => {
    const contactoId = c.req.param('contactoId');
    try {
      const expediente = await exportarDatosContacto(
        { repo: deps.exportacion, auditoria: deps.panel.auditoria },
        { tenantId: c.get('tenantId'), actor: actorDe(c), contactoId },
      );
      c.header('content-disposition', `attachment; filename="expediente-${contactoId}.json"`);
      return c.json(expediente);
    } catch (error) {
      if (error instanceof ContactoDesconocidoError) return c.json({ error: 'no encontrado' }, 404);
      throw error;
    }
  });

  // --- Citas ----------------------------------------------------------------

  app.post(`${PREFIJO}/:slug/citas/:citaId/cancelar`, async (c) => {
    const citaId = c.req.param('citaId');
    const cancelada = await cancelarDesdePanel(deps.panel, {
      tenantId: c.get('tenantId'),
      actor: actorDe(c),
      citaId,
    });

    if (!cancelada) return c.html(filaNoSePudo(citaId, 'Esa cita ya no estaba activa.'));
    return c.html(avisoCancelada(base(c), citaId, GRACIA_MS / 1000));
  });

  app.post(`${PREFIJO}/:slug/citas/:citaId/deshacer`, async (c) => {
    const citaId = c.req.param('citaId');
    const resultado = await deshacerCancelacion(deps.panel, {
      tenantId: c.get('tenantId'),
      actor: actorDe(c),
      citaId,
    });

    if (resultado === 'restaurada') return c.html(filaRestaurada(base(c), citaId));
    if (resultado === 'ocupado') {
      return c.html(filaNoSePudo(citaId, 'Ese horario ya se ocupó. Hay que reagendar.'));
    }
    return c.html(filaNoSePudo(citaId, 'El plazo para deshacer ya pasó.'));
  });

  // --- Bandeja --------------------------------------------------------------

  app.post(`${PREFIJO}/:slug/conversaciones/:conversacionId/cerrar`, async (c) => {
    const cerrada = await cerrarConversacion(deps.panel, {
      tenantId: c.get('tenantId'),
      actor: actorDe(c),
      conversacionId: c.req.param('conversacionId'),
    });
    if (!cerrada) return c.html(html`<tr><td colspan="5" class="vacio">Ya estaba cerrada.</td></tr>`);
    return c.html(html``);
  });

  return app;
}
