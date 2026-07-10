-- Inspect the laguna_escondida database: table list, estimated row counts, and
-- which migration-bookkeeping table is present. Read-only — safe to run anytime.
--
-- Run with: scripts/db/run-sql.sh scripts/db/inspect.sql
--
-- Use it BEFORE the DO import (to see the app-migrated schema + confirm the
-- migration table name to exclude/preserve) and AFTER (to sanity-check row counts
-- landed). Counts are planner estimates (n_live_tup); spot-check exact counts on
-- specific tables if a number looks off.
\connect laguna_escondida

\echo '--- public tables + estimated row counts ---'
SELECT relname AS table_name, n_live_tup AS est_rows
FROM pg_stat_user_tables
WHERE schemaname = 'public'
ORDER BY relname;

\echo '--- migration-bookkeeping table(s) present (preserved by truncate/import) ---'
SELECT tablename
FROM pg_tables
WHERE schemaname = 'public'
  AND tablename ~* '(schema_migrations|goose_db_version|flyway_schema_history|alembic_version|knex_migrations|migrations)';

\echo '--- migration-bookkeeping CONTENTS (real schema version on this DB) ---'
-- The counts above are planner ESTIMATES (n_live_tup); this shows the ACTUAL rows.
-- Migration tools differ: golang-migrate (table `schema_migrations`) keeps a SINGLE
-- row -> (version, dirty), where `version` is the latest applied migration id -- so
-- 1 row is normal and a value like 51 means version=51, NOT 51 rows. goose/rails
-- keep one row per migration. \gexec runs a real SELECT against whichever migration
-- table exists so you see the true version. Compare this to the DO database before a
-- data-only import: the versions must match (same schema) or the import is unsafe.
SELECT format('SELECT * FROM public.%I', tablename)
FROM pg_tables
WHERE schemaname = 'public'
  AND tablename ~* '(schema_migrations|goose_db_version|flyway_schema_history|alembic_version|knex_migrations|migrations)'
\gexec
