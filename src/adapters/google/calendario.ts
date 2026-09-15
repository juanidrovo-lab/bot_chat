/**
 * Google Calendar como **espejo** de la agenda (D4).
 *
 * La cita vive en Postgres; aquí solo se refleja. Si Google está caído, la reserva ya
 * ocurrió y el relay reintentará: nunca se bloquea una reserva por un servicio externo.
 *
 * La idempotencia no se consigue reintentando con cuidado, sino dándole a Google un
 * identificador determinista: crear dos veces el mismo evento devuelve 409, que aquí es
 * un éxito. Es lo que hace que correr el relay dos veces no cree dos eventos.
 */
import { calendar, type calendar_v3 } from '@googleapis/calendar';
import { OAuth2Client } from 'google-auth-library';
import type { Calendario, CalendarioDe, EventoCalendario } from '../../app/puertos/Calendario.ts';
import type { Intervalo } from '../../domain/agenda/Slot.ts';
import { logger } from '../../platform/logger.ts';

/**
 * Identificador de evento derivado del id de la cita.
 *
 * Google exige base32hex —minúsculas de la «a» a la «v» y dígitos— y entre 5 y 1024
 * caracteres. Un uuid sin guiones son 32 caracteres de [0-9a-f], que cae dentro de ese
 * juego, así que la conversión es quitar los guiones y nada más.
 */
export function idDeEvento(citaId: string): string {
  const limpio = citaId.replace(/-/g, '').toLowerCase();
  if (!/^[a-v0-9]{5,1024}$/.test(limpio)) {
    throw new Error(`El id de cita «${citaId}» no sirve como id de evento de Google`);
  }
  return limpio;
}

/** Google devuelve el estado en sitios distintos según la versión del cliente. */
function estadoHttp(error: unknown): number | null {
  if (typeof error !== 'object' || error === null) return null;
  const e = error as { status?: unknown; code?: unknown; response?: { status?: unknown } };
  for (const candidato of [e.status, e.code, e.response?.status]) {
    if (typeof candidato === 'number') return candidato;
  }
  return null;
}

export interface CredencialesCalendario {
  calendarId: string;
  refreshToken: string;
}

export interface OpcionesGoogle {
  clientId: string;
  clientSecret: string;
  /** Lee y descifra las credenciales del abogado. Lo implementa el adaptador de Postgres. */
  credencialesDe: (tenantId: string, abogadoId: string) => Promise<CredencialesCalendario | null>;
  /** Inyectable para poder probar sin red. */
  clienteDe?: (credenciales: CredencialesCalendario) => calendar_v3.Calendar;
}

export function crearCalendarioDe(opciones: OpcionesGoogle): CalendarioDe {
  const clienteDe =
    opciones.clienteDe ??
    ((credenciales: CredencialesCalendario) => {
      // OAuth con refresh token, no cuenta de servicio: los calendarios son cuentas de
      // Gmail gratuitas y una cuenta de servicio no puede suplantarlas sin Workspace.
      const oauth = new OAuth2Client({
        clientId: opciones.clientId,
        clientSecret: opciones.clientSecret,
      });
      oauth.setCredentials({ refresh_token: credenciales.refreshToken });
      return calendar({ version: 'v3', auth: oauth });
    });

  return async (tenantId, abogadoId) => {
    const credenciales = await opciones.credencialesDe(tenantId, abogadoId);
    // Un abogado que todavía no conectó su Google no es un error: no hay espejo que mantener.
    if (credenciales === null) return null;

    const cliente = clienteDe(credenciales);
    const calendarId = credenciales.calendarId;

    const calendario: Calendario = {
      async crearEvento(evento: EventoCalendario) {
        try {
          const respuesta = await cliente.events.insert({
            calendarId,
            requestBody: {
              id: evento.id,
              summary: evento.titulo,
              ...(evento.descripcion === undefined ? {} : { description: evento.descripcion }),
              start: { dateTime: evento.iniciaAt.toISOString() },
              end: { dateTime: evento.terminaAt.toISOString() },
            },
          });
          return respuesta.data.id ?? evento.id;
        } catch (error) {
          // 409: ya existe un evento con ese id, que es precisamente el que íbamos a crear.
          if (estadoHttp(error) === 409) {
            logger.info({ tenantId }, 'el evento de Google ya existía; se reusa');
            return evento.id;
          }
          throw error;
        }
      },

      async borrarEvento(eventId) {
        try {
          await cliente.events.delete({ calendarId, eventId });
        } catch (error) {
          const estado = estadoHttp(error);
          // Borrar algo que ya no está es el resultado que se buscaba.
          if (estado === 404 || estado === 410) return;
          throw error;
        }
      },

      async ocupados(desdeMs, hastaMs) {
        const respuesta = await cliente.freebusy.query({
          requestBody: {
            timeMin: new Date(desdeMs).toISOString(),
            timeMax: new Date(hastaMs).toISOString(),
            items: [{ id: calendarId }],
          },
        });

        const franjas = respuesta.data.calendars?.[calendarId]?.busy ?? [];
        const intervalos: Intervalo[] = [];
        for (const franja of franjas) {
          if (typeof franja.start !== 'string' || typeof franja.end !== 'string') continue;
          const inicioMs = Date.parse(franja.start);
          const finMs = Date.parse(franja.end);
          // Una franja ilegible se descarta: mejor un hueco de más que una agenda rota.
          if (Number.isNaN(inicioMs) || Number.isNaN(finMs) || finMs <= inicioMs) continue;
          intervalos.push({ inicioMs, finMs });
        }
        return intervalos;
      },
    };

    return calendario;
  };
}
