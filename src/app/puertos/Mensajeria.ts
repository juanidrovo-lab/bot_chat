/**
 * Formas genéricas de una opción presentable. Se definen aquí y no en el adaptador de
 * WhatsApp: un puerto que importa de su propio adaptador deja de ser un puerto, y el día
 * que haya un widget web o Telegram estas siguen valiendo igual.
 */
export interface FilaLista {
  id: string;
  titulo: string;
  descripcion?: string;
}

export interface BotonRespuesta {
  id: string;
  titulo: string;
}

export interface SeccionLista {
  titulo: string;
  filas: readonly FilaLista[];
}

export interface Lista {
  encabezado?: string;
  cuerpo: string;
  pie?: string;
  textoBoton: string;
  secciones: readonly SeccionLista[];
}

export interface Botones {
  cuerpo: string;
  botones: readonly BotonRespuesta[];
}

/**
 * Flow estático de captura de datos (§8). No lleva endpoint ni cifrado: la respuesta llega
 * en el `nfm_reply` del webhook.
 */
export interface Flow {
  flowId: string;
  cta: string;
  cuerpo: string;
  /** Identifica esta sesión del formulario en la respuesta. */
  token: string;
}

export interface Plantilla {
  nombre: string;
  idioma: string;
  componentes?: readonly unknown[];
}

/**
 * Salida hacia el usuario. Todo lo que sale pasa por aquí, y todo se trunca a los límites
 * de WhatsApp antes de salir.
 *
 * Cada método devuelve el `wa_message_id` que asigna Meta, para poder guardarlo en
 * `mensajes` y casar después los acuses de entrega.
 */
export interface Mensajeria {
  enviarTexto(destino: string, texto: string): Promise<string>;
  enviarLista(destino: string, lista: Lista): Promise<string>;
  enviarBotones(destino: string, botones: Botones): Promise<string>;
  /** Nota de voz: `.ogg` con OPUS y `voice: true`. */
  enviarAudio(destino: string, mediaId: string): Promise<string>;
  enviarPlantilla(destino: string, plantilla: Plantilla): Promise<string>;
  enviarFlow(destino: string, flow: Flow): Promise<string>;
}
