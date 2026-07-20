-- Fail closed before the bootstrap performs any replace/json/window work on
-- legacy rows. The guard reads only SQLite byte lengths, so an oversized
-- descriptor or payload never crosses into JS and never reaches JSON1.
CREATE TEMP TABLE echo_checkpoint_bootstrap_guard (
  invalid_count INTEGER NOT NULL CHECK (invalid_count = 0)
);
INSERT INTO echo_checkpoint_bootstrap_guard (invalid_count)
SELECT COUNT(*)
FROM events
WHERE length(CAST(id AS BLOB)) > 256
   OR length(CAST(source AS BLOB)) > 16384
   OR length(CAST(timestamp AS BLOB)) > 128
   OR (
     length(CAST(id AS BLOB))
     + length(CAST(source AS BLOB))
     + length(CAST(timestamp AS BLOB))
     + length(CAST(content AS BLOB))
     + COALESCE(length(CAST(metadata AS BLOB)), 0)
     + COALESCE(length(embedding), 0)
   ) > 4194304;
DROP TABLE echo_checkpoint_bootstrap_guard;

-- Durable, compact capture progress. This table is additive: legacy events
-- remain byte-for-byte untouched and continue to be the source of truth for
-- captured context. WITHOUT ROWID keeps the composite key as the table b-tree.
CREATE TABLE capture_checkpoints (
  extractor  TEXT NOT NULL CHECK (
    length(extractor) > 0
    AND length(CAST(extractor AS BLOB)) <= 128
  ),
  resource   TEXT NOT NULL CHECK (
    length(resource) > 0
    AND length(CAST(resource AS BLOB)) <= 16384
  ),
  partition  TEXT NOT NULL DEFAULT '' CHECK (
    length(CAST(partition AS BLOB)) <= 1024
  ),
  position   INTEGER CHECK (position IS NULL OR position >= 0),
  cursor     TEXT CHECK (
    cursor IS NULL
    OR (length(cursor) > 0 AND length(CAST(cursor AS BLOB)) <= 4096)
  ),
  ordinal    INTEGER CHECK (ordinal IS NULL OR ordinal >= 0),
  mtime_ms   REAL CHECK (mtime_ms IS NULL OR mtime_ms >= 0),
  state      TEXT NOT NULL DEFAULT '{}' CHECK (
    length(CAST(state AS BLOB)) <= 131072
    AND json_valid(state)
    AND json_type(state) = 'object'
  ),
  updated_at TEXT NOT NULL CHECK (
    length(updated_at) > 0
    AND length(CAST(updated_at AS BLOB)) <= 128
  ),
  PRIMARY KEY (extractor, resource, partition)
) WITHOUT ROWID;

-- Existing retrieval paths order by these composite tuples. Keeping the
-- original single-column indexes preserves prior query plans while these
-- additive indexes let bounded pages seek and stop inside SQLite.
CREATE INDEX idx_events_timestamp_id
  ON events(timestamp DESC, id DESC);
CREATE INDEX idx_events_source_timestamp_id
  ON events(source, timestamp DESC, id DESC);
CREATE INDEX idx_capture_checkpoints_updated_at
  ON capture_checkpoints(updated_at DESC, extractor, resource, partition);

