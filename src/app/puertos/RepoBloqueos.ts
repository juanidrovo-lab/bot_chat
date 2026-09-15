import type { Intervalo } from '../../domain/agenda/Slot.ts';

export interface AbogadoConCalendario {
  id: string;
  calendarId: string;
}

export interface RepoBloqueos {
  /** Abogados activos que ya conectaron su Google. */
  conCalendario(tenantId: string): Promise<AbogadoConCalendario[]>;

  /**
   * Reemplaza los bloqueos importados de Google en la ventana. `freeBusy` devuelve franjas
   * sin identificador propio, así que sincronizar es sustituir: lo que Google ya no reporta
   * como ocupado deja de bloquear la agenda.
   *
   * Solo toca los de origen `gcal`: los bloqueos que el estudio ponga a mano no los pisa
   * una sincronización.
   */
  reemplazarDeGoogle(
    tenantId: string,
    abogadoId: string,
    desdeMs: number,
    hastaMs: number,
    ocupados: readonly Intervalo[],
  ): Promise<number>;
}
