-- One logical writer per database, independent of launchd label or runtime
-- home. A crashed owner's row is replaced atomically after its process
-- identity is proven stale.
CREATE TABLE context_authority (
  lock_name       TEXT    PRIMARY KEY CHECK (lock_name = 'writer'),
  owner_pid       INTEGER NOT NULL CHECK (owner_pid > 0),
  owner_identity  TEXT    NOT NULL,
  database_identity TEXT  NOT NULL,
  owner_token     TEXT    NOT NULL,
  acquired_at     TEXT    NOT NULL
) WITHOUT ROWID;
