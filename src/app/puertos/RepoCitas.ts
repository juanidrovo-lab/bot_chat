import type { Ocupado } from '../../domain/agenda/Slot.ts';
import type { HorarioSemanal } from '../../domain/agenda/politicas.ts';

export interface ReservaInput {
  tenantId: string;
  abogadoId: string;
  contactoId: string;
  materia: string;
  modalidad: 'presencial' | 'virtual';
  iniciaAt: Date;
  terminaAt: Date;
  honorarioUsd: string;
  /**
   * Cita que este reagendamiento reemplaza. Se cancela en la MISMA transacción: si se
   * cancelara antes, un fallo al reservar dejaría al contacto sin cita ninguna.
   */
  citaOrigenId?: string;
  /**
   * Si esta reserva gasta cupo mensual (§6). Un reagendamiento no lo gasta: mover una cita
   * no es pedir una nueva, y cobrarle cupo dejaría fuera a quien reagenda dos veces, que es
   * justo el usuario que sí avisa en vez de no presentarse.
   */
  consumeCupo: boolean;
}

export interface CitaReservada {
  id: string;
  iniciaAt: Date;
  terminaAt: Date;
}

export type QuienCancela = 'contacto' | 'estudio' | 'sistema';

/** Lo que el espejo de Google necesita saber de una cita. */
export interface CitaParaCalendario {
  id: string;
  abogadoId: string;
  materia: string;
  modalidad: 'presencial' | 'virtual';
  iniciaAt: Date;
  terminaAt: Date;
  estado: string;
  gcalEventId: string | null;
  nombreContacto: string | null;
  waIdContacto: string;
}

export interface RepoCitas {
  /**
   * Reserva o falla. Nunca consulta disponibilidad para después insertar: la exclusión la
   * garantizan los índices de `citas`.
   *
   * Lanza `SlotTomadoError`, `YaTieneCitaError` o `LimiteMensualError`
   * (`domain/agenda/errores.ts`) según cuál de las tres restricciones haya cedido.
   */
  reservar(input: ReservaInput): Promise<CitaReservada>;

  /** Devuelve `false` si la cita ya no estaba activa: cancelar dos veces no es un error. */
  cancelar(tenantId: string, citaId: string, por: QuienCancela): Promise<boolean>;

  /** Abogados activos que atienden esa materia. */
  abogadosDe(tenantId: string, materia: string): Promise<string[]>;

  horarioSemanal(tenantId: string): Promise<HorarioSemanal>;

  /** Devuelve `null` si la cita ya no existe. */
  paraCalendario(tenantId: string, citaId: string): Promise<CitaParaCalendario | null>;

  /** Guarda el id del evento espejo. */
  anotarEventoGoogle(tenantId: string, citaId: string, eventId: string): Promise<void>;

  /** Citas y bloqueos que tapan huecos en la ventana pedida, en una sola consulta. */
  ocupados(
    tenantId: string,
    abogadoIds: readonly string[],
    desdeMs: number,
    hastaMs: number,
  ): Promise<Ocupado[]>;
}
