/**
 * Esquemas Zod del webhook de WhatsApp Cloud.
 *
 * Todo lo que entra se valida aquí, en el borde. Dos criterios:
 *
 *  - Los objetos son laxos (`looseObject`): Meta añade campos sin avisar y no queremos que
 *    un campo nuevo tumbe el webhook. Lo que sí es estricto es la forma de lo que usamos.
 *  - Un tipo de mensaje que no modelamos no es un error: se reconoce como `no_soportado`
 *    y el flujo responde lo que corresponda. Rechazar el lote entero haría que Meta
 *    reintentara indefinidamente un mensaje que nunca vamos a saber leer.
 */
import { z } from 'zod';
import type { MensajeNormalizado } from '../../domain/conversacion/mensaje.ts';

const Texto = z.looseObject({
  type: z.literal('text'),
  text: z.looseObject({ body: z.string() }),
});

const RespuestaBoton = z.looseObject({
  type: z.literal('interactive'),
  interactive: z.looseObject({
    type: z.literal('button_reply'),
    button_reply: z.looseObject({ id: z.string(), title: z.string() }),
  }),
});

const RespuestaLista = z.looseObject({
  type: z.literal('interactive'),
  interactive: z.looseObject({
    type: z.literal('list_reply'),
    list_reply: z.looseObject({ id: z.string(), title: z.string() }),
  }),
});

/** Respuesta de un Flow estático: el formulario de captura de datos (§8). */
const RespuestaFlow = z.looseObject({
  type: z.literal('interactive'),
  interactive: z.looseObject({
    type: z.literal('nfm_reply'),
    nfm_reply: z.looseObject({
      // JSON serializado dentro de un string. Se parsea aparte, con su propio esquema.
      response_json: z.string(),
      name: z.string().optional(),
    }),
  }),
});

const Audio = z.looseObject({
  type: z.literal('audio'),
  audio: z.looseObject({
    id: z.string(),
    mime_type: z.string().optional(),
    voice: z.boolean().optional(),
  }),
});

/** Respuesta rápida de una plantilla (recordatorio con botones). */
const BotonPlantilla = z.looseObject({
  type: z.literal('button'),
  button: z.looseObject({ payload: z.string(), text: z.string() }),
});

const Comun = z.looseObject({
  from: z.string(),
  id: z.string(),
  timestamp: z.string(),
});

const Conocido = z.union([Texto, RespuestaBoton, RespuestaLista, RespuestaFlow, Audio, BotonPlantilla]);

export const MensajeEntrante = z.intersection(
  Comun,
  z.union([Conocido, z.looseObject({ type: z.string() })]),
);
export type MensajeEntrante = z.infer<typeof MensajeEntrante>;

export const Estado = z.looseObject({
  id: z.string(),
  status: z.string(),
  timestamp: z.string(),
  recipient_id: z.string().optional(),
});

export const ValorCambio = z.looseObject({
  messaging_product: z.literal('whatsapp').optional(),
  metadata: z.looseObject({ phone_number_id: z.string() }),
  contacts: z
    .array(z.looseObject({ wa_id: z.string(), profile: z.looseObject({ name: z.string() }).optional() }))
    .optional(),
  messages: z.array(MensajeEntrante).optional(),
  statuses: z.array(Estado).optional(),
});

export const Webhook = z.looseObject({
  object: z.string(),
  entry: z.array(
    z.looseObject({
      id: z.string().optional(),
      changes: z.array(z.looseObject({ field: z.string().optional(), value: ValorCambio })),
    }),
  ),
});
export type Webhook = z.infer<typeof Webhook>;

/**
 * Lo mínimo para enrutar: el `phone_number_id` identifica al despacho y hay que leerlo
 * ANTES de poder verificar la firma, porque el secreto de la app está guardado por tenant.
 * Por eso este esquema es deliberadamente diminuto: es lo único que se mira de un cuerpo
 * todavía no autenticado.
 */
export const Enrutamiento = z.looseObject({
  entry: z
    .array(
      z.looseObject({
        changes: z
          .array(z.looseObject({ value: z.looseObject({ metadata: z.looseObject({ phone_number_id: z.string() }) }) }))
          .min(1),
      }),
    )
    .min(1),
});

export function phoneNumberIdDe(cuerpo: unknown): string | null {
  const r = Enrutamiento.safeParse(cuerpo);
  return r.success ? r.data.entry[0]!.changes[0]!.value.metadata.phone_number_id : null;
}

/** El tipo vive en `domain`: es la forma que consume la máquina, no la de Meta. */
export type { MensajeNormalizado };

export function normalizar(mensaje: MensajeEntrante): MensajeNormalizado {
  const base = { waMessageId: mensaje.id, waId: mensaje.from };

  const texto = Texto.safeParse(mensaje);
  if (texto.success) return { clase: 'texto', ...base, texto: texto.data.text.body };

  const boton = RespuestaBoton.safeParse(mensaje);
  if (boton.success) {
    const r = boton.data.interactive.button_reply;
    return { clase: 'opcion', ...base, opcionId: r.id, titulo: r.title };
  }

  const lista = RespuestaLista.safeParse(mensaje);
  if (lista.success) {
    const r = lista.data.interactive.list_reply;
    return { clase: 'opcion', ...base, opcionId: r.id, titulo: r.title };
  }

  const plantilla = BotonPlantilla.safeParse(mensaje);
  if (plantilla.success) {
    const r = plantilla.data.button;
    return { clase: 'opcion', ...base, opcionId: r.payload, titulo: r.text };
  }

  const flow = RespuestaFlow.safeParse(mensaje);
  if (flow.success) {
    let respuesta: unknown = null;
    try {
      respuesta = JSON.parse(flow.data.interactive.nfm_reply.response_json);
    } catch {
      // Un `response_json` ilegible es un formulario que no podemos leer, no una caída.
      return { clase: 'no_soportado', ...base, tipo: 'nfm_reply_invalido' };
    }
    return { clase: 'formulario', ...base, respuesta };
  }

  const audio = Audio.safeParse(mensaje);
  if (audio.success) {
    return {
      clase: 'audio',
      ...base,
      mediaId: audio.data.audio.id,
      // Nota de voz de verdad: .ogg con códec OPUS y voice:true. Cualquier otra cosa es
      // un archivo adjunto, y se trata como tal.
      esNotaDeVoz: audio.data.audio.voice === true,
    };
  }

  return { clase: 'no_soportado', ...base, tipo: mensaje.type };
}
