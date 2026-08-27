import Database from 'better-sqlite3';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CaptureEvent } from '../../src/storage/interface.js';
import { loadMigrations, migrate } from '../../src/storage/migrate.js';
import { normalizePathLikeSource } from '../../src/storage/source-match.js';
import { SqliteStorage } from '../../src/storage/sqlite.js';

const MIGRATIONS_DIR = new URL('../../src/storage/migrations/', import.meta.url).pathname;
const MIGRATIONS = loadMigrations(MIGRATIONS_DIR);
const LATEST_SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1]!.version;
const INITIAL_MIGRATION = new URL(
  '../../src/storage/migrations/0001_initial.sql',
  import.meta.url,
).pathname;
const CHECKPOINT_MIGRATION = new URL(
  '../../src/storage/migrations/0002_capture_checkpoints.sql',
  import.meta.url,
).pathname;

function eventInput(overrides: Partial<Omit<CaptureEvent, 'id'>> = {}): Omit<CaptureEvent, 'id'> {
  return {
    source: 'fs:test',
    timestamp: '2026-04-30T12:00:00.000Z',
    content: 'hello',
    ...overrides,
  };
}

describe('SqliteStorage', () => {
  let store: SqliteStorage;

  beforeEach(() => {
    store = new SqliteStorage(':memory:');
  });

  afterEach(() => {
    store.close();
  });

  describe('append + query roundtrip', () => {
    it('preserves all fields including metadata and embedding', async () => {
      const input = eventInput({
        source: 'api:github',
        timestamp: '2026-04-30T10:00:00.000Z',
        content: '{"issue":234}',
        metadata: { repo: 'echo', kind: 'issue' },
        embedding: [0.1, 0.2, 0.3],
      });
      const id = await store.append(input);
      const all = await store.query();
      expect(all).toHaveLength(1);
      const got = all[0]!;
      expect(got.id).toBe(id);
      expect(got.source).toBe(input.source);
      expect(got.timestamp).toBe(input.timestamp);
      expect(got.content).toBe(input.content);
      expect(got.metadata).toEqual(input.metadata);
      expect(got.embedding).toHaveLength(3);
      expect(got.embedding![0]).toBeCloseTo(0.1, 5);
      expect(got.embedding![1]).toBeCloseTo(0.2, 5);
      expect(got.embedding![2]).toBeCloseTo(0.3, 5);
    });

    it('omits metadata/embedding when not supplied', async () => {
      const id = await store.append(eventInput());
      const [evt] = await store.query();
      expect(evt!.id).toBe(id);
      expect(evt!.metadata).toBeUndefined();
      expect(evt!.embedding).toBeUndefined();
    });

    it('returns events in timestamp DESC order by default (021: keep-newest semantics)', async () => {
      const ids: string[] = [];
      const stamps = [
        '2026-04-30T12:04:00.000Z',
        '2026-04-30T12:00:00.000Z',
        '2026-04-30T12:02:00.000Z',
        '2026-04-30T12:01:00.000Z',
        '2026-04-30T12:03:00.000Z',
      ];
      for (let i = 0; i < stamps.length; i++) {
        ids.push(await store.append(eventInput({ content: `msg-${i}`, timestamp: stamps[i]! })));
      }
      const all = await store.query();
      expect(all.map((e) => e.timestamp)).toEqual([...stamps].sort().reverse());
    });

    it('returns events in timestamp ASC order when order: "asc" is passed', async () => {
      const stamps = [
        '2026-04-30T12:04:00.000Z',
        '2026-04-30T12:00:00.000Z',
        '2026-04-30T12:02:00.000Z',
        '2026-04-30T12:01:00.000Z',
        '2026-04-30T12:03:00.000Z',
      ];
      for (let i = 0; i < stamps.length; i++) {
        await store.append(eventInput({ content: `msg-${i}`, timestamp: stamps[i]! }));
      }
      const all = await store.query({ order: 'asc' });
      expect(all.map((e) => e.timestamp)).toEqual([...stamps].sort());
    });
  });

  describe('id uniqueness', () => {
    it('produces 100 distinct ids across 100 appends', async () => {
      const ids = new Set<string>();
      for (let i = 0; i < 100; i++) {
        ids.add(await store.append(eventInput({ content: `c-${i}` })));
      }
      expect(ids.size).toBe(100);
    });
  });

  describe('count', () => {
    it('returns 0 on empty store', async () => {
      expect(await store.count()).toBe(0);
    });

    it('reflects appends accurately', async () => {
      for (let i = 0; i < 7; i++) {
        await store.append(eventInput());
      }
      expect(await store.count()).toBe(7);
    });
  });

  describe('source filter', () => {
    it('returns only events whose source exactly matches', async () => {
      await store.append(
        eventInput({ source: 'fs:cursor', timestamp: '2026-04-30T10:00:00.000Z' }),
      );
      await store.append(
        eventInput({ source: 'api:github', timestamp: '2026-04-30T10:01:00.000Z' }),
      );
      await store.append(
        eventInput({ source: 'fs:cursor', timestamp: '2026-04-30T10:02:00.000Z' }),
      );
      const cursor = await store.query({ source: 'fs:cursor' });
      expect(cursor).toHaveLength(2);
      expect(cursor.every((e) => e.source === 'fs:cursor')).toBe(true);
    });

    it('returns empty when no events match', async () => {
      await store.append(eventInput({ source: 'fs:cursor' }));
      expect(await store.query({ source: 'api:slack' })).toHaveLength(0);
    });
  });

  describe('time-range filter', () => {
    beforeEach(async () => {
      await store.append(eventInput({ timestamp: '2026-04-30T09:00:00.000Z', content: 'a' }));
      await store.append(eventInput({ timestamp: '2026-04-30T10:00:00.000Z', content: 'b' }));
      await store.append(eventInput({ timestamp: '2026-04-30T11:00:00.000Z', content: 'c' }));
      await store.append(eventInput({ timestamp: '2026-04-30T12:00:00.000Z', content: 'd' }));
    });

    it('since is inclusive', async () => {
      const r = await store.query({ since: '2026-04-30T10:00:00.000Z', order: 'asc' });
      expect(r.map((e) => e.content)).toEqual(['b', 'c', 'd']);
    });

    it('until is exclusive', async () => {
      const r = await store.query({ until: '2026-04-30T11:00:00.000Z', order: 'asc' });
      expect(r.map((e) => e.content)).toEqual(['a', 'b']);
    });

    it('combined since + until bounds [since, until)', async () => {
      const r = await store.query({
        since: '2026-04-30T10:00:00.000Z',
        until: '2026-04-30T12:00:00.000Z',
        order: 'asc',
      });
      expect(r.map((e) => e.content)).toEqual(['b', 'c']);
    });

    it('-07:00 query window returns the same atoms as the equivalent Z window', async () => {
      const zWindow = await store.query({
        since: '2026-04-30T10:00:00.000Z',
        until: '2026-04-30T12:00:00.000Z',
        order: 'asc',
      });
      const offsetWindow = await store.query({
        since: '2026-04-30T03:00:00.000-07:00',
        until: '2026-04-30T05:00:00.000-07:00',
        order: 'asc',
      });
      expect(offsetWindow.map((e) => e.id)).toEqual(zWindow.map((e) => e.id));
      expect(offsetWindow.map((e) => e.content)).toEqual(['b', 'c']);
    });

    it('+0900 offset query window works', async () => {
      const r = await store.query({
        since: '2026-04-30T19:00:00+0900',
        until: '2026-04-30T21:00:00+0900',
        order: 'asc',
      });
      expect(r.map((e) => e.content)).toEqual(['b', 'c']);
    });

    it('missing-milliseconds Z query window works', async () => {
      const r = await store.query({
        since: '2026-04-30T10:00:00Z',
        until: '2026-04-30T12:00:00Z',
        order: 'asc',
      });
      expect(r.map((e) => e.content)).toEqual(['b', 'c']);
    });

    it('naive query window is canonicalized as local time before comparing', async () => {
      await store.append(
        eventInput({
          source: 'fs:local',
          timestamp: new Date('2026-04-30T10:30:00').toISOString(),
          content: 'local-window',
        }),
      );
      const r = await store.query({
        source: 'fs:local',
        since: '2026-04-30T10:00:00',
        until: '2026-04-30T11:00:00',
        order: 'asc',
      });
      expect(r.map((e) => e.content)).toEqual(['local-window']);
    });

    it('invalid query timestamp throws', async () => {
      await expect(store.query({ since: 'not-a-date' })).rejects.toThrow(
        /invalid timestamp: not-a-date/,
      );
    });
  });

  describe('limit filter', () => {
    it('with default DESC order, caps result at limit and returns the newest N (021)', async () => {
      for (let i = 0; i < 10; i++) {
        await store.append(
          eventInput({ content: `${i}`, timestamp: `2026-04-30T12:0${i}:00.000Z` }),
        );
      }
      const r = await store.query({ limit: 3 });
      expect(r).toHaveLength(3);
      expect(r.map((e) => e.content)).toEqual(['9', '8', '7']);
    });

    it('with order: "asc", caps result at limit and returns the oldest N', async () => {
      for (let i = 0; i < 10; i++) {
        await store.append(
          eventInput({ content: `${i}`, timestamp: `2026-04-30T12:0${i}:00.000Z` }),
        );
      }
      const r = await store.query({ limit: 3, order: 'asc' });
      expect(r).toHaveLength(3);
      expect(r.map((e) => e.content)).toEqual(['0', '1', '2']);
    });

    it('returns all when limit exceeds total', async () => {
      for (let i = 0; i < 3; i++) await store.append(eventInput({ content: `${i}` }));
      expect(await store.query({ limit: 100 })).toHaveLength(3);
    });
  });

  describe('combined filters', () => {
    beforeEach(async () => {
      await store.append(
        eventInput({ source: 'fs:cursor', timestamp: '2026-04-30T09:00:00.000Z', content: 'cur1' }),
      );
      await store.append(
        eventInput({ source: 'api:github', timestamp: '2026-04-30T10:00:00.000Z', content: 'gh1' }),
      );
      await store.append(
        eventInput({ source: 'fs:cursor', timestamp: '2026-04-30T11:00:00.000Z', content: 'cur2' }),
      );
      await store.append(
        eventInput({ source: 'fs:cursor', timestamp: '2026-04-30T12:00:00.000Z', content: 'cur3' }),
      );
      await store.append(
        eventInput({ source: 'fs:cursor', timestamp: '2026-04-30T13:00:00.000Z', content: 'cur4' }),
      );
    });

    it('source + since + limit compose correctly under default DESC order (021)', async () => {
      const r = await store.query({
        source: 'fs:cursor',
        since: '2026-04-30T10:30:00.000Z',
        limit: 2,
      });
      expect(r.map((e) => e.content)).toEqual(['cur4', 'cur3']);
    });

    it('source + until rejects out-of-range matches', async () => {
      const r = await store.query({
        source: 'fs:cursor',
        until: '2026-04-30T11:00:00.000Z',
      });
      expect(r.map((e) => e.content)).toEqual(['cur1']);
    });
  });

  describe('close()', () => {
    it('is safe to call twice', () => {
      const s = new SqliteStorage(':memory:');
      s.close();
      expect(() => s.close()).not.toThrow();
    });
  });
});

