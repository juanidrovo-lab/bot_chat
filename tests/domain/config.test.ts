/**
 * La configuración, contra un fichero `.env` de verdad.
 *
 * El caso que rompió un arranque en Windows: `SENTRY_DSN=` a secas. En un `.env` así es como
 * se apunta «esta no la uso» sin borrar la línea que recuerda que existe, y `.optional()` de
 * Zod solo admite `undefined`, nunca la cadena vacía. El proceso moría señalando justo las
 * tres variables que el despliegue había decidido no usar.
 */
import { describe, expect, it } from 'vitest';
import { cargarConfig } from '../../src/platform/config.ts';

const MINIMO = {
  DATABASE_URL: 'postgres://app_user:x@localhost:5432/providencia',
  CLAVE_CIFRADO_HEX: 'a'.repeat(64),
};

describe('cargarConfig', () => {
  it('una variable opcional vacía es una variable ausente', () => {
    const config = cargarConfig({
      ...MINIMO,
      GOOGLE_CLIENT_ID: '',
      GOOGLE_CLIENT_SECRET: '',
      SENTRY_DSN: '',
      PANEL_ORIGEN: '',
      WA_VERIFY_TOKEN: '',
      DATABASE_URL_OWNER: '',
    } as NodeJS.ProcessEnv);

    expect(config.GOOGLE_CLIENT_ID).toBeUndefined();
    expect(config.SENTRY_DSN).toBeUndefined();
    expect(config.PANEL_ORIGEN).toBeUndefined();
  });

  it('una opcional con valor se conserva', () => {
    const config = cargarConfig({
      ...MINIMO,
      PANEL_ORIGEN: 'http://localhost:3000',
      SENTRY_DSN: 'https://algo@sentry.io/1',
    } as NodeJS.ProcessEnv);

    expect(config.PANEL_ORIGEN).toBe('http://localhost:3000');
    expect(config.SENTRY_DSN).toBe('https://algo@sentry.io/1');
  });

  it('vacía no es lo mismo que mal escrita: una URL inválida sigue fallando', () => {
    // Si no, un `PANEL_ORIGEN` con una errata se trataría como «sin panel» y el panel
    // fallaría cerrado sin decir por qué.
    expect(() =>
      cargarConfig({ ...MINIMO, PANEL_ORIGEN: 'panel.estudio.ec' } as NodeJS.ProcessEnv),
    ).toThrow(/PANEL_ORIGEN/);
  });

  it('lo obligatorio sigue siendo obligatorio, y el error no enseña los valores', () => {
    try {
      cargarConfig({ DATABASE_URL: '', CLAVE_CIFRADO_HEX: 'corta' } as NodeJS.ProcessEnv);
      expect.unreachable('debería haber fallado');
    } catch (error) {
      const mensaje = (error as Error).message;
      expect(mensaje).toContain('DATABASE_URL');
      expect(mensaje).toContain('CLAVE_CIFRADO_HEX');
      // Son secretos: se enumeran las claves que fallan, nunca su contenido.
      expect(mensaje).not.toContain('corta');
    }
  });

  it('el fichero `.env.example` del repositorio arranca tal cual', async () => {
    // Es el que dice el README que se copie a `.env`. Si no vale, el primer `npm run dev`
    // de cualquiera muere, y el error señala las variables equivocadas.
    const { readFile } = await import('node:fs/promises');
    const texto = await readFile(new URL('../../.env.example', import.meta.url), 'utf8');

    const entorno: Record<string, string> = {};
    for (const linea of texto.split('\n')) {
      const limpia = linea.trim();
      if (limpia === '' || limpia.startsWith('#')) continue;
      const corte = limpia.indexOf('=');
      if (corte > 0) entorno[limpia.slice(0, corte)] = limpia.slice(corte + 1);
    }

    expect(() => cargarConfig(entorno as NodeJS.ProcessEnv)).not.toThrow();
  });
});
