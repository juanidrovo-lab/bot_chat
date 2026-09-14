export interface ReservaInput {
  tenantId: string;
  abogadoId: string;
  contactoId: string;
  materia: string;
  modalidad: 'presencial' | 'virtual';
  iniciaAt: Date;
  terminaAt: Date;
  honorarioUsd: string;
}

export interface CitaReservada {
  id: string;
  iniciaAt: Date;
  terminaAt: Date;
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
}
