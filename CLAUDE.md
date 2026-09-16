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
- La máquina no envía nada: devuelve **acciones declarativas** con claves de texto, y el
  caso de uso las ejecuta. Si en `procesarMensajeEntrante` aparece un `if` sobre el estado
  de la conversación, está en el sitio equivocado.
- Los puertos que dependen de credenciales de despacho (`Mensajeria`) se inyectan como
  **fábrica por tenant**, nunca como instancia única.
- `domain/conversacion/maquina.ts` y todo `domain/agenda/` son **funciones puras**.
  Ninguna llamada de red ni de base de datos adentro. Devuelven acciones declarativas que
  ejecuta el caso de uso.
- **Ni `domain` ni `app` pueden importar `platform`.** `domain/agenda/` trabaja en
  milisegundos y no sabe qué es una zona horaria; los casos de uso piden la conversión entre
  día local e instante por el puerto `Reloj`. Su única implementación (`adapters/reloj.ts`)
  es el único punto del proyecto que menciona America/Guayaquil.
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
  - Un array dentro de ``sql`...` `` se expande a una lista de parámetros. Para pasar un
    `uuid[]` de verdad hace falta `sql.param([...ids])`.
- **Reagendar es `reservarCita` con `citaOrigenId`**, no un caso de uso aparte: la
  cancelación de la anterior y la inserción de la nueva van en la misma transacción. Y no
  gasta cupo mensual — mover una cita no es pedir otra.
- Un `UPDATE` como `app_owner` **sin** fijar `app.tenant_id` no toca ninguna fila y no
  avisa: con FORCE RLS el dueño también está sujeto. Vale para migraciones de datos,
  scripts de mantenimiento y ayudantes de tests.
  Lo mismo vale para `pg_dump`: sin `BYPASSRLS` el volcado sale **vacío y sin error**, y un
  backup vacío parece un backup. Por eso existe `app_dump` y por eso el script comprueba el
  tamaño del archivo.
- El bloqueo del turno es `FOR NO KEY UPDATE`, nunca `FOR UPDATE`: el fuerte excluye también
  el `KEY SHARE` que Postgres toma al comprobar una clave ajena, así que un INSERT en
  `mensajes` desde otra transacción espera al COMMIT del turno y el turno espera a ese
  INSERT. El débil sigue excluyendo a otro trabajador, que es lo único que hacía falta.
- **La disponibilidad no se cachea.** Tras perder la carrera por un horario, la lista que
  se vuelve a ofrecer tiene que ser fresca o el usuario elige el mismo hueco en bucle. La
  configuración del despacho sí se memoriza, porque no cambia a mitad de conversación.
- La máquina guarda el id de la opción **sin interpretarlo**: en el contexto puede acabar
  cualquier cosa —un botón viejo, un id manipulado—. Quien produjo esos ids valida su forma
  al leerlos.
- **En SQL crudo, `timestamptz` y `numeric` llegan como `string`**, no como `Date` ni
  `number`: Drizzle desactiva los analizadores de node-postgres. Toda columna de fecha
  leída así pasa por `aInstante()` (`adapters/postgres/tipos.ts`), y toda comparación de
  tiempo que quepa en SQL se hace en SQL — además quita la deriva entre el reloj de la
  aplicación y el de la base.
- Nada de backticks dentro de una plantilla ``sql`...` ``, ni siquiera en comentarios SQL:
  cierran el literal de JavaScript.
- Todo efecto externo se escribe en `outbox` **en la misma transacción** que el cambio de
  negocio, con `idempotency_key`, y debe tolerar ejecutarse dos veces.
  - El relay **recorre despacho por despacho**: bajo RLS no existe una consulta que vea la
    outbox de todos. La lista sale de `tenants`, la única tabla sin RLS.
  - El reclamo **arrienda**: `FOR UPDATE SKIP LOCKED` para repartir y `proximo_intento_at`
    al futuro para reservar, en una sola sentencia. **Nunca** se mantiene una transacción
    abierta durante una llamada de red.
  - `intentos` se incrementa al reclamar, no al fallar: así un proceso que muere a mitad
    también consume intento y un trabajo venenoso no gira para siempre.
  - Agotados los intentos se **archiva**: `intentos` al tope y sin `publicado_at`, para que
    la alerta de §9 lo siga viendo. Archivar no es borrar.
  - Un fallo que no mejora reintentando (`FalloPermanente`) se archiva en el primer intento.
- El OAuth de Google pide `access_type: 'offline'` **y** `prompt: 'consent'`: sin forzar el
  consentimiento, Google no devuelve refresh token a quien ya autorizó alguna vez, y la
  conexión dura una hora. Si no viene refresh token, la conexión falla en vez de guardar
  media credencial. El `redirectUri` se compone por petición —Google lo exige idéntico al
  registrado y la vuelta es por despacho— y el `state` es de un solo uso, vive en `retos` y
  dice a qué abogado pertenece, que **no** se acepta de la URL de vuelta.
