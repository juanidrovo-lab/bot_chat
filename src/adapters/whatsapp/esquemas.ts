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

/**
 * Lo que trae todo mensaje entrante, sea del tipo que sea.
 *
 * **`from` es opcional a propósito.** WhatsApp está desplegando nombres de usuario: quien
 * adopta uno puede ocultar su número, y entonces el webhook trae `user_id` —el
 * Business-Scoped User ID, estable para este despacho— en lugar del teléfono. Exigir `from`
 * hacía que ese mensaje no validara, y un mensaje que no valida se descarta con un `warn`:
 * la persona escribe y nadie le contesta nunca.
 *
 * Al menos uno de los dos tiene que venir, y eso se comprueba abajo en vez de en el tipo,
 * para poder decir en el log cuál faltó.
 */
const Comun = z.looseObject({
  from: z.string().optional(),
  user_id: z.string().optional(),
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
  // Sin validar a propósito: cada mensaje se analiza por separado con `MensajeEntrante`.
  // Si fueran `z.array(MensajeEntrante)`, un solo mensaje con una forma rara invalidaría el
  // lote entero y los demás —legítimos— se perderían sin que nadie los conteste.
  messages: z.array(z.unknown()).optional(),
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

/**
 * Con quién hablamos, y cómo se le contesta.
 *
 * `direccion` es lo que va en el campo `to` al responder: el teléfono cuando lo hay, y el
 * BSUID cuando el usuario escondió su número. `bsuid` se guarda aparte porque es lo que
 * permite reconocer a la misma persona cuando deja de venir el teléfono — o cuando empieza
 * a venir.
 */
export interface IdentidadRemitente {
  direccion: string;
  bsuid: string | null;
}

export function identidadDe(mensaje: MensajeEntrante): IdentidadRemitente | null {
  const bsuid = mensaje.user_id ?? null;
  const direccion = mensaje.from ?? bsuid;
  // Sin ninguno de los dos no hay a quién contestar. Quien llama lo registra y sigue con el
  // resto del lote: un mensaje raro no puede tapar los demás.
  if (direccion === undefined || direccion === null || direccion === '') return null;
  return { direccion, bsuid };
}

/**
 * El nombre que el contacto tiene puesto en su WhatsApp, si Meta lo manda en este lote.
 *
 * Hace falta porque el guion de hoy **no pregunta el nombre**: el bot toma el caso y el
 * abogado agenda, así que sin esto la bandeja del panel enseña un número de teléfono y nada
 * más, y quien atiende tiene que llamar sin saber a quién. Es el nombre público del perfil,
 * el mismo que vería cualquiera que reciba un mensaje suyo.
 *
 * `contacts` viene por lote y no por mensaje, así que se casa por `wa_id`. Cuando el
 * contacto escondió su número no hay con qué casar y no viene nada: se devuelve `null` y
 * quien lo use se queda como estaba.
 */
export type ContactoDelLote = NonNullable<z.infer<typeof ValorCambio>['contacts']>[number];

export function nombrePerfilDe(
  contactos: readonly ContactoDelLote[] | undefined,
  waId: string,
): string | null {
  const encontrado = contactos?.find((c) => c.wa_id === waId);
  const nombre = encontrado?.profile?.name?.trim();
  return nombre === undefined || nombre === '' ? null : nombre;
}

export function normalizar(mensaje: MensajeEntrante): MensajeNormalizado {
  // El webhook descarta antes de guardar cualquier mensaje sin dirección, así que aquí
  // siempre hay una. El `??` es por el tipo, no por el caso.
  const base = { waMessageId: mensaje.id, waId: identidadDe(mensaje)?.direccion ?? '' };

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
