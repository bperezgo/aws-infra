-- Empty the app's DATA tables in laguna_escondida before a data-only import, so
-- there are no primary-key collisions with any rows the app's migrations seeded.
-- The migration-bookkeeping table is PRESERVED (it records the schema version the
-- app migrated to; the DO data-only dump excludes it, so RDS stays the source of
-- truth for "which migrations have run").
--
-- Run with: scripts/db/run-sql.sh scripts/db/truncate-data.sql
--
-- Connects as master dbadmin (from the RDS secret) and SET ROLEs to laguna_app,
-- which OWNS the tables — TRUNCATE requires ownership. dbadmin is a member of
-- laguna_app (granted in create-laguna-role.sql), so the SET ROLE is allowed.
--
-- DESTRUCTIVE: scale the app to 0 first (no writers) — see import runbook.
\connect laguna_escondida
SET ROLE laguna_app;

DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT tablename
    FROM pg_tables
    WHERE schemaname = 'public'
      AND tablename !~* '(schema_migrations|goose_db_version|flyway_schema_history|alembic_version|knex_migrations|migrations)'
  LOOP
    RAISE NOTICE 'truncating %', r.tablename;
    -- RESTART IDENTITY resets sequences; the import's setval() then restores the
    -- real values from DO. CASCADE handles FK-referenced tables in any order.
    EXECUTE format('TRUNCATE TABLE public.%I RESTART IDENTITY CASCADE', r.tablename);
  END LOOP;
END $$;

\echo '--- data tables truncated (migration bookkeeping preserved) ---'
