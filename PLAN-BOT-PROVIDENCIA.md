# Bot jurídico Providencia — Especificación v2

> Documento de trabajo para dirigir a Claude Code. Vive en la raíz del repo.
> **v3 (15 sep 2026)** — las fases 1 a 5 están implementadas y esta especificación recoge
> lo que se corrigió al chocar con Postgres, con la API de Meta y con la del modelo. Los cambios de v2 sobre
> v1 van marcados con ⬆; los de v3 sobre v2, con ⬆⬆, y los de datos están resumidos
> en §4.6.
> **v2 (10 sep 2026)** — incorpora la auditoría de arquitectura, seguridad y UX.

---

## 0. Qué estamos construyendo

Bot de WhatsApp para un estudio jurídico de 3 abogados en Cuenca. Solo texto y audios
pregrabados fijos. Sin llamadas de voz, sin audio generado en tiempo real.

1. Saludar, identificarse como bot, pedir consentimiento de tratamiento de datos.
2. Menú de 5 materias con lista interactiva.
3. Dos o tres preguntas cerradas según la materia.
4. Informar el honorario de la consulta.
5. Ofrecer **solo horarios realmente libres** y reservar sin doble-reserva.
6. Capturar nombre, contacto y correo, y enviar la ficha al estudio.
7. Confirmar, recordar, y permitir **cancelar y reagendar**. ⬆
8. Derivar a una persona cuando el usuario lo pida o tras tres fallos. ⬆

Multi-tenant desde el primer commit: el cliente #2 no debe costar infraestructura nueva.

---

## 1. Decisiones de arquitectura

**D1 — Sin n8n.** Excelente para prototipar, pésimo para versionar, testear y replicar en
diez clientes. Esto se revende: código en TypeScript, en git, con tests. Ahorra además
$24/mes de n8n Cloud.

**D2 — Un servidor, un binario, multi-tenant.** API, workers, Postgres y TLS en un
Hetzner CX23. Costo marginal del cliente #2: ~$0,80/mes.

**D3 — Flujo determinista, LLM solo en los bordes.** El menú, la agenda y la captura de
datos son una máquina de estados, no un prompt. El LLM **solo clasifica**: recibe texto
libre y devuelve un enum validado contra una lista cerrada. Nunca redacta el mensaje que
ve el usuario, nunca tiene herramientas. Esto elimina de raíz la inyección de prompt y la
alucinación en el tramo crítico, y deja el costo en ~$0,31/mes.

**D4 — Postgres es la fuente de verdad de la agenda; Google Calendar es un espejo.** Se
reserva en Postgres con índice único parcial y después se empuja el evento. Consultar
Google y luego insertar es una condición de carrera garantizada.

**D5 — El webhook responde 200 en menos de un segundo y encola.** Meta reintenta
agresivamente; procesar dentro del handler es la causa número uno de respuestas
duplicadas.

**D6 — Cola sobre el mismo Postgres (pg-boss).** Sin Redis, sin un contenedor más.

**D7 ⬆ — Arquitectura hexagonal con la regla de dependencias impuesta por el linter.**
Tres anillos: `domain` (puro) ← `app` (casos de uso) ← `adapters` (WhatsApp, Google,
Postgres, LLM, HTTP). Las flechas apuntan hacia adentro. `domain` no importa nada de
`adapters`. La regla se impone con `eslint-plugin-boundaries` en CI: **si no es un build
que falla, no es una regla, es un comentario.**

**D8 ⬆ — El aislamiento entre despachos lo garantiza Postgres, no el programador.**
Row-Level Security con `FORCE`, rol de aplicación sin privilegios de dueño, y
`SET LOCAL app.tenant_id` por transacción. `WHERE tenant_id = ?` escrito a mano no es
aislamiento: es disciplina, y la disciplina falla una vez y filtra consultas jurídicas
sujetas a secreto profesional.

**D9 ⬆ — Outbox transaccional con consumidor idempotente.** Todo efecto externo (crear el
evento de Google, enviar un mensaje) se escribe en `outbox` dentro de la misma
transacción que el cambio de negocio, y un relay lo publica con
`FOR UPDATE SKIP LOCKED`. La entrega es *at-least-once*: cada efecto lleva
`idempotency_key` y debe tolerar ejecutarse dos veces.

**D10 ⬆ — Un mensaje por conversación a la vez.** Si el usuario manda dos mensajes
seguidos, dos workers cargan el mismo estado y ambos lo escriben. Se serializa con
`singletonKey = conversacion_id` en pg-boss más `SELECT ... FOR UPDATE` sobre la fila de
conversación al inicio del job.

---

## 2. Stack

| Capa | Elección | Por qué |
|---|---|---|
| Lenguaje | TypeScript, Node LTS activa (24/26) | **No Node 22: ya está en mantenimiento.** Se usa `--experimental-strip-types`, sin paso de compilación |
| HTTP | Hono | `Request`/`Response` estándar: `await c.req.text()` da el raw body para la firma HMAC en una línea |
| Panel ⬆ | Hono JSX (SSR) + HTMX | Cero build de frontend, cero bundle, carga en 50 ms. Un panel de 3 usuarios no necesita React |
| BD | Postgres 17 | Índices únicos parciales, transacciones y **RLS** |
| ORM | Drizzle | Migraciones en SQL plano y tipos. **Excepción: la reserva va en SQL crudo (§6)** |
| Cola | pg-boss | Sobre el mismo Postgres. ⬆⬆ Política `key_strict_fifo` con `singletonKey = conversacion_id`: el orden por conversación lo garantiza la cola, no el programador. Alternativa válida: Graphile Worker |
| Validación | Zod 4 | En el borde y en la salida del LLM |
| Tests | Vitest + Postgres real | El test de concurrencia y el de RLS no se pueden hacer con mocks |
| Arquitectura ⬆ | `eslint-plugin-boundaries` | La regla de dependencias como test que falla. ⬆⬆ **Es la única opción: v2 mencionaba también dependency-cruiser, y tener dos sitios donde vive la misma regla es tener cero** |
| LLM | `@anthropic-ai/sdk`, Haiku 4.5 (`claude-haiku-4-5`) | Detrás de un puerto `Clasificador`, intercambiable. ⬆⬆ El identificador va **sin sufijo de fecha**, y Haiku 4.5 no admite `effort` |
| Calendario | `@googleapis/calendar` + `google-auth-library` | El paquete `googleapis` completo trae cientos de MB de tipos inútiles |
| Auth panel ⬆ | Passkeys (`@simplewebauthn/server`) | Para 3 abogados es más simple que gestionar contraseñas y elimina el phishing |
| Logs | pino, con redacción de PII | El `payload` de los mensajes **nunca** al log |
| Errores | Sentry, con `beforeSend` que borra PII | 5.000 eventos/mes gratis |
| TLS | Caddy | Certificado automático |
| Orquestación | Docker Compose | app + postgres + caddy, contenedores non-root |

---

## 3. Estructura del repositorio ⬆

Reorganizada por anillos, no por tipo de archivo. Esto es lo que hace que en tres meses
siga siendo mantenible y que el día que quieras un widget web o Telegram cambies un solo
adaptador.

