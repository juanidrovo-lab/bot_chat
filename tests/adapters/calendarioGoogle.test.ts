import type { calendar_v3 } from '@googleapis/calendar';
import { describe, expect, it } from 'vitest';
import { crearCalendarioDe, idDeEvento } from '../../src/adapters/google/calendario.ts';

const CREDENCIALES = { calendarId: 'abogado@ejemplo.ec', refreshToken: 'refresh-1' };

interface Llamadas {
  insert: unknown[];
  delete: unknown[];
  freebusy: unknown[];
}

/** Error con la forma que trae Gaxios: el estado viene en `status` o en `code`. */
function errorHttp(estado: number, donde: 'status' | 'code' | 'response' = 'status') {
  const error = new Error(`HTTP ${estado}`) as Error & Record<string, unknown>;
  if (donde === 'status') error.status = estado;
  if (donde === 'code') error.code = estado;
  if (donde === 'response') error.response = { status: estado };
  return error;
}

function clienteFalso(respuestas: {
  insert?: () => unknown;
  delete?: () => unknown;
  busy?: { start: string | null; end: string | null }[];
  calendarKey?: string;
}) {
  const llamadas: Llamadas = { insert: [], delete: [], freebusy: [] };
  const cliente = {
    events: {
      async insert(params: unknown) {
        llamadas.insert.push(params);
        const r = respuestas.insert?.();
        return { data: { id: (r as string | undefined) ?? 'id-del-servidor' } };
      },
      async delete(params: unknown) {
        llamadas.delete.push(params);
        respuestas.delete?.();
        return { data: undefined };
      },
    },
    freebusy: {
      async query(params: unknown) {
        llamadas.freebusy.push(params);
        const clave = respuestas.calendarKey ?? CREDENCIALES.calendarId;
        return { data: { calendars: { [clave]: { busy: respuestas.busy ?? [] } } } };
      },
    },
  } as unknown as calendar_v3.Calendar;

  return { cliente, llamadas };
}

function calendarioDe(respuestas: Parameters<typeof clienteFalso>[0], credenciales = CREDENCIALES) {
  const falso = clienteFalso(respuestas);
  const fabrica = crearCalendarioDe({
    clientId: 'cliente',
    clientSecret: 'secreto',
    credencialesDe: async () => credenciales,
    clienteDe: () => falso.cliente,
  });
  return { fabrica, ...falso };
}

describe('identificador del evento', () => {
  it('es el uuid de la cita sin guiones', () => {
    expect(idDeEvento('0b7c4d2e-1a3f-4b5c-8d9e-0f1a2b3c4d5e')).toBe(
      '0b7c4d2e1a3f4b5c8d9e0f1a2b3c4d5e',
    );
  });

  it('es determinista: la misma cita siempre da el mismo evento', () => {
    // Es lo único que hace idempotente la creación: Google rechaza el segundo insert.
    const cita = '0b7c4d2e-1a3f-4b5c-8d9e-0f1a2b3c4d5e';
    expect(idDeEvento(cita)).toBe(idDeEvento(cita));
  });

  it('cae dentro del juego que Google admite: base32hex, de 5 a 1024', () => {
    const id = idDeEvento('0b7c4d2e-1a3f-4b5c-8d9e-0f1a2b3c4d5e');
    expect(id).toMatch(/^[a-v0-9]{5,1024}$/);
  });

  it('protesta en vez de mandar a Google algo que va a rechazar', () => {
    for (const malo of ['', 'con-mayúsculas-ÑÑ', 'zzz', 'w'.repeat(40)]) {
      expect(() => idDeEvento(malo), `«${malo}»`).toThrow();
    }
  });
});

