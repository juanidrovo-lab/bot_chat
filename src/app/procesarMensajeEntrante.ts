import type { TrabajoMensajeEntrante } from './puertos/Cola.ts';
import type { RepoConversaciones, SesionConversacion } from './puertos/RepoConversaciones.ts';

/**
 * Punto de entrada de la fase 3. Recibe la conversación ya bloqueada y decide el siguiente
 * turno. Mientras no exista la máquina de estados, el trabajador funciona sin ella.
 */
export type Avanzar = (sesion: SesionConversacion, trabajo: TrabajoMensajeEntrante) => Promise<void>;

/**
 * Procesa un mensaje entrante ya deduplicado y encolado.
 *
 * Todo el trabajo ocurre con la fila de conversación bloqueada, así que dos mensajes
 * seguidos del mismo usuario no pueden cargar el mismo estado y escribirlo los dos (D10).
 */
export function crearProcesarMensajeEntrante(
  repo: RepoConversaciones,
  avanzar?: Avanzar,
): (trabajo: TrabajoMensajeEntrante) => Promise<void> {
  return async (trabajo) => {
    await repo.enConversacionBloqueada(trabajo.tenantId, trabajo.conversacionId, async (sesion) => {
      /**
       * Derivada a una persona: el bot se calla. El mensaje ya quedó guardado en
       * `mensajes` y la conversación está en la bandeja del panel; responder aquí sería
       * exactamente el bot que insiste después de haber admitido que no entiende.
       */
      if (sesion.conversacion.derivada) {
        await sesion.registrarEvento('mensaje.ignorado_por_derivacion', {
          waMessageId: trabajo.waMessageId,
        });
        return;
      }

      if (avanzar !== undefined) await avanzar(sesion, trabajo);

      await sesion.registrarEvento('mensaje.procesado', { waMessageId: trabajo.waMessageId });
    });
  };
}
