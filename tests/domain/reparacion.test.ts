import { describe, expect, it } from 'vitest';
import { MAX_FALLOS, registrarFallo } from '../../src/domain/conversacion/reparacion.ts';

describe('reparación escalonada', () => {
  it('reformula, luego da un ejemplo, y al tercero deriva', () => {
    expect(registrarFallo(0)).toEqual({ tipo: 'reformular', fallos: 1 });
    expect(registrarFallo(1)).toEqual({ tipo: 'ejemplo', fallos: 2 });
    expect(registrarFallo(2)).toEqual({ tipo: 'derivar', fallos: 3 });
  });

  it('no hay cuarto intento: pasado el tope sigue derivando', () => {
    for (const previos of [3, 4, 99]) {
      expect(registrarFallo(previos)).toEqual({ tipo: 'derivar', fallos: MAX_FALLOS });
    }
  });

  it('el contador nunca supera el tope, que es lo que admite la columna', () => {
    // `conversaciones.fallos_consecutivos` tiene un CHECK de 0 a 3.
    for (let previos = 0; previos < 10; previos++) {
      expect(registrarFallo(previos).fallos).toBeLessThanOrEqual(MAX_FALLOS);
    }
  });
});
