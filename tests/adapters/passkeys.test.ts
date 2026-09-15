/**
 * El adaptador de WebAuthn.
 *
 * La firma la verifica `@simplewebauthn/server`, y probar esa verificación sería probar la
 * biblioteca. Lo que se prueba aquí son las **políticas** que la biblioteca deja abiertas y
 * que decidimos nosotros: las que, mal puestas, dejan un panel que parece seguro.
 */
import { describe, expect, it } from 'vitest';
import { OrigenInvalido, crearPasskeys, crearPasskeysNoDisponible, rpIdDe } from '../../src/adapters/webauthn/passkeys.ts';
import { VerificacionFallida } from '../../src/app/puertos/Passkeys.ts';

const passkeys = crearPasskeys({ origen: 'https://panel.estudio.ec', nombre: 'Providencia' });

const usuario = {
  id: '9f1c2d3e-4a5b-4c6d-8e9f-0a1b2c3d4e5f',
  email: 'abogado@estudio.ec',
  nombre: 'Abg. Prueba',
  credencialesExistentes: ['cred-vieja'],
};

describe('rpIdDe', () => {
  it('saca el dominio del origen, sin esquema ni puerto', () => {
    expect(rpIdDe('https://panel.estudio.ec')).toBe('panel.estudio.ec');
    expect(rpIdDe('https://panel.estudio.ec:8443')).toBe('panel.estudio.ec');
  });

  it('rechaza http en producción, y falla al arrancar en vez de al primer acceso', () => {
    // WebAuthn solo funciona en origen seguro. Descubrirlo cuando el abogado no puede
    // entrar es mucho peor que descubrirlo aquí.
    expect(() => rpIdDe('http://panel.estudio.ec')).toThrow(OrigenInvalido);
    expect(() => rpIdDe('no-es-una-url')).toThrow(OrigenInvalido);
  });

  it('deja pasar localhost, que es origen seguro para el navegador', () => {
    expect(rpIdDe('http://localhost:3000')).toBe('localhost');
  });
});

describe('opciones de registro', () => {
  it('exige credencial descubrible y verificación de usuario', async () => {
    const { opciones } = await passkeys.opcionesDeRegistro(usuario);
    const o = opciones as {
      authenticatorSelection: { residentKey: string; userVerification: string };
      attestation: string;
      rp: { id: string };
    };

    // Descubrible porque el acceso no manda `allowCredentials`; verificación porque una
    // passkey sin huella ni PIN es un teléfono desbloqueado sobre un escritorio.
    expect(o.authenticatorSelection.residentKey).toBe('required');
    expect(o.authenticatorSelection.userVerification).toBe('required');
    expect(o.rp.id).toBe('panel.estudio.ec');
  });

  it('no pide atestación: no aporta nada y arrastra una cadena de certificados', async () => {
    const { opciones } = await passkeys.opcionesDeRegistro(usuario);

    expect((opciones as { attestation: string }).attestation).toBe('none');
  });

  it('excluye las credenciales que el usuario ya tiene', async () => {
    const { opciones } = await passkeys.opcionesDeRegistro(usuario);
    const o = opciones as { excludeCredentials: { id: string }[] };

    expect(o.excludeCredentials.map((c) => c.id)).toEqual(['cred-vieja']);
  });

  it('el reto que devuelve es el mismo que va en las opciones', async () => {
    const { opciones, reto } = await passkeys.opcionesDeRegistro(usuario);

    // Si no lo fueran, el reto guardado en la base nunca cuadraría con el firmado.
    expect((opciones as { challenge: string }).challenge).toBe(reto);
  });
});

describe('opciones de acceso', () => {
  it('NO manda allowCredentials', async () => {
    const { opciones } = await passkeys.opcionesDeAcceso();
    const o = opciones as { allowCredentials?: unknown[] };

    /**
     * Es la diferencia entre una página de acceso y un censo: con `allowCredentials`,
     * cualquiera que abra la URL del despacho sabe cuántos usuarios tiene y cuáles son sus
     * identificadores de credencial, sin haberse autenticado.
     */
    expect(o.allowCredentials ?? []).toEqual([]);
  });

  it('exige verificación de usuario también al entrar', async () => {
    const { opciones } = await passkeys.opcionesDeAcceso();

    expect((opciones as { userVerification: string }).userVerification).toBe('required');
  });

  it('dos accesos seguidos no comparten reto', async () => {
    const uno = await passkeys.opcionesDeAcceso();
    const dos = await passkeys.opcionesDeAcceso();

    expect(uno.reto).not.toBe(dos.reto);
  });
});

describe('respuestas que no cuadran', () => {
  it('una respuesta de registro inventada es VerificacionFallida, no una excepción cruda', async () => {
    // El caso de uso solo traduce `VerificacionFallida` a una negativa: cualquier otra cosa
    // sale como 500 y le dice al atacante que encontró algo.
    await expect(
      passkeys.verificarRegistro({ esto: 'no es una respuesta' }, 'reto'),
    ).rejects.toBeInstanceOf(VerificacionFallida);
  });

  it('una respuesta de acceso inventada, igual', async () => {
    await expect(
      passkeys.verificarAcceso({ tampoco: true }, 'reto', {
        credencialId: 'cred-1',
        clavePublica: 'AAAA',
        contador: 0,
        transportes: [],
      }),
    ).rejects.toBeInstanceOf(VerificacionFallida);
  });
});

describe('sin configurar', () => {
  it('niega las cuatro ceremonias: falla cerrado', async () => {
    const sin = crearPasskeysNoDisponible();

    await expect(sin.opcionesDeRegistro(usuario)).rejects.toBeInstanceOf(VerificacionFallida);
    await expect(sin.verificarRegistro({}, 'r')).rejects.toBeInstanceOf(VerificacionFallida);
    await expect(sin.opcionesDeAcceso()).rejects.toBeInstanceOf(VerificacionFallida);
    await expect(
      sin.verificarAcceso({}, 'r', {
        credencialId: 'c',
        clavePublica: 'k',
        contador: 0,
        transportes: [],
      }),
    ).rejects.toBeInstanceOf(VerificacionFallida);
  });
});
