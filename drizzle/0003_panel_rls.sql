-- Aislamiento de las tablas del panel · fase 7.
--
-- Las cuatro tablas nuevas llevan `tenant_id`, así que la red de seguridad de
-- `0001_rls.sql` haría fallar la siguiente migración si se quedaran sin proteger. Eso ya
-- sería suficiente motivo, pero aquí hay uno más concreto: `sesiones` y `credenciales`
-- son lo que decide quién entra al panel. Una credencial visible desde otro despacho no
-- es una fuga de datos, es una llave.
--
-- El `GRANT` explícito existe porque `ALTER DEFAULT PRIVILEGES` solo alcanza a lo que crea
-- app_owner *después* de fijarlo, y es más barato repetirlo que depender de ese orden.

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE usuarios, credenciales, retos, sesiones TO app_user;
GRANT SELECT ON TABLE usuarios, credenciales, retos, sesiones TO app_dump;

-- Dar de alta a un usuario del panel es administrativo, igual que dar de alta un despacho:
-- la aplicación puede leerlos y anotar su último acceso, no crearlos ni borrarlos.
REVOKE INSERT, DELETE ON TABLE usuarios FROM app_user;

DO $$
DECLARE
  t text;
  tablas text[] := ARRAY['usuarios', 'credenciales', 'retos', 'sesiones'];
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

-- Misma comprobación que en 0001: si esta migración olvidara una tabla, que falle aquí y
-- no dentro de seis meses.
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
