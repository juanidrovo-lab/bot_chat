# Runbook · Providencia

Lo que hay que hacer cuando algo pasa, escrito para el que lo lee a las siete de la mañana
con el socio al teléfono. Cada sección empieza por el síntoma, no por el componente.

Convenciones: todo corre desde el directorio del proyecto en el servidor, con
`docker compose -f compose.prod.yml`. Donde dice `<...>` hay que sustituir.

---

## 1. El bot dejó de responder

**Primero, en este orden.** No saltarse pasos: el más barato suele ser el que era.

```bash
curl -fsS https://<dominio>/health | jq .
```

La respuesta dice cuál de las tres sondas falló:

| Sonda | Qué significa | A dónde ir |
|---|---|---|
| `postgres` | La base no responde, está en solo lectura o le revocaron permisos | §2 |
| `cola` | Hay trabajos sin tomar desde hace más de cinco minutos: no hay trabajador vivo | §3 |
| `outbox` | Algún efecto externo lleva más de quince minutos sin publicarse | §4 |

Si `/health` no responde nada:

```bash
docker compose -f compose.prod.yml ps
docker compose -f compose.prod.yml logs --tail=200 app
```

**Si el proceso está vivo y `/health` da 200, el problema está antes de nosotros.** Meta
dejó de entregar, o el número está suspendido. Mirar el panel de la app en
`business.facebook.com` → WhatsApp → Calidad del número. Ver §7.

**La trampa.** Un bot que no recibe nada tiene todas las métricas en verde. Si nadie se
quejó pero tampoco llegó nada, buscar en el log:

```bash
docker compose -f compose.prod.yml logs app | grep silencio_anomalo
```

Esa alerta se dispara sola cada quince minutos cuando hoy no entró ningún mensaje y los días
anteriores sí.

---

## 2. Postgres

```bash
docker compose -f compose.prod.yml exec postgres \
  psql -U postgres -d providencia -c 'SELECT now()'
```

- **«disk full»** → mirar `df -h` en el servidor. Lo que crece es `mensajes`; la retención
  diaria borra los de más de noventa días a las 03:00. Si no está corriendo, ver §3.
- **«the database system is in recovery mode»** → esperar. Postgres se está recuperando
  solo; si tarda más de unos minutos, mirar sus logs.
- **«permission denied for table …»** → alguien corrió una migración como el rol equivocado.
  Las migraciones van con `app_owner` (`DATABASE_URL_OWNER`), nunca con `app_user`.

**Nunca** ejecutar un `UPDATE` o un `DELETE` de mantenimiento sin fijar el despacho: con
`FORCE ROW LEVEL SECURITY` **el dueño también está sujeto a la política** y la sentencia no
toca ninguna fila, sin avisar de nada.

```sql
BEGIN;
SELECT set_config('app.tenant_id', '<uuid-del-despacho>', true);
-- ... aquí el UPDATE ...
COMMIT;
```

---

## 3. La cola está parada

```bash
docker compose -f compose.prod.yml exec postgres psql -U postgres -d providencia -c \
  "SELECT name, state, count(*) FROM pgboss.job GROUP BY 1,2 ORDER BY 3 DESC"
```

Muchos en `created` y ninguno en `active` significa que no hay trabajador. Reiniciar la
aplicación:

```bash
docker compose -f compose.prod.yml restart app
```

Los crones los guarda pg-boss en Postgres, así que sobreviven al reinicio y volver a
programarlos no los duplica.

Para ver qué está programado:

```bash
docker compose -f compose.prod.yml exec postgres psql -U postgres -d providencia -c \
  "SELECT name, cron, timezone FROM pgboss.schedule ORDER BY name"
```

Deben aparecer seis: `outbox.relay` cada minuto, `agenda.sincronizar` cada cinco,
`alertas.revisar` cada quince, `recordatorios.enviar` a las 09:00, `retencion.aplicar` a las
03:00 y `media.refrescar` a las 04:00, todos en `America/Guayaquil`.

---

## 4. La outbox se atascó

La alerta salta cuando algo lleva más de quince minutos sin publicarse. Ver qué es, despacho
por despacho —bajo RLS no hay una consulta que los vea a todos—:

```sql
BEGIN;
SELECT set_config('app.tenant_id', '<uuid-del-despacho>', true);
SELECT tipo, intentos, proximo_intento_at, ultimo_error
  FROM outbox WHERE publicado_at IS NULL ORDER BY created_at LIMIT 20;
COMMIT;
```

- **`intentos` en 5** → está archivado: se agotaron los reintentos y ya no se vuelve a tomar.
  El rastro queda a propósito. Leer `ultimo_error` (va sin PII y recortado).
- **`intentos` bajo y `proximo_intento_at` en el futuro** → está esperando su reintento. El
  backoff va de uno a treinta minutos. No hay nada que hacer.
- **`gcal.*` fallando todos** → el refresh token de ese abogado caducó o lo revocó. Que
  vuelva a conectar su calendario desde el panel. **La agenda no se ve afectada**: Google es
  un espejo, las citas viven en Postgres.

Para volver a intentar algo archivado, después de arreglar la causa:

```sql
BEGIN;
SELECT set_config('app.tenant_id', '<uuid-del-despacho>', true);
UPDATE outbox SET intentos = 0, proximo_intento_at = now()
 WHERE id = '<uuid-del-trabajo>' AND publicado_at IS NULL;
COMMIT;
```

---

## 5. Desplegar

```bash
git pull
docker compose -f compose.prod.yml build app
docker compose -f compose.prod.yml run --rm app node scripts/migrar.ts
docker compose -f compose.prod.yml up -d app
curl -fsS https://<dominio>/health | jq .ok
```

