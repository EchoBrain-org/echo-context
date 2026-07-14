import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type Database from 'better-sqlite3';

const FILENAME_PATTERN = /^(\d{4})_[A-Za-z0-9_-]+\.sql$/;

export interface Migration {
  version: number;
  filename: string;
  sql: string;
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
  const migrations = loadMigrations(migrationsDir);
  const currentRow = db.pragma('user_version', { simple: true }) as number;
  let applied = currentRow;

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

const TZ_MARKER_RE = /Z$|[+-]\d{2}(?::?\d{2})?$/;

// Rewrite legacy non-`Z` timestamps to canonical UTC `Z` form. Done in Node,
// not pure SQL: SQLite's `datetime()` parser truncates sub-second precision
// (`2026-05-08T00:18:26.123-07:00` → `2026-05-08T07:18:26.000Z`), but
// `Date.prototype.toISOString()` preserves full millisecond precision.
// Idempotent — `WHERE timestamp NOT LIKE '%Z'` excludes already-canonicalized
// rows on a re-run.
export function canonicalizeTimestamps(db: Database.Database): { converted: number } {
  const rows = db
    .prepare("SELECT id, timestamp FROM events WHERE timestamp NOT LIKE '%Z'")
    .all() as { id: string; timestamp: string }[];

  if (rows.length === 0) return { converted: 0 };

  const update = db.prepare('UPDATE events SET timestamp = ? WHERE id = ?');
  const tx = db.transaction((rs: typeof rows) => {
    for (const r of rs) {
      const withTz = TZ_MARKER_RE.test(r.timestamp) ? r.timestamp : r.timestamp + 'Z';
      const canonical = new Date(withTz).toISOString();
      update.run(canonical, r.id);
    }
  });
  tx(rows);

  const remaining = db
    .prepare("SELECT COUNT(*) AS n FROM events WHERE timestamp NOT LIKE '%Z'")
    .get() as { n: number };
  if (remaining.n !== 0) {
    throw new Error(
      `canonicalizeTimestamps: ${remaining.n} non-Z rows remain after migration`,
    );
  }

  return { converted: rows.length };
}
