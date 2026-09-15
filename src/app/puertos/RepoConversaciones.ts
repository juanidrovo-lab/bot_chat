import type { MotivoDerivacion } from '../../domain/conversacion/acciones.ts';
import type { DatosContacto } from '../../domain/conversacion/estados.ts';
import type { MensajeNormalizado } from '../../domain/conversacion/mensaje.ts';

export interface ConversacionBloqueada {
  id: string;
  estado: string;
  contexto: unknown;
  flowVersion: number;
  fallosConsecutivos: number;
  /** A quién se responde. */
  waId: string;
  contactoId: string;
  /** Escalada a una persona: el bot no vuelve a responder en esta conversación. */
  derivada: boolean;
  /** Pasaron más de 24 h desde el último mensaje: se cerró la ventana de servicio. */
  ventanaExpirada: boolean;
}

/**
 * Todo lo que el caso de uso puede hacer con la conversación, dentro de la transacción que
 * la tiene bloqueada. Leer el mensaje también va aquí: su texto vive en `mensajes`, bajo
 * RLS, y no en el payload del trabajo encolado.
 */
export interface SesionConversacion {
  conversacion: ConversacionBloqueada;
  leerMensaje(waMessageId: string): Promise<MensajeNormalizado | null>;
  guardar(estado: string, contexto: unknown, fallosConsecutivos: number): Promise<void>;
  /** Persiste lo que el usuario escribió en el Flow de captura. */
  guardarDatosContacto(datos: DatosContacto): Promise<void>;
  derivar(motivo: MotivoDerivacion): Promise<void>;
  cerrar(): Promise<void>;
  /** Renueva la ventana de 24 h. Se llama después de haber leído si estaba vencida. */
  renovarVentana(): Promise<void>;
  /** Auditoría LOPDP. Nunca recibe PII: solo identificadores y tipos de evento. */
  registrarEvento(tipo: string, payload: object): Promise<void>;
}

export interface RepoConversaciones {
  enConversacionBloqueada<T>(
    tenantId: string,
    conversacionId: string,
    trabajo: (sesion: SesionConversacion) => Promise<T>,
  ): Promise<T | null>;
}
