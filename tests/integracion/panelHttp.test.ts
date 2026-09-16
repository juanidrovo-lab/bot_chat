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
import { crearRepoMetricas } from '../../src/adapters/postgres/metricasProducto.ts';
import { crearRepoCalendarios } from '../../src/adapters/postgres/calendarios.ts';
import { crearOAuthNoDisponible } from '../../src/adapters/google/oauth.ts';
import { cifrar } from '../../src/platform/crypto.ts';
import { crearPasskeys, crearPasskeysNoDisponible } from '../../src/adapters/webauthn/passkeys.ts';
import { crearReloj } from '../../src/adapters/reloj.ts';
import {
  CLAVE_HEX,
  abrirApp,
  limpiar,
  sembrarDespacho,
  sembrarInvitacion,
  sembrarUsuario,
  type Despacho,
} from './ayuda.ts';

const db = abrirApp();
const reloj = crearReloj();
const repoAuth = crearRepoAuth(db);
const auditoria = crearAuditoria(db);
const hashear = (token: string): string => createHash('sha256').update(token).digest('hex');

let a: Despacho;
let b: Despacho;

function app(conPasskeys = false) {
  return crearPanel({
    db,
    panel: { repo: crearRepoPanel(db), auditoria, reloj },
    auth: {
      repo: repoAuth,
      passkeys: conPasskeys
        ? crearPasskeys({ origen: 'https://panel.estudio.ec', nombre: 'Providencia' })
        : crearPasskeysNoDisponible(),
      reloj,
      auditoria,
      generarToken: () => randomBytes(32).toString('hex'),
      hashear,
    },
    exportacion: crearRepoExportacion(db),
    metricas: crearRepoMetricas(db),
    calendarios: {
      repo: crearRepoCalendarios(db),
      // Sin credenciales de Google: la pantalla se sirve y conectar no prospera.
      oauth: crearOAuthNoDisponible(),
      reloj,
      auditoria,
      generarState: () => randomBytes(32).toString('base64url'),
      cifrar: (valor) => cifrar(valor, CLAVE_HEX),
    },
    panelOrigen: 'https://panel.estudio.ec',
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

describe('alta de la primera passkey', () => {
  async function invitar(d: Despacho, email: string, token: string): Promise<string> {
    const usuarioId = await sembrarUsuario(d.tenantId, email);
    await sembrarInvitacion(d.tenantId, usuarioId, token);
    return usuarioId;
  }

  async function postear(ruta: string, cuerpo: object, conPasskeys = true): Promise<Response> {
    return app(conPasskeys).fetch(
      new Request(`http://localhost${ruta}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(cuerpo),
      }),
    );
  }

  it('la página de alta se ve sin sesión: es justo el usuario que aún no puede entrar', async () => {
    await invitar(a, 'abogado@a.ec', 'testigo-1');

    const respuesta = await pedir('/panel/despacho-a/alta/testigo-1');

    expect(respuesta.status).toBe(200);
    const cuerpo = await respuesta.text();
    expect(cuerpo).toContain('Abg. Panel');
    expect(cuerpo).toContain('Registrar este dispositivo');
  });

  it('una invitación inventada no dice si existió: solo que ya no sirve', async () => {
    const respuesta = await pedir('/panel/despacho-a/alta/no-existe');

    expect(respuesta.status).toBe(404);
    expect(await respuesta.text()).toContain('ya no sirve');
  });

  it('devuelve opciones de registro con el reto que se guardó', async () => {
    await invitar(a, 'abogado@a.ec', 'testigo-2');

    const respuesta = await postear('/panel/despacho-a/alta/inicio', { invitacion: 'testigo-2' });

    expect(respuesta.status).toBe(200);
    const { opciones, reto } = (await respuesta.json()) as {
      opciones: { challenge: string; authenticatorSelection: { residentKey: string } };
      reto: string;
    };
    expect(opciones.challenge).toBe(reto);
    expect(opciones.authenticatorSelection.residentKey).toBe('required');
  });

  it('la invitación de un despacho no vale en otro', async () => {
    await invitar(a, 'abogado@a.ec', 'testigo-3');

    const respuesta = await postear('/panel/despacho-b/alta/inicio', { invitacion: 'testigo-3' });

    expect(respuesta.status).toBe(401);
  });

  it('una respuesta de registro inventada no da de alta a nadie', async () => {
    await invitar(a, 'abogado@a.ec', 'testigo-4');
    const inicio = await postear('/panel/despacho-a/alta/inicio', { invitacion: 'testigo-4' });
    const { reto } = (await inicio.json()) as { reto: string };

    const fin = await postear('/panel/despacho-a/alta/fin', { reto, respuesta: { falso: true } });

    // Y es un 401, no un 500: un 500 le diría al atacante que encontró algo.
    expect(fin.status).toBe(401);
  });

  it('sin PANEL_ORIGEN el alta también falla cerrado', async () => {
    await invitar(a, 'abogado@a.ec', 'testigo-5');

    const respuesta = await postear(
      '/panel/despacho-a/alta/inicio',
      { invitacion: 'testigo-5' },
      false,
    );

    expect(respuesta.status).toBe(401);
  });
});

describe('enumeración', () => {
  it('el acceso no revela cuántas credenciales tiene el despacho', async () => {
    const usuarioId = await sembrarUsuario(a.tenantId, 'abogado@a.ec');
    await repoAuth.guardarCredencial(
      a.tenantId,
      usuarioId,
      { credencialId: 'cred-secreta', clavePublica: 'k', contador: 0, transportes: ['internal'] },
      null,
    );

    const respuesta = await app(true).fetch(
      new Request('http://localhost/panel/despacho-a/acceso/inicio', { method: 'POST' }),
    );
    const texto = await respuesta.text();

    /**
     * Con `allowCredentials`, cualquiera que abra la URL del despacho sabría cuántos
     * usuarios tiene y cuáles son sus identificadores de credencial, sin autenticarse.
     */
    expect(respuesta.status).toBe(200);
    expect(texto).not.toContain('cred-secreta');
    expect(texto).not.toContain('allowCredentials');
  });
});

describe('buscador y asistencia por HTTP', () => {
  it('el buscador responde en la ruta que la caja llama', async () => {
    // La caja de búsqueda hace `hx-get` a esta ruta. Antes no existía y teclear no hacía
    // nada: el fallo más fácil de no ver, porque la página carga perfecta.
    const token = await abrirSesion(a, 'abogado@a.ec');

    const respuesta = await pedir('/panel/despacho-a/buscar?q=Prueba', { token });

    expect(respuesta.status).toBe(200);
    expect(await respuesta.text()).toContain('Contacto Prueba');
  });

  it('el buscador no responde sin sesión', async () => {
    expect((await pedir('/panel/despacho-a/buscar?q=Prueba')).status).toBe(401);
  });

  it('marcar asistencia exige sesión', async () => {
    const respuesta = await app().fetch(
      new Request('http://localhost/panel/despacho-a/citas/x/asistencia?vino=si', {
        method: 'POST',
      }),
    );

    expect(respuesta.status).toBe(401);
  });
});

describe('métricas por HTTP', () => {
  it('la pantalla se sirve y dice que aún no hay datos suficientes', async () => {
    const token = await abrirSesion(a, 'abogado@a.ec');

    const respuesta = await pedir('/panel/despacho-a/metricas', { token });

    expect(respuesta.status).toBe(200);
    const cuerpo = await respuesta.text();
    // Un despacho recién dado de alta no tiene muestra, y la pantalla lo dice en vez de
    // enseñar un porcentaje sobre cero.
    expect(cuerpo).toContain('no dicen nada todavía');
    expect(cuerpo).toContain('Ausencias');
  });

  it('el enlace a métricas está en la pantalla principal', async () => {
    const token = await abrirSesion(a, 'abogado@a.ec');

    const cuerpo = await (await pedir('/panel/despacho-a', { token })).text();

    expect(cuerpo).toContain('/panel/despacho-a/metricas');
  });

  it('no se ven sin sesión', async () => {
    expect((await pedir('/panel/despacho-a/metricas')).status).toBe(401);
  });
});

describe('calendarios por HTTP', () => {
  it('la pantalla dice quién no ha conectado y qué se pierde', async () => {
    const token = await abrirSesion(a, 'abogado@a.ec');

    const cuerpo = await (await pedir('/panel/despacho-a/calendario', { token })).text();
    // El HTML va indentado, así que el texto de una frase viene partido en varias líneas.
    const plano = cuerpo.replace(/\s+/g, ' ');

    expect(plano).toContain('sin conectar');
    // El aviso no es relleno: sin conectar, el bot puede ofrecer la hora de una audiencia.
    expect(plano).toContain('ya tiene algo apuntado');
  });

  it('sin Google configurado, conectar no prospera y lo dice', async () => {
    const token = await abrirSesion(a, 'abogado@a.ec');

    const respuesta = await pedir(`/panel/despacho-a/calendario/${a.abogadoId}/conectar`, { token });

    // Falla cerrado como el resto: no revienta, avisa.
    expect(respuesta.status).toBe(302);
    expect(respuesta.headers.get('location')).toContain('aviso=');
  });

  it('un abogado de otro despacho no se puede conectar desde aquí', async () => {
    const token = await abrirSesion(a, 'abogado@a.ec');

    const respuesta = await pedir(`/panel/despacho-a/calendario/${b.abogadoId}/conectar`, { token });

    expect(respuesta.headers.get('location')).toContain('no%20es%20de%20este%20despacho');
  });

  it('la vuelta de Google exige sesión', async () => {
    expect((await pedir('/panel/despacho-a/calendario/google?code=x&state=y')).status).toBe(401);
  });

  it('si el abogado cancela en Google, se vuelve con un aviso y sin reventar', async () => {
    const token = await abrirSesion(a, 'abogado@a.ec');

    const respuesta = await pedir('/panel/despacho-a/calendario/google?error=access_denied', {
      token,
    });

    expect(respuesta.status).toBe(302);
    expect(respuesta.headers.get('location')).toContain('No%20se%20autoriz');
  });

  it('un state inventado no conecta nada', async () => {
    const token = await abrirSesion(a, 'abogado@a.ec');

    const respuesta = await pedir(
      '/panel/despacho-a/calendario/google?code=abc&state=me-lo-invento',
      { token },
    );

    expect(respuesta.headers.get('location')).toContain('No%20se%20pudo%20conectar');
  });
});
