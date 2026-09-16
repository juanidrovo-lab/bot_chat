/**
 * Conectar el Google Calendar de un abogado.
 *
 * El canje lo hace la biblioteca de Google. Lo que se prueba aquí es lo que decide el caso
 * de uso, que es donde están los fallos que importan: que el `state` sea de un solo uso,
 * que diga a qué abogado pertenece, y que el refresh token no llegue nunca en claro a la
 * base.
 */
import { describe, expect, it } from 'vitest';
import { crearReloj } from '../../src/adapters/reloj.ts';
import {
  ConexionInvalida,
  VIDA_STATE_MS,
  desconectar,
  iniciarConexion,
  terminarConexion,
} from '../../src/app/conectarCalendario.ts';
import type { DependenciasCalendario } from '../../src/app/conectarCalendario.ts';
import type { EventoAuditable } from '../../src/app/puertos/Auditoria.ts';
import type { OAuthGoogle } from '../../src/app/puertos/OAuthGoogle.ts';
import { ConexionGoogleFallida } from '../../src/app/puertos/OAuthGoogle.ts';
import type { RepoCalendarios } from '../../src/app/puertos/RepoCalendarios.ts';

const TENANT = 'despacho-a';
const ABOGADO = 'ab-1';
const ACTOR = 'usuario:u-1';
const VUELTA = 'https://panel.estudio.ec/panel/despacho-a/calendario/google';
const AHORA = Date.parse('2026-09-16T19:00:00Z');
const reloj = crearReloj(() => AHORA);

interface Opciones {
  abogadoExiste?: boolean;
  sinRefreshToken?: boolean;
}

function entorno(opciones: Opciones = {}) {
  const states = new Map<string, string>();
  const guardados: { abogadoId: string; calendarId: string; token: string }[] = [];
  const olvidados: string[] = [];
  const auditados: EventoAuditable[] = [];
  const urisPedidas: string[] = [];
  const cifrados: string[] = [];
  let expiraGuardada: Date | null = null;

  const oauth: OAuthGoogle = {
    urlDeAutorizacion(state, redirectUri) {
      urisPedidas.push(redirectUri);
      return `https://accounts.google.com/o/oauth2/v2/auth?state=${state}`;
    },
    async canjear(_codigo, redirectUri) {
      urisPedidas.push(redirectUri);
      if (opciones.sinRefreshToken === true) {
        throw new ConexionGoogleFallida('Google no devolvió refresh token');
      }
      return { calendarId: 'abogada@estudio.ec', refreshToken: 'el-secreto' };
    },
  };

  const repo: RepoCalendarios = {
    async listar() {
      return [];
    },
    async abogado(_t, id) {
      if (opciones.abogadoExiste === false) return null;
      return { id, nombre: 'Abg. Prueba', calendarId: null };
    },
    async guardarState(_t, state, abogadoId, expiraAt) {
      states.set(state, abogadoId);
      expiraGuardada = expiraAt;
    },
    async consumirState(_t, state) {
      const abogadoId = states.get(state);
      if (abogadoId === undefined) return null;
      states.delete(state);
      return { abogadoId };
    },
    async guardarCalendario(_t, abogadoId, calendarId, token) {
      guardados.push({ abogadoId, calendarId, token });
    },
    async olvidarCalendario(_t, abogadoId) {
      olvidados.push(abogadoId);
    },
  };

  const deps: DependenciasCalendario = {
    repo,
    oauth,
    reloj,
    auditoria: {
      async registrar(evento) {
        auditados.push(evento);
      },
    },
    generarState: () => 'state-fijo',
    /**
     * Opaco a propósito: un doble que devolviera `cifrado(<secreto>)` haría pasar cualquier
     * aserto de «no guarda el texto plano» sin comprobar nada. Se anota qué se le pidió
     * cifrar y se devuelve algo que no contiene el original.
     */
    cifrar: (valor) => {
      cifrados.push(valor);
      return 'OPACO';
    },
  };

  return {
    deps,
    guardados,
    olvidados,
    auditados,
    urisPedidas,
    cifrados,
    expira: () => expiraGuardada,
  };
}

describe('iniciar', () => {
  it('comprueba que el abogado es de este despacho antes de mandar a nadie a Google', async () => {
    const { deps } = entorno({ abogadoExiste: false });

    // Si no, la vuelta traería un id que no es de aquí.
    await expect(
      iniciarConexion(deps, { tenantId: TENANT, abogadoId: 'de-otro', redirectUri: VUELTA }),
    ).rejects.toBeInstanceOf(ConexionInvalida);
  });

  it('guarda el state con caducidad corta y lo pone en la URL', async () => {
    const { deps, expira } = entorno();

    const url = await iniciarConexion(deps, {
      tenantId: TENANT,
      abogadoId: ABOGADO,
      redirectUri: VUELTA,
    });

    expect(url).toContain('state-fijo');
    expect(expira()!.getTime() - AHORA).toBe(VIDA_STATE_MS);
  });
});

