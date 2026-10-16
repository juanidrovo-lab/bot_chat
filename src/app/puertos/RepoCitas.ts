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
  /**
   * Avisar al contacto por WhatsApp de que su cita quedó.
   *
   * Lo pide el panel y no el bot: cuando reserva el bot, la confirmación sale en el mismo
   * turno y con la ventana abierta. Cuando reserva el estudio, el contacto no está
   * escribiendo, así que el aviso tiene que salir por la outbox como cualquier otro efecto
   * externo — en esta misma transacción, para que no exista una cita de la que nadie se
   * enteró.
   */
  avisarContacto?: boolean;
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
  /**
   * Último mensaje del contacto. De aquí sale si la ventana de servicio de 24 h sigue
   * abierta, que es lo que decide entre un texto libre —revisable por el estudio, sin pasar
   * por Meta— y una plantilla aprobada.
   */
  ultimoInboundAt: Date | null;
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

  /** El contacto confirmó que asistirá. Confirmar dos veces tampoco es un error. */
  confirmarAsistencia(tenantId: string, citaId: string): Promise<boolean>;

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