```
providencia-bot/
├─ CLAUDE.md
├─ .github/workflows/             # ⬆⬆ las cinco comprobaciones, contra Postgres 17
├─ .claude/hooks/                 # ⬆⬆ arranque de sesión: dependencias + base lista
├─ eslint.arquitectura.js         # la regla de anillos, en su propio archivo
├─ docker-compose.yml  Caddyfile  .env.example  drizzle.config.ts
├─ audios/                        # .ogg opus fijos
├─ src/
│  ├─ domain/                     # ANILLO 1 — puro. Cero node_modules salvo tipos
│  │  ├─ agenda/
│  │  │  ├─ Slot.ts               # valor: inicio, fin, abogado
│  │  │  ├─ horarios.ts           # generación de candidatos desde la política
│  │  │  ├─ disponibilidad.ts     # candidatos − citas − bloqueos
│  │  │  ├─ politicas.ts          # duración, buffer, antelación, horizonte
│  │  │  └─ errores.ts            # SlotTomado, YaTieneCita, LimiteMensual
│  │  │  # ⬆⬆ todo el anillo trabaja en milisegundos: no sabe qué es una zona horaria
│  │  ├─ conversacion/
│  │  │  ├─ maquina.ts            # reducer PURO (estado, evento) => {estado, acciones}
│  │  │  ├─ estados.ts            # estados y contexto de la conversación
│  │  │  ├─ acciones.ts           # acciones declarativas y claves de texto
│  │  │  ├─ mensaje.ts            # forma normalizada + intents globales   ⬆⬆
│  │  │  ├─ version.ts            # FLOW_VERSION                          ⬆⬆
│  │  │  └─ reparacion.ts         # contador de fallos y escalado
│  │  └─ tenant/
│  ├─ app/                        # ANILLO 2 — casos de uso
│  │  ├─ puertos/                 # INTERFACES, no implementaciones
│  │  │  ├─ Mensajeria.ts  Calendario.ts  Clasificador.ts  Cola.ts
│  │  │  ├─ RepoCitas.ts  RepoConversaciones.ts  Catalogos.ts
│  │  │  └─ Reloj.ts              # `app` tampoco puede importar `platform`   ⬆⬆
│  │  ├─ content.ts               # TODO el texto de cara al usuario, por tenant ⬆⬆
│  │  ├─ disponibilidad.ts        # huecos libres: 3 consultas y aritmética pura ⬆⬆
│  │  ├─ relayOutbox.ts           # publica los efectos, con arriendo y backoff ⬆⬆
│  │  ├─ efectosGoogle.ts         # manejadores gcal.crear / gcal.borrar      ⬆⬆
│  │  ├─ importarBloqueos.ts      # freeBusy → bloqueos                       ⬆⬆
│  │  ├─ procesarMensajeEntrante.ts
│  │  ├─ reservarCita.ts   cancelarCita.ts   reagendarCita.ts
│  │  ├─ enviarRecordatorios.ts
│  │  └─ exportarDatosContacto.ts   # portabilidad LOPDP
│  ├─ adapters/                   # ANILLO 3 — implementaciones
│  │  ├─ reloj.ts                 # único punto que sabe que existe Cuenca    ⬆⬆
│  │  ├─ google/
│  │  │  └─ calendario.ts         # espejo idempotente por id determinista    ⬆⬆
│  │  ├─ anthropic/
│  │  │  └─ clasificador.ts       # salida estructurada contra lista cerrada ⬆⬆
│  │  ├─ whatsapp/
│  │  │  ├─ esquemas.ts           # Zod del webhook + normalización al dominio
│  │  │  ├─ firma.ts              # X-Hub-Signature-256 sobre el cuerpo crudo
│  │  │  ├─ limites.ts            # truncado a los límites de Meta
│  │  │  ├─ cliente.ts            # envío, con backoff en 429/5xx
│  │  │  └─ media.ts              # ensureFreshMediaId
│  │  ├─ cola/
│  │  │  └─ pgboss.ts             # implementa el puerto Cola              ⬆⬆
│  │  ├─ postgres/
│  │  │  ├─ esquema.ts            # Drizzle: fuente de verdad de tablas e índices
│  │  │  ├─ db.ts                 # pool como app_user
│  │  │  ├─ tenantContext.ts      # enTenant(): transacción + set_config   ⬆⬆
│  │  │  ├─ tipos.ts              # aInstante(): SQL crudo devuelve strings ⬆⬆
│  │  │  ├─ inbox.ts              # dedupe + FOR UPDATE de la conversación
│  │  │  ├─ catalogos.ts          # materias, triaje y agenda por tenant   ⬆⬆
│  │  │  ├─ repoConversaciones.ts # la sesión bloqueada                    ⬆⬆
│  │  │  ├─ tenants.ts            # resolución por wa_phone_number_id
│  │  │  └─ reservas.ts           # la reserva, en SQL crudo
│  │  └─ http/
│  │     ├─ webhook.ts
│  │     └─ panel/                # Hono JSX + HTMX
│  └─ platform/                   # config, logger, crypto, tiempo, cola
└─ tests/
   ├─ domain/                     # rápidos, sin Docker
   ├─ adapters/                   # también rápidos: Zod, truncado, firma, backoff ⬆⬆
   └─ integracion/                # con Postgres real: concurrencia, RLS y cola
```

**Regla de dependencias, en el linter:**

```
domain    → no puede importar de app, adapters, platform, ni de ningún paquete de red
app       → puede importar de domain y de app/puertos. NO de adapters
adapters  → puede importar de app y domain
platform  → hoja: nadie de dominio la importa
```

⬆⬆ **`tenantContext` y `db` viven en `adapters/postgres/`, no en `platform/`.** v2 los ponía
en `platform`, pero ambos tienen que conocer el esquema de Drizzle y `platform` está
declarada hoja. Con la regla puesta en el linter esto deja de ser cuestión de gusto: el
build falla. Cuando una regla y una estructura se contradicen, la que cede es la estructura.

⬆⬆ **`domain/agenda/` no puede importar `platform/time.ts`.** Es la misma regla, y en la
fase 4 va a doler: las funciones puras de disponibilidad necesitan saber en qué día local
cae un instante. La salida es pasarles los datos ya resueltos —el desplazamiento, o las
partes locales— como argumento, no darles acceso al reloj ni al calendario.

---

## 4. Base de datos ⬆⬆

> **v3.** Esta sección se reescribió al implementarla. Las diferencias con v2 están
> recogidas en §4.6, y cada una tiene su test en `tests/integracion/`.

### 4.1 Tablas

```sql
-- Identidad y enrutamiento. ÚNICA tabla sin tenant_id y, por tanto, sin RLS:
-- el webhook resuelve el despacho por wa_phone_number_id ANTES de poder fijar
-- app.tenant_id, y el planificador de jobs necesita recorrer la lista.
-- Por eso aquí no vive ningún secreto.
tenants(id, slug UNIQUE, nombre, tz default 'America/Guayaquil',
        wa_phone_number_id UNIQUE, activo, created_at, updated_at)

-- Configuración y credenciales. Lleva tenant_id, luego va bajo RLS.
tenant_config(tenant_id PK, tarifario jsonb, horarios jsonb,
              wa_waba_id, wa_token_enc, wa_app_secret_enc, updated_at)

abogados(id, tenant_id, nombre, materias text[],
         gcal_calendar_id, gcal_refresh_token_enc, activo,
         created_at, updated_at,
         UNIQUE (tenant_id, id))            -- destino de las FK compuestas

contactos(id, tenant_id, wa_id, nombre, email, cedula,
          consent_at, consent_version, consent_revocado_at,
          bloqueado, anonimizado_at, ultimo_inbound_at,
          created_at, updated_at,
          UNIQUE (tenant_id, wa_id), UNIQUE (tenant_id, id))

conversaciones(id, tenant_id, contacto_id, estado, contexto jsonb,
               flow_version, fallos_consecutivos,
               derivada_at, derivada_motivo,     -- escalado a persona
               cerrada_at, ultimo_inbound_at, expira_at,
               created_at, updated_at,
               UNIQUE (tenant_id, id))

mensajes(id, tenant_id, conversacion_id, wa_message_id,
         direccion, tipo, payload jsonb, created_at)

citas(id, tenant_id, abogado_id, contacto_id, materia, modalidad,
      inicia_at, termina_at, estado, gcal_event_id,
      honorario_usd numeric(10,2),
      confirmada_at, cancelada_por, cancelada_at,
      cita_origen_id,                            -- enlaza el reagendamiento
      created_at, updated_at,
      UNIQUE (tenant_id, id))

reservas_mes(tenant_id, contacto_id, periodo, total, actualizado_at,
             PRIMARY KEY (tenant_id, contacto_id, periodo))

bloqueos(id, tenant_id, abogado_id, inicia_at, termina_at, origen, external_id, created_at)

outbox(id bigint identity, tenant_id, tipo, payload jsonb, idempotency_key,
       intentos, proximo_intento_at, publicado_at, ultimo_error, created_at,
       UNIQUE (tenant_id, idempotency_key))

audios(id, tenant_id, clave, ruta, wa_media_id, subido_at, created_at,
       UNIQUE (tenant_id, clave))

eventos(id bigint identity, tenant_id, actor, tipo, entidad, entidad_id,
        payload jsonb, created_at)                -- auditoría LOPDP
```

Las claves foráneas son **compuestas**, `(tenant_id, id)`, no simples. Así es el motor y
no el programador quien impide que una cita del despacho A apunte a un abogado del
despacho B.

### 4.2 Las restricciones que sostienen la agenda

Las tres son del motor. Ninguna se comprueba leyendo antes de escribir.

```sql
-- 1. Nunca dos citas en el mismo horario con el mismo abogado.
CREATE UNIQUE INDEX citas_slot_unico
  ON citas (tenant_id, abogado_id, inicia_at)
  WHERE estado <> 'cancelada';

-- 2. Máximo una cita activa por contacto (§6). En v2 era una política enunciada;
--    implementarla leyendo primero habría reintroducido la condición de carrera que
--    todo el diseño evita.
CREATE UNIQUE INDEX citas_una_activa_por_contacto
  ON citas (tenant_id, contacto_id)
  WHERE estado IN ('reservada', 'confirmada');

-- 3. A una cita le corresponde como mucho un evento de Google.
CREATE UNIQUE INDEX citas_gcal_event_unico
  ON citas (tenant_id, gcal_event_id)
  WHERE gcal_event_id IS NOT NULL;
```

El tope de **3 reservas por número al mes** no se puede expresar como índice único. Es un
contador con incremento condicional sobre `reservas_mes`:

