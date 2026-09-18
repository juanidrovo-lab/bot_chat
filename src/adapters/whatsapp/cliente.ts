/**
 * Cliente de la API de WhatsApp Cloud.
 *
 * Dos responsabilidades y nada más: traducir la forma que pide Meta, y sobrevivir a que
 * Meta responda 429 o 5xx. Ni una decisión de producto; los textos vienen de `content.ts`.
 */
import type { Botones, Flow, Lista, Mensajeria, Plantilla } from '../../app/puertos/Mensajeria.ts';
import { ajustarBotones, ajustarFilas, LIMITES, truncar } from './limites.ts';

export class ErrorWhatsApp extends Error {
  readonly estado: number;
  readonly reintentable: boolean;

  constructor(estado: number, detalle: string, reintentable: boolean) {
    super(`WhatsApp respondió ${estado}: ${detalle}`);
    this.name = 'ErrorWhatsApp';
    this.estado = estado;
    this.reintentable = reintentable;
  }
}

export interface OpcionesCliente {
  phoneNumberId: string;
  token: string;
  urlBase?: string;
  version?: string;
  maxIntentos?: number;
  /** Inyectables para poder probar el backoff sin red y sin esperas reales. */
  fetchImpl?: typeof fetch;
  esperar?: (ms: number) => Promise<void>;
}

const dormir = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** 429 y 5xx se reintentan; 4xx del resto son errores nuestros y no mejoran repitiendo. */
function esReintentable(estado: number): boolean {
  return estado === 429 || estado >= 500;
}

function esperaTrasFallo(intento: number, cabecera: string | null): number {
  const retryAfter = Number(cabecera);
  if (Number.isFinite(retryAfter) && retryAfter > 0) return Math.min(retryAfter * 1000, 30_000);
  // Exponencial con jitter: sin el jitter, todos los workers reintentan a la vez.
  const base = Math.min(2 ** intento * 500, 16_000);
  return base + Math.floor(Math.random() * 250);
}

