import { describe, expect, it } from 'vitest';
import { crearMensajeria, ErrorWhatsApp } from '../../src/adapters/whatsapp/cliente.ts';
import { LIMITES } from '../../src/adapters/whatsapp/limites.ts';

interface Llamada {
  url: string;
  cuerpo: Record<string, unknown>;
  autorizacion: string | null;
}

/** Fetch de mentira: registra lo enviado y devuelve las respuestas que se le den. */
function fakeFetch(respuestas: { estado: number; json?: unknown; retryAfter?: string }[]) {
  const llamadas: Llamada[] = [];
  let i = 0;
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    const r = respuestas[Math.min(i, respuestas.length - 1)]!;
    i++;
    llamadas.push({
      url: String(url),
      cuerpo: JSON.parse(String(init?.body)) as Record<string, unknown>,
      autorizacion: new Headers(init?.headers).get('authorization'),
    });
    return new Response(JSON.stringify(r.json ?? { messages: [{ id: 'wamid.OK' }] }), {
      status: r.estado,
      headers: r.retryAfter === undefined ? {} : { 'retry-after': r.retryAfter },
    });
  }) as unknown as typeof fetch;
  return { impl, llamadas, intentos: () => i };
}

function crear(respuestas: { estado: number; json?: unknown; retryAfter?: string }[]) {
  const fake = fakeFetch(respuestas);
  const esperas: number[] = [];
  const mensajeria = crearMensajeria({
    phoneNumberId: '111',
    token: 'token-secreto',
    urlBase: 'https://ejemplo.test',
    fetchImpl: fake.impl,
    esperar: async (ms) => {
      esperas.push(ms);
    },
  });
  return { mensajeria, ...fake, esperas };
}

describe('cliente de WhatsApp · envío', () => {
  it('devuelve el wa_message_id y manda el token en la cabecera', async () => {
    const { mensajeria, llamadas } = crear([{ estado: 200 }]);
    expect(await mensajeria.enviarTexto('593999', 'Buenas tardes.')).toBe('wamid.OK');
    expect(llamadas[0]!.url).toBe('https://ejemplo.test/v23.0/111/messages');
    expect(llamadas[0]!.autorizacion).toBe('Bearer token-secreto');
    expect(llamadas[0]!.cuerpo.messaging_product).toBe('whatsapp');
  });

  it('trunca el texto al límite de WhatsApp', async () => {
    const { mensajeria, llamadas } = crear([{ estado: 200 }]);
    await mensajeria.enviarTexto('593999', 'x'.repeat(LIMITES.texto + 500));
    const texto = (llamadas[0]!.cuerpo.text as { body: string }).body;
    expect(Array.from(texto)).toHaveLength(LIMITES.texto);
  });

  it('el audio sale como nota de voz', async () => {
    const { mensajeria, llamadas } = crear([{ estado: 200 }]);
    await mensajeria.enviarAudio('593999', 'media-1');
    expect(llamadas[0]!.cuerpo.audio).toEqual({ id: 'media-1', voice: true });
  });

  it('reparte el presupuesto de 10 filas entre secciones, no 10 por sección', async () => {
    const { mensajeria, llamadas } = crear([{ estado: 200 }]);
    const filas = (n: number, p: string) =>
      Array.from({ length: n }, (_, i) => ({ id: `${p}${i}`, titulo: `${p} ${i}` }));

    await mensajeria.enviarLista('593999', {
      cuerpo: '¿Qué día le queda mejor?',
      textoBoton: 'Ver horarios',
      secciones: [
        { titulo: 'Martes', filas: filas(7, 'm') },
        { titulo: 'Miércoles', filas: filas(7, 'x') },
      ],
    });

    const accion = (llamadas[0]!.cuerpo.interactive as { action: { sections: { rows: unknown[] }[] } }).action;
    const total = accion.sections.reduce((n, s) => n + s.rows.length, 0);
    expect(total).toBe(LIMITES.filasLista);
    expect(accion.sections[0]!.rows).toHaveLength(7);
    expect(accion.sections[1]!.rows).toHaveLength(3);
  });

  it('nunca manda más de 3 botones', async () => {
    const { mensajeria, llamadas } = crear([{ estado: 200 }]);
    await mensajeria.enviarBotones('593999', {
      cuerpo: 'Su cita es mañana.',
      botones: [
        { id: 'c', titulo: 'Confirmar' },
        { id: 'x', titulo: 'Cancelar' },
        { id: 'r', titulo: 'Reagendar' },
        { id: 'z', titulo: 'Sobra' },
      ],
    });
    const accion = (llamadas[0]!.cuerpo.interactive as { action: { buttons: unknown[] } }).action;
    expect(accion.buttons).toHaveLength(3);
  });
});

describe('cliente de WhatsApp · reintentos', () => {
  it('reintenta ante un 429 y acaba enviando', async () => {
    const { mensajeria, intentos } = crear([{ estado: 429 }, { estado: 200 }]);
    expect(await mensajeria.enviarTexto('593999', 'hola')).toBe('wamid.OK');
    expect(intentos()).toBe(2);
  });

  it('respeta Retry-After cuando viene', async () => {
    const { mensajeria, esperas } = crear([{ estado: 429, retryAfter: '3' }, { estado: 200 }]);
    await mensajeria.enviarTexto('593999', 'hola');
    expect(esperas[0]).toBe(3000);
  });

  it('el backoff crece entre intentos', async () => {
    const { mensajeria, esperas } = crear([{ estado: 503 }, { estado: 503 }, { estado: 200 }]);
    await mensajeria.enviarTexto('593999', 'hola');
    expect(esperas).toHaveLength(2);
    expect(esperas[1]!).toBeGreaterThan(esperas[0]!);
  });

  it('agota los intentos ante 5xx persistente y lanza', async () => {
    const { mensajeria, intentos } = crear([{ estado: 500 }]);
    await expect(mensajeria.enviarTexto('593999', 'hola')).rejects.toBeInstanceOf(ErrorWhatsApp);
    expect(intentos()).toBe(4);
  });

  it('un 400 no se reintenta: repetirlo no lo arregla', async () => {
    const { mensajeria, intentos } = crear([{ estado: 400 }]);
    await expect(mensajeria.enviarTexto('593999', 'hola')).rejects.toMatchObject({ estado: 400 });
    expect(intentos()).toBe(1);
  });

  it('una respuesta 200 sin wa_message_id es un error, no un envío silencioso', async () => {
    const { mensajeria } = crear([{ estado: 200, json: { messages: [] } }]);
    await expect(mensajeria.enviarTexto('593999', 'hola')).rejects.toBeInstanceOf(ErrorWhatsApp);
  });
});
