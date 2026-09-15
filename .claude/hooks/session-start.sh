#!/bin/bash
# Deja la sesión lista para trabajar: dependencias instaladas y un Postgres con el esquema
# aplicado, para que `npm run test:integration` funcione sin preparar nada a mano.
#
# Solo corre en sesiones remotas: en local cada quien tiene su entorno.
set -euo pipefail

if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

cd "${CLAUDE_PROJECT_DIR:-.}"

echo "→ instalando dependencias"
npm install --no-audit --no-fund

# --- Postgres para los tests de integración --------------------------------------------
#
# Los tests de concurrencia y de RLS necesitan un Postgres de verdad: un mock no tiene
# índices únicos parciales ni políticas de fila. El camino normal es `compose.test.yml`,
# pero en un contenedor sin acceso al registro de imágenes no hay de dónde bajarlas, así
# que se levanta un clúster local con los binarios que ya están instalados.
#
# La versión local puede no ser la 17 de producción. Eso lo cubre CI, que sí corre contra
# Postgres 17; aquí lo que importa es tener SQL real contra el que probar.
PUERTO=55432
DATOS=/var/tmp/providencia-pg
BASE=providencia_test

preparar_postgres() {
  local bin
  bin=$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -V | tail -1 || true)
  if [ -z "$bin" ] || ! id postgres >/dev/null 2>&1; then
    echo "→ sin binarios de Postgres: los tests de integración necesitarán compose"
    return 0
  fi

  if ! "$bin/pg_isready" -h 127.0.0.1 -p "$PUERTO" -q 2>/dev/null; then
    if [ ! -s "$DATOS/PG_VERSION" ]; then
      echo "→ creando clúster en $DATOS"
      rm -rf "$DATOS"
      mkdir -p "$DATOS"
      chown postgres:postgres "$DATOS"
      chmod 700 "$DATOS"
      su postgres -c "$bin/initdb -D $DATOS -U postgres --auth=trust" >/dev/null
    fi
    echo "→ arrancando Postgres en el puerto $PUERTO"
    su postgres -c "$bin/pg_ctl -D $DATOS -o '-p $PUERTO -c listen_addresses=127.0.0.1' -l $DATOS/log start -w" >/dev/null
  fi

  local host="127.0.0.1:$PUERTO"
  export DATABASE_URL_SUPERUSER="postgres://postgres:local@$host/$BASE"
  export APP_OWNER_PASSWORD=local APP_USER_PASSWORD=local APP_DUMP_PASSWORD=local
  export DATABASE_URL="postgres://app_user:local@$host/$BASE"
  export DATABASE_URL_OWNER="postgres://app_owner:local@$host/$BASE"
  export DATABASE_URL_DUMP="postgres://app_dump:local@$host/$BASE"

  # Ambos pasos son idempotentes: se pueden repetir en cada arranque sin romper nada.
  npm run --silent db:aprovisionar
  npm run --silent db:migrate

  {
    echo "export DATABASE_URL='$DATABASE_URL'"
    echo "export DATABASE_URL_OWNER='$DATABASE_URL_OWNER'"
    echo "export DATABASE_URL_DUMP='$DATABASE_URL_DUMP'"
    echo "export DATABASE_URL_SUPERUSER='$DATABASE_URL_SUPERUSER'"
    echo "export APP_OWNER_PASSWORD=local APP_USER_PASSWORD=local APP_DUMP_PASSWORD=local"
  } >> "${CLAUDE_ENV_FILE:-/dev/null}"

  echo "→ base lista: npm run test:integration usa este Postgres"
}

# Que falle la base no puede impedir trabajar: la suite rápida no la necesita.
preparar_postgres || echo "‼ no se pudo preparar Postgres; la suite rápida sigue disponible"

echo "✓ entorno listo"
