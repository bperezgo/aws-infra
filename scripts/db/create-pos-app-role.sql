-- Pre-create the pos_app group role (backend migration 65) as master dbadmin.
--
-- Migration 65 runs as laguna_app, which has no CREATEROLE, so its CREATE ROLE would
-- fail and leave schema_migrations dirty at 65. With the role already here, its
-- IF NOT EXISTS skips the create and the rest (GRANTs as table owner) runs fine.
--
-- No NOSUPERUSER: dbadmin is rds_superuser, which may not name (NO)SUPERUSER; new
-- roles are NOSUPERUSER by default anyway. NOLOGIN: the login user joins later via
-- `CREATE ROLE ... LOGIN IN ROLE pos_app`. Idempotent.
--
--   scripts/db/run-sql.sh scripts/db/create-pos-app-role.sql

SELECT 'CREATE ROLE pos_app NOLOGIN NOCREATEDB NOCREATEROLE NOBYPASSRLS'
WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'pos_app')\gexec

\du pos_app