- **Google Calendar es un espejo, no la fuente de verdad.** La idempotencia viene del id
  determinista del evento —el uuid de la cita sin guiones, que es base32hex válido—, no de
  reintentar con cuidado: el 409 de «ya existe» es un éxito. Un abogado sin Google conectado
  devuelve un calendario nulo, y eso no es un fallo.
- La ventana de 24 h la renueva el **trabajador**, nunca el webhook: renovarla al recibir
  haría que nadie llegara a ver que estaba vencida y `SESION_EXPIRADA` no dispararía.
- Los trabajos programados son crones de pg-boss con política `exclusive`, nunca
  `setInterval`: con dos procesos, dos intervalos corren a la vez y gastan intentos por
  duplicado. `exclusive` deja una sola pasada en cola o activa, y esa exclusión vive en
  Postgres, que es donde ambos procesos la ven. `missed: 'once'` y no `'skip'`: si el
  despliegue estuvo caído a las 09:00 los recordatorios del día no se pierden, pero tampoco
  se manda uno por cada ocurrencia perdida.
- Cada job **recorre los despachos** y fija el tenant en cada vuelta. La lista sale de
  `tenants`, no de «los que tienen algo pendiente»: un estudio con la outbox vacía también
  tiene que sincronizar su agenda. Una vuelta que falle se registra y se sigue con la
  siguiente.
- El recordatorio no se envía desde el job: se **encola en `outbox`** con clave
  `recordatorio:<citaId>`. Así hereda idempotencia, backoff y reintentos, y sigue habiendo
  un solo camino para todo lo que sale. Va por plantilla porque a esa hora la ventana de
  24 h está cerrada.
- Los botones de una plantilla de WhatsApp se casan por **índice**, no por nombre, y su
  `payload` es el identificador que la máquina recibirá de vuelta. Hay un test que fija los
  tres y su orden.
- Retención: los **mensajes se borran** —su `payload` es la consulta jurídica— y los
  **contactos se anonimizan**, porque sus citas pasadas siguen contando para las métricas.
  Nunca se anonimiza a quien tiene una cita por delante.
- Todo `timestamptz` se guarda en UTC y se formatea con `platform/time.ts`
  (America/Guayaquil, UTC−5, sin horario de verano).

## Seguridad

- La firma `X-Hub-Signature-256` se verifica contra el **cuerpo crudo** y se compara con
  `crypto.timingSafeEqual`. **Nunca con `===`.** Comprobar la longitud antes: si difiere,
  `timingSafeEqual` lanza, y esa excepción convierte un 401 en un 500.
- El webhook responde 200 en menos de un segundo. La lógica va en jobs.
- `/health` comprueba Postgres, la cola y la outbox de verdad. Un `SELECT 1` pasa con la
  base en solo lectura, con el disco lleno y con los permisos revocados: las tres formas en
  que esto se rompe. Cada sonda con su límite de tiempo y todas en paralelo.
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
  - Modelo: `claude-haiku-4-5`, **sin sufijo de fecha**. Haiku 4.5 no admite
    `output_config.effort`.
  - El esquema de salida lleva siempre `ninguna` además de los identificadores reales: sin
    salida de escape, un modelo obligado a elegir elige mal.
  - Cualquier fallo —429, red, respuesta rara— devuelve `null`, que el guion trata como un
    «no entendí» y repara. El clasificador nunca tumba una conversación.
- `payload`, `nombre`, `email` y `cedula` **nunca** salen en logs ni en Sentry.
  Redactar en pino y en el `beforeSend` de Sentry.
- **El consentimiento se registra, con la versión del texto que el contacto vio.** Aceptar
  sella `consent_at` y `consent_version`; rechazar sella `consent_revocado_at`. Va en la
  misma transacción que el turno, y también a `eventos`: `contactos` dice el estado actual y
  `eventos` prueba que se preguntó y qué se respondió cada vez. **Hay que subir
  `VERSION_CONSENTIMIENTO` cada vez que cambie el texto**, o el registro dirá que alguien
  aceptó algo que nunca leyó.
- Volver a escribir no reinicia `consent_at`: es la fecha que prueba desde cuándo.
- Los secretos se cifran con `platform/crypto.ts` (AES-256-GCM). Nunca en claro en la
  base de datos ni en logs.
- Todo error propio fija `this.name`. El mensaje se redacta antes de llegar al log o a
  Sentry —puede traer los parámetros de una consulta—, así que el nombre es lo único que
  sobrevive para saber qué pasó. Hay un test que los recorre.
