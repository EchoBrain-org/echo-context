import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  STORAGE_DESCRIPTOR_ID_BYTES,
  STORAGE_DESCRIPTOR_PAGE_ROWS,
  STORAGE_DESCRIPTOR_SOURCE_BYTES,
  STORAGE_DESCRIPTOR_TIMESTAMP_BYTES,
  STORAGE_GET_BY_IDS_MAX_IDS,
  STORAGE_MAX_DESCRIPTOR_PAGES,
  STORAGE_MAX_ROW_LIMIT,
  STORAGE_MAX_SCANNED_ROWS,
  STORAGE_PAYLOAD_PAGE_BYTES,
  STORAGE_PAYLOAD_PAGE_ROWS,
  STORAGE_QUERY_STORED_BYTES,
  type StorageSelectPageObservation,
} from '../../src/storage/budgets.js';
import { normalizePathLikeSource } from '../../src/storage/source-match.js';
import { SqliteStorage } from '../../src/storage/sqlite.js';

function timestampAt(second: number): string {
  return new Date(Date.UTC(2026, 0, 1) + second * 1_000).toISOString();
}

describe('SqliteStorage hard read budgets', () => {
  let dir: string;
  let dbPath: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'echo-storage-budget-'));
    dbPath = join(dir, 'context.db');
    new SqliteStorage(dbPath).close();

    const db = new Database(dbPath);
    const insert = db.prepare(
      `INSERT INTO events (id, source, source_key, timestamp, content, metadata)
       VALUES (@id, @source, @source_key, @timestamp, @content, @metadata)`,
    );
    const seed = db.transaction(() => {
      insert.run({
        id: 'wanted',
        source: 'fs:/wanted/session.jsonl',
        source_key: normalizePathLikeSource('fs:/wanted/session.jsonl'),
        timestamp: timestampAt(0),
        content: 'wanted',
        metadata: JSON.stringify({ composer_id: 'wanted' }),
      });
      for (let i = 1; i <= STORAGE_MAX_SCANNED_ROWS; i += 1) {
        const source = `fs:/other/session-${i}.jsonl`;
        insert.run({
          id: `noise-${i.toString().padStart(5, '0')}`,
          source,
          source_key: normalizePathLikeSource(source),
          timestamp: timestampAt(i),
          content: 'noise',
          metadata: JSON.stringify({ surface: 'fs', composer_id: 'noise' }),
        });
      }
    });
    seed();
    db.close();
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('applies a finite default and hard maximum row cap', async () => {
    const storage = new SqliteStorage(dbPath);
    expect(await storage.query()).toHaveLength(1_000);
    expect(await storage.query({ limit: Number.MAX_SAFE_INTEGER })).toHaveLength(
      STORAGE_MAX_ROW_LIMIT,
    );
    expect(await storage.iterateAtomsByAppendOrder()).toHaveLength(1_000);
    expect(
      await storage.iterateAtomsByAppendOrder({ limit: Number.MAX_SAFE_INTEGER }),
    ).toHaveLength(STORAGE_MAX_ROW_LIMIT);
    storage.close();
  });

  it('uses the normalized exact-source index to reach a sparse old path directly', async () => {
    const observations: StorageSelectPageObservation[] = [];
    const storage = new SqliteStorage(dbPath, {
      onSelectPage: (observation) => observations.push(observation),
    });
    const rows = await storage.query({ source: 'fs:\\wanted\\session.jsonl', limit: 1 });
    expect(rows.map((row) => row.id)).toEqual(['wanted']);
    expect(observations.filter((item) => item.phase === 'descriptor')).toHaveLength(1);
    expect(observations.find((item) => item.phase === 'descriptor')?.rows).toBe(1);
    storage.close();
  });

  it('stops a sparse source-prefix scan at the descriptor budget and exposes lossless continuation', async () => {
    const observations: StorageSelectPageObservation[] = [];
    const storage = new SqliteStorage(dbPath, {
      onSelectPage: (observation) => observations.push(observation),
    });
    let failure: unknown;
    try {
      await storage.query({ source_prefix: 'fs:/wanted', limit: 1 });
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({
      code: 'scan_budget_exceeded',
      scanned_rows: STORAGE_MAX_SCANNED_ROWS,
      matched_ids: [],
      order: 'desc',
    });
    const resume = (failure as { resume_cursor: { timestamp: string; id: string } })
      .resume_cursor;
    expect(observations.filter((item) => item.phase === 'descriptor')).toHaveLength(
      STORAGE_MAX_DESCRIPTOR_PAGES,
    );
    expect(observations.every((item) => item.rows <= STORAGE_DESCRIPTOR_PAGE_ROWS)).toBe(true);
    expect(observations.filter((item) => item.phase === 'payload')).toHaveLength(0);

    const resumed = await storage.query({
      source_prefix: 'fs:/wanted',
      before: resume,
      limit: 1,
    });
    expect(resumed.map((row) => row.id)).toEqual(['wanted']);
    storage.close();
  });

  it('bounds sparse JSON metadata work to the same resumable descriptor window', async () => {
    const observations: StorageSelectPageObservation[] = [];
    const storage = new SqliteStorage(dbPath, {
      onSelectPage: (observation) => observations.push(observation),
    });
    let failure: unknown;
    try {
      await storage.query({
        metadata_match: { composer_id: 'wanted' },
        exclude_metadata_surface: ['fs'],
        limit: 1,
      });
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({
      code: 'scan_budget_exceeded',
      scanned_rows: STORAGE_MAX_SCANNED_ROWS,
    });
    const resume = (failure as { resume_cursor: { timestamp: string; id: string } })
      .resume_cursor;
    expect(observations.filter((item) => item.phase === 'descriptor')).toHaveLength(
      STORAGE_MAX_DESCRIPTOR_PAGES,
    );
    expect(observations.filter((item) => item.phase === 'payload')).toHaveLength(0);
    const resumed = await storage.query({
      metadata_match: { composer_id: 'wanted' },
      exclude_metadata_surface: ['fs'],
      before: resume,
      limit: 1,
    });
    expect(resumed.map((row) => row.id)).toEqual(['wanted']);
    storage.close();
  });

  it('bounds sparse append-order prefix work and exposes sequence continuation', async () => {
    const observations: StorageSelectPageObservation[] = [];
    const storage = new SqliteStorage(dbPath, {
      onSelectPage: (observation) => observations.push(observation),
    });
    let failure: unknown;
    try {
      await storage.iterateAtomsByAppendOrder({
        sourcePrefixes: ['fs:/wanted'],
        limit: 2,
      });
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({
      code: 'scan_budget_exceeded',
      operation: 'iterateAtomsByAppendOrder',
      scanned_rows: STORAGE_MAX_SCANNED_ROWS,
      matched: [{ id: 'wanted', sequence_id: 1 }],
      resume_since_seq: STORAGE_MAX_SCANNED_ROWS + 1,
    });
    expect(
      observations.filter(
        (item) => item.operation === 'iterateAtomsByAppendOrder' && item.phase === 'descriptor',
      ),
    ).toHaveLength(STORAGE_MAX_DESCRIPTOR_PAGES);
    expect(observations.filter((item) => item.phase === 'payload')).toHaveLength(0);
    expect(await storage.getByIds(['wanted'])).toHaveLength(1);
    expect(
      await storage.iterateAtomsByAppendOrder({
        sourcePrefixes: ['fs:/wanted'],
        sinceSeq: STORAGE_MAX_SCANNED_ROWS + 1,
        limit: 2,
      }),
    ).toEqual([]);
    storage.close();
  });

  it('rejects an oversized append without creating a durable poison row', async () => {
    const storage = new SqliteStorage(':memory:');
    await expect(
      storage.append({
        source: 'git:repo',
        timestamp: timestampAt(0),
        content: 'x'.repeat(STORAGE_PAYLOAD_PAGE_BYTES),
      }),
    ).rejects.toMatchObject({ code: 'event_too_large', operation: 'append' });
    expect(await storage.count()).toBe(0);
    storage.close();
  });

  it('rejects oversized descriptor inputs before append/query/getByIds work', async () => {
    const observations: StorageSelectPageObservation[] = [];
    const storage = new SqliteStorage(':memory:', {
      onSelectPage: (observation) => observations.push(observation),
    });
    await expect(
      storage.append({
        source: 's'.repeat(STORAGE_DESCRIPTOR_SOURCE_BYTES + 1),
        timestamp: timestampAt(0),
        content: 'never stored',
      }),
    ).rejects.toMatchObject({
      code: 'descriptor_field_too_large',
      operation: 'append',
      field: 'source',
    });
    await expect(
      storage.append({
        source: 'git:repo',
        timestamp: 't'.repeat(STORAGE_DESCRIPTOR_TIMESTAMP_BYTES + 1),
        content: 'never stored',
      }),
    ).rejects.toMatchObject({
      code: 'descriptor_field_too_large',
      operation: 'append',
      field: 'timestamp',
    });
    await expect(
      storage.query({ source_prefix: 's'.repeat(STORAGE_DESCRIPTOR_SOURCE_BYTES + 1) }),
    ).rejects.toMatchObject({
      code: 'descriptor_field_too_large',
      operation: 'query',
      field: 'source',
    });
    await expect(
      storage.getByIds(['i'.repeat(STORAGE_DESCRIPTOR_ID_BYTES + 1)]),
    ).rejects.toMatchObject({
      code: 'descriptor_field_too_large',
      operation: 'getByIds',
      field: 'id',
    });
    expect(await storage.count()).toBe(0);
    expect(observations).toHaveLength(0);
    storage.close();
  });

  it.each([
    {
      field: 'id',
      id: 'i'.repeat(STORAGE_DESCRIPTOR_ID_BYTES + 1),
      source: 'git:legacy',
      timestamp: timestampAt(0),
    },
    {
      field: 'source',
      id: 'legacy-source',
      source: 's'.repeat(STORAGE_DESCRIPTOR_SOURCE_BYTES + 1),
      timestamp: timestampAt(0),
    },
    {
      field: 'timestamp',
      id: 'legacy-timestamp',
      source: 'git:legacy',
      timestamp: 'z'.repeat(STORAGE_DESCRIPTOR_TIMESTAMP_BYTES + 1),
    },
  ] as const)(
    'rejects a legacy oversized $field descriptor before any payload SELECT',
    async ({ field, id, source, timestamp }) => {
      const poisonPath = join(dir, `legacy-${field}-descriptor.db`);
      new SqliteStorage(poisonPath).close();
      const db = new Database(poisonPath);
      db.prepare(
        `INSERT INTO events (id, source, timestamp, content)
         VALUES (?, ?, ?, 'must stay native')`,
      ).run(id, source, timestamp);
      db.close();

      const observations: StorageSelectPageObservation[] = [];
      const storage = new SqliteStorage(poisonPath, {
        onSelectPage: (observation) => observations.push(observation),
      });
      await expect(storage.query({ limit: 1 })).rejects.toMatchObject({
        code: 'descriptor_field_too_large',
        operation: 'query',
        field,
      });
      expect(observations.filter((item) => item.phase === 'descriptor')).toHaveLength(1);
      expect(observations.filter((item) => item.phase === 'payload')).toHaveLength(0);
      storage.close();
    },
  );

  it('fails migration before a huge legacy source reaches the normalizer', () => {
    const poisonPath = join(dir, 'legacy-v4-huge-source.db');
    const db = new Database(poisonPath);
    db.exec(`
      CREATE TABLE events (
        id TEXT PRIMARY KEY,
        source TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        content TEXT NOT NULL,
        metadata TEXT,
        embedding BLOB
      );
      PRAGMA user_version = 4;
    `);
    db.prepare(
      `INSERT INTO events (id, source, timestamp, content) VALUES (?, ?, ?, 'poison')`,
    ).run('legacy', 's'.repeat(STORAGE_DESCRIPTOR_SOURCE_BYTES + 1), timestampAt(0));
    db.close();

    expect(() => new SqliteStorage(poisonPath)).toThrow(/CHECK constraint failed/);
    const unchanged = new Database(poisonPath);
    expect(unchanged.pragma('user_version', { simple: true })).toBe(4);
    unchanged.close();
  });

  it('never selects a legacy oversized event payload into JS', async () => {
    const poisonPath = join(dir, 'legacy-poison.db');
    new SqliteStorage(poisonPath).close();
    const db = new Database(poisonPath);
    db.prepare(
      `INSERT INTO events (id, source, timestamp, content)
       VALUES ('poison', 'git:poison', ?, ?)`,
    ).run(timestampAt(0), 'x'.repeat(STORAGE_PAYLOAD_PAGE_BYTES + 1));
    db.close();
    const observations: StorageSelectPageObservation[] = [];
    const storage = new SqliteStorage(poisonPath, {
      onSelectPage: (observation) => observations.push(observation),
    });
    await expect(storage.query({ source: 'git:poison', limit: 1 })).rejects.toMatchObject({
      code: 'event_too_large',
      operation: 'query',
    });
    expect(observations.filter((item) => item.phase === 'descriptor')).toHaveLength(1);
    expect(observations.filter((item) => item.phase === 'payload')).toHaveLength(0);
    storage.close();
  });

  it('fails explicitly on aggregate stored-byte overflow before any payload SELECT', async () => {
    const observations: StorageSelectPageObservation[] = [];
    const storage = new SqliteStorage(':memory:', {
      onSelectPage: (observation) => observations.push(observation),
    });
    const content = 'x'.repeat(Math.floor(STORAGE_QUERY_STORED_BYTES / 9) + 1_024);
    for (let i = 0; i < 9; i += 1) {
      await storage.append({ source: 'git:large', timestamp: timestampAt(i), content });
    }
    await expect(storage.query({ limit: 9 })).rejects.toMatchObject({
      code: 'request_too_large',
      operation: 'query',
    });
    expect(observations.filter((item) => item.phase === 'payload')).toHaveLength(0);
    storage.close();
  });

  it('bounds every query/getByIds/append-order payload page by rows and stored bytes', async () => {
    const observations: StorageSelectPageObservation[] = [];
    const storage = new SqliteStorage(':memory:', {
      onSelectPage: (observation) => observations.push(observation),
    });
    const ids: string[] = [];
    for (let i = 0; i < 70; i += 1) {
      ids.push(
        await storage.append({
          source: 'git:paged',
          timestamp: timestampAt(i),
          content: 'x'.repeat(60 * 1_024),
        }),
      );
    }
    expect(await storage.query({ limit: 70 })).toHaveLength(70);
    expect(await storage.getByIds(ids)).toHaveLength(70);
    expect(await storage.iterateAtomsByAppendOrder({ limit: 70 })).toHaveLength(70);

    const payloadPages = observations.filter((item) => item.phase === 'payload');
    expect(new Set(payloadPages.map((item) => item.operation))).toEqual(
      new Set(['query', 'getByIds', 'iterateAtomsByAppendOrder']),
    );
    for (const page of payloadPages) {
      expect(page.rows).toBeLessThanOrEqual(STORAGE_PAYLOAD_PAGE_ROWS);
      expect(page.stored_bytes).toBeLessThanOrEqual(STORAGE_PAYLOAD_PAGE_BYTES);
    }
    storage.close();
  });

  it('rejects oversized getByIds input before issuing any SELECT', async () => {
    const observations: StorageSelectPageObservation[] = [];
    const storage = new SqliteStorage(':memory:', {
      onSelectPage: (observation) => observations.push(observation),
    });
    await expect(
      storage.getByIds(Array.from({ length: STORAGE_GET_BY_IDS_MAX_IDS + 1 }, (_, i) => `${i}`)),
    ).rejects.toThrow(/at most 100 ids/);
    expect(observations).toHaveLength(0);
    storage.close();
  });
});
