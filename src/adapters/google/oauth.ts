/**
 * El baile de OAuth con Google, sobre `google-auth-library`.
 *
 * Tres detalles que, mal puestos, dejan una conexión que parece buena y no sirve:
 *
 *  - **`access_type: 'offline'` y `prompt: 'consent'`.** Google entrega el refresh token
 *    solo en la primera autorización de una cuenta. Sin forzar el consentimiento, un
 *    abogado que ya había autorizado alguna vez —o que reconecta tras un error— recibe un
 *    access token de una hora y ningún refresh token: la conexión funciona esa tarde y deja
 *    de funcionar al día siguiente, sin que nadie lo relacione.
 *  - **Se comprueba que el refresh token vino.** Si no vino, es mejor fallar la conexión que
 *    guardar media credencial.
 *  - **El `calendarId` se pregunta, no se asume.** `primary` funciona, pero guardar el
 *    correo real permite que el panel diga qué cuenta quedó conectada, que es lo que un
 *    abogado con dos cuentas necesita ver.
 */
import { calendar } from '@googleapis/calendar';
import { OAuth2Client } from 'google-auth-library';
import type { CalendarioConectado, OAuthGoogle } from '../../app/puertos/OAuthGoogle.ts';
import { ConexionGoogleFallida } from '../../app/puertos/OAuthGoogle.ts';

/** Lectura y escritura de eventos: el espejo escribe y la importación de bloqueos lee. */
const ALCANCES = ['https://www.googleapis.com/auth/calendar'];

export interface OpcionesOAuth {
  clientId: string;
  clientSecret: string;
}

export function crearOAuthGoogle(opciones: OpcionesOAuth): OAuthGoogle {
  /**
   * El `redirectUri` va en cada cliente porque tiene que coincidir carácter por carácter
   * con la URI autorizada en Google Cloud —una barra final de más y el canje falla con
   * `redirect_uri_mismatch`— y la vuelta del panel es por despacho.
   */
  const cliente = (redirectUri: string): OAuth2Client =>
    new OAuth2Client({
      clientId: opciones.clientId,
      clientSecret: opciones.clientSecret,
      redirectUri,
    });

  return {
    urlDeAutorizacion(state, redirectUri) {
      return cliente(redirectUri).generateAuthUrl({
        access_type: 'offline',
        // Sin esto, reconectar no devuelve refresh token. Ver la cabecera del archivo.
        prompt: 'consent',
        scope: ALCANCES,
        state,
        include_granted_scopes: true,
      });
    },

    async canjear(codigo, redirectUri) {
      const oauth = cliente(redirectUri);

      let tokens;
      try {
        ({ tokens } = await oauth.getToken(codigo));
      } catch (error) {
        throw new ConexionGoogleFallida(
          error instanceof Error ? error.message : 'Google rechazó el código',
        );
      }

      const refreshToken = tokens.refresh_token;
      if (refreshToken === undefined || refreshToken === null || refreshToken === '') {
        throw new ConexionGoogleFallida(
          'Google no devolvió refresh token: la conexión duraría una hora',
        );
      }

      oauth.setCredentials(tokens);

      let calendarId: string;
      try {
        const api = calendar({ version: 'v3', auth: oauth });
        const { data } = await api.calendarList.get({ calendarId: 'primary' });
        calendarId = data.id ?? 'primary';
      } catch (error) {
        throw new ConexionGoogleFallida(
          error instanceof Error ? error.message : 'no se pudo leer el calendario principal',
        );
      }

      return { calendarId, refreshToken } satisfies CalendarioConectado;
    },
  };
}

/**
 * OAuth que niega, para un despliegue sin credenciales de Google o sin `PANEL_ORIGEN`.
 *
 * Falla cerrado como el resto: la pantalla de calendarios se sirve, dice que no se puede
 * conectar, y el bot sigue agendando sobre Postgres — que es lo que D4 siempre dijo.
 */
export function crearOAuthNoDisponible(): OAuthGoogle {
  const motivo = 'Google no está configurado en este despliegue';
  return {
    urlDeAutorizacion: () => {
      throw new ConexionGoogleFallida(motivo);
    },
    canjear: async () => {
      throw new ConexionGoogleFallida(motivo);
    },
  };
}
