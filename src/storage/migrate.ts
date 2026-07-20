import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { normalizePathLikeSource } from './source-match.js';
import {
  STORAGE_DESCRIPTOR_TIMESTAMP_BYTES,
  StorageDescriptorFieldExceededError,
} from './budgets.js';

const FILENAME_PATTERN = /^(\d{4})_[A-Za-z0-9_-]+\.sql$/;

export interface Migration {
  version: number;
  filename: string;
  sql: string;
}

export interface SchemaCompatibility {
  current_version: number;
  latest_supported_version: number;
  compatible: boolean;
}

export function loadMigrations(migrationsDir: string): Migration[] {
  const entries = readdirSync(migrationsDir);
  const migrations: Migration[] = [];
  for (const filename of entries) {
    const match = FILENAME_PATTERN.exec(filename);
    if (match === null) continue;
    const version = Number.parseInt(match[1]!, 10);
    const sql = readFileSync(join(migrationsDir, filename), 'utf8');
    migrations.push({ version, filename, sql });
  }
  migrations.sort((a, b) => a.version - b.version);

  for (const [i, m] of migrations.entries()) {
    const expected = i + 1;
    if (m.version !== expected) {
      throw new Error(
        `migration sequence error: expected version ${expected} but found ${m.version} (${m.filename})`,
      );
    }
  }
  return migrations;
}

export function migrate(db: Database.Database, migrationsDir: string): number {
  // Migration 0002 bootstraps checkpoints with a window rank over the legacy
  // ledger. Force SQLite's temporary b-trees to file-backed storage before
  // any migration runs so a large authority cannot balloon process/JS memory.
  // `temp_store` is connection-local: this does not rewrite source database
  // metadata or persist beyond the caller's connection.
  db.pragma('temp_store = FILE');
  const migrations = loadMigrations(migrationsDir);
  const compatibility = inspectSchemaCompatibility(db, migrations);
  if (!compatibility.compatible) {
    throw new Error(
      `database schema version ${compatibility.current_version} is newer than supported version ${compatibility.latest_supported_version}`,
    );
  }
  const currentRow = compatibility.current_version;
  let applied = currentRow;

  // Migration 0005 uses the exact same path normalization as runtime writes.
  // Registration is connection-local and deterministic; no event payload is
  // selected into JS during the one-time indexed-key backfill.
  db.function(
    'echo_normalize_path_like_source',
    { deterministic: true },
    (source: string) => normalizePathLikeSource(source),
  );

  for (const m of migrations) {
    if (m.version <= applied) continue;
    const tx = db.transaction(() => {
      db.exec(m.sql);
      db.pragma(`user_version = ${m.version}`);
    });
    tx();
    applied = m.version;
  }
  return applied;
}

/** Read-only compatibility preflight shared by storage construction and
 * launch/runtime admission. Pass preloaded migrations to avoid a second
 * directory read when the caller is already applying them. */
export function inspectSchemaCompatibility(
  db: Database.Database,
  migrationsOrDir: readonly Migration[] | string,
): SchemaCompatibility {
  const migrations =
    typeof migrationsOrDir === 'string' ? loadMigrations(migrationsOrDir) : migrationsOrDir;
  const currentVersion = db.pragma('user_version', { simple: true }) as number;
  const latestSupportedVersion = migrations[migrations.length - 1]?.version ?? 0;
  return {
    current_version: currentVersion,
    latest_supported_version: latestSupportedVersion,
    compatible: currentVersion <= latestSupportedVersion,
  };
}

const TZ_MARKER_RE = /Z$|[+-]\d{2}(?::?\d{2})?$/;

// Rewrite legacy non-`Z` timestamps to canonical UTC `Z` form. Done in Node,
// not pure SQL: SQLite's `datetime()` parser truncates sub-second precision
// (`2026-05-08T00:18:26.123-07:00` → `2026-05-08T07:18:26.000Z`), but
// `Date.prototype.toISOString()` preserves full millisecond precision.
// Idempotent — `WHERE timestamp NOT LIKE '%Z'` excludes already-canonicalized
// rows on a re-run.
export function canonicalizeTimestamps(db: Database.Database): { converted: number } {
  const pageSize = 256;
  const firstPage = db.prepare(
    `SELECT
       events.rowid AS event_rowid,
       CASE
         WHEN length(CAST(timestamp AS BLOB)) <= ${STORAGE_DESCRIPTOR_TIMESTAMP_BYTES}
         THEN timestamp
         ELSE NULL
       END AS timestamp,
       length(CAST(timestamp AS BLOB)) AS timestamp_bytes
     FROM events
     WHERE timestamp NOT LIKE '%Z'
     ORDER BY events.rowid ASC
     LIMIT ${pageSize}`,
  );
  const nextPage = db.prepare(
    `SELECT
       events.rowid AS event_rowid,
       CASE
         WHEN length(CAST(timestamp AS BLOB)) <= ${STORAGE_DESCRIPTOR_TIMESTAMP_BYTES}
         THEN timestamp
         ELSE NULL
       END AS timestamp,
       length(CAST(timestamp AS BLOB)) AS timestamp_bytes
     FROM events
     WHERE events.rowid > ?
       AND timestamp NOT LIKE '%Z'
     ORDER BY events.rowid ASC
     LIMIT ${pageSize}`,
  );
  const update = db.prepare('UPDATE events SET timestamp = ? WHERE events.rowid = ?');
  type TimestampPageRow = {
    event_rowid: number | bigint;
    timestamp: string | null;
    timestamp_bytes: number;
  };

  const convert = db.transaction(() => {
    let converted = 0;
    let cursor: number | bigint | null = null;
    for (;;) {
      const rows = (cursor === null ? firstPage.all() : nextPage.all(cursor)) as TimestampPageRow[];
      if (rows.length === 0) return converted;
      for (const row of rows) {
        if (row.timestamp === null) {
          throw new StorageDescriptorFieldExceededError({
            operation: 'query',
            field: 'timestamp',
            field_bytes: row.timestamp_bytes,
            budget_bytes: STORAGE_DESCRIPTOR_TIMESTAMP_BYTES,
          });
        }
        const withTz = TZ_MARKER_RE.test(row.timestamp)
          ? row.timestamp
          : `${row.timestamp}Z`;
        update.run(new Date(withTz).toISOString(), row.event_rowid);
        cursor = row.event_rowid;
        converted += 1;
      }
      if (rows.length < pageSize) return converted;
    }
  });
  const converted = convert();

  const remaining = db
    .prepare("SELECT COUNT(*) AS n FROM events WHERE timestamp NOT LIKE '%Z'")
    .get() as { n: number };
  if (remaining.n !== 0) {
    throw new Error(
      `canonicalizeTimestamps: ${remaining.n} non-Z rows remain after migration`,
    );
  }

  return { converted };
}
