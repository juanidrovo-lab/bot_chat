/**
 * El recordatorio, tal como lo publica el relay.
 *
 * Los `payload` de los botones son la parte delicada: lo que viaja en la plantilla es lo que
 * la máquina de estados va a recibir de vuelta. Si alguien renombra una opción y no toca la
 * plantilla, el botón deja de hacer nada y el usuario se queda hablando solo.
 */
import { describe, expect, it } from 'vitest';
import { crearReloj } from '../../src/adapters/reloj.ts';
import { PLANTILLA_RECORDATORIO, crearManejadoresWhatsApp } from '../../src/app/efectosWhatsApp.ts';
import { FalloPermanente } from '../../src/app/relayOutbox.ts';
import { OPCION } from '../../src/domain/conversacion/acciones.ts';
import type { Mensajeria, Plantilla } from '../../src/app/puertos/Mensajeria.ts';
import type { CitaParaCalendario, RepoCitas } from '../../src/app/puertos/RepoCitas.ts';
import type { TrabajoOutbox } from '../../src/app/puertos/RepoOutbox.ts';

const CITA_ID = '3f8b1c2d-4e5f-4a6b-8c9d-0e1f2a3b4c5d';
const reloj = crearReloj(() => Date.parse('2026-10-19T15:00:00Z'));

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

function trabajo(payload: unknown): TrabajoOutbox {
  return {
    id: '1',
    tenantId: 'despacho-a',
    tipo: 'wa.recordatorio',
    payload,
    idempotencyKey: `recordatorio:${CITA_ID}`,
    intentos: 1,
  };
}

function entorno(laCita: CitaParaCalendario | null) {
  const enviadas: { destino: string; plantilla: Plantilla }[] = [];

  const mensajeria = {
    async enviarPlantilla(destino: string, plantilla: Plantilla) {
      enviadas.push({ destino, plantilla });
      return 'wamid.1';
    },
  } as unknown as Mensajeria;

  const repoCitas = {
    async paraCalendario() {
      return laCita;
    },
  } as unknown as RepoCitas;

  const manejadores = crearManejadoresWhatsApp({
    repoCitas,
    mensajeriaDe: async () => mensajeria,
    reloj,
  });

  return { manejadores, enviadas };
}

describe('wa.recordatorio', () => {
  it('manda la plantilla al contacto con la fecha en hora local', async () => {
    const { manejadores, enviadas } = entorno(cita());

    await manejadores['wa.recordatorio']!(trabajo({ citaId: CITA_ID }));

    expect(enviadas).toHaveLength(1);
    expect(enviadas[0]!.destino).toBe('593990000000');
    expect(enviadas[0]!.plantilla.nombre).toBe(PLANTILLA_RECORDATORIO);

    const cuerpo = enviadas[0]!.plantilla.componentes!.find(
      (c) => (c as { type: string }).type === 'body',
    ) as { parameters: { text: string }[] };
    // 19:00 UTC son las 14:00 en Guayaquil, y el recordatorio habla en hora de Cuenca.
    expect(cuerpo.parameters[0]!.text).toContain('14:00');
  });

  it('los tres botones llevan los payload que la máquina entiende, en orden', async () => {
    const { manejadores, enviadas } = entorno(cita());

    await manejadores['wa.recordatorio']!(trabajo({ citaId: CITA_ID }));

    const botones = enviadas[0]!.plantilla.componentes!.filter(
      (c) => (c as { type: string }).type === 'button',
    ) as { index: string; sub_type: string; parameters: { payload: string }[] }[];

    expect(botones.map((b) => b.index)).toEqual(['0', '1', '2']);
    expect(botones.map((b) => b.sub_type)).toEqual(['quick_reply', 'quick_reply', 'quick_reply']);
    expect(botones.map((b) => b.parameters[0]!.payload)).toEqual([
      OPCION.confirmarAsistencia,
      OPCION.cancelar,
      OPCION.reagendar,
    ]);
    // Límite de WhatsApp: tres botones, ni uno más.
    expect(botones).toHaveLength(3);
  });

  it('una cita cancelada entre encolar y publicar no genera aviso', async () => {
    const { manejadores, enviadas } = entorno(cita({ estado: 'cancelada' }));

    await manejadores['wa.recordatorio']!(trabajo({ citaId: CITA_ID }));

    expect(enviadas).toHaveLength(0);
  });

  it('si la cita ya no existe se archiva en vez de reintentar cinco veces', async () => {
    const { manejadores } = entorno(null);

    await expect(manejadores['wa.recordatorio']!(trabajo({ citaId: CITA_ID }))).rejects.toBeInstanceOf(
      FalloPermanente,
    );
  });

  it('un payload ilegible es permanente: reintentarlo no lo va a arreglar', async () => {
    const { manejadores } = entorno(cita());

    await expect(manejadores['wa.recordatorio']!(trabajo({ citaId: 'no-es-uuid' }))).rejects.toBeInstanceOf(
      FalloPermanente,
    );
  });
});
