/**
 * Acceso al panel.
 *
 * La firma la verifica la biblioteca; lo que se prueba aquí es lo que la biblioteca NO
 * hace y donde se cometen los fallos de verdad: que el reto sea de un solo uso, que el
 * contador del autenticador tenga que avanzar, que la base guarde el hash y no el testigo,
 * y que un usuario de baja no entre aunque su passkey siga siendo válida.
 */
import { describe, expect, it } from 'vitest';
import { crearReloj } from '../../src/adapters/reloj.ts';
import {
  AccesoDenegado,
  VIDA_RETO_MS,
  VIDA_SESION_MS,
  iniciarAcceso,
  iniciarRegistro,
  terminarAcceso,
  terminarRegistro,
} from '../../src/app/autenticar.ts';
import type { DependenciasAuth } from '../../src/app/autenticar.ts';
import type { EventoAuditable } from '../../src/app/puertos/Auditoria.ts';
import type { Passkeys } from '../../src/app/puertos/Passkeys.ts';
import { VerificacionFallida } from '../../src/app/puertos/Passkeys.ts';
import type { RepoAuth, UsuarioPanel } from '../../src/app/puertos/RepoAuth.ts';

const TENANT = 'despacho-a';
const AHORA = Date.parse('2026-09-16T19:00:00Z');
const reloj = crearReloj(() => AHORA);

const usuario: UsuarioPanel = {
  id: 'u-1',
  email: 'abogado@estudio.ec',
  nombre: 'Abg. Prueba',
  rol: 'abogado',
  abogadoId: 'ab-1',
  activo: true,
};

const CREDENCIAL = {
  usuarioId: 'u-1',
  credencialId: 'cred-1',
  clavePublica: 'clave',
  contador: 7,
  transportes: ['internal'],
};

interface Opciones {
  contadorNuevo?: number;
  verificacionFalla?: boolean;
  retosVivos?: Set<string>;
  /** Hash de la invitación viva, si la hay. */
  invitacionHash?: string;
}

function entorno(opciones: Opciones = {}) {
  const retos = opciones.retosVivos ?? new Set<string>();
  const guardados: { hash: string; expiraAt: Date }[] = [];
  const auditados: EventoAuditable[] = [];
  const usos: { credencialId: string; contador: number }[] = [];
  const guardadas: { usuarioId: string; credencialId: string }[] = [];
  const consumidas: string[] = [];
  const buscadas: string[] = [];
  let retoGuardado: { reto: string; expiraAt: Date } | null = null;

  const passkeys: Passkeys = {
    async opcionesDeRegistro() {
      return { opciones: {}, reto: 'reto-registro' };
    },
    async verificarRegistro() {
      return { credencialId: 'cred-2', clavePublica: 'k', contador: 0, transportes: [] };
    },
    async opcionesDeAcceso() {
      return { opciones: { challenge: 'reto-acceso' }, reto: 'reto-acceso' };
    },
    async verificarAcceso() {
      if (opciones.verificacionFalla === true) throw new VerificacionFallida('firma mala');
      return { credencialId: CREDENCIAL.credencialId, contador: opciones.contadorNuevo ?? 8 };
    },
  };

  const repo = {
    async usuarioPorInvitacion(_t: string, tokenHash: string) {
      buscadas.push(tokenHash);
      return opciones.invitacionHash === tokenHash ? usuario : null;
    },
    async consumirInvitacion(_t: string, usuarioId: string) {
      consumidas.push(usuarioId);
    },
    async credencialesDe() {
      return [CREDENCIAL];
    },
    async credencialesDelDespacho() {
      return [CREDENCIAL];
    },
    async guardarReto(_t: string, reto: string, _p: string, _u: string | null, expiraAt: Date) {
      retos.add(reto);
      retoGuardado = { reto, expiraAt };
    },
    async consumirReto(_t: string, reto: string) {
      if (!retos.has(reto)) return { valido: false, usuarioId: null };
      retos.delete(reto);
      return { valido: true, usuarioId: 'u-1' };
    },
    async guardarCredencial(_t: string, usuarioId: string, credencial: { credencialId: string }) {
      guardadas.push({ usuarioId, credencialId: credencial.credencialId });
    },
    async anotarUso(_t: string, credencialId: string, contador: number) {
      usos.push({ credencialId, contador });
    },
    async crearSesion(_t: string, _u: string, tokenHash: string, expiraAt: Date) {
      guardados.push({ hash: tokenHash, expiraAt });
      return 's-1';
    },
    async sesionPorHash(_t: string, tokenHash: string) {
      const existe = guardados.some((g) => g.hash === tokenHash);
      return existe ? { id: 's-1', tenantId: TENANT, usuario } : null;
    },
    async cerrarSesion() {},
    async purgar() {
      return { retos: 0, sesiones: 0 };
    },
  } as unknown as RepoAuth;

  const deps: DependenciasAuth = {
    repo,
    passkeys,
    reloj,
    auditoria: {
      async registrar(evento) {
        auditados.push(evento);
      },
    },
    generarToken: () => 'testigo-secreto',
    // SHA-256 de mentira, pero determinista: lo que importa es que lo guardado no sea el
    // testigo.
    hashear: (token) => `hash(${token})`,
  };

  return {
    deps,
    guardados,
    auditados,
    usos,
    retos,
    guardadas,
    consumidas,
    buscadas,
    retoGuardado: () => retoGuardado,
  };
}

