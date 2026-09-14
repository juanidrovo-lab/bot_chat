import { describe, expect, it } from 'vitest';
import { intentGlobal } from '../../src/domain/conversacion/mensaje.ts';
import { OPCION } from '../../src/domain/conversacion/acciones.ts';

describe('intents globales', () => {
  it('reconoce las palabras sueltas del guion', () => {
    for (const texto of ['menu', 'MENÚ', ' 0 ', 'inicio', 'volver']) {
      expect(intentGlobal(texto)).toBe(OPCION.menu);
    }
    expect(intentGlobal('cancelar')).toBe(OPCION.cancelar);
    expect(intentGlobal('Persona')).toBe(OPCION.persona);
    expect(intentGlobal('abogado')).toBe(OPCION.persona);
  });

  it('ignora la puntuación y las mayúsculas', () => {
    expect(intentGlobal('¿Menú?')).toBe(OPCION.menu);
    expect(intentGlobal('Cancelar.')).toBe(OPCION.cancelar);
  });

  it('NO dispara con la palabra dentro de una frase', () => {
    // Quien escribe esto está describiendo su consulta, no pidiendo cancelar una cita.
    // Distinguirlo en texto corrido es justo lo que se delega al clasificador.
    expect(intentGlobal('quiero cancelar el contrato de arriendo')).toBeNull();
    expect(intentGlobal('necesito hablar de una persona que me debe')).toBeNull();
    expect(intentGlobal('mi jefe es abogado y me despidió')).toBeNull();
  });

  it('el texto normal no es un intent', () => {
    expect(intentGlobal('Buenas tardes, necesito una consulta')).toBeNull();
    expect(intentGlobal('')).toBeNull();
  });
});
