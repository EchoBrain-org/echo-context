-- Legacy ledgers may contain equivalent instants in offset or timezone-less
-- form. Normalize them exactly once at schema migration time so every normal
-- process start remains O(1) in ledger size. strftime('%f') retains SQLite's
-- millisecond precision and this UPDATE never selects event bodies into JS.
UPDATE events
SET timestamp = COALESCE(
  strftime(
    '%Y-%m-%dT%H:%M:%fZ',
    CASE
      WHEN substr(timestamp, -1) = 'z'
        THEN substr(timestamp, 1, length(timestamp) - 1) || 'Z'
      WHEN timestamp GLOB '*[+-][0-9][0-9][0-9][0-9]'
        THEN substr(timestamp, 1, length(timestamp) - 5)
          || substr(timestamp, -5, 3)
          || ':'
          || substr(timestamp, -2)
      WHEN timestamp GLOB '*[+-][0-9][0-9]'
        THEN timestamp || ':00'
      WHEN timestamp GLOB '*[+-][0-9][0-9]:[0-9][0-9]'
        THEN timestamp
      ELSE timestamp || 'Z'
    END
  ),
  timestamp
)
WHERE substr(timestamp, -1) <> 'Z';

-- Refuse to advance user_version if any legacy value could not be normalized.
-- The temporary CHECK table turns a nonzero count into a transaction failure,
-- rolling back the UPDATE and leaving the DB at version 2 for operator repair.
CREATE TEMP TABLE echo_timestamp_migration_guard (
  invalid_count INTEGER NOT NULL CHECK (invalid_count = 0)
);
INSERT INTO echo_timestamp_migration_guard (invalid_count)
SELECT count(*)
FROM events
WHERE substr(timestamp, -1) <> 'Z'
   OR strftime('%Y-%m-%dT%H:%M:%fZ', timestamp) IS NULL;
DROP TABLE echo_timestamp_migration_guard;
