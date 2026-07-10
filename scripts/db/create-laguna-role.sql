-- Create the app-scoped role `laguna_app` and hand it ownership of its own
-- database, so the running app connects as a least-privilege user instead of the
-- shared master `dbadmin`. Idempotent — safe to re-run (also rotates the password).
--
-- Run with: scripts/db/run-sql.sh scripts/db/create-laguna-role.sql
--
-- The password is read from the LAGUNA_DB_PASSWORD env var, which the db-admin
-- task injects from Secrets Manager (bryan-dev/laguna/app -> DB_PASSWORD). It is
-- never written in this file, on the CLI, or in shell history.

\getenv pw LAGUNA_DB_PASSWORD

-- 1. Create the login role if absent. New roles are already NOSUPERUSER /
--    NOCREATEDB / NOCREATEROLE by default — and on RDS the master user may NOT
--    even specify the SUPERUSER attribute, so we set nothing beyond LOGIN.
SELECT 'CREATE ROLE laguna_app LOGIN'
WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'laguna_app')\gexec

-- 2. (Re)set the password from the secret. :'pw' is a safely-quoted literal.
ALTER ROLE laguna_app WITH LOGIN PASSWORD :'pw';

-- 3. dbadmin must be a member of laguna_app to hand it object ownership.
GRANT laguna_app TO CURRENT_USER;

-- 4. Grant schema rights WHILE dbadmin still owns the database (so it controls the
--    public schema), THEN transfer the database. PG15+ no longer gives PUBLIC the
--    CREATE privilege on the public schema, so the app role needs it explicitly.
\connect laguna_escondida
GRANT ALL ON SCHEMA public TO laguna_app;

-- 5. Transfer database ownership from the postgres DB (can't ALTER the DB you're
--    connected to). As owner, laguna_app fully controls laguna_escondida and
--    nothing else on the instance.
\connect postgres
ALTER DATABASE laguna_escondida OWNER TO laguna_app;

\echo '--- laguna_app configured ---'
\du laguna_app
