/**
 * El baile de OAuth con Google, detrás de un puerto.
 *
 * Lo que el caso de uso decide —que el `state` sea de un solo uso, que viva en la base, que
 * el refresh token se cifre antes de guardarlo— no depende de la biblioteca de Google y por
 * eso no está aquí.
 */
export interface CalendarioConectado {
  /**
   * El identificador del calendario principal, que en una cuenta de Gmail es el correo.
   * Se guarda ese y no `primary` para que el panel pueda decir **qué cuenta** quedó
   * conectada: un abogado con dos cuentas tiene que poder ver cuál autorizó.
   */
  calendarId: string;
  /** Vive cifrado en `abogados.gcal_refresh_token_enc`, nunca en claro. */
  refreshToken: string;
}

export class ConexionGoogleFallida extends Error {
  constructor(motivo: string) {
    super(motivo);
    this.name = 'ConexionGoogleFallida';
  }
}

/**
 * El `redirectUri` viaja en cada llamada y no se fija al arrancar.
 *
 * Google exige que coincida **carácter por carácter** con una de las URIs registradas, y la
 * vuelta del panel es por despacho (`/panel/<slug>/calendario/google`). Fijarlo al arrancar
 * obligaría a un proceso por despacho; componerlo por petición solo obliga a registrar una
 * URI por despacho en Google Cloud, que para un estudio son treinta segundos una vez.
 */
export interface OAuthGoogle {
  /** URL a la que se manda al abogado para que autorice. */
  urlDeAutorizacion(state: string, redirectUri: string): string;

  /**
   * Canjea el código por un refresh token y averigua qué calendario quedó conectado.
   *
   * Lanza `ConexionGoogleFallida` si Google no devuelve refresh token, que es el fallo más
   * fácil de tener y el que deja una conexión que parece buena y no sirve.
   */
  canjear(codigo: string, redirectUri: string): Promise<CalendarioConectado>;
}
