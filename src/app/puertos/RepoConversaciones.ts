export interface ConversacionBloqueada {
  id: string;
  estado: string;
  contexto: unknown;
  flowVersion: number;
  fallosConsecutivos: number;
  /** Escalada a una persona: el bot no vuelve a responder en esta conversación. */
  derivada: boolean;
  /** Pasaron más de 24 h desde el último mensaje del usuario: se cerró la ventana. */
  ventanaExpirada: boolean;
}

export interface SesionConversacion {
  conversacion: ConversacionBloqueada;
  /** Auditoría LOPDP. Nunca recibe PII: solo identificadores y tipos de evento. */
  registrarEvento(tipo: string, payload: object): Promise<void>;
}

export interface RepoConversaciones {
  /**
   * Abre una transacción con el tenant fijado, toma la fila de conversación en exclusiva
   * y ejecuta el trabajo. Devuelve `null` si la conversación ya no existe.
   */
  enConversacionBloqueada<T>(
    tenantId: string,
    conversacionId: string,
    trabajo: (sesion: SesionConversacion) => Promise<T>,
  ): Promise<T | null>;
}