describe('SqliteStorage durability', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'echo-sqlite-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('write → close → reopen → identical readback', async () => {
    const dbPath = join(dir, 'echo.db');
    const a = new SqliteStorage(dbPath);
    const id1 = await a.append(
      eventInput({ source: 'api:github', content: 'one', metadata: { x: 1 } }),
    );
    const id2 = await a.append(
      eventInput({
        source: 'fs:cursor',
        content: 'two',
        timestamp: '2026-04-30T12:01:00.000Z',
        embedding: [0.5, -0.5],
      }),
    );
    a.close();

    const b = new SqliteStorage(dbPath);
    expect(await b.count()).toBe(2);
    const all = await b.query();
    const ids = all.map((e) => e.id);
    expect(new Set(ids)).toEqual(new Set([id1, id2]));
    const byContent = new Map(all.map((e) => [e.content, e]));
    expect(byContent.get('one')!.metadata).toEqual({ x: 1 });
    expect(byContent.get('two')!.embedding).toHaveLength(2);
    expect(byContent.get('two')!.embedding![0]).toBeCloseTo(0.5, 5);
    expect(byContent.get('two')!.embedding![1]).toBeCloseTo(-0.5, 5);
    b.close();
  });
});

describe('migration runner', () => {
  it('starts at user_version 0 on a fresh DB and applies all packaged migrations', () => {
    const db = new Database(':memory:');
    expect(db.pragma('user_version', { simple: true })).toBe(0);
    const v = migrate(db, MIGRATIONS_DIR);
    expect(v).toBe(LATEST_SCHEMA_VERSION);
    expect(db.pragma('temp_store', { simple: true })).toBe(1);
    expect(db.pragma('user_version', { simple: true })).toBe(LATEST_SCHEMA_VERSION);
    const tables = db
      .prepare(
        `SELECT name FROM sqlite_master
         WHERE type='table' AND name IN ('events', 'capture_checkpoints')
         ORDER BY name`,
      )
      .all() as { name: string }[];
    expect(tables.map((row) => row.name)).toEqual(['capture_checkpoints', 'events']);
    db.close();
  });

  it('is a no-op on a DB already at the latest version', () => {
    const db = new Database(':memory:');
    migrate(db, MIGRATIONS_DIR);
    const latest = migrate(db, MIGRATIONS_DIR);
    expect(latest).toBe(LATEST_SCHEMA_VERSION);
    expect(db.pragma('user_version', { simple: true })).toBe(LATEST_SCHEMA_VERSION);
    db.close();
  });

  it('upgrades a version-5 ledger with generated overlapping source-family indexes', () => {
    const root = mkdtempSync(join(tmpdir(), 'echo-source-family-migration-'));
    const dbPath = join(root, 'context.db');
    try {
      const legacy = new Database(dbPath);
      legacy.function(
        'echo_normalize_path_like_source',
        { deterministic: true },
        (source: string) => normalizePathLikeSource(source),
      );
      for (const migration of MIGRATIONS.slice(0, 5)) {
        legacy.transaction(() => {
          legacy.exec(migration.sql);
          legacy.pragma(`user_version = ${migration.version}`);
        })();
      }
      legacy
        .prepare(
          `INSERT INTO events (id, source, source_key, timestamp, content)
           VALUES (?, ?, ?, ?, 'legacy overlap')`,
        )
        .run(
          'overlap',
          'fs:/home/.codex/sessions/nested/.claude/projects/a.jsonl',
          normalizePathLikeSource('fs:/home/.codex/sessions/nested/.claude/projects/a.jsonl'),
          '2026-04-30T12:00:00.000Z',
        );
      legacy.close();

      new SqliteStorage(dbPath).close();
      const inspect = new Database(dbPath, { readonly: true });
      expect(inspect.pragma('user_version', { simple: true })).toBe(LATEST_SCHEMA_VERSION);
      expect(
        inspect
          .prepare('SELECT source_family_mask FROM events WHERE id = ?')
          .pluck()
          .get('overlap'),
      ).toBe(6);
      const indexes = inspect
        .prepare(
          `SELECT name FROM sqlite_master
            WHERE type = 'index' AND name LIKE 'idx_events_source_family_%'
            ORDER BY name`,
        )
        .pluck()
        .all();
      expect(indexes).toEqual([
        'idx_events_source_family_claude_code_timestamp_id',
        'idx_events_source_family_codex_timestamp_id',
        'idx_events_source_family_cursor_timestamp_id',
        'idx_events_source_family_git_timestamp_id',
        'idx_events_source_family_granola_timestamp_id',
      ]);
      inspect.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('fails closed when user_version is newer than the package schema', () => {
    const db = new Database(':memory:');
    db.exec('CREATE TABLE future_authority (value TEXT NOT NULL)');
    db.prepare('INSERT INTO future_authority (value) VALUES (?)').run('preserve');
    db.pragma('user_version = 999');

    expect(() => migrate(db, MIGRATIONS_DIR)).toThrow(
      new RegExp(`schema version 999 is newer than supported version ${LATEST_SCHEMA_VERSION}`),
    );
    expect(db.pragma('user_version', { simple: true })).toBe(999);
    expect(db.prepare('SELECT value FROM future_authority').pluck().get()).toBe('preserve');
    db.close();
  });
});

describe('SqliteStorage timestamp canonicalization migration (item 022 Bug A)', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'echo-canon-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('canonicalizes new offset timestamps at the append seam', async () => {
    const dbPath = join(dir, 'echo.db');
    const a = new SqliteStorage(dbPath);
    await a.append({
      source: 'git:repo',
      timestamp: '2026-05-08T00:00:00.000-07:00', // = 2026-05-08T07:00:00.000Z
      content: 'commit-canonical',
    });
    const inWindow = await a.query({
      since: '2026-05-08T05:00:00.000Z',
      until: '2026-05-08T09:00:00.000Z',
    });
    expect(inWindow).toHaveLength(1);
    expect(inWindow[0]!.timestamp).toBe('2026-05-08T07:00:00.000Z');
    a.close();
  });

  it('canonicalizes a version-2 legacy ledger once during schema migration', async () => {
    const dbPath = join(dir, 'echo.db');
    const legacy = new Database(dbPath);
    legacy.exec(readFileSync(INITIAL_MIGRATION, 'utf8'));
    legacy.exec(readFileSync(CHECKPOINT_MIGRATION, 'utf8'));
    legacy.pragma('user_version = 2');
    legacy
      .prepare(
        `INSERT INTO events (id, source, timestamp, content)
         VALUES ('legacy-offset', 'git:repo', '2026-05-08T00:18:26.123-07:00', 'legacy')`,
      )
      .run();
    legacy.close();

    const b = new SqliteStorage(dbPath);
    const migrated = await b.query({
      since: '2026-05-08T05:00:00.000Z',
      until: '2026-05-08T09:00:00.000Z',
    });
    expect(migrated).toHaveLength(1);
    expect(migrated[0]!.timestamp).toBe('2026-05-08T07:18:26.123Z');
    b.close();

    const inspect = new Database(dbPath, { readonly: true });
    expect(inspect.pragma('user_version', { simple: true })).toBe(LATEST_SCHEMA_VERSION);
    expect(inspect.prepare('SELECT timestamp FROM events').pluck().get()).toBe(
      '2026-05-08T07:18:26.123Z',
    );
    inspect.close();
  });

  it('rolls back and leaves version 2 when a legacy timestamp is unparsable', () => {
    const dbPath = join(dir, 'invalid.db');
    const legacy = new Database(dbPath);
    legacy.exec(readFileSync(INITIAL_MIGRATION, 'utf8'));
    legacy.exec(readFileSync(CHECKPOINT_MIGRATION, 'utf8'));
    legacy.pragma('user_version = 2');
    legacy
      .prepare(
        `INSERT INTO events (id, source, timestamp, content)
         VALUES ('invalid', 'git:repo', 'not-a-timestamp', 'preserve')`,
      )
      .run();
    legacy.close();

    expect(() => new SqliteStorage(dbPath)).toThrow(/CHECK constraint failed/);
    const inspect = new Database(dbPath, { readonly: true });
    expect(inspect.pragma('user_version', { simple: true })).toBe(2);
    expect(inspect.prepare('SELECT timestamp FROM events').pluck().get()).toBe('not-a-timestamp');
    inspect.close();
  });
});