- La redacción por rutas de pino **no alcanza al mensaje de un error**: Drizzle pega los
  parámetros de la consulta al `message`, y ahí acaba el texto de un mensaje de WhatsApp sin
  que ninguna clave se llame `payload`. `platform/redaccion.ts` recorta `message` y `stack`,
  y es la misma función que usa el `beforeSend` del reportador de errores.
- **El panel falla cerrado.** Sin `Passkeys` configurado no entra nadie: un «mientras tanto»
  que dejara pasar sería la agenda del estudio abierta a quien encuentre la URL.
- La cookie de sesión lleva un testigo aleatorio; la base guarda su **hash**. Una copia de
  la base no puede bastar para entrar al panel. `httpOnly`, `Secure` y `SameSite=Strict`:
  al panel se entra escribiendo la dirección, nunca desde un enlace de fuera.
- El reto de WebAuthn vive en la base —con dos procesos, la ceremonia empieza en uno y
  termina en el otro— y **se lee y se borra en la misma sentencia**. En dos, la ventana
  intermedia permite repetir una respuesta capturada.
- **El acceso no manda `allowCredentials`.** Pasar las credenciales del despacho le diría a
  cualquiera que abra la página cuántos usuarios tiene y cuáles son sus identificadores, sin
  autenticarse. Por eso el registro exige `residentKey: 'required'`: con credenciales
  descubribles el navegador las enseña y el servidor averigua quién es por el identificador
  que vuelve firmado.
- **El alta va por invitación de un solo uso** (`npm run panel:invitar`), no por correo: un
  formulario que responde distinto según el correo exista o no es un comprobador de quién
  trabaja en el estudio. La base guarda el hash del testigo, caduca a los siete días, y se
  quema **después** de guardar la credencial — al revés, un fallo al guardar dejaría al
  abogado sin passkey y sin forma de reintentar.
- Atestación `none` y `userVerification: 'required'`. Saber marca y modelo del autenticador
  no aporta nada y arrastra una cadena de certificados de confianza —donde estaba la
  vulnerabilidad de `@simplewebauthn/server` hasta 13.3.1—; la verificación sí se exige,
  porque una passkey sin huella ni PIN es un teléfono desbloqueado sobre un escritorio.
- `PANEL_ORIGEN` es el origen exacto que el navegador firma en `clientDataJSON`. Sin él no
  hay forma de verificar nada y el panel **falla cerrado** en vez de adivinar un dominio.
- El contador del autenticador tiene que avanzar; si no, la credencial está clonada. Única
  excepción: el `0`, que muchas passkeys sincronizadas no llevan.

## Producto

- Todo texto de cara al usuario vive en `content.ts`, por tenant. Nunca en línea en el
  código. Lo que cada despacho reescribe está en `tenant_config.textos`, y solo lo que
  reescribe: una clave que no toque se queda con la de serie, así que añadir un texto nuevo
  al guion nunca deja a un cliente sin él.
- **`z.record` con clave enum es exhaustivo en Zod 4**: exige todas las claves. Para un mapa
  parcial no sirve, y `z.partialRecord` rechaza el objeto entero ante una clave desconocida
  —un error tipográfico borraría todos los textos del despacho—. Se valida abierto y se
  filtra a mano, avisando de la clave mala.
- **Sin `flowDatos` el bot no puede pedir los datos**, y la conversación se deriva en el acto
  con motivo `error_sistema` en vez de dejar que el usuario falle tres veces contra una
  puerta cerrada. El Flow sale de `tenant_config.flow_datos`, no del catálogo base.
- Estilo: **usted**, nunca tú. Máximo dos frases por turno.
- Las reglas de estilo son propiedades de `content.ts` y hay un test que las recorre una
  por una. Si añade un texto, ese test es el que dice si cumple.
- **Emoji: solo el mensaje de confirmación de la cita lleva uno. Ningún otro.** Es una
  propiedad de los textos de `content.ts`, no un contador en tiempo de ejecución: no hay
  estado que persistir, simplemente ningún otro texto del flujo contiene emojis.
  Consecuencia aceptada: quien reagenda ve dos confirmaciones, y por tanto dos emojis.
- Preguntas accionables, no de sí o no. Confirmación explícita solo de fecha, hora y
  modalidad.
- Frases prohibidas: "asistente virtual", "¿en qué puedo ayudarte?", "lo siento, no
  entendí", "por favor intenta de nuevo".
- Bloquear a un contacto calla al bot en **todas** sus conversaciones; derivar, solo en una.
  En los dos casos el mensaje se guarda y no se contesta.
