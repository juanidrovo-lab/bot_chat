import { describe, expect, it } from 'vitest';
import { necesitaRefresco } from '../../src/adapters/whatsapp/media.ts';
import { DIAS_REFRESCO } from '../../src/app/refrescarMedia.ts';

const AHORA = new Date('2026-09-14T12:00:00Z');
const haceDias = (d: number) => new Date(AHORA.getTime() - d * 86_400_000);

describe('caducidad de los media_id', () => {
  it('un audio nunca subido necesita subirse', () => {
    expect(necesitaRefresco(null, null, AHORA)).toBe(true);
    expect(necesitaRefresco(null, haceDias(1), AHORA)).toBe(true);
    expect(necesitaRefresco('m1', null, AHORA)).toBe(true);
  });

  it('uno reciente no se toca', () => {
    expect(necesitaRefresco('m1', haceDias(1), AHORA)).toBe(false);
    expect(necesitaRefresco('m1', haceDias(DIAS_REFRESCO - 1), AHORA)).toBe(false);
  });

  it('se refresca al llegar al umbral, con margen sobre los 30 días de Meta', () => {
    expect(necesitaRefresco('m1', haceDias(DIAS_REFRESCO), AHORA)).toBe(true);
    expect(necesitaRefresco('m1', haceDias(29), AHORA)).toBe(true);
    expect(DIAS_REFRESCO).toBeLessThan(30);
  });
});
