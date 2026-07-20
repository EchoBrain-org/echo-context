import { chmodSync, existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { copyDatabaseForContext } from '../../src/migration/copy-database.js';
import {
  assertCopyContainsCurrentLegacy,
  readCopyLineage,
} from '../../src/migration/copy-lineage.js';
import { SqliteStorage } from '../../src/storage/sqlite.js';

describe('copyDatabaseForContext', () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it('backs up read-only source state, applies additive migrations, and verifies event count', async () => {
    const root = mkdtempSync(join(tmpdir(), 'echo-context-copy-'));
    roots.push(root);
    const source = join(root, 'source.db');
    const destination = join(root, 'candidate', 'context.db');
    const store = new SqliteStorage(source);
    await store.append({
      source: 'fs:/tmp/session.jsonl',
      timestamp: '2026-07-20T12:00:00.000Z',
      content: 'USER: hi\n\nASSISTANT: hello',
      metadata: { byte_offset: 42, turn_index: 0 },
    });
    store.close();
    if (process.platform !== 'win32') chmodSync(source, 0o640);

    const result = await copyDatabaseForContext(source, destination);
    expect(result).toMatchObject({ events: 1, integrity: 'ok' });
    expect(existsSync(destination)).toBe(true);
    if (process.platform !== 'win32') {
      expect(statSync(source).mode & 0o777).toBe(0o640);
      expect(statSync(join(root, 'candidate')).mode & 0o777).toBe(0o700);
      expect(statSync(destination).mode & 0o777).toBe(0o600);
    }

    const copied = new SqliteStorage(destination);
    expect(await copied.count()).toBe(1);
    copied.close();
    expect(readCopyLineage(destination)).toMatchObject({
      sourceEventCount: 1,
      snapshotLastEventId: result.snapshotLastEventId,
    });
    expect(() => assertCopyContainsCurrentLegacy(source, destination)).not.toThrow();
  });

  it('never overwrites an existing destination', async () => {
    const root = mkdtempSync(join(tmpdir(), 'echo-context-copy-'));
    roots.push(root);
    const source = join(root, 'source.db');
    const destination = join(root, 'destination.db');
    new SqliteStorage(source).close();
    new SqliteStorage(destination).close();
    await expect(copyDatabaseForContext(source, destination)).rejects.toThrow(/already exists/);
  });

  it('records the numeric SQLite tail rather than lexicographic rowid order', async () => {
    const root = mkdtempSync(join(tmpdir(), 'echo-context-copy-tail-'));
    roots.push(root);
    const source = join(root, 'source.db');
    const destination = join(root, 'destination.db');
    const seed = new SqliteStorage(source);
    const ids: string[] = [];
    for (let index = 0; index < 12; index += 1) {
      ids.push(
        await seed.append({
          source: 'fs:/tmp/numeric-tail.jsonl',
          timestamp: `2026-07-20T12:00:${String(index).padStart(2, '0')}.000Z`,
          content: `event ${index}`,
        }),
      );
    }
    seed.close();

    const result = await copyDatabaseForContext(source, destination);
    expect(result.snapshotLastRowid).toBe(12);
    expect(result.snapshotLastEventId).toBe(ids[11]);
    expect(readCopyLineage(destination).snapshotLastRowid).toBe('12');
  });

  it('atomically permits only one concurrent publisher for a destination', async () => {
    const root = mkdtempSync(join(tmpdir(), 'echo-context-copy-'));
    roots.push(root);
    const source = join(root, 'source.db');
    const destination = join(root, 'destination.db');
    const seed = new SqliteStorage(source);
    await seed.append({
      source: 'fs:/tmp/race.jsonl',
      timestamp: '2026-07-20T12:00:00.000Z',
      content: 'preserve me',
    });
    seed.close();

    const outcomes = await Promise.allSettled([
      copyDatabaseForContext(source, destination),
      copyDatabaseForContext(source, destination),
    ]);
    expect(outcomes.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.filter((result) => result.status === 'rejected')).toHaveLength(1);
    const copied = new SqliteStorage(destination);
    expect(await copied.count()).toBe(1);
    copied.close();
  });

  it('pins count and backup to one snapshot while the source keeps writing', async () => {
    const root = mkdtempSync(join(tmpdir(), 'echo-context-copy-'));
    roots.push(root);
    const source = join(root, 'source.db');
    const destination = join(root, 'destination.db');
    const seed = new SqliteStorage(source);
    await seed.append({
      source: 'fs:/tmp/before.jsonl',
      timestamp: '2026-07-20T12:00:00.000Z',
      content: 'before snapshot',
    });
    seed.close();

    const result = await copyDatabaseForContext(source, destination, {
      afterSnapshotEstablished: async () => {
        const writer = new SqliteStorage(source);
        await writer.append({
          source: 'fs:/tmp/after.jsonl',
          timestamp: '2026-07-20T12:00:01.000Z',
          content: 'after snapshot',
        });
        writer.close();
      },
    });
    expect(result.events).toBe(1);
    const live = new SqliteStorage(source);
    const copied = new SqliteStorage(destination);
    expect(await live.count()).toBe(2);
    expect(await copied.count()).toBe(1);
    live.close();
    copied.close();
    expect(() => assertCopyContainsCurrentLegacy(source, destination)).toThrow(
      /stale or unrelated/,
    );
  });
});
