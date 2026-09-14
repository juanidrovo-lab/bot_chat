import { describe, expect, it } from 'vitest';
import {
  desdeLocal,
  diaSemanaLocal,
  fechaLocalISO,
  formatearFechaHora,
  formatearHora,
  periodoMensual,
} from '../../src/platform/time.ts';

describe('time · America/Guayaquil', () => {
  it('una cita a las 23:30 locales cae en el día local correcto, no en el de UTC', () => {
    // 23:30 del 16 de septiembre en Cuenca son las 04:30 UTC del 17.
    const instante = new Date('2026-09-17T04:30:00Z');
    expect(fechaLocalISO(instante)).toBe('2026-09-16');
    expect(formatearHora(instante)).toBe('23:30');
    expect(formatearFechaHora(instante)).toBe('miércoles 16 de septiembre, 23:30');
  });

  it('la medianoche local se formatea como 00:00 y no como 24:00', () => {
    const instante = new Date('2026-09-17T05:00:00Z');
    expect(formatearHora(instante)).toBe('00:00');
    expect(fechaLocalISO(instante)).toBe('2026-09-17');
  });

  it('el periodo mensual es el del calendario local: el 31 a las 21:00 aún es enero', () => {
    // 31 de enero 21:00 en Cuenca = 1 de febrero 02:00 UTC.
    expect(periodoMensual(new Date('2026-02-01T02:00:00Z'))).toBe('2026-01');
    expect(periodoMensual(new Date('2026-02-01T06:00:00Z'))).toBe('2026-02');
  });

  it('el día de la semana se calcula sobre la fecha local', () => {
    // Domingo 20 de septiembre 22:00 local = lunes 21 a las 03:00 UTC.
    expect(diaSemanaLocal(new Date('2026-09-21T03:00:00Z'))).toBe(0);
  });

  it('desdeLocal es la inversa de partesLocales', () => {
    const instante = desdeLocal(2026, 9, 16, 23, 30);
    expect(instante.toISOString()).toBe('2026-09-17T04:30:00.000Z');
    expect(fechaLocalISO(instante)).toBe('2026-09-16');
  });
});