-- One-time SQL-only bootstrap from the highest durable progress already
-- embedded in legacy event metadata. No event bodies are materialized in JS.
-- Claude Code / Codex own one byte-offset partition per JSONL resource; Cursor
-- owns one assistant-bubble cursor per composer in its shared global database.
WITH valid_events AS (
  SELECT
    rowid AS event_sequence,
    source,
    timestamp,
    metadata,
    replace(source, char(92), '/') AS normalized_source
  FROM events
  WHERE substr(source, 1, 3) = 'fs:'
    AND length(source) > 3
    AND metadata IS NOT NULL
    AND json_valid(metadata)
),
candidates AS (
  SELECT
    CASE
      WHEN instr(normalized_source, '/.claude/projects/') > 0 THEN 'claude_code'
      WHEN instr(normalized_source, '/.codex/sessions/') > 0 THEN 'codex'
      ELSE 'cursor'
    END AS extractor,
    substr(source, 4) AS resource,
    CASE
      WHEN instr(normalized_source, '/Cursor/User/globalStorage/state.vscdb') > 0
        THEN json_extract(metadata, '$.composer_id')
      ELSE ''
    END AS partition,
    CASE
      WHEN instr(normalized_source, '/Cursor/User/globalStorage/state.vscdb') = 0
        THEN CAST(json_extract(metadata, '$.byte_offset') AS INTEGER)
      ELSE NULL
    END AS position,
    CASE
      WHEN instr(normalized_source, '/Cursor/User/globalStorage/state.vscdb') > 0
        THEN json_extract(metadata, '$.assistant_bubble_id')
      ELSE NULL
    END AS cursor,
    CASE
      WHEN instr(normalized_source, '/Cursor/User/globalStorage/state.vscdb') = 0
        THEN CAST(json_extract(metadata, '$.turn_index') AS INTEGER)
      ELSE NULL
    END AS ordinal,
    CASE
      WHEN json_type(metadata, '$.mtime') IN ('integer', 'real')
        AND CAST(json_extract(metadata, '$.mtime') AS REAL) >= 0
        THEN CAST(json_extract(metadata, '$.mtime') AS REAL)
      ELSE NULL
    END AS mtime_ms,
    CASE
      WHEN instr(normalized_source, '/.codex/sessions/') > 0 THEN json_object(
        'cwd', json_extract(metadata, '$.cwd'),
        'git', json_extract(metadata, '$.git'),
        'codex', json_extract(metadata, '$.codex')
      )
      WHEN instr(normalized_source, '/.claude/projects/') > 0 THEN json_object(
        'repo_root', json_extract(metadata, '$.repo_root')
      )
      ELSE json_object(
        'workspace_id', json_extract(metadata, '$.workspace_id'),
        'repo_root', json_extract(metadata, '$.repo_root')
      )
    END AS state,
    COALESCE(strftime('%Y-%m-%dT%H:%M:%fZ', timestamp), timestamp) AS updated_at,
    event_sequence
  FROM valid_events
  WHERE (
      (
        instr(normalized_source, '/.claude/projects/') > 0
        OR instr(normalized_source, '/.codex/sessions/') > 0
      )
      AND json_type(metadata, '$.byte_offset') IN ('integer', 'real')
      AND CAST(json_extract(metadata, '$.byte_offset') AS INTEGER) >= 0
      AND json_type(metadata, '$.turn_index') IN ('integer', 'real')
      AND CAST(json_extract(metadata, '$.turn_index') AS INTEGER) >= 0
    )
    OR (
      instr(normalized_source, '/Cursor/User/globalStorage/state.vscdb') > 0
      AND json_type(metadata, '$.composer_id') = 'text'
      AND length(json_extract(metadata, '$.composer_id')) > 0
      AND json_type(metadata, '$.assistant_bubble_id') = 'text'
      AND length(json_extract(metadata, '$.assistant_bubble_id')) > 0
    )
),
ranked AS (
  SELECT
    *,
    row_number() OVER (
      PARTITION BY extractor, resource, partition
      ORDER BY
        CASE WHEN position IS NULL THEN 0 ELSE 1 END DESC,
        position DESC,
        ordinal DESC,
        event_sequence DESC
    ) AS checkpoint_rank
  FROM candidates
)
INSERT INTO capture_checkpoints (
  extractor,
  resource,
  partition,
  position,
  cursor,
  ordinal,
  mtime_ms,
  state,
  updated_at
)
SELECT
  extractor,
  resource,
  partition,
  position,
  cursor,
  ordinal,
  mtime_ms,
  state,
  updated_at
FROM ranked
WHERE checkpoint_rank = 1;
