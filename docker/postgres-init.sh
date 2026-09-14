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
SQL
