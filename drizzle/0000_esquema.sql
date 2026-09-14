CREATE TYPE "public"."cancelada_por" AS ENUM('contacto', 'estudio', 'sistema');--> statement-breakpoint
CREATE TYPE "public"."cita_estado" AS ENUM('reservada', 'confirmada', 'cancelada', 'atendida', 'ausente');--> statement-breakpoint
CREATE TYPE "public"."direccion_mensaje" AS ENUM('entrante', 'saliente');--> statement-breakpoint
CREATE TYPE "public"."modalidad" AS ENUM('presencial', 'virtual');--> statement-breakpoint
CREATE TYPE "public"."motivo_derivacion" AS ENUM('peticion_usuario', 'tres_fallos', 'error_sistema');--> statement-breakpoint
CREATE TYPE "public"."origen_bloqueo" AS ENUM('gcal', 'manual');--> statement-breakpoint
CREATE TABLE "abogados" (
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"nombre" text NOT NULL,
	"materias" text[] DEFAULT '{}'::text[] NOT NULL,
	"gcal_calendar_id" text,
	"gcal_refresh_token_enc" text,
	"activo" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "abogados_pkey" PRIMARY KEY("id"),
	CONSTRAINT "abogados_tenant_id_unico" UNIQUE("tenant_id","id")
);
--> statement-breakpoint
CREATE TABLE "audios" (
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"clave" text NOT NULL,
	"ruta" text NOT NULL,
	"wa_media_id" text,
	"subido_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "audios_pkey" PRIMARY KEY("id")
);
--> statement-breakpoint
CREATE TABLE "bloqueos" (
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"abogado_id" uuid NOT NULL,
	"inicia_at" timestamp with time zone NOT NULL,
	"termina_at" timestamp with time zone NOT NULL,
	"origen" "origen_bloqueo" NOT NULL,
	"external_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bloqueos_pkey" PRIMARY KEY("id"),
	CONSTRAINT "bloqueos_rango_valido" CHECK (termina_at > inicia_at)
);
--> statement-breakpoint
CREATE TABLE "citas" (
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"abogado_id" uuid NOT NULL,
	"contacto_id" uuid NOT NULL,
	"materia" text NOT NULL,
	"modalidad" "modalidad" NOT NULL,
	"inicia_at" timestamp with time zone NOT NULL,
	"termina_at" timestamp with time zone NOT NULL,
	"estado" "cita_estado" DEFAULT 'reservada' NOT NULL,
	"gcal_event_id" text,
	"honorario_usd" numeric(10, 2) NOT NULL,
	"confirmada_at" timestamp with time zone,
	"cancelada_por" "cancelada_por",
	"cancelada_at" timestamp with time zone,
	"cita_origen_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "citas_pkey" PRIMARY KEY("id"),
	CONSTRAINT "citas_tenant_id_unico" UNIQUE("tenant_id","id"),
	CONSTRAINT "citas_rango_valido" CHECK (termina_at > inicia_at),
	CONSTRAINT "citas_cancelacion_coherente" CHECK ((estado = 'cancelada') = (cancelada_at IS NOT NULL)),
	CONSTRAINT "citas_honorario_no_negativo" CHECK (honorario_usd >= 0)
);
--> statement-breakpoint
CREATE TABLE "contactos" (
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"wa_id" text NOT NULL,
	"nombre" text,
	"email" text,
	"cedula" text,
	"consent_at" timestamp with time zone,
	"consent_version" text,
	"consent_revocado_at" timestamp with time zone,
	"bloqueado" boolean DEFAULT false NOT NULL,
	"anonimizado_at" timestamp with time zone,
	"ultimo_inbound_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "contactos_pkey" PRIMARY KEY("id"),
	CONSTRAINT "contactos_tenant_id_unico" UNIQUE("tenant_id","id")
);
--> statement-breakpoint
CREATE TABLE "conversaciones" (
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"contacto_id" uuid NOT NULL,
	"estado" text NOT NULL,
	"contexto" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"flow_version" integer NOT NULL,
	"fallos_consecutivos" integer DEFAULT 0 NOT NULL,
	"derivada_at" timestamp with time zone,
	"derivada_motivo" "motivo_derivacion",
	"cerrada_at" timestamp with time zone,
	"ultimo_inbound_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expira_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "conversaciones_pkey" PRIMARY KEY("id"),
	CONSTRAINT "conversaciones_tenant_id_unico" UNIQUE("tenant_id","id"),
	CONSTRAINT "conversaciones_fallos_rango" CHECK (fallos_consecutivos BETWEEN 0 AND 3),
	CONSTRAINT "conversaciones_derivacion_coherente" CHECK ((derivada_at IS NULL) = (derivada_motivo IS NULL))
);
--> statement-breakpoint
CREATE TABLE "eventos" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "eventos_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"tenant_id" uuid NOT NULL,
	"actor" text NOT NULL,
	"tipo" text NOT NULL,
	"entidad" text,
	"entidad_id" text,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mensajes" (
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"conversacion_id" uuid NOT NULL,
	"wa_message_id" text,
	"direccion" "direccion_mensaje" NOT NULL,
	"tipo" text NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mensajes_pkey" PRIMARY KEY("id")
);
--> statement-breakpoint
CREATE TABLE "outbox" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "outbox_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"tenant_id" uuid NOT NULL,
	"tipo" text NOT NULL,
	"payload" jsonb NOT NULL,
	"idempotency_key" text NOT NULL,
	"intentos" integer DEFAULT 0 NOT NULL,
	"proximo_intento_at" timestamp with time zone DEFAULT now() NOT NULL,
	"publicado_at" timestamp with time zone,
	"ultimo_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "outbox_idempotencia_unica" UNIQUE("tenant_id","idempotency_key"),
	CONSTRAINT "outbox_intentos_no_negativos" CHECK (intentos >= 0)
);
--> statement-breakpoint
CREATE TABLE "reservas_mes" (
	"tenant_id" uuid NOT NULL,
	"contacto_id" uuid NOT NULL,
	"periodo" text NOT NULL,
	"total" integer DEFAULT 0 NOT NULL,
	"actualizado_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reservas_mes_pkey" PRIMARY KEY("tenant_id","contacto_id","periodo"),
	CONSTRAINT "reservas_mes_total_no_negativo" CHECK (total >= 0),
	CONSTRAINT "reservas_mes_periodo_formato" CHECK (periodo ~ '^[0-9]{4}-[0-9]{2}$')
);
--> statement-breakpoint
CREATE TABLE "tenant_config" (
	"tenant_id" uuid PRIMARY KEY NOT NULL,
	"tarifario" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"horarios" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"wa_waba_id" text NOT NULL,
	"wa_token_enc" text NOT NULL,
	"wa_app_secret_enc" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tenants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"nombre" text NOT NULL,
	"tz" text DEFAULT 'America/Guayaquil' NOT NULL,
	"wa_phone_number_id" text NOT NULL,
	"activo" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tenants_slug_unique" UNIQUE("slug"),
	CONSTRAINT "tenants_wa_phone_number_id_unique" UNIQUE("wa_phone_number_id")
);
--> statement-breakpoint
ALTER TABLE "abogados" ADD CONSTRAINT "abogados_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audios" ADD CONSTRAINT "audios_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bloqueos" ADD CONSTRAINT "bloqueos_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bloqueos" ADD CONSTRAINT "bloqueos_abogado_fk" FOREIGN KEY ("tenant_id","abogado_id") REFERENCES "public"."abogados"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "citas" ADD CONSTRAINT "citas_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "citas" ADD CONSTRAINT "citas_abogado_fk" FOREIGN KEY ("tenant_id","abogado_id") REFERENCES "public"."abogados"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "citas" ADD CONSTRAINT "citas_contacto_fk" FOREIGN KEY ("tenant_id","contacto_id") REFERENCES "public"."contactos"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "citas" ADD CONSTRAINT "citas_origen_fk" FOREIGN KEY ("tenant_id","cita_origen_id") REFERENCES "public"."citas"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contactos" ADD CONSTRAINT "contactos_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversaciones" ADD CONSTRAINT "conversaciones_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversaciones" ADD CONSTRAINT "conversaciones_contacto_fk" FOREIGN KEY ("tenant_id","contacto_id") REFERENCES "public"."contactos"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eventos" ADD CONSTRAINT "eventos_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mensajes" ADD CONSTRAINT "mensajes_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mensajes" ADD CONSTRAINT "mensajes_conversacion_fk" FOREIGN KEY ("tenant_id","conversacion_id") REFERENCES "public"."conversaciones"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbox" ADD CONSTRAINT "outbox_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reservas_mes" ADD CONSTRAINT "reservas_mes_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reservas_mes" ADD CONSTRAINT "reservas_mes_contacto_fk" FOREIGN KEY ("tenant_id","contacto_id") REFERENCES "public"."contactos"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_config" ADD CONSTRAINT "tenant_config_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "abogados_por_tenant" ON "abogados" USING btree ("tenant_id","activo");--> statement-breakpoint
CREATE UNIQUE INDEX "audios_clave_unica" ON "audios" USING btree ("tenant_id","clave");--> statement-breakpoint
CREATE INDEX "audios_por_subida" ON "audios" USING btree ("tenant_id","subido_at");--> statement-breakpoint
CREATE UNIQUE INDEX "bloqueos_externo_unico" ON "bloqueos" USING btree ("tenant_id","abogado_id","origen","external_id") WHERE external_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX "bloqueos_por_abogado" ON "bloqueos" USING btree ("tenant_id","abogado_id","inicia_at");--> statement-breakpoint
CREATE UNIQUE INDEX "citas_slot_unico" ON "citas" USING btree ("tenant_id","abogado_id","inicia_at") WHERE estado <> 'cancelada';--> statement-breakpoint
CREATE UNIQUE INDEX "citas_una_activa_por_contacto" ON "citas" USING btree ("tenant_id","contacto_id") WHERE estado IN ('reservada', 'confirmada');--> statement-breakpoint
CREATE UNIQUE INDEX "citas_gcal_event_unico" ON "citas" USING btree ("tenant_id","gcal_event_id") WHERE gcal_event_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX "citas_por_fecha" ON "citas" USING btree ("tenant_id","inicia_at");--> statement-breakpoint
CREATE INDEX "citas_por_estado" ON "citas" USING btree ("tenant_id","estado","inicia_at");--> statement-breakpoint
CREATE UNIQUE INDEX "contactos_wa_id_unico" ON "contactos" USING btree ("tenant_id","wa_id");--> statement-breakpoint
CREATE INDEX "contactos_por_actividad" ON "contactos" USING btree ("tenant_id","ultimo_inbound_at");--> statement-breakpoint
CREATE UNIQUE INDEX "conversaciones_abierta_unica" ON "conversaciones" USING btree ("tenant_id","contacto_id") WHERE cerrada_at IS NULL;--> statement-breakpoint
CREATE INDEX "conversaciones_derivadas" ON "conversaciones" USING btree ("tenant_id","derivada_at") WHERE derivada_at IS NOT NULL AND cerrada_at IS NULL;--> statement-breakpoint
CREATE INDEX "conversaciones_por_expiracion" ON "conversaciones" USING btree ("tenant_id","expira_at") WHERE cerrada_at IS NULL;--> statement-breakpoint
CREATE INDEX "eventos_por_fecha" ON "eventos" USING btree ("tenant_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "mensajes_wa_id_unico" ON "mensajes" USING btree ("tenant_id","wa_message_id") WHERE wa_message_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX "mensajes_por_conversacion" ON "mensajes" USING btree ("tenant_id","conversacion_id","created_at");--> statement-breakpoint
CREATE INDEX "mensajes_por_fecha" ON "mensajes" USING btree ("tenant_id","created_at");--> statement-breakpoint
CREATE INDEX "outbox_pendiente" ON "outbox" USING btree ("tenant_id","proximo_intento_at") WHERE publicado_at IS NULL;