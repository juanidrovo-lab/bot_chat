/**
 * Las dos ceremonias de WebAuthn, detrás de un puerto.
 *
 * Aquí no se valida nada a mano: comprobar una firma de WebAuthn —el `clientDataJSON`, el
 * origen, el `rpIdHash`, el flag de presencia de usuario, el contador del autenticador— es
 * exactamente el tipo de criptografía que no se escribe uno mismo. El adaptador es una capa
 * fina sobre `@simplewebauthn/server` (§2), y este puerto existe para que el caso de uso no
 * dependa de esa biblioteca ni de su forma de nombrar las cosas.
 *
 * Lo que sí es responsabilidad del sistema, y por eso está en el caso de uso y no aquí: que
 * el reto sea de un solo uso, que viva en la base y no en memoria, y que el contador nuevo
 * se guarde.
 */
export interface OpcionesRegistro {
  /** JSON que el navegador pasa tal cual a `navigator.credentials.create()`. */
  opciones: unknown;
  reto: string;
}

export interface OpcionesAcceso {
  /** JSON que el navegador pasa tal cual a `navigator.credentials.get()`. */
  opciones: unknown;
  reto: string;
}

export interface UsuarioParaRegistro {
  id: string;
  email: string;
  nombre: string;
  /** Credenciales que ya tiene: el navegador no debe ofrecer registrar la misma dos veces. */
  credencialesExistentes: readonly string[];
}

export interface CredencialRegistrada {
  credencialId: string;
  clavePublica: string;
  contador: number;
  transportes: readonly string[];
}

export interface CredencialGuardada {
  credencialId: string;
  clavePublica: string;
  contador: number;
  transportes: readonly string[];
}

export interface AccesoVerificado {
  credencialId: string;
  /** Contador nuevo del autenticador. Si no avanzó, la credencial puede estar clonada. */
  contador: number;
}

export class VerificacionFallida extends Error {}

export interface Passkeys {
  opcionesDeRegistro(usuario: UsuarioParaRegistro): Promise<OpcionesRegistro>;

  /** Lanza `VerificacionFallida` si la respuesta no cuadra. */
  verificarRegistro(respuesta: unknown, reto: string): Promise<CredencialRegistrada>;

  opcionesDeAcceso(credenciales: readonly CredencialGuardada[]): Promise<OpcionesAcceso>;

  /** Lanza `VerificacionFallida` si la firma, el origen o el reto no cuadran. */
  verificarAcceso(
    respuesta: unknown,
    reto: string,
    credencial: CredencialGuardada,
  ): Promise<AccesoVerificado>;
}
