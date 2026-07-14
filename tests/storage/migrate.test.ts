import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { canonicalizeTimestamps, migrate } from '../../src/storage/migrate.js';

const MIGRATIONS_DIR = new URL('../../src/storage/migrations/', import.meta.url).pathname;

interface Row {
  id: string;
  timestamp: string;
}

function seed(db: Database.Database, rows: { id: string; ts: string }[]): void {
  const insert = db.prepare(
    "INSERT INTO events (id, source, timestamp, content) VALUES (?, 'git:test', ?, 'x')",
  );
  for (const r of rows) insert.run(r.id, r.ts);
}

function readAll(db: Database.Database): Row[] {
  return db
    .prepare('SELECT id, timestamp FROM events ORDER BY id')
    .all() as Row[];
}

describe('canonicalizeTimestamps (item 022 Bug A migration)', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    migrate(db, MIGRATIONS_DIR);
  });

  afterEach(() => {
    db.close();
  });

  it('rewrites -07:00 offset rows to canonical Z form', () => {
    seed(db, [
      { id: 'a', ts: '2026-05-08T00:00:00.000-07:00' },
      { id: 'b', ts: '2026-05-08T07:00:00.000Z' },
    ]);
    const result = canonicalizeTimestamps(db);
    expect(result.converted).toBe(1);
    const rows = readAll(db);
    const map = new Map(rows.map((r) => [r.id, r.timestamp]));
    expect(map.get('a')).toBe('2026-05-08T07:00:00.000Z');
    expect(map.get('b')).toBe('2026-05-08T07:00:00.000Z');
  });

  it('preserves millisecond precision (the reason this is Node, not pure SQL)', () => {
    seed(db, [{ id: 'a', ts: '2026-05-08T00:18:26.123-07:00' }]);
    canonicalizeTimestamps(db);
    const [row] = readAll(db);
    expect(row!.timestamp).toBe('2026-05-08T07:18:26.123Z');
  });

  it('handles a 5+ row mixed-form fixture (Z + +HH:MM + -HH:MM)', () => {
    seed(db, [
      { id: 'a', ts: '2026-05-08T07:00:00.000Z' },
      { id: 'b', ts: '2026-05-08T00:00:00.000-07:00' },
      { id: 'c', ts: '2026-05-08T14:00:00.000+07:00' },
      { id: 'd', ts: '2026-05-08T00:18:26.500-07:00' },
      { id: 'e', ts: '2026-05-08T08:00:00.000Z' },
      { id: 'f', ts: '2026-05-08T13:30:00.000+06:30' },
    ]);
    const result = canonicalizeTimestamps(db);
    // 4 non-Z rows: b, c, d, f
    expect(result.converted).toBe(4);

    // Post-migration: 0 non-Z rows
    const remaining = db
      .prepare("SELECT COUNT(*) AS n FROM events WHERE timestamp NOT LIKE '%Z'")
      .get() as { n: number };
    expect(remaining.n).toBe(0);

    // Row IDs preserved
    const rows = readAll(db);
    expect(rows.map((r) => r.id).sort()).toEqual(['a', 'b', 'c', 'd', 'e', 'f']);

    // Spot-check correct UTC conversions
    const map = new Map(rows.map((r) => [r.id, r.timestamp]));
    expect(map.get('a')).toBe('2026-05-08T07:00:00.000Z');
    expect(map.get('b')).toBe('2026-05-08T07:00:00.000Z');
    expect(map.get('c')).toBe('2026-05-08T07:00:00.000Z');
    expect(map.get('d')).toBe('2026-05-08T07:18:26.500Z');
    expect(map.get('e')).toBe('2026-05-08T08:00:00.000Z');
    expect(map.get('f')).toBe('2026-05-08T07:00:00.000Z');
  });

  it('is idempotent — running twice does not double-convert', () => {
    seed(db, [
      { id: 'a', ts: '2026-05-08T00:18:26.123-07:00' },
      { id: 'b', ts: '2026-05-08T00:00:00.000-07:00' },
    ]);
    const first = canonicalizeTimestamps(db);
    expect(first.converted).toBe(2);
    const after1 = readAll(db);

    const second = canonicalizeTimestamps(db);
    expect(second.converted).toBe(0);
    const after2 = readAll(db);

    expect(after2).toEqual(after1);
  });

  it('returns converted: 0 on a fully-canonical store (no UPDATE issued)', () => {
    seed(db, [
      { id: 'a', ts: '2026-05-08T07:00:00.000Z' },
      { id: 'b', ts: '2026-05-08T08:00:00.000Z' },
    ]);
    const result = canonicalizeTimestamps(db);
    expect(result.converted).toBe(0);
  });

  it('preserves row content unchanged (only timestamp updates)', () => {
    db.prepare(
      "INSERT INTO events (id, source, timestamp, content) VALUES ('a', 'git:repo', '2026-05-08T00:18:26.123-07:00', 'commit X')",
    ).run();
    canonicalizeTimestamps(db);
    const row = db
      .prepare('SELECT id, source, content FROM events WHERE id = ?')
      .get('a') as { id: string; source: string; content: string };
    expect(row.id).toBe('a');
    expect(row.source).toBe('git:repo');
    expect(row.content).toBe('commit X');
  });
});
