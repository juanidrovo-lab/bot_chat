/**
 * Esquema Drizzle · §4 del plan (v3).
 *
 * Reglas que este archivo hace cumplir y que conviene no perder de vista:
 *
 * 1. Todo índice de escaneo sobre una tabla con `tenant_id` empieza por `tenant_id`,
 *    porque la política de RLS es el primer predicado del plan. La única excepción son
 *    las claves primarias subrogadas (`id`), que son únicas globalmente y solo se usan
 *    para búsquedas puntuales.
 * 2. Ninguna restricción UNIQUE cruza tenants. Un índice único global se sigue evaluando
 *    por debajo de la RLS: la fila en conflicto sería invisible y un `ON CONFLICT DO
 *    NOTHING` descartaría en silencio un dato legítimo de otro despacho.
 * 3. Las claves foráneas son compuestas `(tenant_id, id)`. Así el motor impide que una
 *    cita del despacho A apunte a un abogado del despacho B.
 * 4. Los límites de negocio que el plan enunciaba como política (§6) son restricciones:
 *    una cita activa por contacto es un índice único parcial, y el tope mensual de
 *    reservas es un contador con incremento condicional. Ninguno se comprueba leyendo
 *    antes de escribir.
 */
import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

/** Marca temporal: siempre UTC. Se formatea con `platform/time.ts`. */
const instante = (nombre: string) => timestamp(nombre, { withTimezone: true, mode: 'date' });
const creadoEn = () => instante('created_at').notNull().defaultNow();
const editadoEn = () => instante('updated_at').notNull().defaultNow();

export const citaEstado = pgEnum('cita_estado', [
  'reservada',
  'confirmada',
  'cancelada',
  'atendida',
  'ausente',
]);
export const modalidad = pgEnum('modalidad', ['presencial', 'virtual']);
export const direccionMensaje = pgEnum('direccion_mensaje', ['entrante', 'saliente']);
export const origenBloqueo = pgEnum('origen_bloqueo', ['gcal', 'manual']);
export const canceladaPor = pgEnum('cancelada_por', ['contacto', 'estudio', 'sistema']);
export const motivoDerivacion = pgEnum('motivo_derivacion', [
  'peticion_usuario',
  'tres_fallos',
  'error_sistema',
]);

/**
 * Identidad y enrutamiento del despacho. Es la única tabla sin `tenant_id` y, por tanto,
 * sin RLS: el webhook tiene que resolver el tenant a partir de `wa_phone_number_id`
 * ANTES de poder fijar `app.tenant_id`, y el planificador de jobs necesita recorrer la
 * lista de despachos. Aquí no vive ningún secreto ni ningún dato de negocio.
 */
export const tenants = pgTable('tenants', {
  id: uuid('id').primaryKey().defaultRandom(),
  slug: text('slug').notNull().unique(),
  nombre: text('nombre').notNull(),
  tz: text('tz').notNull().default('America/Guayaquil'),
  waPhoneNumberId: text('wa_phone_number_id').notNull().unique(),
  activo: boolean('activo').notNull().default(true),
  createdAt: creadoEn(),
  updatedAt: editadoEn(),
});

/**
 * Configuración y secretos del despacho, separados de `tenants` justamente porque esta
 * tabla sí lleva `tenant_id` y sí queda bajo RLS. Los tokens de WhatsApp se guardan
 * cifrados con AES-256-GCM (`platform/crypto.ts`), nunca en claro.
 */
export const tenantConfig = pgTable('tenant_config', {
  tenantId: uuid('tenant_id')
    .primaryKey()
    .references(() => tenants.id, { onDelete: 'cascade' }),
  tarifario: jsonb('tarifario').notNull().default(sql`'{}'::jsonb`),
  horarios: jsonb('horarios').notNull().default(sql`'{}'::jsonb`),
  waWabaId: text('wa_waba_id').notNull(),
  waTokenEnc: text('wa_token_enc').notNull(),
  waAppSecretEnc: text('wa_app_secret_enc').notNull(),
  updatedAt: editadoEn(),
});

export const abogados = pgTable(
  'abogados',
  {
    id: uuid('id').notNull().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    nombre: text('nombre').notNull(),
    /**
     * Lista abierta a propósito: cada despacho define sus materias en
     * `tenant_config.tarifario`. Un enum de Postgres obligaría a migrar la base para
     * admitir al cliente que trabaja una materia distinta. El conjunto cerrado que
     * valida la salida del clasificador vive en el dominio, por tenant.
     */
    materias: text('materias').array().notNull().default(sql`'{}'::text[]`),
    gcalCalendarId: text('gcal_calendar_id'),
    gcalRefreshTokenEnc: text('gcal_refresh_token_enc'),
    activo: boolean('activo').notNull().default(true),
    createdAt: creadoEn(),
    updatedAt: editadoEn(),
  },
  (t) => [
    primaryKey({ columns: [t.id], name: 'abogados_pkey' }),
    unique('abogados_tenant_id_unico').on(t.tenantId, t.id),
    index('abogados_por_tenant').on(t.tenantId, t.activo),
  ],
);

