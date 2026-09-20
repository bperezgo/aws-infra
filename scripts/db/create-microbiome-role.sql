-- Create the app-scoped role `microbiome_app` and hand it ownership of its own
-- database, so the running app connects as a least-privilege user instead of the
-- shared master `dbadmin`. Idempotent — safe to re-run (also rotates the password).
--
-- Run with: scripts/db/run-sql.sh scripts/db/create-microbiome-role.sql
--
-- The password is read from the MICROBIOME_DB_PASSWORD env var, which the db-admin
-- task injects from Secrets Manager (bryan-dev/microbiome-lab/app -> DB_PASSWORD).
-- It is never written in this file, on the CLI, or in shell history.

\getenv pw MICROBIOME_DB_PASSWORD

-- 1. Create the login role if absent. New roles are already NOSUPERUSER /
--    NOCREATEDB / NOCREATEROLE by default — and on RDS the master user may NOT
--    even specify the SUPERUSER attribute, so we set nothing beyond LOGIN.
SELECT 'CREATE ROLE microbiome_app LOGIN'
WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'microbiome_app')\gexec

-- 2. (Re)set the password from the secret. :'pw' is a safely-quoted literal.
ALTER ROLE microbiome_app WITH LOGIN PASSWORD :'pw';

-- 3. dbadmin must be a member of microbiome_app to hand it object ownership.
GRANT microbiome_app TO CURRENT_USER;

-- 4. Grant schema rights WHILE dbadmin still owns the database (so it controls the
--    public schema), THEN transfer the database. PG15+ no longer gives PUBLIC the
--    CREATE privilege on the public schema, so the app role needs it explicitly.
\connect microbiome_lab
GRANT ALL ON SCHEMA public TO microbiome_app;

-- 5. Transfer database ownership from the postgres DB (can't ALTER the DB you're
--    connected to). As owner, microbiome_app fully controls microbiome_lab and
--    nothing else on the instance — the app's embedded golang-migrate migrations
--    then create the schema at startup.
\connect postgres
ALTER DATABASE microbiome_lab OWNER TO microbiome_app;

\echo '--- microbiome_app configured ---'
\du microbiome_app
