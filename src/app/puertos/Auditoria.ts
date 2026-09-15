/**
 * Rastro de acceso a datos personales (LOPDP).
 *
 * No es un log: un log se rota y se pierde, y aquí la obligación es poder responder «quién
 * vio la ficha de este contacto y cuándo». Por eso vive en `eventos`, dentro de la misma
 * base y bajo la misma RLS que el dato al que se accedió.
 *
 * El `payload` de un evento **nunca** lleva el dato en sí —ni nombre, ni cédula, ni el
 * texto de la consulta—: guarda a quién se accedió, no qué decía. Registrar el contenido
 * convertiría la auditoría en una segunda copia de lo que protege.
 */
export interface EventoAuditable {
  tenantId: string;
  /** Quién: `usuario:<id>` en el panel, `sistema:<job>` en un trabajo programado. */
  actor: string;
  /** Qué pasó: `contacto.visto`, `cita.cancelada`, `datos.exportados`… */
  tipo: string;
  entidad?: string;
  entidadId?: string;
  /** Contexto sin datos personales. */
  payload?: Record<string, unknown>;
}

export interface Auditoria {
  registrar(evento: EventoAuditable): Promise<void>;
}
