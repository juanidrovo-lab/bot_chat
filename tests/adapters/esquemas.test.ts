import { describe, expect, it } from 'vitest';
import { identidadDe, MensajeEntrante, normalizar, phoneNumberIdDe, Webhook } from '../../src/adapters/whatsapp/esquemas.ts';

function mensaje(extra: object) {
  return MensajeEntrante.parse({ from: '593999111222', id: 'wamid.A', timestamp: '1757000000', ...extra });
}

function sobre(mensajes: object[]) {
  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: 'waba-1',
        changes: [
          {
            field: 'messages',
            value: { messaging_product: 'whatsapp', metadata: { phone_number_id: '111222' }, messages: mensajes },
          },
        ],
      },
    ],
  };
}

describe('esquemas del webhook', () => {
  it('saca el phone_number_id de un cuerpo aún no autenticado', () => {
    expect(phoneNumberIdDe(sobre([]))).toBe('111222');
  });

  it('devuelve null si el cuerpo no tiene la forma de enrutamiento', () => {
    for (const basura of [{}, { entry: [] }, null, 'texto', { entry: [{ changes: [] }] }]) {
      expect(phoneNumberIdDe(basura)).toBeNull();
    }
  });

  it('acepta campos nuevos de Meta sin romperse', () => {
    const conExtras = sobre([{ from: '1', id: 'wamid.X', timestamp: '1', type: 'text', text: { body: 'hola' } }]);
    (conExtras.entry[0] as Record<string, unknown>).campo_nuevo_de_meta = { lo_que_sea: true };
    expect(Webhook.safeParse(conExtras).success).toBe(true);
  });

  it('acepta un lote de acuses de entrega sin mensajes', () => {
    const acuses = {
      object: 'whatsapp_business_account',
      entry: [
        {
          changes: [
            {
              value: {
                metadata: { phone_number_id: '111222' },
                statuses: [{ id: 'wamid.A', status: 'delivered', timestamp: '1757000000' }],
              },
            },
          ],
        },
      ],
    };
    expect(Webhook.safeParse(acuses).success).toBe(true);
  });
});

describe('normalización de mensajes', () => {
  it('texto', () => {
    expect(normalizar(mensaje({ type: 'text', text: { body: 'Necesito ayuda laboral' } }))).toEqual({
      clase: 'texto',
      waMessageId: 'wamid.A',
      waId: '593999111222',
      texto: 'Necesito ayuda laboral',
    });
  });

  it('respuesta de botón y de lista llegan como la misma clase', () => {
    const boton = normalizar(
      mensaje({ type: 'interactive', interactive: { type: 'button_reply', button_reply: { id: 'confirmar', title: 'Confirmar' } } }),
    );
    const lista = normalizar(
      mensaje({ type: 'interactive', interactive: { type: 'list_reply', list_reply: { id: 'laboral', title: 'Laboral' } } }),
    );
    expect(boton).toMatchObject({ clase: 'opcion', opcionId: 'confirmar' });
    expect(lista).toMatchObject({ clase: 'opcion', opcionId: 'laboral' });
  });

  it('el botón de una plantilla también es una opción', () => {
    const r = normalizar(mensaje({ type: 'button', button: { payload: 'cancelar', text: 'Cancelar' } }));
    expect(r).toMatchObject({ clase: 'opcion', opcionId: 'cancelar', titulo: 'Cancelar' });
  });

  it('el Flow llega con su response_json ya parseado', () => {
    const r = normalizar(
      mensaje({
        type: 'interactive',
        interactive: { type: 'nfm_reply', nfm_reply: { name: 'datos', response_json: '{"nombre":"Ana","correo":"a@b.ec"}' } },
      }),
    );
    expect(r).toEqual({
      clase: 'formulario',
      waMessageId: 'wamid.A',
      waId: '593999111222',
      respuesta: { nombre: 'Ana', correo: 'a@b.ec' },
    });
  });

  it('un response_json ilegible no tumba el webhook', () => {
    const r = normalizar(
      mensaje({ type: 'interactive', interactive: { type: 'nfm_reply', nfm_reply: { response_json: 'esto no es json' } } }),
    );
    expect(r).toMatchObject({ clase: 'no_soportado', tipo: 'nfm_reply_invalido' });
  });

  it('distingue una nota de voz de un audio adjunto', () => {
    const nota = normalizar(mensaje({ type: 'audio', audio: { id: 'm1', mime_type: 'audio/ogg; codecs=opus', voice: true } }));
    const adjunto = normalizar(mensaje({ type: 'audio', audio: { id: 'm2', mime_type: 'audio/mpeg' } }));
    expect(nota).toMatchObject({ clase: 'audio', mediaId: 'm1', esNotaDeVoz: true });
    expect(adjunto).toMatchObject({ clase: 'audio', mediaId: 'm2', esNotaDeVoz: false });
  });

  it('un tipo que no modelamos se reconoce, no revienta', () => {
    for (const tipo of ['sticker', 'location', 'contacts', 'reaction', 'video']) {
      expect(normalizar(mensaje({ type: tipo }))).toMatchObject({ clase: 'no_soportado', tipo });
    }
  });
});

describe('quién escribió', () => {
  const base = { id: 'wamid.A', timestamp: '1757000000', type: 'text', text: { body: 'hola' } };

  it('con teléfono, la dirección es el teléfono y no hay BSUID', () => {
    expect(identidadDe(MensajeEntrante.parse({ ...base, from: '593999111222' })))
      .toEqual({ direccion: '593999111222', bsuid: null });
  });

  it('sin teléfono, el BSUID es la dirección', () => {
    // Quien adopta un nombre de usuario en WhatsApp puede ocultar su número: el webhook
    // manda `user_id` en lugar de `from`. Antes ese mensaje no validaba y se descartaba con
    // un warn, así que la persona escribía y nadie le contestaba nunca.
    const m = MensajeEntrante.parse({ ...base, user_id: 'bsuid-abc' });
    expect(identidadDe(m)).toEqual({ direccion: 'bsuid-abc', bsuid: 'bsuid-abc' });
    expect(normalizar(m)).toMatchObject({ clase: 'texto', waId: 'bsuid-abc' });
  });

  it('con los dos, se contesta al teléfono y se guarda el BSUID', () => {
    expect(identidadDe(MensajeEntrante.parse({ ...base, from: '593999111222', user_id: 'bsuid-abc' })))
      .toEqual({ direccion: '593999111222', bsuid: 'bsuid-abc' });
  });

  it('sin ninguno de los dos no hay a quién contestar', () => {
    expect(identidadDe(MensajeEntrante.parse(base))).toBeNull();
    expect(identidadDe(MensajeEntrante.parse({ ...base, from: '' }))).toBeNull();
  });

  it('un mensaje con forma rara no invalida el lote entero', () => {
    // `messages` se valida mensaje a mensaje, no de golpe: si fuera un array tipado, el
    // mensaje sin `id` tumbaría el safeParse del webhook y el bueno se perdería con él.
    const lote = sobre([{ sin_id: true }, { from: '1', id: 'wamid.X', timestamp: '1', type: 'text', text: { body: 'hola' } }]);
    const analizado = Webhook.safeParse(lote);
    expect(analizado.success).toBe(true);
    const mensajes = analizado.data!.entry[0]!.changes[0]!.value.messages!;
    expect(MensajeEntrante.safeParse(mensajes[0]).success).toBe(false);
    expect(MensajeEntrante.safeParse(mensajes[1]).success).toBe(true);
  });
});
