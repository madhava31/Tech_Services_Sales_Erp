-- Lock the database against Supabase's public Data API.
--
-- Supabase publishes every table in the public schema through a REST API that anyone holding the project's public
-- ("anon") key can call, and by default grants that role access to new tables. This app never uses that API:
-- the server talks to Postgres directly, as the owner of the tables, and the owner bypasses row security. So the
-- safe setup is deny-all for the public roles: row security on for every table (with no policies, nothing is
-- visible or writable through the API) and no table privileges for anon / authenticated.
--
-- No policy "to see your own data" is written on purpose: nothing here is meant to be read by a browser holding a
-- key. People sign in to this app, not to Supabase, and every rule is applied by the server.
-- Additive: it changes no data, and the app's own connection is unaffected.

DO $$
DECLARE t RECORD;
BEGIN
  FOR t IN SELECT tablename FROM pg_tables WHERE schemaname = 'public' LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t.tablename);
  END LOOP;

  -- Only on Supabase: these roles do not exist on a plain Postgres.
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') AND EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'REVOKE ALL ON ALL TABLES IN SCHEMA public FROM anon, authenticated';
    EXECUTE 'REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM anon, authenticated';
    EXECUTE 'REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM anon, authenticated';
    -- Tables and functions made later by this role start out closed too.
    EXECUTE 'ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM anon, authenticated';
    EXECUTE 'ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM anon, authenticated';
    EXECUTE 'ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON FUNCTIONS FROM anon, authenticated';
  END IF;
END $$;
