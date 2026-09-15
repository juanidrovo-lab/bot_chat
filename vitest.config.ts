import { defineConfig } from 'vitest/config';

/**
 * Suite rápida: dominio, casos de uso con puertos falsos, y las partes puras de los
 * adaptadores (esquemas Zod, truncado a los límites de WhatsApp, verificación de firma).
 * Sin red y sin Docker.
 */
export default defineConfig({
  test: {
    include: ['tests/domain/**/*.test.ts', 'tests/app/**/*.test.ts', 'tests/adapters/**/*.test.ts'],
    environment: 'node',
    // Los avisos de «el clasificador falló» son parte de lo que se prueba, no ruido.
    env: { LOG_LEVEL: 'silent' },
  },
});
