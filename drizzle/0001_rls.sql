-- Aislamiento entre despachos · §4.3 del plan.
--
-- Lo que impone este archivo y por qué, porque cada línea tapa una forma concreta de
-- filtrar consultas jurídicas de un despacho a otro:
--
--   * ENABLE y además FORCE. Sin FORCE, el dueño de la tabla ignora las políticas en
--     silencio, y «en silencio» es exactamente lo que no queremos.
--   * La política es TO PUBLIC, no TO app_user. Así app_owner también queda sujeto y el
--     test de RLS demuestra el aislamiento incluso para el rol de migraciones.
--   * current_setting(..., true): la forma de dos argumentos devuelve NULL en vez de
--     lanzar excepción si nadie fijó el tenant. Combinado con `tenant_id = NULL`, que es
--     NULL y por tanto falso, el comportamiento por defecto es no ver nada.
--   * NULLIF(..., ''): si el valor llega como cadena vacía, `''::uuid` reventaría con un
--     error de conversión en mitad de una consulta de negocio en vez de devolver cero
--     filas.
--
-- `tenants` es la única tabla sin tenant_id y, deliberadamente, sin RLS: el webhook debe
-- resolver el despacho a partir de `wa_phone_number_id` ANTES de poder fijar
-- `app.tenant_id`, y el planificador de jobs necesita recorrer la lista. Por eso no
-- guarda ningún secreto: esos viven en `tenant_config`, que sí está protegida.

--------------------------------------------------------------------------------
-- 1. Roles
--------------------------------------------------------------------------------
-- Se crean sin LOGIN ni contraseña. Las credenciales se asignan fuera del control de
-- versiones (`docker/postgres-init.sh` en local, el runbook en producción):
--   ALTER ROLE app_user WITH LOGIN PASSWORD '...';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_owner') THEN
    CREATE ROLE app_owner;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_user') THEN
    CREATE ROLE app_user;
  END IF;
  -- Solo para `pg_dump`: sin BYPASSRLS el backup exporta cero filas.
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_dump') THEN
    CREATE ROLE app_dump BYPASSRLS;
  END IF;
END
$$;

--------------------------------------------------------------------------------
-- 2. Privilegios
--------------------------------------------------------------------------------
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO app_user, app_dump;

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_user;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO app_user;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO app_dump;

-- Identidad y configuración del despacho son de solo lectura para la aplicación: dar de
-- alta un tenant o rotar sus credenciales es una tarea administrativa que corre como
-- app_owner (§ runbook), no algo que pueda hacer una petición del webhook.
REVOKE INSERT, UPDATE, DELETE ON TABLE tenants FROM app_user;
REVOKE INSERT, UPDATE, DELETE ON TABLE tenant_config FROM app_user;

-- Que las tablas que se creen en migraciones futuras hereden lo mismo sin acordarse.
ALTER DEFAULT PRIVILEGES FOR ROLE app_owner IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_user;
ALTER DEFAULT PRIVILEGES FOR ROLE app_owner IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO app_user;
ALTER DEFAULT PRIVILEGES FOR ROLE app_owner IN SCHEMA public
  GRANT SELECT ON TABLES TO app_dump;

-- pg-boss crea sus propias tablas al arrancar y necesita poder hacerlo en su esquema.
CREATE SCHEMA IF NOT EXISTS pgboss AUTHORIZATION app_owner;
GRANT USAGE, CREATE ON SCHEMA pgboss TO app_user;

--------------------------------------------------------------------------------
-- 3. Row-Level Security
--------------------------------------------------------------------------------
DO $$
DECLARE
  t text;
  tablas text[] := ARRAY[
    'tenant_config', 'abogados', 'contactos', 'conversaciones', 'mensajes',
    'citas', 'reservas_mes', 'bloqueos', 'outbox', 'audios', 'eventos'
  ];
BEGIN
  FOREACH t IN ARRAY tablas LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE  ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS aislamiento_tenant ON %I', t);
    EXECUTE format($f$
      CREATE POLICY aislamiento_tenant ON %I
        FOR ALL
        TO PUBLIC
        USING      (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
        WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    $f$, t);
  END LOOP;
END
$$;

--------------------------------------------------------------------------------
-- 4. Red de seguridad: ninguna tabla con tenant_id puede quedarse sin protección
--------------------------------------------------------------------------------
-- Si una migración futura añade una tabla con tenant_id y olvida la política, esta
-- comprobación hace fallar la migración en vez de dejar un agujero silencioso.
DO $$
DECLARE
  desprotegidas text;
BEGIN
  SELECT string_agg(c.relname, ', ')
    INTO desprotegidas
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'tenant_id' AND a.attnum > 0
   WHERE n.nspname = 'public'
     AND c.relkind = 'r'
     AND NOT (c.relrowsecurity AND c.relforcerowsecurity);

  IF desprotegidas IS NOT NULL THEN
    RAISE EXCEPTION 'Tablas con tenant_id sin ENABLE+FORCE ROW LEVEL SECURITY: %', desprotegidas;
  END IF;
END
$$;
