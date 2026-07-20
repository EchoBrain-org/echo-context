import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { CaptureEvent, Storage } from '../../src/storage/interface.js';
import { MemoryStorage } from '../../src/storage/memory.js';
import { SqliteStorage } from '../../src/storage/sqlite.js';

const EVENT: Omit<CaptureEvent, 'id'> = {
  source: 'fs:/repo/session.jsonl',
  timestamp: '2026-07-20T12:00:00.000Z',
  content: 'USER: hello\n\nASSISTANT: hi',
  metadata: { byte_offset: 42, turn_index: 0 },
  embedding: [0.25, -0.5],
};

async function assertReplayContract(storage: Storage): Promise<void> {
  const first = await storage.append(EVENT, { dedupeKey: 'codex:/repo/session.jsonl:0:42' });
  const replay = await storage.append(EVENT, { dedupeKey: 'codex:/repo/session.jsonl:0:42' });
  expect(replay).toBe(first);
  expect(first).toMatch(/^dedupe:v1:[a-f0-9]{64}$/);
  expect(await storage.count()).toBe(1);

  const enrichedReplay = await storage.append(
    {
      ...EVENT,
      timestamp: 'regenerated value is ignored after first write',
      content: 'different regenerated enrichment',
    },
    { dedupeKey: 'codex:/repo/session.jsonl:0:42' },
  );
  expect(enrichedReplay).toBe(first);
  expect(await storage.count()).toBe(1);
  expect((await storage.getByIds([first]))[0]?.content).toBe(EVENT.content);
}

describe('append replay dedupe', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('is idempotent and first-write-wins in MemoryStorage', async () => {
    await assertReplayContract(new MemoryStorage());
  });

  it('survives a SQLite close/reopen crash boundary', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'echo-dedupe-replay-'));
    dirs.push(dir);
    const dbPath = join(dir, 'context.db');
    const firstStore = new SqliteStorage(dbPath);
    const first = await firstStore.append(EVENT, {
      dedupeKey: 'codex:/repo/session.jsonl:0:42',
    });
    firstStore.close();

    const replayStore = new SqliteStorage(dbPath);
    const replay = await replayStore.append(EVENT, {
      dedupeKey: 'codex:/repo/session.jsonl:0:42',
    });
    expect(replay).toBe(first);
    expect(await replayStore.count()).toBe(1);
    const changedReplay = await replayStore.append(
      { ...EVENT, timestamp: '2026-07-20T12:00:01.000Z' },
      { dedupeKey: 'codex:/repo/session.jsonl:0:42' },
    );
    expect(changedReplay).toBe(first);
    expect(await replayStore.count()).toBe(1);
    expect((await replayStore.getByIds([first]))[0]?.timestamp).toBe(EVENT.timestamp);
    replayStore.close();
  });

  it('validates dedupe key shape before inserting', async () => {
    const storage = new MemoryStorage();
    await expect(storage.append(EVENT, { dedupeKey: '' })).rejects.toThrow(/must not be empty/);
    await expect(storage.append(EVENT, { dedupeKey: 'x'.repeat(1_025) })).rejects.toThrow(
      /exceeds 1024/,
    );
    expect(await storage.count()).toBe(0);
  });
});
