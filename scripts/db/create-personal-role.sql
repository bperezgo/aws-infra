-- A personal login (`bryan`) for connecting over Tailscale with ONE user to every
-- project database, switching into a project's permissions on demand:
--
--   psql "host=… dbname=marketing user=bryan sslmode=require"
--   SET ROLE marketing_owner;   -- act as marketing's owner (or marketing_app)
--   RESET ROLE;                 -- back to bryan, which owns/can read nothing
--
-- Memberships are INHERIT FALSE, SET TRUE: bryan holds no table privileges until
-- it SETs a role, and neither app's credentials gain anything. Idempotent — safe
-- to re-run (also rotates the password, and re-applies membership options).
--
-- Run with: scripts/db/run-sql.sh scripts/db/create-personal-role.sql
--
-- The password is read from PERSONAL_DB_PASSWORD, which the db-admin task injects
-- from Secrets Manager (<projectName>/db/personal -> DB_PASSWORD).
--
-- New project: add its database to the CONNECT grant and its roles to the loop.

\getenv pw PERSONAL_DB_PASSWORD

SELECT 'CREATE ROLE bryan LOGIN'
WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'bryan')\gexec
ALTER ROLE bryan WITH LOGIN PASSWORD :'pw';

GRANT CONNECT ON DATABASE laguna_escondida, marketing TO bryan;

SELECT format('GRANT %I TO bryan WITH INHERIT FALSE, SET TRUE', r)
FROM unnest(ARRAY['laguna_app', 'marketing_owner', 'marketing_app']) AS r\gexec

-- Isolate laguna's database the way bootstrap-marketing.sql isolates marketing:
-- only its owner (laguna_app, implicit) and explicit grantees may connect, so the
-- marketing roles can no longer open it.
REVOKE ALL ON DATABASE laguna_escondida FROM PUBLIC;

\echo '--- bryan configured ---'
SELECT roleid::regrole AS member_of, inherit_option, set_option
FROM pg_auth_members WHERE member = 'bryan'::regrole ORDER BY 1;
SELECT r.rolname, d.datname, has_database_privilege(r.oid, d.oid, 'CONNECT') AS can_connect
FROM pg_roles r CROSS JOIN pg_database d
WHERE r.rolname IN ('bryan', 'laguna_app', 'marketing_svc')
  AND d.datname IN ('laguna_escondida', 'marketing')
ORDER BY 1, 2;
