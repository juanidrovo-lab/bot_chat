import { createHmac, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { verificarFirma } from '../../src/adapters/whatsapp/firma.ts';

const SECRETO = 'app-secret-de-prueba';
const CUERPO = Buffer.from(JSON.stringify({ object: 'whatsapp_business_account', entry: [] }), 'utf8');

function firmar(cuerpo: Buffer, secreto = SECRETO): string {
  return 'sha256=' + createHmac('sha256', secreto).update(cuerpo).digest('hex');
}

describe('firma del webhook', () => {
  it('acepta una firma correcta', () => {
    expect(verificarFirma(CUERPO, firmar(CUERPO), SECRETO)).toBe(true);
  });

  it('rechaza el cuerpo alterado', () => {
    const firma = firmar(CUERPO);
    expect(verificarFirma(Buffer.concat([CUERPO, Buffer.from(' ')]), firma, SECRETO)).toBe(false);
  });

  it('rechaza una firma de otro secreto', () => {
    expect(verificarFirma(CUERPO, firmar(CUERPO, 'otro-secreto'), SECRETO)).toBe(false);
  });

  it('rechaza si falta la cabecera', () => {
    expect(verificarFirma(CUERPO, undefined, SECRETO)).toBe(false);
  });

  it('rechaza sin el prefijo sha256=', () => {
    const hex = createHmac('sha256', SECRETO).update(CUERPO).digest('hex');
    expect(verificarFirma(CUERPO, hex, SECRETO)).toBe(false);
  });

  it('una cabecera con basura devuelve false, no lanza', () => {
    // Buffer.from(..., 'hex') trunca en silencio ante caracteres inválidos; si eso llegara
    // a timingSafeEqual con longitudes distintas, sería una excepción y un 500.
    for (const basura of ['sha256=', 'sha256=zz', 'sha256=' + 'a'.repeat(63), 'sha256=nohex']) {
      expect(() => verificarFirma(CUERPO, basura, SECRETO)).not.toThrow();
      expect(verificarFirma(CUERPO, basura, SECRETO)).toBe(false);
    }
  });

  it('el HMAC es sobre los bytes exactos, también con acentos', () => {
    // Si alguien reserializa el JSON antes de firmar, este test es el que falla.
    const conAcentos = Buffer.from(JSON.stringify({ texto: 'Señor Muñoz, ¿día 16?' }), 'utf8');
    expect(verificarFirma(conAcentos, firmar(conAcentos), SECRETO)).toBe(true);
  });

  it('rechaza una firma de longitud distinta', () => {
    const corta = 'sha256=' + randomBytes(16).toString('hex');
    expect(verificarFirma(CUERPO, corta, SECRETO)).toBe(false);
  });
});
