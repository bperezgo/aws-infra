-- Create the read-only role `laguna_readonly` for MCP / tooling access.
-- This role can only SELECT — no INSERT, UPDATE, DELETE, TRUNCATE, or DDL.
-- Idempotent — safe to re-run (also rotates the password).
--
-- Run with: scripts/db/run-sql.sh scripts/db/create-readonly-role.sql
--
-- The password comes from the READONLY_DB_PASSWORD env var, which the db-admin
-- task injects from Secrets Manager (${projectName}/rds/readonly -> password).
-- It is never written in this file, on the CLI, or in shell history.

\getenv pw READONLY_DB_PASSWORD

-- 1. Create the login role if absent. No privileges beyond LOGIN.
SELECT 'CREATE ROLE laguna_readonly LOGIN'
WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'laguna_readonly')\gexec

-- 2. (Re)set the password from the secret. :'pw' is a safely-quoted literal.
ALTER ROLE laguna_readonly WITH LOGIN PASSWORD :'pw';

-- 3. Allow the role to connect to the application database only.
GRANT CONNECT ON DATABASE laguna_escondida TO laguna_readonly;

-- 4. Switch into the application database to grant schema-level permissions.
\connect laguna_escondida

-- 5. Allow the role to see objects in the public schema (required to SELECT).
GRANT USAGE ON SCHEMA public TO laguna_readonly;

-- 6. Grant SELECT on all tables that already exist.
GRANT SELECT ON ALL TABLES IN SCHEMA public TO laguna_readonly;

-- 7. Grant SELECT on any tables created in the future by laguna_app (the schema
--    owner). Without this, new migrations would be invisible to the readonly role.
ALTER DEFAULT PRIVILEGES FOR ROLE laguna_app IN SCHEMA public
  GRANT SELECT ON TABLES TO laguna_readonly;

\echo '--- laguna_readonly configured ---'
\du laguna_readonly
