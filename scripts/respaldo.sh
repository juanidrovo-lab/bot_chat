#!/bin/sh
# Respaldo diario a Cloudflare R2, con retención de catorce días.
#
# Tres decisiones que no son de estilo:
#
#   * Corre como `app_dump`, que tiene BYPASSRLS y solo SELECT. Sin BYPASSRLS el volcado
#     saldría **vacío y sin avisar**: con FORCE ROW LEVEL SECURITY la política se evalúa
#     también para quien no fijó `app.tenant_id`, y un backup vacío parece un backup.
#   * El volcado se cifra antes de salir de la máquina. Dentro van consultas jurídicas y
#     cédulas; el bucket es de un tercero.
#   * `set -e` y la verificación posterior: un respaldo que falla en silencio es peor que no
#     tenerlo, porque nadie lo descubre hasta que hace falta restaurar.
set -eu

: "${DATABASE_URL_DUMP:?falta DATABASE_URL_DUMP}"
: "${R2_ENDPOINT:?falta R2_ENDPOINT}"
: "${R2_BUCKET:?falta R2_BUCKET}"
: "${CLAVE_CIFRADO_HEX:?falta CLAVE_CIFRADO_HEX}"
RETENCION_DIAS="${RETENCION_DIAS:-14}"

# 03:30, media hora después de la retención: volcar mientras se borran filas alarga el
# volcado sin necesidad.
HORA_DIARIA="${HORA_DIARIA:-03:30}"

respaldar() {
  fecha="$(date -u +%Y-%m-%dT%H%M%SZ)"
  archivo="/tmp/providencia-${fecha}.sql.gz.enc"

  # `--no-owner` y `--no-privileges`: el destino de una restauración puede no tener los
  # mismos roles, y ese detalle es lo que convierte una restauración de urgencia en una
  # tarde perdida.
  pg_dump "$DATABASE_URL_DUMP" --no-owner --no-privileges \
    | gzip -9 \
    | openssl enc -aes-256-cbc -pbkdf2 -iter 200000 -pass "env:CLAVE_CIFRADO_HEX" \
    > "$archivo"

  # Un volcado vacío pesa poco: si no llega ni a diez kilobytes, algo salió mal aunque
  # ningún comando haya devuelto error.
  tamano="$(wc -c < "$archivo")"
  if [ "$tamano" -lt 10240 ]; then
    echo "{\"nivel\":\"error\",\"msg\":\"respaldo sospechosamente pequeño\",\"bytes\":$tamano}" >&2
    rm -f "$archivo"
    return 1
  fi

  aws s3 cp "$archivo" "s3://${R2_BUCKET}/$(basename "$archivo")" \
    --endpoint-url "$R2_ENDPOINT"
  rm -f "$archivo"

  # Retención: se borra por fecha en el nombre, no por la del objeto, para que volver a
  # subir un archivo viejo no le regale otros catorce días.
  limite="$(date -u -d "-${RETENCION_DIAS} days" +%Y-%m-%d 2>/dev/null || date -u -v-"${RETENCION_DIAS}"d +%Y-%m-%d)"
  aws s3 ls "s3://${R2_BUCKET}/" --endpoint-url "$R2_ENDPOINT" \
    | awk '{print $4}' \
    | while read -r objeto; do
        [ -z "$objeto" ] && continue
        dia="$(echo "$objeto" | sed -n 's/^providencia-\([0-9-]\{10\}\)T.*/\1/p')"
        [ -z "$dia" ] && continue
        if [ "$dia" \< "$limite" ]; then
          aws s3 rm "s3://${R2_BUCKET}/${objeto}" --endpoint-url "$R2_ENDPOINT"
        fi
      done

  echo "{\"nivel\":\"info\",\"msg\":\"respaldo subido\",\"archivo\":\"$(basename "$archivo")\",\"bytes\":$tamano}"
}

if [ "${UNA_VEZ:-}" = "1" ]; then
  respaldar
  exit 0
fi

# Bucle en vez de cron: el contenedor no lleva cron y añadirlo solo para esto duplicaría el
# sitio donde mirar cuando el respaldo no aparezca.
while true; do
  ahora="$(date -u +%H:%M)"
  if [ "$ahora" = "$HORA_DIARIA" ]; then
    respaldar || echo '{"nivel":"error","msg":"el respaldo diario falló"}' >&2
    sleep 60
  fi
  sleep 30
done
