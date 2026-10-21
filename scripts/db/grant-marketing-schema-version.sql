-- Let whatsapp-agent and console-api read schema_migrations. Run once, after the FIRST
-- scripts/db/migrate-marketing.sh (the migrate CLI creates the table). Idempotent.
--
-- Run with: scripts/db/run-sql.sh scripts/db/grant-marketing-schema-version.sql
--
-- The service checks its required schema version at boot, but no migration
-- grants this table to marketing_app (dev and CI connect as a superuser, so it
-- never shows there). Without it the service exits with "permission denied for
-- table schema_migrations". The durable fix is the same GRANT as a migration in
-- marketing-app; then this script becomes a no-op.

\connect marketing
SET ROLE marketing_owner;
GRANT SELECT ON schema_migrations TO marketing_app, marketing_console;
RESET ROLE;
