import { describe, expect, it } from 'vitest';
import { aInstante, aInstanteOpcional, ValorInesperadoError } from '../../src/adapters/postgres/tipos.ts';

describe('conversión de valores de SQL crudo', () => {
  it('lee el formato que devuelve Postgres para timestamptz', () => {
    // Este es el literal exacto que llega por `tx.execute`: espacio en vez de «T» y
    // desplazamiento de dos dígitos. No es ISO 8601 estricto.
    expect(aInstante('2026-09-17 04:30:00+00').toISOString()).toBe('2026-09-17T04:30:00.000Z');
    expect(aInstante('2026-09-17 04:30:00.123456+00').getTime()).toBe(
      Date.parse('2026-09-17T04:30:00.123Z'),
    );
  });

  it('deja pasar un Date tal cual', () => {
    const fecha = new Date('2026-09-17T04:30:00Z');
    expect(aInstante(fecha)).toBe(fecha);
  });

  it('protesta en vez de devolver una fecha inválida', () => {
    for (const basura of [null, undefined, 42, {}, 'no es una fecha']) {
      expect(() => aInstante(basura)).toThrow(ValorInesperadoError);
    }
  });

  it('la variante opcional distingue el nulo de la basura', () => {
    expect(aInstanteOpcional(null)).toBeNull();
    expect(aInstanteOpcional(undefined)).toBeNull();
    expect(() => aInstanteOpcional('nada')).toThrow(ValorInesperadoError);
  });
});