describe('terminar', () => {
  async function conState(opciones: Opciones = {}) {
    const e = entorno(opciones);
    await iniciarConexion(e.deps, {
      tenantId: TENANT,
      abogadoId: ABOGADO,
      redirectUri: VUELTA,
    });
    return e;
  }

  it('guarda el calendario y el token CIFRADO', async () => {
    const { deps, guardados, cifrados } = await conState();

    const conectado = await terminarConexion(deps, {
      tenantId: TENANT,
      state: 'state-fijo',
      codigo: 'abc',
      actor: ACTOR,
      redirectUri: VUELTA,
    });

    expect(conectado.calendarId).toBe('abogada@estudio.ec');
    // Pasó por el cifrado, y lo que llega a la base no es el original: ese refresh token da
    // acceso al calendario del abogado hasta que él lo revoque.
    expect(cifrados).toEqual(['el-secreto']);
    expect(guardados[0]!.token).toBe('OPACO');
  });

  it('el abogado sale del state, no de la URL de vuelta', async () => {
    const { deps, guardados } = await conState();

    await terminarConexion(deps, {
      tenantId: TENANT,
      state: 'state-fijo',
      codigo: 'abc',
      actor: ACTOR,
      redirectUri: VUELTA,
    });

    // Si viniera de fuera, cualquiera con sesión podría conectar su calendario al nombre
    // de otro abogado.
    expect(guardados[0]!.abogadoId).toBe(ABOGADO);
  });

  it('el state es de un solo uso', async () => {
    const { deps } = await conState();
    const peticion = {
      tenantId: TENANT,
      state: 'state-fijo',
      codigo: 'abc',
      actor: ACTOR,
      redirectUri: VUELTA,
    };

    await terminarConexion(deps, peticion);

    await expect(terminarConexion(deps, peticion)).rejects.toBeInstanceOf(ConexionInvalida);
  });

  it('un state inventado no vale', async () => {
    const { deps } = await conState();

    await expect(
      terminarConexion(deps, {
        tenantId: TENANT,
        state: 'me-lo-invento',
        codigo: 'abc',
        actor: ACTOR,
        redirectUri: VUELTA,
      }),
    ).rejects.toBeInstanceOf(ConexionInvalida);
  });

  it('sin refresh token no se guarda media credencial', async () => {
    const { deps, guardados } = await conState({ sinRefreshToken: true });

    // Es el fallo más fácil de tener: la conexión funcionaría esa tarde y dejaría de
    // funcionar al día siguiente, sin que nadie lo relacione.
    await expect(
      terminarConexion(deps, {
        tenantId: TENANT,
        state: 'state-fijo',
        codigo: 'abc',
        actor: ACTOR,
        redirectUri: VUELTA,
      }),
    ).rejects.toBeInstanceOf(ConexionInvalida);
    expect(guardados).toEqual([]);
  });

  it('un canje fallido quema el state: hay que empezar de nuevo', async () => {
    const { deps } = await conState({ sinRefreshToken: true });
    const peticion = {
      tenantId: TENANT,
      state: 'state-fijo',
      codigo: 'abc',
      actor: ACTOR,
      redirectUri: VUELTA,
    };

    await expect(terminarConexion(deps, peticion)).rejects.toBeInstanceOf(ConexionInvalida);

    // Un `state` que sobrevive a un intento fallido se puede reutilizar.
    await expect(terminarConexion(deps, peticion)).rejects.toBeInstanceOf(ConexionInvalida);
  });

  it('la misma URI de vuelta en los dos pasos, o Google rechaza el canje', async () => {
    const { deps, urisPedidas } = await conState();

    await terminarConexion(deps, {
      tenantId: TENANT,
      state: 'state-fijo',
      codigo: 'abc',
      actor: ACTOR,
      redirectUri: VUELTA,
    });

    expect(urisPedidas).toEqual([VUELTA, VUELTA]);
  });

  it('queda auditado', async () => {
    const { deps, auditados } = await conState();

    await terminarConexion(deps, {
      tenantId: TENANT,
      state: 'state-fijo',
      codigo: 'abc',
      actor: ACTOR,
      redirectUri: VUELTA,
    });

    expect(auditados[0]).toMatchObject({ tipo: 'calendario.conectado', entidadId: ABOGADO });
  });
});

describe('desconectar', () => {
  it('olvida el calendario y lo audita', async () => {
    const { deps, olvidados, auditados } = entorno();

    await desconectar(deps, { tenantId: TENANT, abogadoId: ABOGADO, actor: ACTOR });

    expect(olvidados).toEqual([ABOGADO]);
    expect(auditados[0]).toMatchObject({ tipo: 'calendario.desconectado' });
  });
});