```sql
INSERT INTO reservas_mes (tenant_id, contacto_id, periodo, total)
VALUES ($1, $2, $3, 1)
ON CONFLICT (tenant_id, contacto_id, periodo)
DO UPDATE SET total = reservas_mes.total + 1, actualizado_at = now()
WHERE reservas_mes.total < 3
RETURNING total
```

Si no devuelve fila, el cupo está agotado. El bloqueo que toma el `DO UPDATE` serializa
los intentos simultáneos, así que tampoco aquí hay ventana entre contar y reservar. El
`periodo` es `YYYY-MM` **en hora local**: una reserva del 31 de enero a las 21:00 en Cuenca
cuenta en enero, no en febrero.

### 4.3 Aislamiento entre despachos: Row-Level Security

```sql
CREATE ROLE app_owner;                 -- migraciones, dueña de las tablas
CREATE ROLE app_user;                  -- la aplicación
CREATE ROLE app_dump BYPASSRLS;        -- solo backups

ALTER TABLE citas ENABLE ROW LEVEL SECURITY;
ALTER TABLE citas FORCE  ROW LEVEL SECURITY;   -- sin FORCE, la dueña la ignora en silencio

CREATE POLICY aislamiento_tenant ON citas
  FOR ALL
  TO PUBLIC                            -- también app_owner, no solo app_user
  USING      (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
```

`TO PUBLIC` y no `TO app_user`: si la política solo alcanzara al rol de la aplicación,
`FORCE` no tendría a qué aplicarse sobre la dueña y el test no podría demostrar nada. El
`NULLIF` evita que un `app.tenant_id` vacío reviente con un error de conversión en mitad
de una consulta de negocio en vez de devolver cero filas.

En la aplicación, **siempre dentro de una transacción** y siempre por `enTenant()`:

```ts
await db.transaction(async (tx) => {
  await tx.execute(sql`SELECT set_config('app.tenant_id', ${tenantId}, true)`);
  // ...todo lo demás
});
```

> **`SET LOCAL app.tenant_id = $1` no existe.** `SET` no admite parámetros enlazados: la
> versión que traía v2 falla con error de sintaxis en cuanto Drizzle la envía como consulta
> parametrizada. La forma parametrizable es `set_config(nombre, valor, true)`, y ese tercer
> argumento es justamente lo que la hace local a la transacción. La otra salida —concatenar
> el uuid en el texto de la sentencia— es una inyección esperando a que alguien pase algo
> que no sea un uuid.

Seis trampas que anulan la RLS:

| Trampa | Qué pasa |
|---|---|
| `SET` en vez de `SET LOCAL` / `set_config(..., true)` | Con pool de conexiones el valor se filtra a la petición siguiente. |
| App conectada como dueña de la tabla | Las políticas se ignoran en silencio. Por eso existe `app_user`. |
| Falta `FORCE ROW LEVEL SECURITY` | Mismo efecto que el anterior. |
| `current_setting('app.tenant_id')` sin el segundo argumento | Lanza excepción si no está seteado. Siempre la forma de dos argumentos. |
| `pg_dump` con el rol normal | Exporta **cero filas**. El backup usa `app_dump` con `BYPASSRLS`. |
| ⬆⬆ Índice único **global** sobre una tabla con `tenant_id` | Se evalúa por debajo de la RLS: la fila en conflicto es invisible y `ON CONFLICT DO NOTHING` descarta un dato legítimo de otro despacho sin dejar rastro. Ver §4.4. |

La migración `0001_rls.sql` termina con una comprobación que hace **fallar la migración**
si alguna tabla con `tenant_id` se quedó sin `ENABLE` y `FORCE`. Añadir una tabla y
olvidar la política deja de ser un agujero silencioso.

### 4.4 ⬆⬆ Ninguna restricción UNIQUE cruza despachos

Todo índice único sobre una tabla multi-tenant empieza por `tenant_id`:

```sql
-- Patrón inbox. NO `UNIQUE (wa_message_id)` a secas, como traía v2.
CREATE UNIQUE INDEX mensajes_wa_id_unico
  ON mensajes (tenant_id, wa_message_id)
  WHERE wa_message_id IS NOT NULL;
```

Dos motivos, y el segundo es el importante:

1. Los mensajes salientes no tienen `wa_message_id` hasta que Meta responde al envío, así
   que el índice tiene que ser parcial.
2. Un índice único **global** se sigue evaluando por debajo de la RLS. Si el despacho A ya
   tiene `wamid.X` y llega `wamid.X` para el despacho B, el `INSERT ... ON CONFLICT DO
   NOTHING` choca con una fila que B no puede ver, no inserta nada, y el webhook concluye
   que era un duplicado. Resultado: un mensaje real descartado en silencio, sin error y sin
   log. Lo mismo valía para `outbox.idempotency_key`, ahora `UNIQUE (tenant_id,
   idempotency_key)`.

La regla «todo índice empieza por `tenant_id`» tiene **una excepción declarada**: las claves
primarias subrogadas (`citas.id`, `outbox.id`…). Son únicas globalmente y solo se usan para
búsquedas puntuales por id, nunca para recorrer. Todo lo demás la cumple, y hay un test que
lo comprueba leyendo `pg_index`.

También es único por tenant, y por el mismo motivo, el que impide dos conversaciones
abiertas para un mismo contacto:

```sql
CREATE UNIQUE INDEX conversaciones_abierta_unica
  ON conversaciones (tenant_id, contacto_id)
  WHERE cerrada_at IS NULL;
```

Sin él, dos mensajes simultáneos de un usuario nuevo abren dos conversaciones y la
serialización por `singletonKey = conversacion_id` (D10) deja de serializar nada.

### 4.5 Versionado del flujo

`conversaciones.flow_version` se fija al abrir la conversación y se compara con una
**constante del código**, no con una columna de `tenants`. v2 tenía `flow_version` en las dos
tablas sin decir cuál mandaba; para tres abogados no hay motivo para versionar el guion por
despacho, y dos fuentes de verdad para lo mismo es justo lo que este campo existe para
evitar. Si no coincide, la conversación se reinicia limpiamente al menú con un mensaje
("actualizamos el asistente, volvamos a empezar"), nunca con un error.

### 4.6 ⬆⬆ Qué cambió respecto de v2, y por qué

| Cambio | Motivo |
|---|---|
| `UNIQUE (wa_message_id)` → `(tenant_id, wa_message_id)`, parcial | Un único global se evalúa bajo la RLS y descarta mensajes legítimos de otro despacho (§4.4). Igual en `outbox.idempotency_key`. |
| `citas_slot_unico` ahora empieza por `tenant_id` | La propia regla del proyecto: la política de RLS es el primer predicado del plan. |
| Nuevo índice `citas_una_activa_por_contacto` | «1 cita activa por contacto» era una política sin restricción: obligaba a consultar antes de insertar. |
| Nueva tabla `reservas_mes` | Ídem para «3 reservas por `wa_id` al mes». |
| `tenants` partida en `tenants` + `tenant_config` | `tenants` no puede llevar RLS (el webhook la consulta antes de saber el tenant). Los secretos y el tarifario se van a una tabla que sí la lleva. |
| Claves foráneas compuestas `(tenant_id, id)` | Impiden que una cita apunte a un abogado de otro despacho. |
| `honorario_usd` → `numeric(10,2)` | Dinero en coma flotante, nunca. |
| `citas.estado` gana `atendida` y `ausente` | §9 pide tasa de ausencias y no había estado donde registrarla. |
| Nuevos `confirmada_at`, `cita_origen_id` | El recordatorio con botones y el reagendamiento necesitan dónde apuntar el resultado. |
| Nuevos `derivada_at`, `derivada_motivo` | La bandeja del panel (§9) necesita consultar las conversaciones escaladas sin recorrer todas. |
| Nuevos `consent_revocado_at`, `anonimizado_at` | LOPDP: retirar el consentimiento y la anonimización de la fase 6. |
| `materias` sigue siendo `text[]`, no un enum | Cada despacho define las suyas en `tenant_config.tarifario`. Un enum de Postgres convertiría al cliente #2 con otra materia en una migración. |
| `conversaciones.estado` sigue siendo `text` | Los estados de §5 cambian con la máquina; `flow_version` ya es el mecanismo previsto para eso. |
| `outbox.id` y `eventos.id` son `bigint` | Tablas de crecimiento indefinido. |
| La política de RLS es `TO PUBLIC` | Para que `FORCE` tenga efecto demostrable sobre la dueña de las tablas. |
| `0001_rls.sql` termina comprobando que no queda ninguna tabla sin proteger | Olvidar la política en una migración futura falla en vez de abrir un agujero. |


---

## 5. Máquina de estados ⬆

