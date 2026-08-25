-- Explicit source_app searches are frequent retrieval bounds, but their
-- canonical filesystem prefixes contain one machine's home directory. Keep a
-- platform-invariant, conservative family mask so a copied authority can seek
-- by app without making the mask authoritative for returned results.
--
-- The column is VIRTUAL: legacy and direct/manual inserts are classified by
-- SQLite itself, with no event payload backfill through JS. A bitmask permits
-- deliberately strange paths containing more than one app marker to remain a
-- candidate for every applicable family.
-- Fail before any generated expression or index build operates on a descriptor
-- that could have been injected by an external writer after migration 0005.
CREATE TEMP TABLE echo_source_family_migration_guard (
  invalid_count INTEGER NOT NULL CHECK (invalid_count = 0)
);
INSERT INTO echo_source_family_migration_guard (invalid_count)
SELECT count(*)
FROM events
WHERE typeof(id) != 'text'
   OR typeof(source) != 'text'
   OR typeof(timestamp) != 'text'
   OR length(CAST(id AS BLOB)) > 256
   OR length(CAST(source AS BLOB)) > 16384
   OR length(CAST(timestamp AS BLOB)) > 128;
DROP TABLE echo_source_family_migration_guard;

ALTER TABLE events ADD COLUMN source_family_mask INTEGER
GENERATED ALWAYS AS (
  (CASE
     WHEN substr(lower(replace(source, char(92), '/')), 1, 3) = 'fs:'
      AND instr(
        lower(replace(source, char(92), '/')) || '/',
        '/library/application support/cursor/'
      ) > 0
     THEN 1 ELSE 0
   END)
  |
  (CASE
     WHEN substr(lower(replace(source, char(92), '/')), 1, 3) = 'fs:'
      AND instr(
        lower(replace(source, char(92), '/')) || '/',
        '/.claude/projects/'
      ) > 0
     THEN 2 ELSE 0
   END)
  |
  (CASE
     WHEN substr(lower(replace(source, char(92), '/')), 1, 3) = 'fs:'
      AND instr(
        lower(replace(source, char(92), '/')) || '/',
        '/.codex/sessions/'
      ) > 0
     THEN 4 ELSE 0
   END)
  |
  (CASE WHEN substr(source, 1, 4) = 'git:' THEN 8 ELSE 0 END)
  |
  (CASE WHEN substr(source, 1, 11) = 'api:granola' THEN 16 ELSE 0 END)
) VIRTUAL;

-- Each family gets an order-compatible partial index. In ordinary data a row
-- belongs to one family, so the combined entry count remains near one index,
-- while equality/range prefix scans that require an unbounded temp sort are
-- avoided entirely.
CREATE INDEX idx_events_source_family_cursor_timestamp_id
  ON events(timestamp DESC, id DESC)
  WHERE (source_family_mask & 1) != 0;

CREATE INDEX idx_events_source_family_claude_code_timestamp_id
  ON events(timestamp DESC, id DESC)
  WHERE (source_family_mask & 2) != 0;

CREATE INDEX idx_events_source_family_codex_timestamp_id
  ON events(timestamp DESC, id DESC)
  WHERE (source_family_mask & 4) != 0;

CREATE INDEX idx_events_source_family_git_timestamp_id
  ON events(timestamp DESC, id DESC)
  WHERE (source_family_mask & 8) != 0;

CREATE INDEX idx_events_source_family_granola_timestamp_id
  ON events(timestamp DESC, id DESC)
  WHERE (source_family_mask & 16) != 0;
