/**
 * Implementación del puerto `Passkeys` sobre `@simplewebauthn/server` (§2).
 *
 * Es deliberadamente delgada: aquí no se valida nada a mano. Comprobar una respuesta de
 * WebAuthn —el CBOR de la atestación, el `rpIdHash`, los flags de presencia y verificación,
 * la firma sobre `authData || sha256(clientDataJSON)`— es exactamente el tipo de
 * criptografía que §2 decidió no escribir. Lo único que decide este archivo son las
 * políticas que la biblioteca deja abiertas, y cada una está justificada abajo.
 *
 * Lo que **no** está aquí y sí es responsabilidad del sistema —el reto de un solo uso en la
 * base, el contador que tiene que avanzar, la sesión con el hash del testigo— vive en
 * `app/autenticar.ts`, porque no depende de esta biblioteca.
 */
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from '@simplewebauthn/server';
import type {
  AuthenticationResponseJSON,
  AuthenticatorTransportFuture,
  RegistrationResponseJSON,
} from '@simplewebauthn/server';
import type {
  CredencialGuardada,
  CredencialRegistrada,
  Passkeys,
} from '../../app/puertos/Passkeys.ts';
import { VerificacionFallida } from '../../app/puertos/Passkeys.ts';

export interface OpcionesPasskeys {
  /**
   * Origen público exacto del panel, con esquema y sin barra final
   * (`https://panel.estudio.ec`). Es lo que el navegador firma dentro de `clientDataJSON`:
   * si no coincide carácter por carácter, ninguna passkey valida.
   */
  origen: string;
  /** Nombre visible del estudio: lo que el usuario ve al guardar la passkey. */
  nombre: string;
}

export class OrigenInvalido extends Error {
  constructor(motivo: string) {
    super(motivo);
    // El `name` no es cosmético: el mensaje se redacta antes de llegar al log —puede traer
    // los parámetros de una consulta— y esto es lo único que sobrevive para saber qué pasó.
    this.name = 'OrigenInvalido';
  }
}

/** El `rpId` es el dominio del origen, sin esquema ni puerto. */
export function rpIdDe(origen: string): string {
  let url: URL;
  try {
    url = new URL(origen);
  } catch {
    throw new OrigenInvalido(`PANEL_ORIGEN no es una URL: ${origen}`);
  }
  if (url.protocol !== 'https:' && url.hostname !== 'localhost') {
    // WebAuthn solo funciona en un origen seguro. Fallar aquí, al arrancar, es mucho mejor
    // que descubrirlo cuando el primer abogado no puede entrar.
    throw new OrigenInvalido('PANEL_ORIGEN tiene que ser https (salvo localhost)');
  }
  return url.hostname;
}

const aBase64Url = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64url');

/**
 * `Uint8Array<ArrayBuffer>` y no `Uint8Array` a secas: el SDK exige que el búfer sea un
 * `ArrayBuffer` y no uno compartido, y `Buffer.from` devuelve el tipo ancho.
 */
function deBase64Url(texto: string): Uint8Array<ArrayBuffer> {
  const buffer = Buffer.from(texto, 'base64url');
  const copia = new Uint8Array(new ArrayBuffer(buffer.length));
  copia.set(buffer);
  return copia;
}

