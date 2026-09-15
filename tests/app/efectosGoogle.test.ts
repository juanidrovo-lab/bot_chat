import { describe, expect, it } from 'vitest';
import { crearManejadoresGoogle } from '../../src/app/efectosGoogle.ts';
import { FalloPermanente } from '../../src/app/relayOutbox.ts';
import type { Calendario, EventoCalendario } from '../../src/app/puertos/Calendario.ts';
import type { CitaParaCalendario, RepoCitas } from '../../src/app/puertos/RepoCitas.ts';
import type { TrabajoOutbox } from '../../src/app/puertos/RepoOutbox.ts';

const CITA_ID = '0b7c4d2e-1a3f-4b5c-8d9e-0f1a2b3c4d5e';

function cita(parcial: Partial<CitaParaCalendario> = {}): CitaParaCalendario {
  return {
    id: CITA_ID,
    abogadoId: 'abogado-1',
    materia: 'laboral',
    modalidad: 'presencial',
    iniciaAt: new Date('2026-10-20T19:00:00Z'),
    terminaAt: new Date('2026-10-20T19:45:00Z'),
    estado: 'reservada',
    gcalEventId: null,
    nombreContacto: 'Ana Pérez',
    waIdContacto: '593990000000',
    ...parcial,
  };
}

function trabajo(tipo: string, payload: unknown): TrabajoOutbox {
  return { id: '1', tenantId: 'despacho-a', tipo, payload, idempotencyKey: 'k', intentos: 1 };
}

function entorno(opciones: { cita?: CitaParaCalendario | null; calendario?: Calendario | null } = {}) {
  const creados: EventoCalendario[] = [];
  const borrados: string[] = [];
  const anotados: { citaId: string; eventId: string }[] = [];

  const calendario: Calendario = {
    async crearEvento(evento) {
      creados.push(evento);
      return evento.id;
    },
    async borrarEvento(id) {
      borrados.push(id);
    },
    async ocupados() {
      return [];
    },
  };

  const repoCitas = {
    async paraCalendario() {
      return opciones.cita === undefined ? cita() : opciones.cita;
    },
    async anotarEventoGoogle(_t: string, citaId: string, eventId: string) {
      anotados.push({ citaId, eventId });
    },
  } as unknown as RepoCitas;

  const manejadores = crearManejadoresGoogle({
    repoCitas,
    calendarioDe: async () => (opciones.calendario === undefined ? calendario : opciones.calendario),
    idDeEvento: (id) => id.replace(/-/g, ''),
  });

  return { manejadores, creados, borrados, anotados };
}

describe('efectos · crear el evento espejo', () => {
  it('crea el evento y guarda su id en la cita', async () => {
    const e = entorno();
    await e.manejadores['gcal.crear']!(trabajo('gcal.crear', { citaId: CITA_ID }));

    expect(e.creados).toHaveLength(1);
    expect(e.creados[0]!.id).toBe(CITA_ID.replace(/-/g, ''));
    expect(e.creados[0]!.titulo).toBe('Consulta laboral · Ana Pérez');
    expect(e.anotados[0]).toEqual({ citaId: CITA_ID, eventId: CITA_ID.replace(/-/g, '') });
  });

  it('una cita ya reflejada no se vuelve a crear', async () => {
    // Segunda pasada del relay sobre un trabajo que ya se publicó.
    const e = entorno({ cita: cita({ gcalEventId: 'ev-existente' }) });
    await e.manejadores['gcal.crear']!(trabajo('gcal.crear', { citaId: CITA_ID }));
    expect(e.creados).toHaveLength(0);
  });

  it('una cita cancelada entre encolar y publicar no se refleja', async () => {
    const e = entorno({ cita: cita({ estado: 'cancelada' }) });
    await e.manejadores['gcal.crear']!(trabajo('gcal.crear', { citaId: CITA_ID }));
    expect(e.creados).toHaveLength(0);
  });

  it('un abogado sin Google conectado no es un fallo', async () => {
    const e = entorno({ calendario: null });
    await expect(
      e.manejadores['gcal.crear']!(trabajo('gcal.crear', { citaId: CITA_ID })),
    ).resolves.toBeUndefined();
    expect(e.anotados).toHaveLength(0);
  });

  it('un contacto sin nombre no deja el título a medias', async () => {
    const e = entorno({ cita: cita({ nombreContacto: null }) });
    await e.manejadores['gcal.crear']!(trabajo('gcal.crear', { citaId: CITA_ID }));
    expect(e.creados[0]!.titulo).toBe('Consulta laboral');
  });

  it('una cita que ya no existe se abandona sin gastar cinco intentos', async () => {
    const e = entorno({ cita: null });
    await expect(
      e.manejadores['gcal.crear']!(trabajo('gcal.crear', { citaId: CITA_ID })),
    ).rejects.toBeInstanceOf(FalloPermanente);
  });

  it('un payload ilegible tampoco se reintenta', async () => {
    const e = entorno();
    for (const payload of [{}, { citaId: 'no-es-uuid' }, null, 'texto']) {
      await expect(
        e.manejadores['gcal.crear']!(trabajo('gcal.crear', payload)),
      ).rejects.toBeInstanceOf(FalloPermanente);
    }
  });
});

describe('efectos · borrar el evento espejo', () => {
  it('borra el evento que se le indica', async () => {
    const e = entorno();
    await e.manejadores['gcal.borrar']!(
      trabajo('gcal.borrar', { citaId: CITA_ID, gcalEventId: 'ev-1' }),
    );
    expect(e.borrados).toEqual(['ev-1']);
  });

  it('sin Google conectado no hay nada que borrar', async () => {
    const e = entorno({ calendario: null });
    await expect(
      e.manejadores['gcal.borrar']!(trabajo('gcal.borrar', { citaId: CITA_ID, gcalEventId: 'ev-1' })),
    ).resolves.toBeUndefined();
  });

  it('un payload sin id de evento no se reintenta', async () => {
    const e = entorno();
    await expect(
      e.manejadores['gcal.borrar']!(trabajo('gcal.borrar', { citaId: CITA_ID })),
    ).rejects.toBeInstanceOf(FalloPermanente);
  });
});
