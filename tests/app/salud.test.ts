/**
 * La sonda de salud.
 *
 * Un `/health` que devuelve 200 porque el proceso de Node sigue vivo es peor que no tener
 * sonda: convence a todo el mundo de que el sistema está bien mientras la base está llena.
 */
import { describe, expect, it } from 'vitest';
import { comprobarSalud } from '../../src/app/salud.ts';
import type { Sonda } from '../../src/app/puertos/Salud.ts';

const buena = (nombre: string): Sonda => ({ nombre, comprobar: async () => {} });

const mala = (nombre: string, motivo: string): Sonda => ({
  nombre,
  async comprobar() {
    throw new Error(motivo);
  },
});

const colgada = (nombre: string): Sonda => ({
  nombre,
  comprobar: () => new Promise<void>(() => {}),
});

describe('comprobarSalud', () => {
  it('con todo bien, ok', async () => {
    const resultado = await comprobarSalud([buena('postgres'), buena('cola')]);

    expect(resultado.ok).toBe(true);
    expect(resultado.comprobaciones.map((c) => c.nombre)).toEqual(['postgres', 'cola']);
  });

  it('una sola que falle basta para que no esté sano', async () => {
    const resultado = await comprobarSalud([buena('postgres'), mala('cola', 'atascada')]);

    expect(resultado.ok).toBe(false);
    expect(resultado.comprobaciones[1]).toMatchObject({ ok: false, motivo: 'atascada' });
  });

  it('una sonda colgada no deja la petición esperando para siempre', async () => {
    // Un balanceador que no obtiene respuesta no distingue «tarda» de «cayó»: acaba sacando
    // de rotación al proceso sano y dejando el roto.
    const resultado = await comprobarSalud([colgada('postgres')], 30);

    expect(resultado.ok).toBe(false);
    expect(resultado.comprobaciones[0]!.motivo).toContain('no respondió');
  });

  it('las sondas corren en paralelo: no suman sus límites', async () => {
    const inicio = Date.now();

    await comprobarSalud([colgada('a'), colgada('b'), colgada('c')], 50);

    // En serie serían 150 ms; el margen cubre la lentitud del entorno de tests.
    expect(Date.now() - inicio).toBeLessThan(120);
  });

  it('el motivo se recorta: un error de Postgres puede traer los parámetros', async () => {
    const largo = 'x'.repeat(500);
    const resultado = await comprobarSalud([mala('postgres', largo)]);

    expect(resultado.comprobaciones[0]!.motivo!.length).toBeLessThanOrEqual(120);
  });
});
