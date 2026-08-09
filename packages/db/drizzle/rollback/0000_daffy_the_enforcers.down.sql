-- Destructive rollback for an empty/new PostgreSQL deployment only.
-- Production rollback must restore the pre-migration backup instead of running this file.
DROP TABLE IF EXISTS "daily_quota";
DROP TABLE IF EXISTS "tasks";
DROP TABLE IF EXISTS "user_sessions";
DROP TABLE IF EXISTS "users";
DROP SCHEMA IF EXISTS "drizzle" CASCADE;