Las migraciones van **antes** de levantar la versión nueva y corren con `app_owner`. Son
idempotentes: volver a aplicarlas no hace nada.

Durante unos segundos pueden convivir el proceso viejo y el nuevo. No pasa nada: el orden
por conversación lo sostienen la política `key_strict_fifo` de la cola y el
`SELECT ... FOR UPDATE` sobre la fila de conversación, no el hecho de que haya un solo
proceso.

---

## 6. Rotar el token de WhatsApp

El token es por despacho y está cifrado en `tenant_config`. Rotarlo **no** exige reiniciar:
se lee en cada turno.

```bash
docker compose -f compose.prod.yml run --rm app node -e "
  const { cifrar } = await import('./src/platform/crypto.ts');
  console.log(cifrar(process.argv[1], process.env.CLAVE_CIFRADO_HEX));
" '<token-nuevo>'
```

Y con el valor cifrado:

```sql
BEGIN;
SELECT set_config('app.tenant_id', '<uuid-del-despacho>', true);
UPDATE tenant_config SET wa_token_enc = '<valor-cifrado>' WHERE tenant_id = '<uuid>';
COMMIT;
```

Comprobar mandándose un mensaje al número del estudio. Si empieza a fallar todo, la alerta
`whatsapp_errores` salta en menos de quince minutos.

---

## 7. Meta suspendió el número

Síntoma: todos los envíos fallan con 4xx y la alerta `whatsapp_errores` está encendida.

1. `business.facebook.com` → WhatsApp Manager → el número → **Estado y calidad**.
2. Si dice *Restringido*, el número siguió enviando con calidad baja. Se levanta solo al
   cabo de unas horas o un día; no hay nada que tocar en el código.
3. Si dice *Inhabilitado*, hay que apelar desde ahí mismo.

**Mientras tanto el sistema no pierde nada.** Los mensajes entrantes se siguen guardando y
los efectos quedan en `outbox` reintentando; cuando el número vuelve, salen solos. Lo que sí
conviene es avisar al estudio de que conteste por su cuenta a quien escriba.

Qué **no** hacer: subir el volumen de plantillas para «recuperar» actividad. Es lo que
empeora la calificación de calidad.

---

## 8. Restaurar un respaldo

Los respaldos son diarios, cifrados y viven en R2 con catorce días de retención.

```bash
aws s3 ls s3://<bucket>/ --endpoint-url <r2-endpoint>
aws s3 cp s3://<bucket>/providencia-<fecha>.sql.gz.enc . --endpoint-url <r2-endpoint>

openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -pass "env:CLAVE_CIFRADO_HEX" \
  -in providencia-<fecha>.sql.gz.enc | gunzip > providencia.sql
```

**Restaurar siempre en una base nueva primero**, nunca encima de la de producción:

```bash
docker compose -f compose.prod.yml exec postgres createdb -U postgres providencia_restore
docker compose -f compose.prod.yml exec -T postgres \
  psql -U postgres -d providencia_restore < providencia.sql
```

Comprobar que trae datos —si el volcado se hizo sin `BYPASSRLS`, **saldría vacío y sin dar
error**, y por eso `respaldo.sh` rechaza cualquier archivo de menos de diez kilobytes—:

```sql
SELECT (SELECT count(*) FROM tenants) AS despachos,
       (SELECT count(*) FROM citas) AS citas;
```

Solo entonces, y con la aplicación parada, cambiar el nombre de las bases.

---

## 9. Dar de alta un despacho

Es administrativo: corre con `app_owner`, porque `tenants` y `tenant_config` son de solo
lectura para la aplicación a propósito.

1. Crear la fila en `tenants` con su `slug` y su `wa_phone_number_id`.
2. Cifrar el token y el app secret con `platform/crypto.ts` (§6) y escribirlos en
   `tenant_config`, junto con el tarifario y los horarios en JSON.
3. Crear los abogados en `abogados`, con sus materias.
4. Crear los usuarios del panel en `usuarios`. **La aplicación no puede insertarlos**: la
   migración le revoca el `INSERT` justamente para que dar de alta a alguien sea un acto
   deliberado.
5. Cada usuario registra su passkey desde el panel, en `/panel/<slug>`.

Todo dentro de una transacción con el tenant fijado, por lo de §2.

---

## 10. Una persona pide sus datos o su borrado (LOPDP)

- **Acceso / portabilidad:** desde el panel, ficha del contacto → *Exportar datos*. Sale un
  JSON con su expediente completo y la descarga queda registrada en `eventos`.
- **Supresión:** la retención automática borra los mensajes a los noventa días y anonimiza
  al contacto tras doce meses sin actividad. Para hacerlo antes, a petición:

```sql
BEGIN;
SELECT set_config('app.tenant_id', '<uuid-del-despacho>', true);
UPDATE contactos SET nombre = NULL, email = NULL, cedula = NULL, anonimizado_at = now()
 WHERE id = '<uuid-del-contacto>';
DELETE FROM mensajes WHERE conversacion_id IN (
  SELECT id FROM conversaciones WHERE contacto_id = '<uuid-del-contacto>'
);
COMMIT;
```

La fila del contacto **no se borra**: sus citas pasadas sostienen las métricas del estudio y
ya no identifican a nadie. Si tiene una cita futura, avisar antes al estudio: se presentaría
y no sabrían quién es.

---

## 11. Quién vio qué

```sql
BEGIN;
SELECT set_config('app.tenant_id', '<uuid-del-despacho>', true);
SELECT created_at, actor, tipo, entidad, entidad_id
  FROM eventos WHERE entidad_id = '<uuid>' ORDER BY created_at DESC LIMIT 50;
COMMIT;
```

`eventos` guarda **a quién** se accedió, nunca **qué** decía: es auditoría, no una segunda
copia de los datos.