```
INICIO
  └─ primer mensaje ──► CONSENTIMIENTO            [texto + audio bienvenida]
        ├─ Acepto        ──► MENU
        └─ No acepto     ──► DESPEDIDA

MENU                                               [lista: 5 materias + persona]
  ├─ materia 1..5   ──► TRIAJE
  └─ persona        ──► DERIVAR_HUMANO

TRIAJE   2–3 preguntas cerradas ──► TARIFA         [texto + audio + honorario]
  ├─ Agendar        ──► ¿tiene cita activa?
  │                       ├─ sí ──► CITA_EXISTENTE  [ver | reagendar | cancelar]  ⬆
  │                       └─ no ──► MODALIDAD
  └─ Solo consultaba──► CIERRE_SIN_CITA

MODALIDAD [botones] ──► ELEGIR_DIA ──► ELEGIR_HORA ──► DATOS ──► CONFIRMAR ──► CITA_OK

⬆⬆ CONFIRMAR **no salta directo a CITA_OK**: emite la acción `reservar` y espera. La
   reserva puede perder la carrera por el horario (§6), así que el caso de uso devuelve
   `citaReservada` —y entonces sí, CITA_OK— u `horarioOcupado`, que recalcula y vuelve a
   ELEGIR_HORA. Dar la cita por hecha antes de que el índice único la conceda es
   justamente la doble reserva que todo el diseño evita.

DATOS ⬆   un solo WhatsApp Flow estático (nombre, correo, cédula opcional)
          en vez de tres preguntas seguidas

CANCELAR_CITA  ⬆   [lista de citas activas → confirmar → libera el slot + borra el evento]
REAGENDAR      ⬆   [cancelar + ELEGIR_DIA en un solo paso]

DERIVAR_HUMANO ⬆⬆  el bot se calla. Deja de responder en esa conversación, la marca con
                   `derivada_at` y `derivada_motivo`, y aparece en la bandeja del panel
                   (§9). Si el usuario sigue escribiendo, los mensajes se guardan pero no se
                   contestan: nada peor que un bot insistiendo después de admitir que no
                   entiende. Vuelve a manos del bot solo si un abogado lo reactiva.

Intents globales: "menu"/"0" ──► MENU · "cancelar" ──► CANCELAR_CITA · "persona" ──► DERIVAR_HUMANO

NO_ENTIENDO ⬆   contador de fallos consecutivos:
  1.er fallo → reformula corto
  2.º fallo  → da un ejemplo concreto de respuesta válida
  3.er fallo → DERIVAR_HUMANO, sin excepción

SESION_EXPIRADA ⬆  >24 h sin actividad: se cerró la ventana de servicio.
                   Al volver, empieza de nuevo (no se puede escribir gratis fuera de ella).
```

`domain/conversacion/maquina.ts` es una **función pura**. Ninguna llamada de red ni de
base de datos adentro. Las `acciones` son objetos declarativos que ejecuta el caso de uso
después. Así se testea la conversación completa sin Docker y sin WhatsApp.

---

## 6. El motor de agenda ⬆⬆

| Parámetro | Valor |
|---|---|
| Duración | 45 min |
| Buffer | 15 min (paso efectivo 60 min) |
| Antelación mínima | 3 h |
| Horizonte | 14 días |
| Máx. opciones por lista | 10 (límite de WhatsApp) |
| Máx. citas activas por contacto | 1 — `citas_una_activa_por_contacto` (§4.2) |
| Máx. reservas por `wa_id` al mes | 3 — contador `reservas_mes` (§4.2). ⬆⬆ **Reagendar no gasta cupo** |
| Zona horaria | America/Guayaquil (UTC−5, sin DST) |

Las dos últimas filas eran políticas enunciadas en v2. Ahora son restricciones: ningún
límite del sistema se comprueba consultando antes de escribir.

### La reserva, en SQL crudo

