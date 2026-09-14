#!/bin/sh
# Provisiona los tres roles de §4.3 y cede la propiedad del esquema a app_owner.
# Corre una sola vez, en la inicialización del contenedor, como superusuario.
#
# La aplicación NUNCA es dueña de las tablas: si lo fuera, las políticas de RLS se
# ignorarían en silencio aunque estén creadas.
set -e

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-SQL
  CREATE ROLE app_owner LOGIN PASSWORD '${APP_OWNER_PASSWORD:?falta APP_OWNER_PASSWORD}';
  CREATE ROLE app_user  LOGIN PASSWORD '${APP_USER_PASSWORD:?falta APP_USER_PASSWORD}';
  CREATE ROLE app_dump  LOGIN PASSWORD '${APP_DUMP_PASSWORD:?falta APP_DUMP_PASSWORD}' BYPASSRLS;

  ALTER DATABASE "$POSTGRES_DB" OWNER TO app_owner;
  ALTER SCHEMA public OWNER TO app_owner;
  GRANT CONNECT ON DATABASE "$POSTGRES_DB" TO app_user, app_dump;

  -- Casa de pg-boss. Pertenece a app_user porque la cola gestiona sus propias tablas:
  -- las crea, las migra y las particiona. No rompe el principio de que la aplicación no es
  -- dueña de nada, porque aquí no hay datos de despachos (los trabajos no llevan tenant_id
  -- ni RLS), y la alternativa —dar CREATE sobre la base a app_user— es mucho peor.
  -- Se crea aquí, en el aprovisionamiento, y no en una migración: cambiar de dueño exige
  -- poder hacer SET ROLE al destino, y app_owner no es miembro de app_user a propósito.
  CREATE SCHEMA pgboss AUTHORIZATION app_user;
SQL
