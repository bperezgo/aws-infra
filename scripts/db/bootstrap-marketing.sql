-- Create the `marketing` database (marketing-app) and its login roles.
-- Idempotent — safe to re-run (also rotates every password).
--
-- Run with: scripts/db/run-sql.sh scripts/db/bootstrap-marketing.sql
--
--   marketing_owner  owns the database; only the migrate task connects as it
--                    (password: <projectName>/marketing/db-owner -> DB_PASSWORD)
--   marketing_svc    what whatsapp-agent connects as; holds marketing_app, the
--                    grant-holder role the app's migrations grant to
--                    (password: <projectName>/whatsapp-agent/app -> DB_PASSWORD)
--   marketing_console_svc  what console-api connects as; holds marketing_console
--                    (password: <projectName>/console-api/app -> DB_PASSWORD)
--
-- Passwords come from env vars the db-admin task injects from Secrets Manager,
-- never from this file or the CLI.

\getenv owner_pw MARKETING_OWNER_DB_PASSWORD
\getenv svc_pw MARKETING_SVC_DB_PASSWORD
\getenv console_pw MARKETING_CONSOLE_DB_PASSWORD

-- Login roles. On RDS the master may not specify SUPERUSER/NOSUPERUSER at all,
-- and new roles are NOSUPERUSER/NOCREATEDB/NOCREATEROLE by default.
SELECT 'CREATE ROLE marketing_owner LOGIN'
WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'marketing_owner')\gexec
SELECT 'CREATE ROLE marketing_svc LOGIN'
WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'marketing_svc')\gexec
SELECT 'CREATE ROLE marketing_console_svc LOGIN'
WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'marketing_console_svc')\gexec
ALTER ROLE marketing_owner WITH LOGIN PASSWORD :'owner_pw';
ALTER ROLE marketing_svc WITH LOGIN PASSWORD :'svc_pw';
ALTER ROLE marketing_console_svc WITH LOGIN PASSWORD :'console_pw';

-- The grant holders the app's migrations would create (000002; 000008 adds
-- marketing_console). marketing_owner has no CREATEROLE, so each must exist
-- before its migration runs; the migration's IF NOT EXISTS then skips.
SELECT format('CREATE ROLE %I NOLOGIN', r)
FROM unnest(ARRAY['marketing_app', 'marketing_contact', 'marketing_analytics',
                  'marketing_console']) AS r
WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = r)\gexec

GRANT marketing_app TO marketing_svc;
GRANT marketing_console TO marketing_console_svc;

SELECT 'CREATE DATABASE marketing'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'marketing')\gexec

-- Same ownership hand-off as create-laguna-role.sql: the master must be a member
-- to transfer ownership, schema rights are granted while it still owns the DB,
-- and the ALTER runs from another database.
GRANT marketing_owner TO CURRENT_USER;
\connect marketing
GRANT ALL ON SCHEMA public TO marketing_owner;
\connect postgres
ALTER DATABASE marketing OWNER TO marketing_owner;
REVOKE ALL ON DATABASE marketing FROM PUBLIC;
GRANT CONNECT ON DATABASE marketing TO marketing_svc, marketing_console_svc;

\echo '--- marketing roles configured ---'
\du marketing_*
