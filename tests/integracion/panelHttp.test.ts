/**
 * El panel por HTTP.
 *
 * Lo que se comprueba aquí es la puerta, no el contenido: que sin sesión no se ve nada, que
 * una sesión de otro despacho no vale en este, y que las cabeceras de seguridad salen
 * aunque delante no haya ningún proxy.
 */
import { createHash, randomBytes } from 'node:crypto';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { crearPanel, COOKIE_SESION } from '../../src/adapters/http/panel/rutas.ts';
import { crearEstaticos } from '../../src/adapters/http/panel/estaticos.ts';
import { crearRepoAuth } from '../../src/adapters/postgres/auth.ts';
import { crearAuditoria, crearRepoPanel } from '../../src/adapters/postgres/panel.ts';
import { crearRepoExportacion } from '../../src/adapters/postgres/exportacion.ts';
import { crearPasskeysNoDisponible } from '../../src/adapters/webauthn/passkeys.ts';
import { crearReloj } from '../../src/adapters/reloj.ts';
import { abrirApp, limpiar, sembrarDespacho, sembrarUsuario, type Despacho } from './ayuda.ts';

const db = abrirApp();
const reloj = crearReloj();
const repoAuth = crearRepoAuth(db);
const auditoria = crearAuditoria(db);
const hashear = (token: string): string => createHash('sha256').update(token).digest('hex');

let a: Despacho;
let b: Despacho;

function app() {
  return crearPanel({
    db,
    panel: { repo: crearRepoPanel(db), auditoria, reloj },
    auth: {
      repo: repoAuth,
      passkeys: crearPasskeysNoDisponible(),
      reloj,
      auditoria,
      generarToken: () => randomBytes(32).toString('hex'),
      hashear,
    },
    exportacion: crearRepoExportacion(db),
    reloj,
    cookieSegura: true,
    estaticos: crearEstaticos(),
  });
}

async function abrirSesion(d: Despacho, email: string): Promise<string> {
  const usuarioId = await sembrarUsuario(d.tenantId, email);
  const token = randomBytes(16).toString('hex');
  await repoAuth.crearSesion(d.tenantId, usuarioId, hashear(token), new Date(Date.now() + 3600_000));
  return token;
}

async function pedir(
  ruta: string,
  opciones: { token?: string; htmx?: boolean } = {},
): Promise<Response> {
  const cabeceras = new Headers();
  if (opciones.token !== undefined) cabeceras.set('cookie', `${COOKIE_SESION}=${opciones.token}`);
  if (opciones.htmx === true) cabeceras.set('hx-request', 'true');
  return app().fetch(new Request(`http://localhost${ruta}`, { headers: cabeceras }));
}

beforeEach(async () => {
  await limpiar();
  a = await sembrarDespacho('despacho-a');
  b = await sembrarDespacho('despacho-b');
});

afterEach(limpiar);
afterAll(() => db.cerrar());

describe('la puerta', () => {
  it('sin sesión devuelve 401 con la página de acceso', async () => {
    const respuesta = await pedir('/panel/despacho-a');

    expect(respuesta.status).toBe(401);
    expect(await respuesta.text()).toContain('Entrar al panel');
  });

  it('un despacho que no existe es 404, no una página de acceso', async () => {
    expect((await pedir('/panel/no-existe')).status).toBe(404);
  });

  it('con sesión se ve la pantalla de hoy y mañana', async () => {
    const token = await abrirSesion(a, 'abogado@a.ec');

    const respuesta = await pedir('/panel/despacho-a', { token });

    expect(respuesta.status).toBe(200);
    const cuerpo = await respuesta.text();
    expect(cuerpo).toContain('Esperando a una persona');
    expect(cuerpo).toContain('Abg. Panel');
  });

  it('la sesión de un despacho no abre el panel de otro', async () => {
    const token = await abrirSesion(a, 'abogado@a.ec');
    await sembrarUsuario(b.tenantId, 'abogado@b.ec');

    // La cookie es la misma, pero la sesión se busca bajo la RLS del despacho de la URL.
    expect((await pedir('/panel/despacho-b', { token })).status).toBe(401);
  });

  it('una petición de HTMX sin sesión recibe una redirección, no una página entera', async () => {
    const respuesta = await pedir('/panel/despacho-a/contactos/x', { htmx: true });

    expect(respuesta.status).toBe(401);
    // Sin esto, la página de acceso acabaría metida dentro de una fila de la tabla.
    expect(respuesta.headers.get('hx-redirect')).toBe('/panel/despacho-a');
    expect(await respuesta.text()).toBe('');
  });

  it('un testigo inventado no entra', async () => {
    await sembrarUsuario(a.tenantId, 'abogado@a.ec');

    expect((await pedir('/panel/despacho-a', { token: 'a'.repeat(64) })).status).toBe(401);
  });
});