export const contactos = pgTable(
  'contactos',
  {
    id: uuid('id').notNull().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    waId: text('wa_id').notNull(),
    nombre: text('nombre'),
    email: text('email'),
    cedula: text('cedula'),
    consentAt: instante('consent_at'),
    consentVersion: text('consent_version'),
    /** LOPDP: el consentimiento se puede retirar, y retirarlo no borra la cita ya pactada. */
    consentRevocadoAt: instante('consent_revocado_at'),
    bloqueado: boolean('bloqueado').notNull().default(false),
    /** Fase 6: anonimización tras 12 meses sin actividad. */
    anonimizadoAt: instante('anonimizado_at'),
    ultimoInboundAt: instante('ultimo_inbound_at'),
    createdAt: creadoEn(),
    updatedAt: editadoEn(),
  },
  (t) => [
    primaryKey({ columns: [t.id], name: 'contactos_pkey' }),
    unique('contactos_tenant_id_unico').on(t.tenantId, t.id),
    uniqueIndex('contactos_wa_id_unico').on(t.tenantId, t.waId),
    index('contactos_por_actividad').on(t.tenantId, t.ultimoInboundAt),
  ],
);

export const conversaciones = pgTable(
  'conversaciones',
  {
    id: uuid('id').notNull().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    contactoId: uuid('contacto_id').notNull(),
    /**
     * Texto libre, no enum: los estados de §5 cambian con la máquina y `flow_version` es
     * justamente el mecanismo previsto para que una conversación vieja no se cuelgue.
     * Un enum de Postgres convertiría cada retoque del guion en una migración.
     */
    estado: text('estado').notNull(),
    contexto: jsonb('contexto').notNull().default(sql`'{}'::jsonb`),
    flowVersion: integer('flow_version').notNull(),
    fallosConsecutivos: integer('fallos_consecutivos').notNull().default(0),
    derivadaAt: instante('derivada_at'),
    derivadaMotivo: motivoDerivacion('derivada_motivo'),
    cerradaAt: instante('cerrada_at'),
    ultimoInboundAt: instante('ultimo_inbound_at').notNull().defaultNow(),
    /** Ventana de servicio de 24 h de WhatsApp. Fuera de ella solo entran plantillas. */
    expiraAt: instante('expira_at').notNull(),
    createdAt: creadoEn(),
    updatedAt: editadoEn(),
  },
  (t) => [
    primaryKey({ columns: [t.id], name: 'conversaciones_pkey' }),
    unique('conversaciones_tenant_id_unico').on(t.tenantId, t.id),
    foreignKey({
      columns: [t.tenantId, t.contactoId],
      foreignColumns: [contactos.tenantId, contactos.id],
      name: 'conversaciones_contacto_fk',
    }),
    /**
     * Una sola conversación abierta por contacto. Sin esto, dos mensajes simultáneos de
     * un usuario nuevo abren dos conversaciones y la serialización por
     * `singletonKey = conversacion_id` deja de serializar nada.
     */
    uniqueIndex('conversaciones_abierta_unica')
      .on(t.tenantId, t.contactoId)
      .where(sql`cerrada_at IS NULL`),
    index('conversaciones_derivadas')
      .on(t.tenantId, t.derivadaAt)
      .where(sql`derivada_at IS NOT NULL AND cerrada_at IS NULL`),
    index('conversaciones_por_expiracion')
      .on(t.tenantId, t.expiraAt)
      .where(sql`cerrada_at IS NULL`),
    check('conversaciones_fallos_rango', sql`fallos_consecutivos BETWEEN 0 AND 3`),
    check(
      'conversaciones_derivacion_coherente',
      sql`(derivada_at IS NULL) = (derivada_motivo IS NULL)`,
    ),
  ],
);

