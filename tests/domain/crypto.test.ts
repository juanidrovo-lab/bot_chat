import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  CifradoInvalidoError,
  cifrar,
  descifrar,
  firmaCoincide,
} from '../../src/platform/crypto.ts';

const CLAVE = randomBytes(32).toString('hex');

describe('crypto · AES-256-GCM', () => {
  it('lo cifrado se descifra', () => {
    const secreto = 'EAAG...token-de-whatsapp';
    expect(descifrar(cifrar(secreto, CLAVE), CLAVE)).toBe(secreto);
  });

  it('dos cifrados del mismo texto son distintos: el IV es aleatorio', () => {
    expect(cifrar('mismo', CLAVE)).not.toBe(cifrar('mismo', CLAVE));
  });

  it('con otra clave no descifra', () => {
    const otra = randomBytes(32).toString('hex');
    expect(() => descifrar(cifrar('secreto', CLAVE), otra)).toThrow(CifradoInvalidoError);
  });

  it('un texto cifrado alterado no pasa la etiqueta de autenticación', () => {
    const cifrado = cifrar('secreto', CLAVE);
    const alterado = cifrado.slice(0, -2) + (cifrado.endsWith('A') ? 'BB' : 'AA');
    expect(() => descifrar(alterado, CLAVE)).toThrow(CifradoInvalidoError);
  });

  it('rechaza claves que no sean de 32 bytes', () => {
    expect(() => cifrar('x', 'aabb')).toThrow(CifradoInvalidoError);
  });
});

describe('crypto · firma del webhook', () => {
  it('firmas iguales coinciden', () => {
    const firma = randomBytes(32);
    expect(firmaCoincide(firma, Buffer.from(firma))).toBe(true);
  });

  it('firmas distintas no coinciden', () => {
    expect(firmaCoincide(randomBytes(32), randomBytes(32))).toBe(false);
  });

  it('longitudes distintas devuelven false en vez de lanzar', () => {
    // timingSafeEqual lanza si difieren las longitudes, y esa excepción se convertiría
    // en un 500 donde corresponde un 401.
    expect(() => firmaCoincide(randomBytes(32), randomBytes(16))).not.toThrow();
    expect(firmaCoincide(randomBytes(32), randomBytes(16))).toBe(false);
  });
});
