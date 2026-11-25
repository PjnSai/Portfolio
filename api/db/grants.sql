-- Least-privilege grants. Run as a superuser after roles.sql and after every
-- migration that adds a table. Safe to run again.
--
-- Tables are listed by name on purpose: a new table gets no access until it is
-- added here, and django_migrations is never readable by the app.

REVOKE ALL ON SCHEMA public FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM PUBLIC, app_rw;

GRANT USAGE, CREATE ON SCHEMA public TO migrator;
GRANT USAGE ON SCHEMA public TO app_rw;

-- Content the admin edits. Projects, experience, skills and the rest are
-- rows in section_items.
GRANT SELECT, INSERT, UPDATE, DELETE ON
    site_settings, sections, section_items, media, cv_files,
    revisions, palettes
TO app_rw;

-- Contact messages from the public form. A note can be added and read, never
-- changed; it is deleted only along with its message.
GRANT SELECT, INSERT, UPDATE, DELETE ON contact_messages TO app_rw;
GRANT SELECT, INSERT, DELETE ON contact_notes TO app_rw;

-- Contacts the owner keeps. Deleting one unlinks its messages.
GRANT SELECT, INSERT, UPDATE, DELETE ON contacts TO app_rw;

-- Blocked senders: the keyed hash of an email, and the address only if the
-- owner chose to keep it. Neither is changed once stored; renewing moves the
-- expiry, the owner may edit the note, and the form counts hits.
GRANT SELECT, INSERT, DELETE ON blocked_senders TO app_rw;
GRANT UPDATE (expires_at, note, hit_count, last_hit_at) ON blocked_senders
TO app_rw;

-- Auth state.
GRANT SELECT, INSERT, UPDATE, DELETE ON
    admin_credentials, sessions, rate_limit_blocks, pending_actions
TO app_rw;

-- The owner row: made by a migration, never added or removed by the app. Only
-- the bootstrap time and the recovery key hash can change.
GRANT SELECT ON admin_owner TO app_rw;
GRANT UPDATE (bootstrapped_at, recovery_key_hash) ON admin_owner TO app_rw;

-- Audit log: append and read only. A trigger also blocks UPDATE, DELETE and
-- TRUNCATE for every role, and only the table owner can disable it.
GRANT SELECT, INSERT ON audit_log TO app_rw;
