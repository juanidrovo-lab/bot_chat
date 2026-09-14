import { describe, expect, it } from 'vitest';
import { MensajeEntrante, normalizar, phoneNumberIdDe, Webhook } from '../../src/adapters/whatsapp/esquemas.ts';

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
