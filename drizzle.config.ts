import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/adapters/postgres/esquema.ts',
  out: './drizzle',
  casing: 'snake_case',
  dbCredentials: {
    // Las migraciones corren como app_owner; la aplicación nunca es dueña de las tablas.
    url: process.env.DATABASE_URL_OWNER ?? 'postgres://app_owner:cambiame@localhost:5432/providencia',
  },
});
