import { defineConfig } from 'vitest/config';

/**
 * Suite rápida: dominio, plataforma y las partes puras de los adaptadores (esquemas Zod,
 * truncado a los límites de WhatsApp, verificación de firma). Sin red y sin Docker.
 */
export default defineConfig({
  test: {
    include: ['tests/domain/**/*.test.ts', 'tests/adapters/**/*.test.ts'],
    environment: 'node',
  },
});
