import { leerIdDeSlot } from '../domain/agenda/Slot.ts';
import type { Politica } from '../domain/agenda/politicas.ts';
import {
  LimiteMensualError,
  SlotTomadoError,
  YaTieneCitaError,
} from '../domain/agenda/errores.ts';
import type { DatosContacto } from '../domain/conversacion/estados.ts';
import type { CitaReservada, RepoCitas } from './puertos/RepoCitas.ts';

export interface PeticionReserva {
  tenantId: string;
  contactoId: string;
  materia: string;
  modalidad: 'presencial' | 'virtual';
  /** Identificador opaco del hueco elegido. */
  slotId: string;
  honorarioUsd: string;
  datos: DatosContacto;
  /** Presente cuando esto es un reagendamiento: la cita que reemplaza. */
  citaOrigenId?: string;
}

export type ResultadoReserva =
  | { estado: 'reservada'; cita: CitaReservada }
  | { estado: 'ocupado' }
  | { estado: 'yaTieneCita' }
  | { estado: 'limiteMensual' }
  | { estado: 'slotInvalido' };

/**
 * Reserva una cita, o dice por qué no pudo.
 *
 * **Reagendar es esta misma operación con `citaOrigenId`.** No hay un `reagendarCita.ts`
 * aparte porque sería un envoltorio de un solo campo alrededor de esto: la cancelación de
 * la cita anterior y la inserción de la nueva tienen que ocurrir en la misma transacción,
 * así que separarlas en dos casos de uso invitaría justo al error que hay que evitar
 * —cancelar primero y quedarse sin cita si la reserva falla—.
 *
 * Los tres fallos posibles no son excepciones excepcionales: son ramas del guion, y por eso
 * salen como resultado y no como `throw`.
 */
export async function reservarCita(
  repo: RepoCitas,
  politica: Politica,
  peticion: PeticionReserva,
): Promise<ResultadoReserva> {
  const slot = leerIdDeSlot(peticion.slotId);
  if (slot === null) return { estado: 'slotInvalido' };

  const iniciaAt = new Date(slot.inicioMs);
  const terminaAt = new Date(slot.inicioMs + politica.duracionMin * 60_000);

  try {
    const cita = await repo.reservar({
      tenantId: peticion.tenantId,
      abogadoId: slot.abogadoId,
      contactoId: peticion.contactoId,
      materia: peticion.materia,
      modalidad: peticion.modalidad,
      iniciaAt,
      terminaAt,
      honorarioUsd: peticion.honorarioUsd,
      ...(peticion.citaOrigenId === undefined ? {} : { citaOrigenId: peticion.citaOrigenId }),
      // Mover una cita no gasta cupo mensual: el tope frena el spam, no a quien reagenda.
      consumeCupo: peticion.citaOrigenId === undefined,
    });
    return { estado: 'reservada', cita };
  } catch (error) {
    if (error instanceof SlotTomadoError) return { estado: 'ocupado' };
    if (error instanceof YaTieneCitaError) return { estado: 'yaTieneCita' };
    if (error instanceof LimiteMensualError) return { estado: 'limiteMensual' };
    throw error;
  }
}