export const mensajes = pgTable(
  'mensajes',
  {
    id: uuid('id').notNull().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    conversacionId: uuid('conversacion_id').notNull(),
    /** Nulo en los salientes hasta que Meta devuelve el identificador del envío. */
    waMessageId: text('wa_message_id'),
    direccion: direccionMensaje('direccion').notNull(),
    tipo: text('tipo').notNull(),
    /** PII: nunca se registra en logs ni en Sentry. */
    payload: jsonb('payload').notNull(),
    createdAt: creadoEn(),
  },
  (t) => [
    primaryKey({ columns: [t.id], name: 'mensajes_pkey' }),
    foreignKey({
      columns: [t.tenantId, t.conversacionId],
      foreignColumns: [conversaciones.tenantId, conversaciones.id],
      name: 'mensajes_conversacion_fk',
    }),
    /**
     * Patrón inbox. Acotado al tenant a propósito: un índice único global sobre
     * `wa_message_id` se evalúa por debajo de la RLS, así que un choque con la fila de
     * otro despacho haría que `ON CONFLICT DO NOTHING` tratara un mensaje nuevo como
     * duplicado y lo descartara sin dejar rastro.
     */
    uniqueIndex('mensajes_wa_id_unico')
      .on(t.tenantId, t.waMessageId)
      .where(sql`wa_message_id IS NOT NULL`),
    index('mensajes_por_conversacion').on(t.tenantId, t.conversacionId, t.createdAt),
    /** Retención: borrado de mensajes con más de 90 días. */
    index('mensajes_por_fecha').on(t.tenantId, t.createdAt),
  ],
);

export const citas = pgTable(
  'citas',
  {
    id: uuid('id').notNull().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    abogadoId: uuid('abogado_id').notNull(),
    contactoId: uuid('contacto_id').notNull(),
    materia: text('materia').notNull(),
    modalidad: modalidad('modalidad').notNull(),
    iniciaAt: instante('inicia_at').notNull(),
    terminaAt: instante('termina_at').notNull(),
    estado: citaEstado('estado').notNull().default('reservada'),
    gcalEventId: text('gcal_event_id'),
    /** Dinero en `numeric`, nunca en coma flotante. */
    honorarioUsd: numeric('honorario_usd', { precision: 10, scale: 2 }).notNull(),
    confirmadaAt: instante('confirmada_at'),
    canceladaPor: canceladaPor('cancelada_por'),
    canceladaAt: instante('cancelada_at'),
    /** Reagendar es cancelar y volver a reservar; esto enlaza ambas para la métrica. */
    citaOrigenId: uuid('cita_origen_id'),
    createdAt: creadoEn(),
    updatedAt: editadoEn(),
  },
  (t) => [
    primaryKey({ columns: [t.id], name: 'citas_pkey' }),
    unique('citas_tenant_id_unico').on(t.tenantId, t.id),
    foreignKey({
      columns: [t.tenantId, t.abogadoId],
      foreignColumns: [abogados.tenantId, abogados.id],
      name: 'citas_abogado_fk',
    }),
    foreignKey({
      columns: [t.tenantId, t.contactoId],
      foreignColumns: [contactos.tenantId, contactos.id],
      name: 'citas_contacto_fk',
    }),
    foreignKey({
      columns: [t.tenantId, t.citaOrigenId],
      foreignColumns: [t.tenantId, t.id],
      name: 'citas_origen_fk',
    }),
    /** La restricción que impide la doble reserva (§4.2). */
    uniqueIndex('citas_slot_unico')
      .on(t.tenantId, t.abogadoId, t.iniciaAt)
      .where(sql`estado <> 'cancelada'`),
    /** «Máx. 1 cita activa por contacto» (§6), como restricción y no como consulta previa. */
    uniqueIndex('citas_una_activa_por_contacto')
      .on(t.tenantId, t.contactoId)
      .where(sql`estado IN ('reservada', 'confirmada')`),
    /** El evento de Google es un espejo: a una cita le corresponde como mucho uno. */
    uniqueIndex('citas_gcal_event_unico')
      .on(t.tenantId, t.gcalEventId)
      .where(sql`gcal_event_id IS NOT NULL`),
    /** Pantalla «hoy y mañana» del panel. */
    index('citas_por_fecha').on(t.tenantId, t.iniciaAt),
    index('citas_por_estado').on(t.tenantId, t.estado, t.iniciaAt),
    check('citas_rango_valido', sql`termina_at > inicia_at`),
    check(
      'citas_cancelacion_coherente',
      sql`(estado = 'cancelada') = (cancelada_at IS NOT NULL)`,
    ),
    check('citas_honorario_no_negativo', sql`honorario_usd >= 0`),
  ],
);

/**
 * Tope de reservas por contacto y mes (§6: 3 por `wa_id`). No se puede expresar como
 * índice único, así que es un contador con incremento condicional:
 *
 *   INSERT ... ON CONFLICT (...) DO UPDATE SET total = total + 1 WHERE total < $limite
 *
 * Si la sentencia no devuelve fila, el tope está alcanzado. El bloqueo de fila que toma
 * el `DO UPDATE` serializa los intentos simultáneos, de modo que no hay ventana entre
 * contar y reservar. El contador cuenta reservas hechas, no citas vigentes: cancelar y
 * volver a reservar consume cupo, que es justamente lo que frena el spam.
 */