Drizzle tiene un bug abierto desde 2023 (issue #1628): `onConflictDoNothing` con índice
**parcial** genera SQL inválido — coloca el `WHERE` después del `DO NOTHING`. El motivo de
fondo es mejor que el bug: la única consulta de la que depende la corrección del sistema no
debería depender de que un ORM la traduzca bien.

```ts
export async function reservar(tx: Tx, input: ReservaInput): Promise<CitaReservada> {
  const periodo = periodoMensual(input.iniciaAt);      // YYYY-MM en hora local

  // 1. Cupo mensual. Va primero: rechaza al spam antes de tocar el índice caliente.
  const cupo = await tx.execute(sql`
    INSERT INTO reservas_mes (tenant_id, contacto_id, periodo, total)
    VALUES (${input.tenantId}::uuid, ${input.contactoId}::uuid, ${periodo}, 1)
    ON CONFLICT (tenant_id, contacto_id, periodo)
    DO UPDATE SET total = reservas_mes.total + 1, actualizado_at = now()
    WHERE reservas_mes.total < ${LIMITE_RESERVAS_MES}
    RETURNING total
  `);
  if (cupo.rows.length === 0) throw new LimiteMensualError(LIMITE_RESERVAS_MES);

  // 2. Horario libre.
  let cita;
  try {
    cita = await tx.execute(sql`
      INSERT INTO citas (tenant_id, abogado_id, contacto_id, materia, modalidad,
                         inicia_at, termina_at, estado, honorario_usd)
      VALUES (${input.tenantId}::uuid, ${input.abogadoId}::uuid, ${input.contactoId}::uuid,
              ${input.materia}, ${input.modalidad}::modalidad,
              ${input.iniciaAt}, ${input.terminaAt}, 'reservada', ${input.honorarioUsd}::numeric)
      ON CONFLICT (tenant_id, abogado_id, inicia_at) WHERE estado <> 'cancelada'
      DO NOTHING
      RETURNING id, inicia_at, termina_at
    `);
  } catch (error) {
    // 3. Una cita activa por contacto. NO se puede inferir en el mismo ON CONFLICT
    //    (Postgres admite un solo árbitro), así que llega como 23505.
    if (esViolacionUnica(error, 'citas_una_activa_por_contacto')) throw new YaTieneCitaError();
    throw error;
  }
  const fila = cita.rows[0];
  if (fila === undefined) throw new SlotTomadoError();

  await tx.execute(sql`
    INSERT INTO outbox (tenant_id, tipo, payload, idempotency_key)
    VALUES (${input.tenantId}::uuid, 'gcal.crear',
            ${JSON.stringify({ citaId: fila.id })}::jsonb, ${'gcal.crear:' + fila.id})
    ON CONFLICT (tenant_id, idempotency_key) DO NOTHING
  `);

  return { id: fila.id, iniciaAt: fila.inicia_at, terminaAt: fila.termina_at };
}
```

Nunca `SELECT` de disponibilidad seguido de `INSERT`. Los índices garantizan la exclusión;
el código solo maneja el fallo. Al capturar `SlotTomadoError` el bot dice *"ese horario se
acaba de ocupar, elija otro"* y vuelve a `ELEGIR_HORA` recalculado.

Tres detalles que v2 traía mal y cuestan una tarde de depuración cada uno:

- **`tx.execute` no devuelve un array.** Con `node-postgres` devuelve un `QueryResult`: se
  lee `resultado.rows`, no `resultado.length` ni `resultado[0]`.
- **El error de Postgres viene envuelto.** Drizzle lo mete dentro de un `Error` propio cuyo
  mensaje es «Failed query: ...», así que `code` y `constraint` están en `error.cause` y no
  en el error que se recibe. Mirar solo el primer nivel hace que una violación de
  restricción se escape como error genérico y acabe en un 500 en vez de en su rama del
  guion.
- **`ON CONFLICT` admite un solo árbitro.** Las dos restricciones de `citas` no caben en la
  misma cláusula: una se infiere, la otra se captura por SQLSTATE y nombre de restricción.

La transacción es una sola, así que un rechazo en el paso 2 devuelve el cupo que consumió
el paso 1. Hay un test para eso.

### ⬆⬆ Cómo se calculan los huecos

`domain/agenda/` trabaja en **milisegundos** y no sabe qué es una zona horaria. El
adaptador convierte el horario semanal del despacho —«los martes de 09:00 a 13:00»— en
ventanas UTC para cada uno de los próximos 14 días; el dominio hace el resto con aritmética
de intervalos. Por eso el motor entero se prueba sin Docker y sin depender del reloj de la
máquina, y por eso una cita a las 23:30 locales cae en el día local correcto aunque en UTC
ya sea el día siguiente.

`app` **tampoco** puede importar `platform`: la regla de anillos vale igual para los dos.
La conversión entre día local e instante entra por el puerto `Reloj`, y su única
implementación es el único punto del proyecto que menciona America/Guayaquil.

El buffer se aplica **alrededor de lo ocupado**, no solo entre candidatos: una cita antigua
a las 14:30, fuera de la rejilla actual, sigue protegiendo su descanso. Con la rejilla de 60
minutos eso no descarta huecos legítimos —una cita de 14:00 a 14:45 más 15 de buffer llega
justo a las 15:00, que es el candidato siguiente—.

La lista de huecos es **informativa y no se cachea**. Se intentó memorizarla unos segundos
y estaba mal: justo después de perder la carrera por un horario, el guion vuelve a
ELEGIR_HORA y tiene que ofrecer una lista fresca; con caché reaparecía el hueco recién
ocupado y el usuario podía elegirlo otra vez, en bucle. Lo que sí se memoriza es la
configuración del despacho, que no cambia a mitad de una conversación.

### Si Google Calendar se cae

La cita **se guarda igual**. Postgres es la fuente de verdad. El job `gcal.crear` reintenta
con backoff exponencial; tras 5 intentos fallidos alerta al estudio por correo. Nunca se
bloquea una reserva por un servicio externo.

### Reagendar

Cancelar y volver a reservar, **en una sola transacción**. El `UPDATE ... SET estado =
'cancelada'` saca la fila del índice parcial antes de que se compruebe la nueva, así que la
restricción de «una cita activa» no choca consigo misma. `cita_origen_id` enlaza ambas para
poder medir cuánta gente reagenda en vez de ausentarse.

⬆⬆ Dos decisiones que v2 no resolvía:

- **No hay `reagendarCita.ts`.** Reagendar es `reservarCita` con `citaOrigenId`: separarlo
  en dos casos de uso invitaría justo al error que hay que evitar —cancelar primero y
  quedarse sin cita si la reserva falla—. Si el horario nuevo se ocupa, el rollback devuelve
  la cita original intacta, y hay un test para eso.
- **Reagendar no gasta cupo mensual.** Mover una cita no es pedir otra: cobrarle cupo
  dejaría fuera a quien reagenda dos veces, que es justamente el usuario que sí avisa en vez
  de no presentarse. Cancelar y volver a reservar más tarde sí lo gasta, porque eso sí es
  una reserva nueva.


---

## 7. ⬆ Seguridad, mapeada contra OWASP Top 10:2025

| Riesgo | Aplicación concreta aquí |
|---|---|
| **A01 Broken Access Control** | RLS con `FORCE` (§4.3). En el panel, todo se filtra por el tenant de la sesión, jamás por un id de la URL |
| **A02 Security Misconfiguration** | Contenedores non-root y `read_only`; Postgres sin puerto publicado; `NODE_ENV=production`; cabeceras de seguridad en Caddy |
| **A03 Software Supply Chain** | `npm ci` con lockfile, versiones exactas, `--ignore-scripts`, `npm audit` en CI, Renovate. Revisar toda dependencia nueva antes de añadirla |
| **A04 Cryptographic Failures** | AES-256-GCM para tokens, clave en env fuera del repo; TLS 1.2+; ningún token en logs |
| **A05 Injection** | Todo parametrizado, incluido el SQL crudo de la reserva. Zod en el borde |
| **A06 Insecure Design** | El bot no consulta expedientes ni da criterio jurídico: no es una restricción de producto, es una superficie de ataque que no existe |
| **A07 Authentication Failures** | Passkeys en el panel; cookie `httpOnly` + `SameSite=Strict`; rate limit en el login |
| **A08 Data Integrity Failures** | Firma HMAC del webhook comparada con `crypto.timingSafeEqual`, **nunca con `===`** |
| **A09 Logging & Alerting Failures** | No basta con loguear: hay que **alertar**. Las cuatro alertas están en §9 |
| **A10 Mishandling of Exceptional Conditions** | Comportamiento definido para: Google caído, Meta 429, JSON inválido del LLM, audio de 15 MB, slot tomado, sesión expirada |

### Amenazas propias de este sistema

1. **Enumeración de agenda.** Cualquiera con WhatsApp puede mapear cuándo está libre el
   abogado. Mitigación: máximo 10 slots visibles, nunca el calendario completo, y rate
   limit por `wa_id`.
2. **Spam de reservas.** Mitigación: 1 cita activa por contacto, 3 reservas por número al
   mes, confirmación obligatoria, campo `contactos.bloqueado`.
3. **Suplantación.** El `wa_id` es solo un número; nadie verifica identidad. Suficiente
   para agendar, **insuficiente para cualquier cosa del expediente**. El bot no puede
   consultar casos: eso es una regla de seguridad, no una decisión de alcance.
4. **Inyección de prompt.** El clasificador devuelve un enum validado con Zod contra una
   lista cerrada; su texto libre nunca se reenvía al usuario y no tiene herramientas.
   *El LLM clasifica, no redacta.*
5. **PII en logs y en Sentry.** Los mensajes llevan consultas jurídicas. `payload`,
   `nombre`, `email` y `cedula` se redactan en pino y se borran en el `beforeSend` de
   Sentry. Un stack trace con el texto de una consulta de familia es una brecha.

---

## 8. ⬆ UX conversacional: cómo no sonar a bot genérico

El bot genérico se reconoce al instante: *"¡Hola! 👋 Soy tu asistente virtual, ¿en qué
puedo ayudarte hoy?"*, emojis decorativos en cada mensaje, párrafos largos, y
*"No entendí tu mensaje, por favor intenta de nuevo"* en bucle infinito.

### Reglas de estilo, en `content.ts` y en la revisión de cada texto

- **Usted**, nunca tú. Es un estudio jurídico.
- **Máximo dos frases por turno.** El usuario imita el registro del bot: si tú escribes
  párrafos, él escribe párrafos y el clasificador se complica.
- **Solo el mensaje de confirmación de la cita lleva emoji.** Ninguno más. ⬆⬆ Es una
  propiedad de los textos de `content.ts`, no un contador en tiempo de ejecución: ningún
  otro texto del flujo contiene emojis, así que no hay estado que persistir. Consecuencia
  aceptada: quien reagenda ve dos confirmaciones y, por tanto, dos emojis. La alternativa
  —llevar la cuenta por conversación— es estado persistido para ahorrar un emoji.
- **Preguntas accionables, no de sí/no.** "¿Qué día le queda mejor?" en vez de "¿Desea
  agendar una cita?".
- **Confirmación explícita solo de lo crítico**: fecha, hora y modalidad. La materia se
  confirma implícitamente ("Perfecto, laboral.").
- Prohibidas: "asistente virtual", "¿en qué puedo ayudarte?", "lo siento, no entendí",
  "por favor intenta de nuevo".

### Reparación escalonada — máximo tres fallos

Es el estándar de la industria (Google lo fija explícitamente en sus guías de diseño
conversacional) y es lo que separa un bot usable de uno que la gente abandona:

| Fallo | Respuesta |
|---|---|
| 1.º | Reformula corto, con otras palabras |
| 2.º | Da un ejemplo concreto de respuesta válida |
| 3.º | Deriva a una persona. **Sin excepción, sin cuarto intento** |

### ⬆ WhatsApp Flow estático para la captura de datos

Tres preguntas seguidas (nombre → cédula → correo) es donde más gente abandona. Un
**Flow estático** presenta un formulario de una sola pantalla dentro del chat, la
respuesta llega en el `nfm_reply` del webhook, y **no requiere endpoint ni cifrado**.

Deliberadamente **no** usamos un Flow con endpoint de datos: eso exige cifrado híbrido
RSA-OAEP-SHA256 más AES-128-GCM, health check con `ping`, y HTTP 421 en fallo de
descifrado. Para elegir horario seguimos con listas interactivas, que sí necesitan datos
en vivo y son más simples.

### El recordatorio lleva botones

*Confirmar* / *Cancelar* / *Reagendar*. Reduce ausencias, y la tasa de ausencias es la
métrica que el estudio va a mirar para decidir si renueva.

---

## 9. ⬆ Panel: una bandeja, no un tablero

Los tableros informan; las herramientas internas **habilitan acción**. Para tres abogados,
un gráfico de conversaciones por semana no lo abre nadie dos veces.

**Pantalla principal: "Hoy y mañana".** Dos bloques:

1. Citas de hoy y mañana, con la ficha del contacto desplegable en línea.
2. Conversaciones que pidieron una persona o que escalaron por tres fallos.

**Reglas de diseño:**

- Toda tarea real en 2–3 clics: ver la ficha del que viene ahora, cancelar, reagendar,
  leer una conversación trabada.
- Densidad alta, tabla, buscador arriba. Sin menús anidados.
- **Deshacer en vez de modal de confirmación**: cancelar una cita muestra un aviso con
  "Deshacer" durante 10 segundos. Menos fricción y menos errores que un "¿Está seguro?".
- Navegable por teclado, contraste WCAG AA.
- **Nada de plantilla de admin comprada.** Hono JSX server-side + HTMX: sin build de
  frontend, sin bundle, carga en 50 ms.

### Las cuatro alertas

1. `/health` cae (verifica Postgres y pg-boss de verdad, no un 200 vacío).
2. La `outbox` tiene entradas con más de 15 minutos sin publicar.
3. Tasa de error de la API de WhatsApp por encima del 5% en 10 minutos.
4. **Silencio anómalo:** cero mensajes entrantes en 24 h cuando el promedio es mayor.
   Este es el fallo que nadie detecta hasta que el cliente llama enojado.

### Métricas de producto, no de sistema

Sin esto no puedes mejorar el guion ni justificar la mensualidad: tasa de finalización
del flujo, en qué estado abandonan, citas agendadas por cada 100 conversaciones,
porcentaje de derivaciones a humano, y tasa de ausencias.

---

## 10. Trampas conocidas

1. Verificar `X-Hub-Signature-256` contra el **cuerpo crudo**, con `timingSafeEqual`.
2. Responder 200 antes de procesar.
3. Deduplicar por `wa_message_id` (patrón inbox).
4. **Los `media_id` caducan a los 30 días.** Job diario que re-suba los de más de 25.
5. Nota de voz real: `.ogg` con códec **OPUS** y `"voice": true`.
6. Listas: máx. 10 filas. Botones: máx. 3. Título de fila ≤24 caracteres. Truncar en código.
7. Ventana de 24 h: dentro todo es gratis, incluidas las plantillas de utilidad.
8. Las plantillas necesitan aprobación de Meta: pedirlas en la fase 0.
9. Google Calendar con Gmail gratuito: OAuth con refresh token, no cuenta de servicio.
10. Cifrar tokens con AES-256-GCM. Nunca en claro en la BD ni en logs.
11. Guardar UTC, formatear en America/Guayaquil. Test de una cita a las 23:30 local.
12. ⬆ `SET LOCAL`, nunca `SET`. Y `FORCE ROW LEVEL SECURITY` en todas las tablas.
13. ⬆ `pg_dump` necesita el rol `app_dump` con `BYPASSRLS` o exporta cero filas.
14. ⬆ Serializar por conversación (`singletonKey`), o dos mensajes seguidos corrompen el estado.
15. ⬆⬆ `SET LOCAL app.tenant_id = $1` **no existe**: `SET` no admite parámetros enlazados.
    Es `set_config('app.tenant_id', $1, true)`.
16. ⬆⬆ Ningún índice único global sobre tablas con `tenant_id`: se evalúa por debajo de la
    RLS y `ON CONFLICT DO NOTHING` descarta en silencio datos legítimos de otro despacho.
17. ⬆⬆ `tx.execute` devuelve un `QueryResult`, no un array: se lee `.rows`.
18. ⬆⬆ El error de Postgres viene envuelto por Drizzle: `code` y `constraint` están en
    `error.cause`, no en el error que se recibe.
19. ⬆⬆ `timingSafeEqual` **lanza** si los búferes miden distinto. Comprobar la longitud
    antes, o un 401 se convierte en un 500.
20. ⬆⬆ Deduplicar antes de encolar no es un solo round-trip: hay que resolver contacto y
    conversación primero, porque `mensajes.conversacion_id` es obligatorio y el
    `singletonKey` lo necesita. Son tres sentencias, no una; caben de sobra en el segundo.
21. ⬆⬆ **En SQL crudo, `timestamptz` y `numeric` llegan como `string`.** Drizzle desactiva
    los analizadores de node-postgres, así que tipar la columna como `Date` compila y
    revienta en la primera llamada a `.getTime()`. Pasa por `aInstante()`, y lleva a SQL
    toda comparación de tiempo que quepa: además quita la deriva entre relojes.
22. ⬆⬆ Nada de backticks dentro de una plantilla ``sql`...` ``, ni siquiera en comentarios
    SQL: cierran el literal de JavaScript.
23. ⬆⬆ pg-boss necesita crear y particionar sus propias tablas. Su esquema se crea en el
    aprovisionamiento y **pertenece a `app_user`**; la aplicación arranca con
    `createSchema: false`. La alternativa era dar `CREATE` sobre la base a `app_user`.
24. ⬆⬆ El HMAC va sobre los **bytes** del cuerpo (`arrayBuffer`), no sobre el texto
    reserializado: en cuanto hay un acento, deja de cuadrar.
25. ⬆⬆ El identificador del modelo es `claude-haiku-4-5`, **sin sufijo de fecha**. Y Haiku
    4.5 no admite `output_config.effort`: pasarlo es un error.
26. ⬆⬆ Renovar `expira_at` en el webhook hace que el trabajador nunca vea la ventana
    vencida —la acaba de refrescar el propio webhook— y `SESION_EXPIRADA` no dispara jamás.
    La ventana la renueva el trabajador, después de haber leído si expiró.
27. ⬆⬆ Arrancar el servidor con una guardia sobre `NODE_ENV` levanta un proceso de verdad
    en cuanto alguien importa el módulo. La guardia correcta compara `import.meta.url` con
    `process.argv[1]`.
28. ⬆⬆ Dentro de una plantilla ``sql`...` `` de Drizzle, un array se expande a una lista de
    parámetros separados por comas. Para pasar un `uuid[]` de verdad hace falta
    `sql.param([...ids])`, o Postgres recibe el primer elemento suelto.
29. ⬆⬆ Un `UPDATE` como `app_owner` **sin** fijar `app.tenant_id` no toca ninguna fila y no
    avisa: con FORCE RLS, el dueño también está sujeto a la política. Vale también para los
    scripts de mantenimiento y para los ayudantes de los tests.
30. ⬆⬆ Cachear la disponibilidad rompe la recuperación del horario ocupado: la lista que se
    vuelve a ofrecer tiene que ser fresca. La configuración del despacho sí se memoriza.
31. ⬆⬆ La máquina guarda el id de la opción **sin interpretarlo**, así que en el contexto
    puede acabar cualquier cosa. Quien produjo esos ids es quien valida su forma al leerlos;
    si no, un botón viejo llega al formateador de fechas y tumba el turno.
32. ⬆⬆ `ALTER ROLE ... PASSWORD $1` **tampoco existe**: como `SET`, esta sentencia no admite
    parámetros enlazados. Se escapa con `escapeLiteral`, no concatenando comillas: una
    contraseña con un apóstrofo convertiría eso en una inyección.
33. ⬆⬆ Desde Node 24 la elisión de tipos no necesita `--experimental-strip-types`, y
    `--env-file=.env` revienta si el archivo no existe. En CI se usa `--env-file-if-exists`.
34. ⬆⬆ El id de un evento de Google es base32hex (`[a-v0-9]`, de 5 a 1024). Un uuid sin
    guiones sirve; uno con mayúsculas o con `w`–`z`, no.
35. ⬆⬆ Nunca mantener una transacción abierta durante una llamada de red. El outbox se
    reclama con arriendo: `FOR UPDATE SKIP LOCKED` para repartir y `proximo_intento_at` al
    futuro para reservar, todo en una sentencia.
36. ⬆⬆ El relay no puede ver la `outbox` de todos los despachos: bajo RLS no existe esa
    consulta. Recorre `tenants` —la única tabla sin RLS— y reclama despacho por despacho.
37. ⬆⬆ Un trabajo programado con una cola normal apila pasadas: si tarda más que su
    intervalo, la siguiente se encola encima. La política `exclusive` de pg-boss deja una
    sola en cola o activa. Y `missed: 'once'` recupera la cita perdida sin mandar una por
    cada ocurrencia que el proceso estuvo caído.
38. ⬆⬆ Los botones de una plantilla de WhatsApp se casan por **índice**, no por nombre. El
    `payload` que viaja en cada uno es el identificador que la máquina de estados recibirá
    de vuelta.
39. ⬆⬆ El job diario de retención no puede anonimizar a quien tiene una cita futura: la
    agenda del día siguiente quedaría con un contacto sin nombre.

---

## 11. Plan de construcción

### Fase 0 bis — Verificación continua ⬆⬆

> `.github/workflows/verificacion.yml` corre en cada push. Dos trabajos: el rápido
> —tipos, estilo, regla de anillos, dominio y `npm audit` de producción— responde en menos
> de un minuto; el de integración levanta **Postgres 17**, aprovisiona, migra y corre
> concurrencia, RLS y agenda. Hasta aquí las fases se validaron contra Postgres 16 local
> por falta de acceso al registro de imágenes; CI cierra esa salvedad.
>
> `.claude/hooks/session-start.sh` deja cualquier sesión remota lista: dependencias
> instaladas y un Postgres con el esquema aplicado, de modo que `npm run test:integration`
> funciona sin preparar nada a mano.

**Aceptación:** un push con la regla de anillos rota, un test en rojo o una vulnerabilidad
alta en una dependencia de producción deja el check en rojo.

### Fase 0 — Preparación manual

- [ ] Meta Business verificado (1–3 días hábiles). **Ruta crítica: empieza hoy.**
- [ ] App en Meta for Developers, número registrado, token de sistema permanente, app secret.
- [ ] Plantillas a aprobación: `confirmacion_cita`, `recordatorio_cita` (con botones).
- [ ] **Flow estático de captura de datos** creado y publicado. ⬆
- [ ] Google Cloud: Calendar API, credenciales OAuth, 3 correos como usuarios de prueba.
- [ ] Hetzner CX23, subdominio, `cloudflared` para desarrollo local.
- [ ] Audios grabados por el abogado y convertidos:
      `ffmpeg -i in.m4a -c:a libopus -b:a 32k out.ogg`

### Fase 1 — Esqueleto, anillos y RLS ⬆

> Proyecto TypeScript con Node LTS, Hono, Drizzle sobre Postgres 17, Zod 4, Vitest.
> Estructura por anillos según §3. Configura `eslint-plugin-boundaries` con la regla de
> dependencias de §3 y hazla fallar el build. Implementa `platform/config.ts` (Zod),
> `platform/crypto.ts` (AES-256-GCM), `platform/time.ts` (America/Guayaquil) y
> `platform/tenantContext.ts` (envuelve toda operación en transacción con
> `SET LOCAL app.tenant_id`). Esquema Drizzle de §4 más las migraciones SQL de RLS de
> §4.3, con los tres roles. `docker-compose.yml` con contenedores non-root y Postgres sin
> puerto publicado.

**Aceptación:** un import de `adapters` desde `domain` rompe el lint, y un import de
cualquier paquete de `node_modules` desde `domain` también. El test de RLS demuestra que con
el tenant B no se ve nada de A, que sin tenant fijado no se ve nada, que `FORCE` alcanza a la
dueña de las tablas y que `app_dump` sí lo ve todo. `EXPLAIN ANALYZE` muestra index scan, y
un test lee `pg_index` para comprobar que ningún índice de escaneo sobre tablas multi-tenant
empieza por algo que no sea `tenant_id`.

**Estado: hecha.** 13 tests de dominio y 24 de integración en verde.

### Fase 2 — WhatsApp y webhook

> Esquemas Zod de los webhooks (text, button_reply, list_reply, `nfm_reply` del Flow,
> audio, status). `webhook.ts`: GET de verificación; POST que captura raw body, verifica
> la firma con `timingSafeEqual`, deduplica por `wa_message_id`, encola con
> `singletonKey = conversacion_id` y responde 200 en <1 s.
> Adaptador `whatsapp/` con `sendText`, `sendList`, `sendButtons`, `sendAudio`
> (`voice: true`), `sendTemplate`, `sendFlow`, con backoff en 429/5xx y truncado a los
> límites. `media.ts` con `ensureFreshMediaId`.

**Aceptación:** firma alterada devuelve 401 (y una cabecera con basura también, no un
500); payload repetido no se duplica ni se vuelve a encolar; el mismo `wa_message_id` en
otro despacho **no** se descarta; dos mensajes seguidos del mismo usuario comparten
`singletonKey` y se procesan en orden y sin solaparse; un usuario nuevo que manda dos
mensajes a la vez abre una sola conversación.

**Estado: hecha.** 56 tests rápidos y 46 de integración en verde.

> ⬆⬆ **Orden de la verificación de firma.** El secreto está guardado por despacho, así que
> hay que leer el `phone_number_id` del cuerpo *antes* de poder verificar nada. Es seguro
> porque de ese cuerpo no autenticado solo se lee ese campo, con un esquema diminuto, y no
> se escribe nada hasta que la firma cuadra: lo único que puede provocar un desconocido es
> una búsqueda por índice en `tenants`.

> ⬆⬆ **`@hono/node-server` no está instalado.** No figura en el stack de §2 y la regla es
> preguntar antes de añadir dependencias, así que el puente con `node:http` está escrito a
> mano en `adapters/http/servidor.ts`. Son treinta líneas y el webhook se prueba por
> `app.fetch`, sin servidor. Conviene revisarlo cuando llegue el panel de la fase 7.

### Fase 3 — Dominio conversacional

> `domain/conversacion/maquina.ts` como reducer puro según §5, con `reparacion.ts`
> (contador de fallos y escalado al tercero) y versionado de flujo. `content.ts` con
> todos los textos siguiendo las reglas de estilo de §8. `Clasificador` como **puerto**;
> el adaptador de Anthropic devuelve un enum validado con Zod contra lista cerrada.
> Caso de uso `procesarMensajeEntrante` en `app/`.

**Aceptación:** un test recorre INICIO → CITA_OK sin red ni Docker. Otro comprueba que al
tercer fallo deriva a humano, que el contador se reinicia al acertar (son *consecutivos*) y
que después de derivar el bot deja de responder. Un intento de inyección de prompt devuelve
`null`, no texto. Y un test recorre `content.ts` entero verificando las reglas de §8 —usted,
dos frases, frases prohibidas, un único emoji y solo en la confirmación— con detectores que
se comprueban a sí mismos.

**Estado: hecha.** 103 tests rápidos y 49 de integración en verde.

> ⬆⬆ **El clasificador necesita una salida de escape.** El esquema de salida incluye
> `ninguna` además de los identificadores reales. Sin ella, un modelo obligado a elegir
> entre opciones que no aplican elige una igualmente y el usuario acaba en una rama que no
> pidió; con ella, «no encaja» es una respuesta válida que se traduce a `null` y el flujo
> repara. Cualquier fallo de la API —429, red, respuesta rara— devuelve también `null`: un
> problema del modelo se convierte en un «no entendí» que el guion ya sabe manejar.

> ⬆⬆ **La mensajería es una fábrica por tenant, no una instancia.** El token y el
> `phone_number_id` son de cada despacho; un único cliente mandaría los mensajes de todos
> por la línea del primero que arrancara.

### Fase 4 — Agenda

> `domain/agenda/` puro: `horarios.ts`, `disponibilidad.ts`, `politicas.ts`.
> `app/reservarCita.ts`, `cancelarCita.ts`, `reagendarCita.ts`.
> El adaptador de Postgres implementa `reservar` con el SQL crudo de §6 y escribe en
> `outbox` en la misma transacción.

**Aceptación obligatoria:** (a) dos reservas concurrentes al mismo slot — una gana, la
otra recibe `SlotTomadoError`; (b) un bloqueo elimina el slot; (c) cita a las 23:30 local
cae en el día correcto; (d) un contacto con cita activa no puede reservar otra.

Además: un test recorre la conversación entera —de un «hola» a una cita en la base, con su
abogado, su honorario y sus datos de contacto—, y otro pone a dos usuarios a elegir el mismo
horario para comprobar que el segundo recibe el aviso y una lista **nueva** que ya no lo
incluye, en vez de quedarse en bucle.

**Estado: hecha.** 122 tests rápidos y 74 de integración en verde.

### Fase 5 — Google Calendar y relay del outbox ⬆

> OAuth por abogado con refresh token cifrado. `importarBloqueos` con `freeBusy.query`.
> `crearEvento` / `borrarEvento` **idempotentes por `idempotency_key`**.
> Relay del outbox con `FOR UPDATE SKIP LOCKED`, backoff exponencial, y alerta al estudio
> tras 5 fallos. Si Google está caído, la cita se guarda igual.

**Aceptación:** correr el relay dos veces no crea dos eventos en Google. Con la API de
Google apagada, la reserva sigue funcionando.

Además: dos relays simultáneos se reparten los trabajos y no duplican ninguno; un trabajo
reclamado queda arrendado y no se vuelve a tomar enseguida; agotados los intentos se archiva
y **sigue sin publicar**, que es lo que busca la alerta de §9; y un bloqueo importado de
Google desaparece de la agenda en cuanto Google deja de reportarlo.

**Estado: hecha.** 162 tests rápidos y 88 de integración en verde.

> ⬆⬆ **La idempotencia no se consigue reintentando con cuidado**, sino dándole a Google un
> identificador determinista: el uuid de la cita sin guiones. Google exige base32hex
> —minúsculas de la «a» a la «v» y dígitos— y un uuid hexadecimal cae justo dentro de ese
> juego. Crear dos veces el mismo evento devuelve 409, y ese 409 es un éxito.

> ⬆⬆ **El reclamo del outbox arrienda en vez de mantener abierta la transacción.** El
> `FOR UPDATE SKIP LOCKED` evita que dos relays tomen la misma fila, pero sostener la
> transacción durante la llamada a Google retendría una conexión del pool y un bloqueo de
> fila durante segundos. En su lugar, el reclamo empuja `proximo_intento_at` al futuro en la
> misma sentencia. Si el proceso muere a mitad, el arriendo vence y el trabajo vuelve: la
> entrega es *at-least-once* y por eso cada efecto tiene que tolerar ejecutarse dos veces.

> ⬆⬆ **`intentos` se incrementa al reclamar, no al fallar.** Así un proceso que muere a
> mitad también consume intento, y un trabajo venenoso que tumba el relay no gira para
> siempre.

> ⬆⬆ **Archivar no es borrar.** Agotados los intentos, la fila se deja con `intentos` al
> tope y sin `publicado_at`: el reclamo ya no la toma y la alerta de §9 —«entradas con más
> de quince minutos sin publicar»— sigue viéndola. El transporte del aviso al estudio es de
> la fase 8; lo que la fase 5 garantiza es que el rastro queda.

> ⬆⬆ **Si el Google de un abogado falla, sus bloqueos no se vacían.** `freeBusy` no devuelve
> identificadores, así que sincronizar es sustituir la ventana; pero sustituirla por nada
> ante un error convertiría un fallo de red en horarios ocupados ofrecidos como libres.

### Fase 6 — Jobs programados ⬆

> Cinco crones de pg-boss, todos con política `exclusive` y zona `America/Guayaquil`:
> `outbox.relay` cada minuto; `agenda.sincronizar` cada 5 min; `recordatorios.enviar`
> diario 09:00 con botones Confirmar/Cancelar/Reagendar; `retencion.aplicar` diario 03:00
> (borra `mensajes` >90 días, anonimiza contactos sin actividad en 12 meses);
> `media.refrescar` diario 04:00. Todos idempotentes.

**Aceptación:** correr cualquiera de los cinco dos veces seguidas no duplica nada. El
recordatorio del día siguiente se encola una sola vez por cita. Un despacho que falle no
impide que los demás se procesen.

**Estado: hecha.** 181 tests rápidos y 101 de integración en verde.

> ⬆⬆ **El relay deja de ser un `setInterval` y pasa a ser un cron de pg-boss.** Con dos
> procesos —el despliegue solapado, o el día que haya dos réplicas— dos `setInterval`
> corren a la vez y gastan intentos por duplicado. La política `exclusive` de la cola pone
> esa exclusión en Postgres, donde ambos procesos la ven.

> ⬆⬆ **`exclusive` es lo que impide que las pasadas se apilen.** Un relay que tarde más de
> un minuto, con una cola normal, acabaría con sesenta copias encoladas en una hora. Con
> `exclusive` solo hay un trabajo en cola o activo: si la pasada anterior sigue viva, la
> siguiente sencillamente no entra.

> ⬆⬆ **`missed: 'once'`, no `'skip'`.** Si el despliegue estuvo caído a las 09:00, los
> recordatorios del día no pueden perderse sin más; pero tampoco hace falta una puesta al
> día por cada ocurrencia perdida.

> ⬆⬆ **El recordatorio no se envía: se encola en `outbox`.** Así hereda la idempotencia por
> clave (`recordatorio:<citaId>`), el backoff y los reintentos del relay, y sigue habiendo
> un solo camino para todo lo que sale del sistema. Va por plantilla porque a las 09:00 del
> día anterior la ventana de 24 h casi nunca está abierta.

> ⬆⬆ **Los botones de la plantilla se casan por índice, no por nombre.** Meta numera los
> `quick_reply` por posición, y lo que viaja en el `payload` es exactamente lo que la
> máquina de estados va a recibir de vuelta. Hay un test que fija los tres payloads y su
> orden: renombrar una opción sin tocar la plantilla dejaría el botón sin efecto y al
> usuario hablando solo.

> ⬆⬆ **Los mensajes se borran y los contactos se anonimizan.** No es lo mismo: el `payload`
> de un mensaje guarda la consulta jurídica y no hay motivo para conservarla; la fila del
> contacto sostiene las métricas del estudio y basta con que deje de identificar a nadie.
> Y nunca se anonimiza a quien tiene una cita por delante: se presentaría en la agenda de
> mañana y el estudio no sabría quién es.

> ⬆⬆ **Un despacho que falle no puede llevarse por delante a los demás.** Cada job recorre
> los despachos —`tenants` es la única tabla legible sin fijar tenant— y cada vuelta va en
> su propio `try`. El bucle anterior de importación de bloqueos sacaba la lista de
> `tenantsConPendientes`, así que un estudio con la `outbox` vacía no sincronizaba nunca.

### Fase 7 — Panel y auditoría ⬆

> Panel con Hono JSX + HTMX según §9: pantalla "Hoy y mañana", fichas en línea, cancelar
> con deshacer de 10 s. Autenticación con passkeys (`@simplewebauthn/server`), cookie
> `httpOnly` + `SameSite=Strict`. Todo acceso a datos personales queda en `eventos`.
> Endpoint de exportación de datos de un contacto en JSON (portabilidad LOPDP).
> Redacción de PII en pino y en el `beforeSend` de Sentry.

### Fase 8 — Despliegue

> `docker-compose.prod.yml`, Caddy con dominio real y cabeceras de seguridad,
> `/health` que verifica Postgres y pg-boss, `pg_dump` diario con el rol `app_dump` a
> Cloudflare R2 con retención de 14 días, las cuatro alertas de §9, y `RUNBOOK.md` con:
> desplegar, rotar el token de WhatsApp, restaurar un backup, dar de alta un tenant,
> qué hacer si Meta suspende el número, y qué revisar cuando el bot deja de responder.

---

## 12. `CLAUDE.md`

El archivo real está en la raíz del repositorio y es la copia que manda. Lo que sigue es un
resumen; ante cualquier diferencia, vale `CLAUDE.md`.

```md
# Reglas del proyecto

## Arquitectura
- Anillos: domain ← app ← adapters. Las flechas apuntan hacia adentro.
  `domain` NO importa de adapters, app ni platform. El linter lo impone.
- `domain/conversacion/maquina.ts` y todo `domain/agenda/` son PUROS:
  ninguna llamada de red ni de base de datos.
- Los casos de uso viven en `app/` y dependen de PUERTOS, nunca de adaptadores.

## Datos
- Toda operación de BD va dentro de una transacción que empieza con
  `SET LOCAL app.tenant_id`. Nunca `SET` a secas.
- Toda reserva pasa por el caso de uso `reservarCita`. Prohibido
  `SELECT` de disponibilidad seguido de `INSERT`.
- Todo efecto externo se escribe en `outbox` en la misma transacción,
  con `idempotency_key`, y debe tolerar ejecutarse dos veces.
- Todo `timestamptz` en UTC. Formatear con `platform/time.ts`.

## Seguridad
- La firma del webhook se compara con `crypto.timingSafeEqual`, nunca con `===`.
- El LLM clasifica, no redacta. Su salida se valida con Zod contra lista cerrada.
- `payload`, `nombre`, `email` y `cedula` NUNCA salen en logs ni en Sentry.
- Los secretos se cifran con `platform/crypto.ts`.

## Producto
- Todo texto de cara al usuario vive en `content.ts`. Usted, no tú.
  Máximo dos frases por turno. Un solo emoji en toda la conversación.
- Al tercer fallo consecutivo se deriva a una persona. Sin cuarto intento.

## Proceso
- Cada feature llega con su test. Los tests de dominio no tocan la red.
- Antes de cerrar una fase: `npm test`, `npm run lint`, `npm run lint:arch`.
```

---

## 13. Costo real de operación

| Partida | Mensual |
|---|---|
| Plantillas de WhatsApp (150 recordatorios × $0,0034) | $0,51 |
| Claude Haiku 4.5 (~200 fichas por clasificación) | $0,31 |
| Hetzner CX23 Falkenstein (€3,99) + IPv4 (€0,50) | $5,35 |
| Dominio | $1,00 |
| Backups (Cloudflare R2), Sentry, uptime | $0,00 |
| Google Calendar API | $0,00 |
| **Total** | **$7,17** |
| Con colchón del 50% | **$10,75** |

Costo marginal del cliente #2: **$0,82/mes**. Con 5 clientes: **$2,16 por cliente**.

> ⬆⬆ **La caché de prompt no interviene**, aunque v2 la diera por supuesta en esta línea.
> El prompt del clasificador ronda las 150 fichas y el prefijo mínimo cacheable está entre
> 512 y 4096 según el modelo, así que un `cache_control` no haría nada: se omite a
> propósito en vez de dejar una llamada que aparenta ahorrar. La cifra se sostiene igual
> por lo corto que es el prompt, no por la caché.

---

## 14. Esfuerzo revisado ⬆

| Fase | v1 | v2 | Δ |
|---|---|---|---|
| 0 — Preparación y audios | 6 | 7 | +1 (Flow estático) |
| 1 — Esqueleto, anillos y RLS | 5 | 9 | +4 (RLS, roles, lint de arquitectura) |
| 2 — WhatsApp y webhook | 8 | 9 | +1 (serialización, Flow) |
| 3 — Dominio conversacional | 12 | 14 | +2 (reparación, versionado) |
| 4 — Agenda | 10 | 13 | +3 (cancelar y reagendar) |
| 5 — Calendar y outbox | 7 | 9 | +2 (relay idempotente) |
| 6 — Jobs | 4 | 5 | +1 (retención) |
| 7 — Panel y auditoría | 7 | 10 | +3 (passkeys, portabilidad, redacción) |
| 8 — Despliegue | 5 | 6 | +1 (alertas) |
| Pruebas con usuarios y ajustes | 8 | 8 | — |
| **Total** | **72** | **90** | **+18** |

Las 18 horas extra compran: aislamiento entre despachos garantizado por el motor de base
de datos, cancelación y reagendamiento, escalado a humano que funciona, entrega fiable de
efectos externos, y un panel que se usa. En un sistema que maneja consultas jurídicas
bajo secreto profesional, ninguna de las cinco es opcional.
