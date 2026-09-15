/**
 * Lo que lee la pantalla «Hoy y mañana» (§9).
 *
 * Es un modelo de lectura aparte y no una vista sobre `RepoCitas`: lo que el panel necesita
 * —el nombre del contacto junto a la cita, el motivo de la derivación— no tiene nada que
 * ver con lo que necesita la reserva, y mezclarlos obligaría a arrastrar campos de panel
 * por el camino conversacional.
 */
export interface CitaDelDia {
  id: string;
  iniciaAt: Date;
  terminaAt: Date;
  estado: string;
  materia: string;
  modalidad: string;
  honorarioUsd: string;
  abogadoId: string;
  abogadoNombre: string;
  contactoId: string;
  contactoNombre: string | null;
  contactoWaId: string;
}

export interface ConversacionEnBandeja {
  id: string;
  contactoId: string;
  contactoNombre: string | null;
  contactoWaId: string;
  estado: string;
  motivo: string;
  derivadaAt: Date;
  ultimoInboundAt: Date;
}

/** Ficha del contacto, tal como se despliega en línea. Es acceso a datos personales. */
export interface FichaContacto {
  id: string;
  waId: string;
  nombre: string | null;
  email: string | null;
  cedula: string | null;
  consentAt: Date | null;
  consentRevocadoAt: Date | null;
  bloqueado: boolean;
  citas: { id: string; iniciaAt: Date; estado: string; materia: string }[];
}

export interface RepoPanel {
  /** Citas vigentes en el rango, con el nombre del abogado y del contacto ya resueltos. */
  citasEntre(tenantId: string, desdeMs: number, hastaMs: number): Promise<CitaDelDia[]>;

  /** Conversaciones derivadas y sin cerrar: las que esperan a una persona. */
  bandeja(tenantId: string, limite: number): Promise<ConversacionEnBandeja[]>;

  /** `null` si el contacto no existe en ese despacho. */
  ficha(tenantId: string, contactoId: string): Promise<FichaContacto | null>;

  /** Cierra una conversación derivada: la persona ya la atendió. */
  cerrarConversacion(tenantId: string, conversacionId: string): Promise<boolean>;

  /**
   * Cancela dejando un plazo de gracia: la cita se cancela ya, pero los efectos que no se
   * pueden deshacer —el aviso al contacto, el borrado del evento de Google— se programan
   * para dentro de `graciaMs`.
   *
   * El estado sí cambia de inmediato a propósito. Retrasar también la cancelación dejaría
   * el horario ocupado durante el plazo y, si el navegador se cierra, la cita seguiría en
   * pie sin que nadie lo supiera.
   */
  cancelarConGracia(tenantId: string, citaId: string, graciaMs: number): Promise<boolean>;

  /**
   * Revierte una cancelación aún no publicada. Devuelve por qué no se pudo, si no se pudo:
   * `'plazo'` si ya pasó la ventana o los avisos salieron, `'ocupado'` si otro se llevó el
   * horario mientras tanto.
   */
  deshacerCancelacion(
    tenantId: string,
    citaId: string,
    graciaMs: number,
  ): Promise<'restaurada' | 'plazo' | 'ocupado'>;
}
