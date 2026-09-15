import { describe, expect, it } from 'vitest';
import { importarBloqueos } from '../../src/app/importarBloqueos.ts';
import { POLITICA } from '../../src/domain/agenda/politicas.ts';
import type { Calendario } from '../../src/app/puertos/Calendario.ts';
import type { RepoBloqueos } from '../../src/app/puertos/RepoBloqueos.ts';
import type { Reloj } from '../../src/app/puertos/Reloj.ts';

const AHORA = Date.UTC(2026, 9, 20, 13, 0, 0);
const reloj = { ahoraMs: () => AHORA } as unknown as Reloj;
const SILENCIO = { warn: () => {} };

function entorno(opciones: {
  abogados?: { id: string; calendarId: string }[];
  ocupadosDe?: Record<string, (() => { inicioMs: number; finMs: number }[]) | undefined>;
}) {
  const reemplazos: { abogadoId: string; desdeMs: number; hastaMs: number; total: number }[] = [];

  const repo: RepoBloqueos = {
    async conCalendario() {
      return opciones.abogados ?? [{ id: 'a1', calendarId: 'a1@ejemplo.ec' }];
    },
    async reemplazarDeGoogle(_t, abogadoId, desdeMs, hastaMs, ocupados) {
      reemplazos.push({ abogadoId, desdeMs, hastaMs, total: ocupados.length });
      return ocupados.length;
    },
  };

  const calendarioDe = async (_t: string, abogadoId: string): Promise<Calendario | null> => ({
    async crearEvento() {
      return 'x';
    },
    async borrarEvento() {},
    async ocupados() {
      const fabrica = opciones.ocupadosDe?.[abogadoId];
      if (fabrica === undefined) return [];
      return fabrica();
    },
  });

  return { repo, calendarioDe, reemplazos };
}

describe('importar bloqueos de Google', () => {
  it('sincroniza la ventana del horizonte', async () => {
    const e = entorno({
      ocupadosDe: { a1: () => [{ inicioMs: AHORA + 3_600_000, finMs: AHORA + 7_200_000 }] },
    });

    const resumen = await importarBloqueos(
      { repo: e.repo, calendarioDe: e.calendarioDe, reloj, politica: POLITICA, registro: SILENCIO },
      'despacho-a',
    );

    expect(resumen).toEqual({ abogados: 1, bloqueos: 1 });
    expect(e.reemplazos[0]!.desdeMs).toBe(AHORA);
    expect(e.reemplazos[0]!.hastaMs).toBe(AHORA + POLITICA.horizonteDias * 86_400_000);
  });

  it('un abogado cuyo Google falle no deja sin sincronizar a los demás', async () => {
    const e = entorno({
      abogados: [
        { id: 'a1', calendarId: 'a1@ejemplo.ec' },
        { id: 'a2', calendarId: 'a2@ejemplo.ec' },
      ],
      ocupadosDe: {
        a1: () => {
          throw new Error('503 de Google');
        },
        a2: () => [{ inicioMs: AHORA, finMs: AHORA + 1000 }],
      },
    });

    const resumen = await importarBloqueos(
      { repo: e.repo, calendarioDe: e.calendarioDe, reloj, politica: POLITICA, registro: SILENCIO },
      'despacho-a',
    );

    expect(resumen.abogados).toBe(1);
    // Y sobre todo: al que falló NO se le vacían los bloqueos. Ofrecer como libre un
    // horario ocupado es peor que ofrecer de menos.
    expect(e.reemplazos.map((r) => r.abogadoId)).toEqual(['a2']);
  });

  it('sin abogados con calendario no hace nada', async () => {
    const e = entorno({ abogados: [] });
    const resumen = await importarBloqueos(
      { repo: e.repo, calendarioDe: e.calendarioDe, reloj, politica: POLITICA, registro: SILENCIO },
      'despacho-a',
    );
    expect(resumen).toEqual({ abogados: 0, bloqueos: 0 });
    expect(e.reemplazos).toHaveLength(0);
  });

  it('un calendario vacío sí sincroniza: limpia lo que Google ya no reporta', async () => {
    const e = entorno({});
    await importarBloqueos(
      { repo: e.repo, calendarioDe: e.calendarioDe, reloj, politica: POLITICA, registro: SILENCIO },
      'despacho-a',
    );
    expect(e.reemplazos).toHaveLength(1);
    expect(e.reemplazos[0]!.total).toBe(0);
  });
});
