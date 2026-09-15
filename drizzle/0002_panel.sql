CREATE TYPE "public"."proposito_reto" AS ENUM('registro', 'acceso');--> statement-breakpoint
CREATE TYPE "public"."rol_panel" AS ENUM('abogado', 'secretaria');--> statement-breakpoint
CREATE TABLE "credenciales" (
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"usuario_id" uuid NOT NULL,
	"credencial_id" text NOT NULL,
	"clave_publica" text NOT NULL,
	"contador" bigint DEFAULT 0 NOT NULL,
	"transportes" text[] DEFAULT '{}'::text[] NOT NULL,
	"apodo" text,
	"ultimo_uso_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "credenciales_pkey" PRIMARY KEY("id")
);
--> statement-breakpoint
CREATE TABLE "retos" (
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"reto" text NOT NULL,
	"proposito" "proposito_reto" NOT NULL,
	"usuario_id" uuid,
	"expira_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "retos_pkey" PRIMARY KEY("id")
);
--> statement-breakpoint
CREATE TABLE "sesiones" (
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"usuario_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"expira_at" timestamp with time zone NOT NULL,
	"ultimo_uso_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sesiones_pkey" PRIMARY KEY("id")
);
--> statement-breakpoint
CREATE TABLE "usuarios" (
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"email" text NOT NULL,
	"nombre" text NOT NULL,
	"rol" "rol_panel" DEFAULT 'abogado' NOT NULL,
	"abogado_id" uuid,
	"activo" boolean DEFAULT true NOT NULL,
	"ultimo_acceso_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "usuarios_pkey" PRIMARY KEY("id"),
	CONSTRAINT "usuarios_tenant_id_unico" UNIQUE("tenant_id","id")
);
--> statement-breakpoint
ALTER TABLE "credenciales" ADD CONSTRAINT "credenciales_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credenciales" ADD CONSTRAINT "credenciales_usuario_fk" FOREIGN KEY ("tenant_id","usuario_id") REFERENCES "public"."usuarios"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retos" ADD CONSTRAINT "retos_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sesiones" ADD CONSTRAINT "sesiones_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sesiones" ADD CONSTRAINT "sesiones_usuario_fk" FOREIGN KEY ("tenant_id","usuario_id") REFERENCES "public"."usuarios"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usuarios" ADD CONSTRAINT "usuarios_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usuarios" ADD CONSTRAINT "usuarios_abogado_fk" FOREIGN KEY ("tenant_id","abogado_id") REFERENCES "public"."abogados"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "credenciales_id_unico" ON "credenciales" USING btree ("tenant_id","credencial_id");--> statement-breakpoint
CREATE INDEX "credenciales_por_usuario" ON "credenciales" USING btree ("tenant_id","usuario_id");--> statement-breakpoint
CREATE UNIQUE INDEX "retos_valor_unico" ON "retos" USING btree ("tenant_id","reto");--> statement-breakpoint
CREATE INDEX "retos_por_expiracion" ON "retos" USING btree ("tenant_id","expira_at");--> statement-breakpoint
CREATE UNIQUE INDEX "sesiones_token_unico" ON "sesiones" USING btree ("tenant_id","token_hash");--> statement-breakpoint
CREATE INDEX "sesiones_por_expiracion" ON "sesiones" USING btree ("tenant_id","expira_at");--> statement-breakpoint
CREATE UNIQUE INDEX "usuarios_email_unico" ON "usuarios" USING btree ("tenant_id","email");