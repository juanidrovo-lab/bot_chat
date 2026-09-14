import { defineConfig } from 'vitest/config';

/**
 * Integración contra Postgres real. En un solo hilo y sin paralelismo entre archivos:
 * los tests comparten la base y varios de ellos dependen de lo que ve o deja de ver una
 * transacción concreta.
 */
export default defineConfig({
  test: {
    include: ['tests/integracion/**/*.test.ts'],
    environment: 'node',
    fileParallelism: false,
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