describe('SqliteStorage authority permissions', () => {
  const posixIt = process.platform === 'win32' ? it.skip : it;
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'echo-private-db-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  posixIt('creates private database, directory, and live WAL/SHM authority', async () => {
    const authorityDir = join(dir, 'new', 'authority');
    const dbPath = join(authorityDir, 'context.db');
    const storage = new SqliteStorage(dbPath);
    await storage.append(eventInput());

    expect(statSync(authorityDir).mode & 0o777).toBe(0o700);
    expect(statSync(dbPath).mode & 0o777).toBe(0o600);
    for (const suffix of ['-wal', '-shm']) {
      const sidecar = `${dbPath}${suffix}`;
      expect(existsSync(sidecar)).toBe(true);
      expect(statSync(sidecar).mode & 0o777).toBe(0o600);
    }
    storage.close();
  });

  posixIt('does not chmod a pre-existing caller-owned database', () => {
    const dbPath = join(dir, 'existing.db');
    new SqliteStorage(dbPath).close();
    chmodSync(dbPath, 0o640);

    const reopened = new SqliteStorage(dbPath);
    reopened.close();
    expect(statSync(dbPath).mode & 0o777).toBe(0o640);
  });
});

describe('SqliteStorage exclude_metadata_surface filter (item 022 Bug C)', () => {
  let store: SqliteStorage;

  beforeEach(() => {
    store = new SqliteStorage(':memory:');
  });

  afterEach(() => {
    store.close();
  });

  it('excludes rows whose metadata.surface is in the exclusion list', async () => {
    await store.append({
      source: 'fs:/Users/zhen/.claude/projects/abc/s.jsonl',
      timestamp: '2026-05-08T10:00:00.000Z',
      content: 'turn-pair',
      metadata: { session_id: 'abc' }, // no surface
    });
    await store.append({
      source: 'fs:/Users/zhen/file.txt',
      timestamp: '2026-05-08T10:01:00.000Z',
      content: '{"event_type":"change","path":"/x","mtime":"...","size":1}',
      metadata: { surface: 'fs', file_kind: 'cursor-workspace' },
    });
    await store.append({
      source: 'git:repo',
      timestamp: '2026-05-08T10:02:00.000Z',
      content: 'commit',
      metadata: { sha: 'abc' },
    });

    const all = await store.query();
    expect(all).toHaveLength(3);

    const filtered = await store.query({ exclude_metadata_surface: ['fs'] });
    expect(filtered).toHaveLength(2);
    expect(filtered.map((e) => e.content).sort()).toEqual(['commit', 'turn-pair']);
  });

  it('preserves the conversation-atom path: fs: source-prefix events without surface=fs are kept', async () => {
    await store.append({
      source: 'fs:/Users/zhen/.claude/projects/abc/s.jsonl',
      timestamp: '2026-05-08T10:00:00.000Z',
      content: 'USER: ...\n\nASSISTANT: ...',
      metadata: { session_id: 'abc', repo_root: '/repo' },
    });
    const r = await store.query({ exclude_metadata_surface: ['fs'] });
    expect(r).toHaveLength(1);
  });

  it('empty exclusion list is a no-op', async () => {
    await store.append({
      source: 'fs:test',
      timestamp: '2026-05-08T10:00:00.000Z',
      content: 'x',
      metadata: { surface: 'fs' },
    });
    expect(await store.query({ exclude_metadata_surface: [] })).toHaveLength(1);
  });
});

