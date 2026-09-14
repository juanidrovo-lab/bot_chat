# Providencia · Bot jurídico de WhatsApp

Bot multi-tenant para estudios jurídicos: atiende WhatsApp, clasifica la consulta por
materia, informa el honorario y agenda citas en horarios realmente libres.

La especificación completa está en `PLAN-BOT-PROVIDENCIA.md`. **Léela antes de escribir
código.** Las referencias `§4.3`, `§6`, etc. de estas reglas apuntan a ese documento.

---

## Arquitectura — no negociable

- Tres anillos: `domain` ← `app` ← `adapters`. **Las flechas apuntan hacia adentro.**
  - `domain/` es puro: ninguna importación de `app`, `adapters` o `platform`, y ningún
    paquete que toque red, disco o base de datos.
  - `app/` contiene casos de uso y depende de **puertos** (interfaces), nunca de
    adaptadores concretos.
  - `adapters/` implementa los puertos: whatsapp, google, postgres, anthropic, http.
- La regla la impone `eslint-plugin-boundaries` y **debe romper el build**. Si un cambio
  necesita saltarse la regla, el diseño está mal: pregúntame antes de añadir una excepción.
- `domain/conversacion/maquina.ts` y todo `domain/agenda/` son **funciones puras**.
  Ninguna llamada de red ni de base de datos adentro. Devuelven acciones declarativas que
  ejecuta el caso de uso. `domain` tampoco puede importar `platform`: si una función pura
  necesita saber la hora o el día local, se le pasa como argumento.
- `db.ts` y `tenantContext.ts` viven en `adapters/postgres/`, no en `platform/`: conocen el
  esquema de Drizzle y `platform` es hoja.

## Datos

- **Toda** operación de base de datos pasa por `enTenant()`, que abre una transacción y
  fija el tenant con `SELECT set_config('app.tenant_id', $1, true)`.
  - **`SET LOCAL app.tenant_id = $1` no existe**: `SET` no admite parámetros enlazados.
  - **Nunca `SET` a secas**: con pool de conexiones el valor se filtra a la petición
    siguiente.
  - Lo único que puede consultarse sin tenant fijado es `tenants`, y solo para resolver el
    despacho por `wa_phone_number_id` o recorrer la lista en los jobs.
- Toda tabla con `tenant_id` lleva `ENABLE` **y** `FORCE ROW LEVEL SECURITY`.
  La aplicación se conecta como `app_user`, que no es dueña de las tablas.
- Usar siempre `current_setting('app.tenant_id', true)` — con el segundo argumento.
- Todo índice **de escaneo** sobre tablas multi-tenant empieza por `tenant_id`. Única
  excepción: las claves primarias subrogadas (`id`), únicas globalmente y usadas solo para
  búsquedas puntuales. Hay un test que lee `pg_index` y lo comprueba.
- **Ninguna restricción UNIQUE cruza tenants.** Un índice único global se evalúa por debajo
  de la RLS: la fila en conflicto sería invisible y `ON CONFLICT DO NOTHING` descartaría en
  silencio un dato legítimo de otro despacho.
- Los límites de negocio son restricciones del motor, no consultas previas: una cita activa
  por contacto es `citas_una_activa_por_contacto`; el tope de 3 reservas al mes es el
  incremento condicional sobre `reservas_mes`.
- Toda reserva pasa por el caso de uso `reservarCita`. **Prohibido** consultar
  disponibilidad y después insertar: la exclusión la garantiza el índice único parcial
  `citas_slot_unico` (§6). Esa consulta va en SQL crudo, no en Drizzle.
  - `tx.execute` devuelve un `QueryResult`: se lee `.rows`, nunca `.length` ni `[0]`.
  - Drizzle envuelve el error de Postgres: `code` y `constraint` están en `error.cause`.
- **En SQL crudo, `timestamptz` y `numeric` llegan como `string`**, no como `Date` ni
  `number`: Drizzle desactiva los analizadores de node-postgres. Toda columna de fecha
  leída así pasa por `aInstante()` (`adapters/postgres/tipos.ts`), y toda comparación de
  tiempo que quepa en SQL se hace en SQL — además quita la deriva entre el reloj de la
  aplicación y el de la base.
- Nada de backticks dentro de una plantilla ``sql`...` ``, ni siquiera en comentarios SQL:
  cierran el literal de JavaScript.
- Todo efecto externo se escribe en `outbox` **en la misma transacción** que el cambio de
  negocio, con `idempotency_key`, y debe tolerar ejecutarse dos veces.
- Todo `timestamptz` se guarda en UTC y se formatea con `platform/time.ts`
  (America/Guayaquil, UTC−5, sin horario de verano).

## Seguridad

- La firma `X-Hub-Signature-256` se verifica contra el **cuerpo crudo** y se compara con
  `crypto.timingSafeEqual`. **Nunca con `===`.** Comprobar la longitud antes: si difiere,
  `timingSafeEqual` lanza, y esa excepción convierte un 401 en un 500.
