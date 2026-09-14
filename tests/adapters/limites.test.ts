import { describe, expect, it } from 'vitest';
import { ajustarBotones, ajustarFilas, LIMITES, truncar } from '../../src/adapters/whatsapp/limites.ts';

describe('límites de WhatsApp', () => {
  it('deja intacto lo que ya cabe', () => {
    expect(truncar('laboral', 24)).toBe('laboral');
    expect(truncar('x'.repeat(24), 24)).toBe('x'.repeat(24));
  });

  it('trunca al máximo, contando el carácter de elipsis', () => {
    const recortado = truncar('x'.repeat(40), 24);
    expect(Array.from(recortado)).toHaveLength(24);
    expect(recortado.endsWith('…')).toBe(true);
  });

  it('no parte un emoji por la mitad', () => {
    // '👍' ocupa dos unidades UTF-16: un slice ingenuo dejaría medio par suplente.
    const texto = '👍'.repeat(10);
    const recortado = truncar(texto, 5);
    expect(Array.from(recortado)).toHaveLength(5);
    // Un emoji válido contiene pares suplentes; lo que no puede quedar es uno suelto.
    expect(recortado.isWellFormed()).toBe(true);
    expect(recortado).toBe('👍👍👍👍…');
  });

  it('una lista nunca pasa de 10 filas y cada título cabe en 24', () => {
    const filas = Array.from({ length: 18 }, (_, i) => ({
      id: `f${i}`,
      titulo: `Título larguísimo número ${i} que no cabe`,
      descripcion: 'd'.repeat(120),
    }));
    const ajustadas = ajustarFilas(filas);

    expect(ajustadas).toHaveLength(LIMITES.filasLista);
    for (const fila of ajustadas) {
      expect(Array.from(fila.titulo).length).toBeLessThanOrEqual(LIMITES.tituloFila);
      expect(Array.from(fila.descripcion!).length).toBeLessThanOrEqual(LIMITES.descripcionFila);
    }
  });

  it('una fila sin descripción no gana una vacía', () => {
    expect(ajustarFilas([{ id: 'a', titulo: 'Laboral' }])[0]).toEqual({ id: 'a', titulo: 'Laboral' });
  });

  it('nunca se envían más de 3 botones', () => {
    const botones = Array.from({ length: 7 }, (_, i) => ({ id: `b${i}`, titulo: `Opción muy larga ${i}` }));
    const ajustados = ajustarBotones(botones);

    expect(ajustados).toHaveLength(LIMITES.botones);
    for (const boton of ajustados) {
      expect(Array.from(boton.titulo).length).toBeLessThanOrEqual(LIMITES.textoBoton);
    }
  });
});