describe('calendario · crear evento', () => {
  const evento = {
    id: 'abcdef0123456789',
    iniciaAt: new Date('2026-10-20T19:00:00Z'),
    terminaAt: new Date('2026-10-20T19:45:00Z'),
    titulo: 'Consulta laboral · Ana Pérez',
    descripcion: 'Modalidad: presencial.',
  };

  it('manda el id determinista y las horas en ISO', async () => {
    const { fabrica, llamadas } = calendarioDe({});
    const calendario = await fabrica('t', 'a');

    await calendario!.crearEvento(evento);

    const params = llamadas.insert[0] as { calendarId: string; requestBody: Record<string, unknown> };
    expect(params.calendarId).toBe(CREDENCIALES.calendarId);
    expect(params.requestBody.id).toBe('abcdef0123456789');
    expect(params.requestBody.start).toEqual({ dateTime: '2026-10-20T19:00:00.000Z' });
  });

  it('un 409 es éxito: el evento que íbamos a crear ya está', async () => {
    // Es la aceptación de la fase: correr el relay dos veces no crea dos eventos.
    for (const donde of ['status', 'code', 'response'] as const) {
      const { fabrica } = calendarioDe({
        insert: () => {
          throw errorHttp(409, donde);
        },
      });
      const calendario = await fabrica('t', 'a');
      expect(await calendario!.crearEvento(evento)).toBe(evento.id);
    }
  });

  it('cualquier otro error sí sube, para que el relay lo reintente', async () => {
    const { fabrica } = calendarioDe({
      insert: () => {
        throw errorHttp(503);
      },
    });
    const calendario = await fabrica('t', 'a');
    await expect(calendario!.crearEvento(evento)).rejects.toThrow();
  });
});

describe('calendario · borrar evento', () => {
  it('borrar algo que ya no está es el resultado que se buscaba', async () => {
    for (const estado of [404, 410]) {
      const { fabrica } = calendarioDe({
        delete: () => {
          throw errorHttp(estado);
        },
      });
      const calendario = await fabrica('t', 'a');
      await expect(calendario!.borrarEvento('ev-1')).resolves.toBeUndefined();
    }
  });

  it('un 500 sí sube', async () => {
    const { fabrica } = calendarioDe({
      delete: () => {
        throw errorHttp(500);
      },
    });
    const calendario = await fabrica('t', 'a');
    await expect(calendario!.borrarEvento('ev-1')).rejects.toThrow();
  });
});

describe('calendario · franjas ocupadas', () => {
  it('traduce las franjas de freeBusy a intervalos', async () => {
    const { fabrica } = calendarioDe({
      busy: [{ start: '2026-10-20T14:00:00Z', end: '2026-10-20T15:00:00Z' }],
    });
    const calendario = await fabrica('t', 'a');

    expect(await calendario!.ocupados(0, 1)).toEqual([
      { inicioMs: Date.parse('2026-10-20T14:00:00Z'), finMs: Date.parse('2026-10-20T15:00:00Z') },
    ]);
  });

  it('descarta franjas ilegibles en vez de romper la agenda', async () => {
    // Mejor un hueco de más que una excepción a mitad de la sincronización.
    const { fabrica } = calendarioDe({
      busy: [
        { start: null, end: '2026-10-20T15:00:00Z' },
        { start: 'no es una fecha', end: '2026-10-20T15:00:00Z' },
        { start: '2026-10-20T16:00:00Z', end: '2026-10-20T15:00:00Z' },
        { start: '2026-10-20T14:00:00Z', end: '2026-10-20T15:00:00Z' },
      ],
    });
    const calendario = await fabrica('t', 'a');
    expect(await calendario!.ocupados(0, 1)).toHaveLength(1);
  });

  it('un calendario sin franjas devuelve lista vacía', async () => {
    const { fabrica } = calendarioDe({ calendarKey: 'otro@ejemplo.ec' });
    const calendario = await fabrica('t', 'a');
    expect(await calendario!.ocupados(0, 1)).toEqual([]);
  });
});

describe('calendario · abogado sin Google', () => {
  it('devuelve null, que no es un error', async () => {
    const fabrica = crearCalendarioDe({
      clientId: 'c',
      clientSecret: 's',
      credencialesDe: async () => null,
    });
    expect(await fabrica('t', 'a')).toBeNull();
  });
});