- El webhook responde 200 en menos de un segundo. La lógica va en jobs.
- Deduplicar por `wa_message_id` **antes** de encolar, con
  `INSERT ... ON CONFLICT DO NOTHING` sobre el índice único de `mensajes`, en el mismo
  Postgres. Es un round-trip de 1–2 ms contra un índice: cabe de sobra en el presupuesto
  de un segundo. La deduplicación tiene que ser **durable**, y hacerla en el worker
  llegaría tarde — el job ya estaría encolado dos veces.
- Serializar por conversación: cola con política `key_strict_fifo` y
  `singletonKey = conversacion_id`, más `SELECT ... FOR UPDATE` sobre la fila de
  conversación al inicio del trabajo. Lo primero da el orden; lo segundo protege del
  despliegue con dos procesos solapados.
- El HMAC va sobre los **bytes** del cuerpo (`c.req.arrayBuffer()`), no sobre el texto
  reserializado: con un solo acento deja de cuadrar.
- El `phone_number_id` se lee del cuerpo **antes** de verificar la firma, porque el secreto
  está guardado por despacho. De ese cuerpo no autenticado no se lee nada más y no se
  escribe nada hasta que la firma cuadra.
- **El modelo clasifica, no redacta.** La salida del LLM se valida con Zod contra una
  lista cerrada de valores. Nunca se reenvía su texto libre al usuario, nunca tiene
  herramientas.
- `payload`, `nombre`, `email` y `cedula` **nunca** salen en logs ni en Sentry.
  Redactar en pino y en el `beforeSend` de Sentry.
- Los secretos se cifran con `platform/crypto.ts` (AES-256-GCM). Nunca en claro en la
  base de datos ni en logs.

## Producto

- Todo texto de cara al usuario vive en `content.ts`, por tenant. Nunca en línea en el
  código.
- Estilo: **usted**, nunca tú. Máximo dos frases por turno.
- **Emoji: solo el mensaje de confirmación de la cita lleva uno. Ningún otro.** Es una
  propiedad de los textos de `content.ts`, no un contador en tiempo de ejecución: no hay
  estado que persistir, simplemente ningún otro texto del flujo contiene emojis.
  Consecuencia aceptada: quien reagenda ve dos confirmaciones, y por tanto dos emojis.
- Preguntas accionables, no de sí o no. Confirmación explícita solo de fecha, hora y
  modalidad.
- Frases prohibidas: "asistente virtual", "¿en qué puedo ayudarte?", "lo siento, no
  entendí", "por favor intenta de nuevo".
- Al **tercer** fallo consecutivo se deriva a una persona. Sin cuarto intento. Derivar
  significa que el bot **se calla**: marca `derivada_at`, la conversación pasa a la bandeja
  del panel y los mensajes siguientes se guardan pero no se contestan.
- Límites de WhatsApp, truncar en código: lista máx. 10 filas, botones máx. 3, título de
  fila ≤24 caracteres, texto de botón ≤20.
- Notas de voz: `.ogg` con códec OPUS y `"voice": true`. Cualquier otro formato llega
  como archivo adjunto.

## Proceso

- Cada feature llega con su test. La suite rápida (`npm test`) son `tests/domain/` y
  `tests/adapters/`: ni red, ni Docker, ni esperas reales — el backoff del cliente y el
  reloj se inyectan.
- Los tests de concurrencia y de RLS necesitan Postgres real (`compose.test.yml`).
- Antes de dar por cerrada una fase: `npm test`, `npm run typecheck`, `npm run lint`,
  `npm run lint:arch` y, si la fase toca la base, `npm run test:integration`.
- El proyecto pide Node 24 o superior (`engines`, `.nvmrc`). Con Node 22 `npm install`
  avisa con `EBADENGINE`.
- No instales dependencias que no estén en el stack de `PLAN-BOT-PROVIDENCIA.md` §2 sin
  preguntarme primero. Por eso el puente con `node:http` de `adapters/http/servidor.ts`
  está escrito a mano en vez de usar `@hono/node-server`.
- El esquema `pgboss` se crea en el aprovisionamiento (`docker/postgres-init.sh`) y
  pertenece a `app_user`: la cola gestiona sus propias tablas y las particiona. La
  aplicación arranca con `createSchema: false`.
- Commits en español, uno por fase o por unidad lógica.

## Comandos

```bash
npm run dev              # servidor + workers en local
npm run db:generate      # genera migración desde el esquema Drizzle
npm run db:migrate       # aplica migraciones (rol app_owner)
npm test                 # unitarios de dominio, sin Docker
npm run test:integration # con Postgres real: concurrencia y RLS
npm run typecheck        # tsc --noEmit
npm run lint             # eslint
npm run lint:arch        # regla de dependencias entre anillos
```
