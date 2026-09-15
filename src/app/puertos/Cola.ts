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

/**
 * Colas de los trabajos programados (fase 6). Cada una la dispara un cron de pg-boss con
 * política `exclusive`: si una pasada tarda más que el intervalo, la siguiente no se apila
 * encima. El trabajo no lleva datos —`schedule` manda `null`— porque cada uno recorre los
 * despachos por su cuenta.
 */
export const COLA_RELAY_OUTBOX = 'outbox.relay';
export const COLA_SINCRONIZAR_AGENDA = 'agenda.sincronizar';
export const COLA_REFRESCAR_MEDIA = 'media.refrescar';
export const COLA_ENVIAR_RECORDATORIOS = 'recordatorios.enviar';
export const COLA_APLICAR_RETENCION = 'retencion.aplicar';
export const COLA_REVISAR_ALERTAS = 'alertas.revisar';

/**
 * Cron de cada trabajo programado, en **hora local del despacho**: la zona la pone el
 * arranque, que es quien puede nombrarla.
 *
 * Los de madrugada no se solapan entre sí a propósito: la retención borra mensajes y el
 * refresco de media sube ficheros; correrlos a la misma hora solo sirve para que el pico de
 * carga sea uno más alto.
 */
export const CRON_PROGRAMADO: Readonly<Record<string, string>> = {
  [COLA_RELAY_OUTBOX]: '* * * * *',
  [COLA_SINCRONIZAR_AGENDA]: '*/5 * * * *',
  [COLA_ENVIAR_RECORDATORIOS]: '0 9 * * *',
  [COLA_APLICAR_RETENCION]: '0 3 * * *',
  [COLA_REFRESCAR_MEDIA]: '0 4 * * *',
  /**
   * Cada cuarto de hora, no cada minuto: la alerta de la outbox mira quince minutos atrás y
   * la del silencio compara días. Revisar más a menudo solo repetiría el mismo aviso.
   */
  [COLA_REVISAR_ALERTAS]: '*/15 * * * *',
};