describe('SqliteStorage composite-key ordering + cursor pagination (item 025)', () => {
  let store: SqliteStorage;

  beforeEach(() => {
    store = new SqliteStorage(':memory:');
  });

  afterEach(() => {
    store.close();
  });

  async function seedSameMs(ts: string, count: number): Promise<string[]> {
    const ids: string[] = [];
    for (let i = 0; i < count; i++) {
      ids.push(
        await store.append({
          source: 'fs:test',
          timestamp: ts,
          content: `c-${i}`,
        }),
      );
    }
    return ids;
  }

  it('query({}) on same-ms-tied rows returns deterministic id-DESC order across 10 runs', async () => {
    const ts = '2026-05-08T12:00:00.000Z';
    await seedSameMs(ts, 5);
    // Take a baseline ordering and assert it does not change across 10
    // consecutive runs. Pre-fix the order was undefined (non-deterministic
    // tie-break inside SQLite); post-fix it must be stable id-DESC.
    const baseline = (await store.query({})).map((e) => e.id);
    expect(baseline).toHaveLength(5);
    // Confirm it's actually sorted id-DESC.
    expect(baseline).toEqual([...baseline].sort().reverse());
    for (let i = 0; i < 10; i++) {
      const next = (await store.query({})).map((e) => e.id);
      expect(next).toEqual(baseline);
    }
  });

  it('query({order: "asc"}) on same-ms-tied rows returns deterministic id-ASC order', async () => {
    const ts = '2026-05-08T12:00:00.000Z';
    await seedSameMs(ts, 5);
    const r = (await store.query({ order: 'asc' })).map((e) => e.id);
    expect(r).toEqual([...r].sort());
  });

  it('before filter: returns rows strictly older than (timestamp, id)', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      ids.push(
        await store.append({
          source: 'fs:test',
          timestamp: `2026-05-08T12:0${i}:00.000Z`,
          content: `c-${i}`,
        }),
      );
    }
    // ids[3] is the 4th-appended (timestamp 12:03:00). Asking for rows
    // strictly older than (12:03:00, ids[3]) should yield only the 3 earlier
    // events under DESC ordering.
    const r = await store.query({
      before: { timestamp: '2026-05-08T12:03:00.000Z', id: ids[3]! },
    });
    expect(r).toHaveLength(3);
    // DESC: 12:02 → 12:01 → 12:00
    expect(r.map((e) => e.content)).toEqual(['c-2', 'c-1', 'c-0']);
  });

  it('before + order: "asc" throws synchronously', async () => {
    await expect(
      store.query({
        before: { timestamp: '2026-05-08T12:00:00.000Z', id: 'some-id' },
        order: 'asc',
      }),
    ).rejects.toThrow(/before is defined for descending queries only/);
  });
});
