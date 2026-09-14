/**
 * Cola de trabajos.
 *
 * `clave` es lo que serializa: dos trabajos con la misma clave se ejecutan en orden de
 * llegada y nunca a la vez. Es `conversacion_id`, porque dos mensajes seguidos del mismo
 * usuario cargarían el mismo estado y ambos lo escribirían (D10).
 */
export interface Cola {
  encolar(cola: string, datos: object, opciones: { clave: string }): Promise<string | null>;
  trabajar<T>(cola: string, manejador: (datos: T) => Promise<void>): Promise<void>;
}

export const COLA_MENSAJE_ENTRANTE = 'mensaje.entrante';

export interface TrabajoMensajeEntrante {
  tenantId: string;
  conversacionId: string;
  contactoId: string;
  waMessageId: string;
}
