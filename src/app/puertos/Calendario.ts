import type { Intervalo } from '../../domain/agenda/Slot.ts';

export interface EventoCalendario {
  /** Identificador determinista. Es lo que hace idempotente la creación (§5). */
  id: string;
  iniciaAt: Date;
  terminaAt: Date;
  titulo: string;
  descripcion?: string;
}

/**
 * El calendario de **un** abogado. Google Calendar es un espejo, no la fuente de verdad
 * (D4): la cita vive en Postgres y aquí solo se refleja.
 */
export interface Calendario {
  /** Devuelve el id del evento. Crear dos veces el mismo no crea dos eventos. */
  crearEvento(evento: EventoCalendario): Promise<string>;
  /** Borrar algo que ya no está no es un error. */
  borrarEvento(eventId: string): Promise<void>;
  /** Franjas ocupadas según Google, para importarlas como bloqueos. */
  ocupados(desdeMs: number, hastaMs: number): Promise<Intervalo[]>;
}

/**
 * Fábrica por abogado: el refresh token es de cada uno. Devuelve `null` cuando ese abogado
 * todavía no conectó su Google, que no es un error —simplemente no hay espejo que mantener—.
 */
export type CalendarioDe = (tenantId: string, abogadoId: string) => Promise<Calendario | null>;