export const reservasMes = pgTable(
  'reservas_mes',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    contactoId: uuid('contacto_id').notNull(),
    /** `YYYY-MM` en America/Guayaquil, no en UTC: el mes es el del calendario local. */
    periodo: text('periodo').notNull(),
    total: integer('total').notNull().default(0),
    actualizadoAt: instante('actualizado_at').notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.contactoId, t.periodo], name: 'reservas_mes_pkey' }),
    foreignKey({
      columns: [t.tenantId, t.contactoId],
      foreignColumns: [contactos.tenantId, contactos.id],
      name: 'reservas_mes_contacto_fk',
    }),
    check('reservas_mes_total_no_negativo', sql`total >= 0`),
    check('reservas_mes_periodo_formato', sql`periodo ~ '^[0-9]{4}-[0-9]{2}$'`),
  ],
);

export const bloqueos = pgTable(
  'bloqueos',
  {
    id: uuid('id').notNull().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    abogadoId: uuid('abogado_id').notNull(),
    iniciaAt: instante('inicia_at').notNull(),
    terminaAt: instante('termina_at').notNull(),
    origen: origenBloqueo('origen').notNull(),
    externalId: text('external_id'),
    createdAt: creadoEn(),
  },
  (t) => [
    primaryKey({ columns: [t.id], name: 'bloqueos_pkey' }),
    foreignKey({
      columns: [t.tenantId, t.abogadoId],
      foreignColumns: [abogados.tenantId, abogados.id],
      name: 'bloqueos_abogado_fk',
    }),
    /** Hace idempotente el `syncCalendar` de cada 5 minutos. */
    uniqueIndex('bloqueos_externo_unico')
      .on(t.tenantId, t.abogadoId, t.origen, t.externalId)
      .where(sql`external_id IS NOT NULL`),
    index('bloqueos_por_abogado').on(t.tenantId, t.abogadoId, t.iniciaAt),
    check('bloqueos_rango_valido', sql`termina_at > inicia_at`),
  ],
);

/**
 * Outbox transaccional (§4.3 del plan, D9). La clave primaria es un entero creciente
 * porque el relay necesita orden de publicación; no empieza por `tenant_id` y no hace
 * falta que lo haga: es única globalmente y solo se usa para búsquedas puntuales.
 */
export const outbox = pgTable(
  'outbox',
  {
    id: bigint('id', { mode: 'bigint' }).generatedAlwaysAsIdentity().primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    tipo: text('tipo').notNull(),
    payload: jsonb('payload').notNull(),
    idempotencyKey: text('idempotency_key').notNull(),
    intentos: integer('intentos').notNull().default(0),
    proximoIntentoAt: instante('proximo_intento_at').notNull().defaultNow(),
    publicadoAt: instante('publicado_at'),
    /** Se guarda ya redactado: un error de la API puede traer PII en el cuerpo. */
    ultimoError: text('ultimo_error'),
    createdAt: creadoEn(),
  },
  (t) => [
    unique('outbox_idempotencia_unica').on(t.tenantId, t.idempotencyKey),
    /** Cola del relay: `FOR UPDATE SKIP LOCKED` sobre este índice. */
    index('outbox_pendiente')
      .on(t.tenantId, t.proximoIntentoAt)
      .where(sql`publicado_at IS NULL`),
    check('outbox_intentos_no_negativos', sql`intentos >= 0`),
  ],
);

export const audios = pgTable(
  'audios',
  {
    id: uuid('id').notNull().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    clave: text('clave').notNull(),
    ruta: text('ruta').notNull(),
    waMediaId: text('wa_media_id'),
    subidoAt: instante('subido_at'),
    createdAt: creadoEn(),
  },
  (t) => [
    primaryKey({ columns: [t.id], name: 'audios_pkey' }),
    uniqueIndex('audios_clave_unica').on(t.tenantId, t.clave),
    /** Los `media_id` caducan a los 30 días: job diario para los de más de 25. */
    index('audios_por_subida').on(t.tenantId, t.subidoAt),
  ],
);

/** Auditoría LOPDP: todo acceso a datos personales deja rastro aquí. */
export const eventos = pgTable(
  'eventos',
  {
    id: bigint('id', { mode: 'bigint' }).generatedAlwaysAsIdentity().primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    actor: text('actor').notNull(),
    tipo: text('tipo').notNull(),
    entidad: text('entidad'),
    entidadId: text('entidad_id'),
    payload: jsonb('payload').notNull().default(sql`'{}'::jsonb`),
    createdAt: creadoEn(),
  },
  (t) => [index('eventos_por_fecha').on(t.tenantId, t.createdAt)],
);

/** Tablas con `tenant_id`: todas llevan ENABLE y FORCE ROW LEVEL SECURITY. */
export const TABLAS_CON_RLS = [
  'tenant_config',
  'abogados',
  'contactos',
  'conversaciones',
  'mensajes',
  'citas',
  'reservas_mes',
  'bloqueos',
  'outbox',
  'audios',
  'eventos',
] as const;