- Al **tercer** fallo consecutivo se deriva a una persona. Sin cuarto intento. Derivar
  significa que el bot **se calla**: marca `derivada_at`, la conversación pasa a la bandeja
  del panel y los mensajes siguientes se guardan pero no se contestan.
- Límites de WhatsApp, truncar en código: lista máx. 10 filas, botones máx. 3, título de
  fila ≤24 caracteres, texto de botón ≤20.
- El panel se escribe con `hono/html`, **nunca en `.tsx`**: la elisión de tipos de Node
  borra anotaciones pero no transforma JSX, y un `.tsx` obligaría a meter el bundler que el
  stack quería evitar.
- El despacho va en la URL del panel (`/panel/<slug>`), por el mismo motivo que el
  `phone_number_id` va en el cuerpo del webhook: la página de acceso tiene que saberlo antes
  de que exista una sesión de la que deducirlo.
- **Deshacer, no «¿está seguro?».** La cancelación se comete ya; lo que se aplaza diez
  segundos son los efectos irreversibles, escribiéndolos en `outbox` con
  `proximo_intento_at` en el futuro. Deshacer puede perder la carrera por el horario: el
  UPDATE va en un punto de guardado para poder responderlo en vez de reventar.
- Ver una ficha se audita; ver la agenda, no. Y el rastro guarda **a quién** se accedió,
  nunca **qué** decía: auditar el contenido convierte `eventos` en una segunda copia de lo
  que protege. La búsqueda también deja rastro —expone nombres— pero guarda cuántos
  contactos se expusieron, nunca lo tecleado.
- Las métricas de §9 salen de las tablas de negocio, nunca de una tabla de analítica: sería
  una segunda copia de los mismos datos con una segunda forma de desincronizarse.
- **Un porcentaje sobre una muestra pequeña no se enseña.** Por debajo de veinte, el informe
  dice que no hay datos suficientes. Y la tasa de ausencias se mide sobre las citas
  *marcadas*, enseñando cuántas pasadas quedaron sin marcar: si no, es una opinión sobre la
  mitad que alguien tocó.
- Notas de voz: `.ogg` con códec OPUS y `"voice": true`. Cualquier otro formato llega
  como archivo adjunto, sin dar error en ninguna parte. `scripts/audios.ts` lo comprueba al
  registrar el fichero, que es el único momento en que alguien está mirando.
- La clave de un audio (`bienvenida`) **no es un `media_id`**: el turno la canja por uno
  vigente antes de enviar. Mandar la clave es un rechazo seguro de Meta, y silencioso.
- El alta de un despacho pasa por `scripts/despacho.ts`, nunca por SQL a mano. Después de
  escribir **relee con los adaptadores del bot**: `jsonb` acepta cualquier cosa, así que un
  tarifario mal formado se guarda sin error y deja al despacho sin materias. Validar contra
  una copia del esquema no sirve; lo que importa es lo que el bot ve.

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
- **CI corre las cinco comprobaciones en cada push** (`.github/workflows/verificacion.yml`),
  y la de integración va contra **Postgres 17**, el de producción. Si CI está rojo, la fase
  no está cerrada.
- El aprovisionamiento —los tres roles, la propiedad del esquema y la casa de pg-boss— vive
  en `scripts/aprovisionar.ts` y es **uno solo** para los tres caminos: compose, CI y un
  clúster local. Es idempotente. El esquema `pgboss` pertenece a `app_user` porque la cola
  gestiona y particiona sus propias tablas; la aplicación arranca con `createSchema: false`.
- `ALTER ROLE ... PASSWORD $1` **tampoco existe**: como `SET`, no admite parámetros
  enlazados. Se escapa con `cliente.escapeLiteral()`, nunca concatenando comillas.
- `npm audit --omit=dev --audit-level=high` es un paso de CI. Solo producción: una
  vulnerabilidad en una herramienta de desarrollo no puede bloquear un arreglo urgente.
- Commits en español, uno por fase o por unidad lógica.

## Comandos

```bash
npm run dev              # servidor + workers en local
npm run db:generate      # genera migración desde el esquema Drizzle
npm run db:aprovisionar  # roles, propiedad y esquema pgboss (superusuario, idempotente)
npm run db:migrate       # aplica migraciones (rol app_owner)
npm run despacho:alta    # da de alta un despacho desde un JSON (app_owner)
npm run audios:registrar # registra los .ogg del despacho en la tabla audios
npm run panel:invitar    # acuña la invitación de alta de un usuario (app_owner)
npm test                 # unitarios de dominio, sin Docker
npm run test:integration # con Postgres real: concurrencia, RLS y agenda
                         # usa DATABASE_URL si está en el entorno; si no, levanta compose
npm run typecheck        # tsc --noEmit
npm run lint             # eslint
npm run lint:arch        # regla de dependencias entre anillos
```
