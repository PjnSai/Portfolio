-- Database roles. Run once per database as a superuser, before grants.sql.
-- Safe to run again.
--
--   migrator  owns the schema and runs migrations. Used only at deploy time.
--   app_rw    what the running API connects as. No DDL, cannot edit the audit log.
--
-- Both are created without LOGIN and without a password, so no secret lives in
-- this file. For each one, create a login user with a password from the secret
-- store and make it a member: GRANT app_rw TO <login user>.

DO $$
BEGIN
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'migrator') THEN
        CREATE ROLE migrator NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE;
    END IF;
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_rw') THEN
        CREATE ROLE app_rw NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE;
    END IF;
END
$$;