describe('cabeceras y estáticos', () => {
  it('toda respuesta lleva las cabeceras de seguridad, también la de acceso', async () => {
    const respuesta = await pedir('/panel/despacho-a');

    const csp = respuesta.headers.get('content-security-policy') ?? '';
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(respuesta.headers.get('x-content-type-options')).toBe('nosniff');
    // Páginas con nombres y cédulas: ni el navegador ni un proxy deben guardarlas.
    expect(respuesta.headers.get('cache-control')).toBe('no-store');
  });

  it('htmx se sirve desde el propio proceso, no desde una CDN', async () => {
    const respuesta = await pedir('/panel/estatico/htmx.js');

    expect(respuesta.status).toBe(200);
    expect(respuesta.headers.get('content-type')).toContain('text/javascript');
    expect(await respuesta.text()).toContain('htmx');
  });

  it('la lista de estáticos es cerrada: no se compone una ruta con lo que venga en la URL', async () => {
    for (const intento of ['..%2F..%2Fpackage.json', 'servidor.ts', 'htmx.min.js']) {
      expect((await pedir(`/panel/estatico/${intento}`)).status).toBe(404);
    }
  });
});

describe('acceso sin WebAuthn configurado', () => {
  it('falla cerrado: no entra nadie y no es un 500', async () => {
    const respuesta = await app().fetch(
      new Request('http://localhost/panel/despacho-a/acceso/inicio', { method: 'POST' }),
    );

    // Un «mientras tanto» que dejara pasar sería el panel del estudio abierto a quien
    // encuentre la URL.
    expect(respuesta.status).toBe(401);
  });
});

describe('montado junto al webhook', () => {
  it('ni el panel se come el webhook ni el webhook tapa el panel', async () => {
    // En producción los dos cuelgan de la misma aplicación. El orden de registro decide qué
    // middleware alcanza a qué ruta, y equivocarse ahí rompe el webhook en silencio: Meta
    // deja de recibir 200 y reintenta hasta darse de baja.
    const { crearWebhook, RUTA } = await import('../../src/adapters/http/webhook.ts');
    const { CLAVE_HEX } = await import('./ayuda.ts');

    const compuesta = crearWebhook({
      db,
      cola: { async encolar() { return null; }, async trabajar() {} },
      claveCifradoHex: CLAVE_HEX,
      verifyToken: 'token-de-verificacion',
    });
    compuesta.route('/', app());

    const verificacion = await compuesta.fetch(
      new Request(
        `http://localhost${RUTA}?hub.mode=subscribe&hub.verify_token=token-de-verificacion&hub.challenge=reto`,
      ),
    );
    expect(verificacion.status).toBe(200);
    expect(await verificacion.text()).toBe('reto');

    const panel = await compuesta.fetch(new Request('http://localhost/panel/despacho-a'));
    expect(panel.status).toBe(401);
    expect(panel.headers.get('content-security-policy')).toContain("script-src 'self'");
  });
});