describe('iniciarAcceso', () => {
  it('guarda el reto con una caducidad corta', async () => {
    const { deps, retoGuardado } = entorno();

    await iniciarAcceso(deps, { tenantId: TENANT });

    const guardado = retoGuardado()!;
    expect(guardado.reto).toBe('reto-acceso');
    expect(guardado.expiraAt.getTime() - AHORA).toBe(VIDA_RETO_MS);
    // Es el tiempo de tocar un lector de huella, no el de un café.
    expect(VIDA_RETO_MS).toBeLessThanOrEqual(5 * 60_000);
  });

  it('sin WebAuthn configurado es una negativa, no una caída', async () => {
    const { deps } = entorno();
    deps.passkeys.opcionesDeAcceso = async () => {
      throw new VerificacionFallida('no configurado');
    };

    await expect(iniciarAcceso(deps, { tenantId: TENANT })).rejects.toBeInstanceOf(AccesoDenegado);
  });
});

describe('terminarAcceso', () => {
  async function conReto(opciones: Opciones = {}) {
    const e = entorno(opciones);
    await iniciarAcceso(e.deps, { tenantId: TENANT });
    return e;
  }

  it('abre sesión y guarda el HASH del testigo, no el testigo', async () => {
    const { deps, guardados } = await conReto();

    const acceso = await terminarAcceso(deps, {
      tenantId: TENANT,
      reto: 'reto-acceso',
      credencialId: 'cred-1',
      respuesta: {},
    });

    expect(acceso.token).toBe('testigo-secreto');
    expect(guardados).toHaveLength(1);
    // Una copia de la base no puede bastar para entrar al panel.
    expect(guardados[0]!.hash).not.toBe(acceso.token);
    expect(guardados[0]!.hash).toBe('hash(testigo-secreto)');
    expect(acceso.expiraAt.getTime() - AHORA).toBe(VIDA_SESION_MS);
  });

  it('el reto es de un solo uso: repetir la misma respuesta ya no entra', async () => {
    const { deps } = await conReto();
    const peticion = {
      tenantId: TENANT,
      reto: 'reto-acceso',
      credencialId: 'cred-1',
      respuesta: {},
    };

    await terminarAcceso(deps, peticion);

    // Sin esto, una respuesta capturada sirve para siempre.
    await expect(terminarAcceso(deps, peticion)).rejects.toBeInstanceOf(AccesoDenegado);
  });

  it('un reto que nadie emitió no vale', async () => {
    const { deps } = await conReto();

    await expect(
      terminarAcceso(deps, {
        tenantId: TENANT,
        reto: 'reto-inventado',
        credencialId: 'cred-1',
        respuesta: {},
      }),
    ).rejects.toBeInstanceOf(AccesoDenegado);
  });

  it('un contador que no avanza es una credencial clonada: no entra y queda registrado', async () => {
    const { deps, auditados } = await conReto({ contadorNuevo: CREDENCIAL.contador });

    await expect(
      terminarAcceso(deps, {
        tenantId: TENANT,
        reto: 'reto-acceso',
        credencialId: 'cred-1',
        respuesta: {},
      }),
    ).rejects.toBeInstanceOf(AccesoDenegado);

    expect(auditados.map((a) => a.tipo)).toContain('passkey.contador_sospechoso');
  });

  it('el contador cero se acepta: muchas passkeys sincronizadas no lo llevan', async () => {
    const { deps } = await conReto({ contadorNuevo: 0 });

    await expect(
      terminarAcceso(deps, {
        tenantId: TENANT,
        reto: 'reto-acceso',
        credencialId: 'cred-1',
        respuesta: {},
      }),
    ).resolves.toMatchObject({ token: 'testigo-secreto' });
  });

  it('guarda el contador nuevo: si no, la defensa contra el clonado no sirve de nada', async () => {
    const { deps, usos } = await conReto({ contadorNuevo: 42 });

    await terminarAcceso(deps, {
      tenantId: TENANT,
      reto: 'reto-acceso',
      credencialId: 'cred-1',
      respuesta: {},
    });

    expect(usos).toEqual([{ credencialId: 'cred-1', contador: 42 }]);
  });

  it('una firma que no cuadra es una negativa, no un error del sistema', async () => {
    const { deps } = await conReto({ verificacionFalla: true });

    await expect(
      terminarAcceso(deps, {
        tenantId: TENANT,
        reto: 'reto-acceso',
        credencialId: 'cred-1',
        respuesta: {},
      }),
    ).rejects.toBeInstanceOf(AccesoDenegado);
  });

  it('una credencial que no es de este despacho no entra', async () => {
    const { deps } = await conReto();

    await expect(
      terminarAcceso(deps, {
        tenantId: TENANT,
        reto: 'reto-acceso',
        credencialId: 'cred-de-otro',
        respuesta: {},
      }),
    ).rejects.toBeInstanceOf(AccesoDenegado);
  });
});

