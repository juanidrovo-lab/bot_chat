/**
 * Lo que se entrega en una petición de acceso o portabilidad (LOPDP).
 *
 * Las fechas viajan como texto ISO en UTC, no como `Date`: el destinatario del export es un
 * archivo, no el proceso que lo generó.
 */
export interface ContactoExportado {
  id: string;
  waId: string;
  nombre: string | null;
  email: string | null;
  cedula: string | null;
  consentAt: string | null;
  consentVersion: string | null;
  consentRevocadoAt: string | null;
  anonimizadoAt: string | null;
  createdAt: string;
}

export interface ConversacionExportada {
  id: string;
  estado: string;
  derivadaAt: string | null;
  createdAt: string;
}

export interface MensajeExportado {
  conversacionId: string;
  direccion: string;
  tipo: string;
  payload: unknown;
  createdAt: string;
}

export interface CitaExportada {
  id: string;
  materia: string;
  modalidad: string;
  iniciaAt: string;
  terminaAt: string;
  estado: string;
  honorarioUsd: string;
  canceladaPor: string | null;
  canceladaAt: string | null;
  createdAt: string;
}

export interface ExpedienteContacto {
  generadoAt: string;
  contacto: ContactoExportado;
  conversaciones: ConversacionExportada[];
  mensajes: MensajeExportado[];
  citas: CitaExportada[];
}

export interface RepoExportacion {
  /** `null` si el contacto no existe en ese despacho. */
  expedienteDe(tenantId: string, contactoId: string): Promise<ExpedienteContacto | null>;
}
