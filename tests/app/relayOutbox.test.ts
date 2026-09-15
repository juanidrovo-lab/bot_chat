import { describe, expect, it } from 'vitest';
import {
  esperaMs,
  FalloPermanente,
  MAX_INTENTOS,
  relayOutbox,
  type ManejadorOutbox,
} from '../../src/app/relayOutbox.ts';
import type { RepoOutbox, TrabajoOutbox } from '../../src/app/puertos/RepoOutbox.ts';

const REGISTRO = { warn: () => {}, error: () => {} };

function trabajo(parcial: Partial<TrabajoOutbox> = {}): TrabajoOutbox {
  return {
    id: '1',
    tenantId: 'despacho-a',
    tipo: 'gcal.crear',
    payload: { citaId: 'cita-1' },
    idempotencyKey: 'gcal.crear:cita-1',
    intentos: 1,
    ...parcial,
  };
}

/** Repositorio de mentira: registra las decisiones del relay. */
function repoFalso(porTenant: Record<string, TrabajoOutbox[]>) {
  const publicados: string[] = [];
  const fallidos: { id: string; esperaMs: number; error: string }[] = [];
  const archivados: { id: string; error: string }[] = [];
  const reclamados: string[] = [];

  const repo: RepoOutbox = {
    async encolar() {
      return true;
    },
    async tenantsConPendientes() {
      return Object.keys(porTenant);
    },
    async reclamar(tenantId) {
      reclamados.push(tenantId);
      return porTenant[tenantId] ?? [];
    },
    async marcarPublicado(_t, id) {
      publicados.push(id);
    },
    async marcarFallido(_t, id, espera, error) {
      fallidos.push({ id, esperaMs: espera, error });
    },
    async archivar(_t, id, error) {
      archivados.push({ id, error });
    },
  };

  return { repo, publicados, fallidos, archivados, reclamados };
}

describe('relay · espera entre reintentos', () => {
  const sinJitter = () => 0.5;

  it('crece exponencialmente desde un minuto', () => {
    expect(esperaMs(1, sinJitter)).toBe(60_000);
    expect(esperaMs(2, sinJitter)).toBe(120_000);
    expect(esperaMs(3, sinJitter)).toBe(240_000);
    expect(esperaMs(4, sinJitter)).toBe(480_000);
  });

  it('tiene tope: reintentar cada media hora ya es «cuando vuelva»', () => {
    expect(esperaMs(20, sinJitter)).toBe(30 * 60_000);
  });

  it('el jitter reparte los reintentos en ±10%', () => {
    // Sin jitter, una caída de Google haría que todo reintentara en el mismo instante y le
    // devolviera la caída.
    expect(esperaMs(1, () => 0)).toBe(54_000);
    expect(esperaMs(1, () => 1)).toBe(66_000);
    expect(esperaMs(1, () => 0.5)).toBe(60_000);
  });

  it('nunca es negativa ni con un contador raro', () => {
    for (const intentos of [0, -1, 1]) {
      expect(esperaMs(intentos, sinJitter)).toBeGreaterThan(0);
    }
  });
});

describe('relay · publicación', () => {
  it('publica lo que sale bien', async () => {
    const falso = repoFalso({ 'despacho-a': [trabajo({ id: '7' })] });
    const manejador: ManejadorOutbox = async () => {};

    const resumen = await relayOutbox({
      repo: falso.repo,
      manejadores: { 'gcal.crear': manejador },
      registro: REGISTRO,
    });

    expect(resumen).toEqual({ publicados: 1, fallidos: 0, archivados: 0 });
    expect(falso.publicados).toEqual(['7']);
  });

  it('recorre los despachos uno a uno, que es lo que la RLS obliga', async () => {
    const falso = repoFalso({
      'despacho-a': [trabajo({ id: 'a1', tenantId: 'despacho-a' })],
      'despacho-b': [trabajo({ id: 'b1', tenantId: 'despacho-b' })],
    });

    await relayOutbox({
      repo: falso.repo,
      manejadores: { 'gcal.crear': async () => {} },
      registro: REGISTRO,
    });

    expect(falso.reclamados).toEqual(['despacho-a', 'despacho-b']);
    expect(falso.publicados).toEqual(['a1', 'b1']);
  });

  it('un trabajo que falla no impide publicar el siguiente', async () => {
    const falso = repoFalso({
      'despacho-a': [trabajo({ id: '1' }), trabajo({ id: '2' })],
    });
    let primera = true;

    const resumen = await relayOutbox({
      repo: falso.repo,
      manejadores: {
        'gcal.crear': async () => {
          if (primera) {
            primera = false;
            throw new Error('503 de Google');
          }
        },
      },
      registro: REGISTRO,
    });

    expect(resumen).toEqual({ publicados: 1, fallidos: 1, archivados: 0 });
    expect(falso.publicados).toEqual(['2']);
    expect(falso.fallidos[0]!.id).toBe('1');
  });
});

