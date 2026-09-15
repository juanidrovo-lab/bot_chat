/**
 * Implementación del puerto `Passkeys`.
 *
 * **Estado: pendiente de `@simplewebauthn/server`.** El paquete está en el stack (§2) pero
 * todavía no está instalado en este repositorio, y verificar una firma de WebAuthn a mano
 * —CBOR de la atestación, `rpIdHash`, flags, contador, cadena de certificados— es
 * exactamente el tipo de criptografía que §2 decidió no escribir. Mientras falte, esto
 * **falla cerrado**: nadie entra al panel.
 *
 * Fallar cerrado y no abierto es la única opción defendible. Un adaptador que dejara pasar
 * «mientras tanto» sería un panel con los datos de los clientes abierto a quien encuentre
 * la URL, y de esos «mientras tanto» viven las brechas.
 *
 * Para completarlo: instalar el paquete y traducir entre este puerto y
 * `generateRegistrationOptions` / `verifyRegistrationResponse` /
 * `generateAuthenticationOptions` / `verifyAuthenticationResponse`. El resto del flujo
 * —reto de un solo uso en la base, contador que tiene que avanzar, sesión con el hash del
 * testigo— ya está en `app/autenticar.ts` y no cambia.
 */
import type { Passkeys } from '../../app/puertos/Passkeys.ts';
import { VerificacionFallida } from '../../app/puertos/Passkeys.ts';

export class PasskeysNoDisponible extends Error {
  constructor() {
    super('WebAuthn no está configurado: falta instalar @simplewebauthn/server');
    this.name = 'PasskeysNoDisponible';
  }
}

export interface OpcionesPasskeys {
  /** Dominio del panel, sin esquema ni puerto. */
  rpId: string;
  /** Origen exacto que el navegador pondrá en `clientDataJSON`. */
  origen: string;
  nombreRp: string;
}

/**
 * Adaptador que niega todo. Es lo que se monta mientras el paquete no esté: el panel se
 * sirve, la página de acceso se ve, y ningún intento de entrar prospera.
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
