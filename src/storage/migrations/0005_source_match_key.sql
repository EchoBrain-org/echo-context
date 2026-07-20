-- Persist the shared path-normalization key once so exact path lookups can
-- seek directly into a source+time index. Non-path-like sources remain NULL
-- and continue to use the existing binary `source` index. The deterministic
-- scalar is registered by the package migration runner from source-match.ts.
-- Fail before the JS scalar sees any adversarially large legacy descriptor.
CREATE TEMP TABLE echo_source_key_migration_guard (
  invalid_count INTEGER NOT NULL CHECK (invalid_count = 0)
);
INSERT INTO echo_source_key_migration_guard (invalid_count)
SELECT count(*)
FROM events
WHERE length(CAST(id AS BLOB)) > 256
   OR length(CAST(source AS BLOB)) > 16384
   OR length(CAST(timestamp AS BLOB)) > 128;
DROP TABLE echo_source_key_migration_guard;

ALTER TABLE events ADD COLUMN source_key TEXT;

UPDATE events
SET source_key = echo_normalize_path_like_source(source);

CREATE INDEX idx_events_source_key_timestamp_id
  ON events(source_key, timestamp DESC, id DESC)
  WHERE source_key IS NOT NULL;