describe('relay · fallos', () => {
  it('programa el reintento con la espera que toca', async () => {
    const falso = repoFalso({ 'despacho-a': [trabajo({ intentos: 3 })] });

    await relayOutbox({
      repo: falso.repo,
      manejadores: { 'gcal.crear': async () => { throw new Error('timeout'); } },
      registro: REGISTRO,
      aleatorio: () => 0.5,
    });

    expect(falso.fallidos[0]!.esperaMs).toBe(esperaMs(3, () => 0.5));
    expect(falso.fallidos[0]!.error).toContain('timeout');
  });

  it('agotados los intentos, se archiva en vez de reintentar para siempre', async () => {
    const falso = repoFalso({ 'despacho-a': [trabajo({ intentos: MAX_INTENTOS })] });

    const resumen = await relayOutbox({
      repo: falso.repo,
      manejadores: { 'gcal.crear': async () => { throw new Error('sigue caído'); } },
      registro: REGISTRO,
    });

    expect(resumen.archivados).toBe(1);
    expect(falso.fallidos).toHaveLength(0);
  });

  it('un fallo permanente se archiva en el primer intento', async () => {
    const falso = repoFalso({ 'despacho-a': [trabajo({ intentos: 1 })] });

    await relayOutbox({
      repo: falso.repo,
      manejadores: {
        'gcal.crear': async () => { throw new FalloPermanente('la cita ya no existe'); },
      },
      registro: REGISTRO,
    });

    // No gasta cinco intentos y media hora en algo que no va a cambiar.
    expect(falso.archivados[0]!.error).toContain('la cita ya no existe');
    expect(falso.fallidos).toHaveLength(0);
  });

  it('un tipo sin manejador se archiva y se registra como error', async () => {
    const falso = repoFalso({ 'despacho-a': [trabajo({ tipo: 'algo.nuevo' })] });
    const errores: string[] = [];

    await relayOutbox({
      repo: falso.repo,
      manejadores: {},
      registro: { warn: () => {}, error: (_d, m) => errores.push(m) },
    });

    expect(falso.archivados[0]!.error).toContain('algo.nuevo');
    expect(errores).toHaveLength(1);
  });

  it('el error que se guarda no arrastra el cuerpo de la respuesta', async () => {
    // Una respuesta de Google puede traer el nombre del contacto o el título de la cita.
    const falso = repoFalso({ 'despacho-a': [trabajo()] });
    const conPII = new Error('x'.repeat(5000));
    conPII.name = 'GaxiosError';

    await relayOutbox({
      repo: falso.repo,
      manejadores: { 'gcal.crear': async () => { throw conPII; } },
      registro: REGISTRO,
    });

    expect(falso.fallidos[0]!.error.length).toBeLessThanOrEqual(300);
    expect(falso.fallidos[0]!.error.startsWith('GaxiosError:')).toBe(true);
  });

  it('algo que no es un Error tampoco rompe el relay', async () => {
    const falso = repoFalso({ 'despacho-a': [trabajo()] });

    await expect(
      relayOutbox({
        repo: falso.repo,
        manejadores: { 'gcal.crear': async () => { throw 'una cadena suelta'; } },
        registro: REGISTRO,
      }),
    ).resolves.toMatchObject({ fallidos: 1 });
  });
});