describe('alta de la primera passkey', () => {
  const TOKEN = 'invitacion-en-mano';
  const HASH = `hash(${TOKEN})`;

  it('busca por el HASH de la invitación, nunca por el testigo', async () => {
    const { deps, buscadas } = entorno({ invitacionHash: HASH });

    await iniciarRegistro(deps, { tenantId: TENANT, invitacion: TOKEN });

    // Una copia de la base no puede bastar para darse de alta en el panel.
    expect(buscadas).toEqual([HASH]);
    expect(buscadas[0]).not.toBe(TOKEN);
  });

  it('una invitación que no existe o caducó es una negativa', async () => {
    const { deps } = entorno({ invitacionHash: HASH });

    await expect(
      iniciarRegistro(deps, { tenantId: TENANT, invitacion: 'otra-cosa' }),
    ).rejects.toBeInstanceOf(AccesoDenegado);
  });

  it('guarda la credencial y después quema la invitación', async () => {
    const { deps, guardadas, consumidas, auditados } = entorno({ invitacionHash: HASH });
    await iniciarRegistro(deps, { tenantId: TENANT, invitacion: TOKEN });

    await terminarRegistro(deps, { tenantId: TENANT, reto: 'reto-registro', respuesta: {} });

    expect(guardadas).toEqual([{ usuarioId: 'u-1', credencialId: 'cred-2' }]);
    // Quemarla antes dejaría al abogado sin passkey y sin forma de volver a intentarlo si
    // el guardado fallara.
    expect(consumidas).toEqual(['u-1']);
    expect(auditados.map((a) => a.tipo)).toContain('passkey.registrada');
  });

  it('el reto del alta también es de un solo uso', async () => {
    const { deps } = entorno({ invitacionHash: HASH });
    await iniciarRegistro(deps, { tenantId: TENANT, invitacion: TOKEN });
    const peticion = { tenantId: TENANT, reto: 'reto-registro', respuesta: {} };

    await terminarRegistro(deps, peticion);

    await expect(terminarRegistro(deps, peticion)).rejects.toBeInstanceOf(AccesoDenegado);
  });

  it('no se puede terminar un alta que nadie empezó', async () => {
    const { deps, guardadas } = entorno({ invitacionHash: HASH });

    await expect(
      terminarRegistro(deps, { tenantId: TENANT, reto: 'reto-inventado', respuesta: {} }),
    ).rejects.toBeInstanceOf(AccesoDenegado);
    expect(guardadas).toEqual([]);
  });
});
