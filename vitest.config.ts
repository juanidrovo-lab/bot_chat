import { defineConfig } from 'vitest/config';

/** Unitarios de dominio y de plataforma: rápidos, sin red y sin Docker. */
export default defineConfig({
  test: {
    include: ['tests/domain/**/*.test.ts'],
    environment: 'node',
  },
});