export function crearPasskeys(opciones: OpcionesPasskeys): Passkeys {
  const rpID = rpIdDe(opciones.origen);

  return {
    async opcionesDeRegistro(usuario) {
      const generadas = await generateRegistrationOptions({
        rpName: opciones.nombre,
        rpID,
        userName: usuario.email,
        userDisplayName: usuario.nombre,
        // El uuid del usuario, no un aleatorio: es lo que vuelve en `userHandle` al
        // acceder con una credencial descubrible.
        userID: new TextEncoder().encode(usuario.id),
        /**
         * `none`: no se pide atestación. Sirve para saber marca y modelo del autenticador,
         * que a un estudio de tres abogados no le aporta nada, y a cambio obliga a mantener
         * una cadena de certificados de confianza — que es justo donde estaba la
         * vulnerabilidad de la biblioteca en 13.3.1.
         */
        attestationType: 'none',
        // El navegador no debe ofrecer registrar dos veces la misma llave.
        excludeCredentials: usuario.credencialesExistentes.map((id) => ({ id })),
        authenticatorSelection: {
          /**
           * `required` en las dos. Descubrible porque el acceso no manda
           * `allowCredentials` —no queremos decirle a un desconocido cuántos usuarios tiene
           * el estudio—, y verificación de usuario porque una passkey sin huella ni PIN es
           * un teléfono desbloqueado sobre un escritorio.
           */
          residentKey: 'required',
          userVerification: 'required',
        },
      });

      return { opciones: generadas, reto: generadas.challenge };
    },

    async verificarRegistro(respuesta, reto) {
      let verificacion;
      try {
        verificacion = await verifyRegistrationResponse({
          response: respuesta as RegistrationResponseJSON,
          expectedChallenge: reto,
          expectedOrigin: opciones.origen,
          expectedRPID: rpID,
          requireUserVerification: true,
        });
      } catch (error) {
        // La biblioteca lanza con un mensaje útil para el registro del servidor, pero no
        // para el navegador: distinguir motivos convierte la página en un oráculo.
        throw new VerificacionFallida(
          error instanceof Error ? error.message : 'el registro no cuadra',
        );
      }

      if (!verificacion.verified) throw new VerificacionFallida('el registro no cuadra');

      const { credential } = verificacion.registrationInfo;

      return {
        credencialId: credential.id,
        // La clave pública no es un secreto, así que no pasa por `platform/crypto.ts`; se
        // guarda en base64url porque la columna es `text` y el SDK la entrega en bytes.
        clavePublica: aBase64Url(credential.publicKey),
        contador: credential.counter,
        transportes: credential.transports ?? [],
      } satisfies CredencialRegistrada;
    },

    async opcionesDeAcceso() {
      const generadas = await generateAuthenticationOptions({
        rpID,
        // Sin `allowCredentials` a propósito: ver el comentario del puerto.
        userVerification: 'required',
      });

      return { opciones: generadas, reto: generadas.challenge };
    },

    async verificarAcceso(respuesta, reto, credencial: CredencialGuardada) {
      let verificacion;
      try {
        verificacion = await verifyAuthenticationResponse({
          response: respuesta as AuthenticationResponseJSON,
          expectedChallenge: reto,
          expectedOrigin: opciones.origen,
          expectedRPID: rpID,
          requireUserVerification: true,
          credential: {
            id: credencial.credencialId,
            publicKey: deBase64Url(credencial.clavePublica),
            counter: credencial.contador,
            transports: [...credencial.transportes] as AuthenticatorTransportFuture[],
          },
        });
      } catch (error) {
        throw new VerificacionFallida(
          error instanceof Error ? error.message : 'la firma no cuadra',
        );
      }

      if (!verificacion.verified) throw new VerificacionFallida('la firma no cuadra');

      return {
        credencialId: verificacion.authenticationInfo.credentialID,
        contador: verificacion.authenticationInfo.newCounter,
      };
    },
  };
}

/**
 * Adaptador que niega todo, para un despliegue sin `PANEL_ORIGEN` configurado.
 *
 * Fallar cerrado y no abierto es la única opción defendible: un «mientras tanto» que dejara
 * pasar sería la agenda del estudio abierta a quien encuentre la URL.
 */
export function crearPasskeysNoDisponible(): Passkeys {
  const negar = (): never => {
    throw new VerificacionFallida('WebAuthn no está configurado en este despliegue');
  };

  return {
    opcionesDeRegistro: async () => negar(),
    verificarRegistro: async () => negar(),
    opcionesDeAcceso: async () => negar(),
    verificarAcceso: async () => negar(),
  };
}