export function crearMensajeria(opciones: OpcionesCliente): Mensajeria {
  const {
    phoneNumberId,
    token,
    urlBase = 'https://graph.facebook.com',
    version = 'v23.0',
    maxIntentos = 4,
    fetchImpl = fetch,
    esperar = dormir,
  } = opciones;

  const url = `${urlBase}/${version}/${phoneNumberId}/messages`;

  async function enviar(cuerpo: object): Promise<string> {
    let ultimo: ErrorWhatsApp | undefined;

    for (let intento = 0; intento < maxIntentos; intento++) {
      const respuesta = await fetchImpl(url, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ messaging_product: 'whatsapp', ...cuerpo }),
      });

      if (respuesta.ok) {
        const datos = (await respuesta.json()) as { messages?: { id?: string }[] };
        const id = datos.messages?.[0]?.id;
        if (id === undefined) throw new ErrorWhatsApp(respuesta.status, 'respuesta sin wa_message_id', false);
        return id;
      }

      // El cuerpo del error puede traer el texto del mensaje: no se registra, solo el
      // código. Un log con una consulta de familia dentro es una brecha.
      ultimo = new ErrorWhatsApp(respuesta.status, respuesta.statusText, esReintentable(respuesta.status));
      if (!ultimo.reintentable) throw ultimo;
      if (intento < maxIntentos - 1) {
        await esperar(esperaTrasFallo(intento, respuesta.headers.get('retry-after')));
      }
    }

    throw ultimo ?? new ErrorWhatsApp(0, 'sin respuesta', true);
  }

  return {
    async enviarTexto(destino, texto) {
      return enviar({
        to: destino,
        type: 'text',
        text: { body: truncar(texto, LIMITES.texto), preview_url: false },
      });
    },

    async enviarLista(destino, lista: Lista) {
      /**
       * El límite de 10 filas es del mensaje entero, no de cada sección: hay que repartir
       * el presupuesto entre secciones y parar cuando se agota, o Meta devuelve 400 y el
       * usuario no recibe nada.
       */
      let restantes: number = LIMITES.filasLista;
      const secciones = [];
      for (const seccion of lista.secciones) {
        if (restantes === 0) break;
        const filas = ajustarFilas(seccion.filas).slice(0, restantes);
        if (filas.length === 0) continue;
        restantes -= filas.length;
        secciones.push({
          title: truncar(seccion.titulo, LIMITES.tituloSeccion),
          rows: filas.map((f) => ({
            id: f.id,
            title: f.titulo,
            ...(f.descripcion === undefined ? {} : { description: f.descripcion }),
          })),
        });
      }

      return enviar({
        to: destino,
        type: 'interactive',
        interactive: {
          type: 'list',
          ...(lista.encabezado === undefined
            ? {}
            : { header: { type: 'text', text: truncar(lista.encabezado, LIMITES.encabezado) } }),
          body: { text: truncar(lista.cuerpo, LIMITES.cuerpo) },
          ...(lista.pie === undefined ? {} : { footer: { text: truncar(lista.pie, LIMITES.pie) } }),
          action: { button: truncar(lista.textoBoton, LIMITES.textoBotonLista), sections: secciones },
        },
      });
    },

    async enviarBotones(destino, botones: Botones) {
      return enviar({
        to: destino,
        type: 'interactive',
        interactive: {
          type: 'button',
          body: { text: truncar(botones.cuerpo, LIMITES.cuerpo) },
          action: {
            buttons: ajustarBotones(botones.botones).map((b) => ({
              type: 'reply',
              reply: { id: b.id, title: b.titulo },
            })),
          },
        },
      });
    },

    async enviarAudio(destino, mediaId) {
      // `voice: true` más un .ogg/OPUS es lo que hace que llegue como nota de voz.
      // Cualquier otra combinación aparece como archivo adjunto.
      return enviar({ to: destino, type: 'audio', audio: { id: mediaId, voice: true } });
    },

    async enviarImagen(destino, mediaId, pie) {
      // El pie se trunca como cualquier cuerpo: Meta rechaza el mensaje entero si se pasa.
      return enviar({
        to: destino,
        type: 'image',
        image: { id: mediaId, caption: truncar(pie, LIMITES.cuerpo) },
      });
    },

    async enviarUbicacion(destino, ubicacion) {
      /**
       * Meta quiere las coordenadas como **cadenas**, no como números, y con un número
       * devuelve un 400 que habla de un campo que sí mandaste. `name` y `address` son
       * opcionales pero sin ellos el punto aparece sin etiqueta y no se sabe qué es.
       */
      return enviar({
        to: destino,
        type: 'location',
        location: {
          latitude: String(ubicacion.latitud),
          longitude: String(ubicacion.longitud),
          ...(ubicacion.nombre === undefined ? {} : { name: ubicacion.nombre }),
          ...(ubicacion.direccion === undefined ? {} : { address: ubicacion.direccion }),
        },
      });
    },

    async enviarFlow(destino, flow: Flow) {
      // Flow estático: sin `flow_action_payload` ni endpoint de datos, que exigiría cifrado
      // híbrido RSA-OAEP más AES-128-GCM y un health check. Para un formulario de una
      // pantalla no hace falta nada de eso.
      return enviar({
        to: destino,
        type: 'interactive',
        interactive: {
          type: 'flow',
          body: { text: truncar(flow.cuerpo, LIMITES.cuerpo) },
          action: {
            name: 'flow',
            parameters: {
              flow_message_version: '3',
              flow_id: flow.flowId,
              flow_token: flow.token,
              flow_cta: truncar(flow.cta, LIMITES.textoBoton),
              mode: 'published',
            },
          },
        },
      });
    },

    async enviarPlantilla(destino, plantilla: Plantilla) {
      return enviar({
        to: destino,
        type: 'template',
        template: {
          name: plantilla.nombre,
          language: { code: plantilla.idioma },
          ...(plantilla.componentes === undefined ? {} : { components: plantilla.componentes }),
        },
      });
    },
  };
}
