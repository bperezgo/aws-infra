-- Bootstrap the laguna_escondida database on the shared RDS instance.
--
-- Run with:  scripts/db/run-sql.sh scripts/db/bootstrap.sql
-- (requires the bryan-dev-dbadmin stack to be deployed first).
--
-- Idempotent: safe to run repeatedly. Postgres has no "CREATE DATABASE IF NOT
-- EXISTS", so we generate the CREATE statement only when the database is absent
-- and run it with psql's \gexec (which executes each returned row as SQL).
-- CREATE DATABASE cannot run inside a transaction; psql autocommits here, so this
-- is fine.
SELECT 'CREATE DATABASE laguna_escondida'
WHERE NOT EXISTS (
  SELECT FROM pg_database WHERE datname = 'laguna_escondida'
)\gexec

-- Show the result so the task logs confirm the database exists.
\echo '--- databases on this instance ---'
SELECT datname FROM pg_database WHERE datistemplate = false ORDER BY datname;
