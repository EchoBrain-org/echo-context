import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CaptureEvent, Storage } from '../../src/storage/interface.js';
import { MemoryStorage } from '../../src/storage/memory.js';
import { SqliteStorage } from '../../src/storage/sqlite.js';

interface Adapter {
  name: string;
  create: () => Storage;
  close?: (store: Storage) => void;
}

const ADAPTERS: Adapter[] = [
  {
    name: 'MemoryStorage',
    create: () => new MemoryStorage(),
  },
  {
    name: 'SqliteStorage',
    create: () => new SqliteStorage(':memory:'),
    close: (s) => (s as SqliteStorage).close(),
  },
];

describe.each(ADAPTERS)('QueryFilter.metadata_match parity ($name)', ({ create, close }) => {
  let store: Storage;

  beforeEach(() => {
    store = create();
  });

  afterEach(() => {
    close?.(store);
  });

  async function seed(events: ReadonlyArray<Omit<CaptureEvent, 'id'>>): Promise<void> {
    for (const e of events) await store.append(e);
  }

  it('single-key match returns only rows whose metadata key equals the value, newest-first', async () => {
    await seed([
      {
        source: 'fs:cursor',
        timestamp: '2026-05-10T10:00:00.000Z',
        content: 'A',
        metadata: { composer_id: 'COMP-1' },
      },
      {
        source: 'fs:cursor',
        timestamp: '2026-05-10T11:00:00.000Z',
        content: 'B',
        metadata: { composer_id: 'COMP-2' },
      },
      {
        source: 'fs:cursor',
        timestamp: '2026-05-10T12:00:00.000Z',
        content: 'C',
        metadata: { composer_id: 'COMP-1', session_id: 'S-X' },
      },
    ]);
    const got = await store.query({ metadata_match: { composer_id: 'COMP-1' } });
    expect(got.map((e) => e.content)).toEqual(['C', 'A']);
  });

  it('multi-key match is AND across keys', async () => {
    await seed([
      {
        source: 'fs:cursor',
        timestamp: '2026-05-10T10:00:00.000Z',
        content: 'A',
        metadata: { composer_id: 'COMP-1' },
      },
      {
        source: 'fs:cursor',
        timestamp: '2026-05-10T11:00:00.000Z',
        content: 'B',
        metadata: { composer_id: 'COMP-2' },
      },
      {
        source: 'fs:cursor',
        timestamp: '2026-05-10T12:00:00.000Z',
        content: 'C',
        metadata: { composer_id: 'COMP-1', session_id: 'S-X' },
      },
    ]);
    const got = await store.query({
      metadata_match: { composer_id: 'COMP-1', session_id: 'S-X' },
    });
    expect(got.map((e) => e.content)).toEqual(['C']);
  });

  it('whitelist rejection: non-whitelisted key throws at the storage seam', async () => {
    await expect(
      store.query({ metadata_match: { arbitrary_field: 'X' } as Record<string, string> }),
    ).rejects.toThrow(/whitelist/);
  });

  it('empty {} metadata_match is a no-op (returns same as omitted)', async () => {
    await seed([
      {
        source: 'fs:cursor',
        timestamp: '2026-05-10T10:00:00.000Z',
        content: 'A',
        metadata: { composer_id: 'COMP-1' },
      },
      {
        source: 'fs:cursor',
        timestamp: '2026-05-10T11:00:00.000Z',
        content: 'B',
        // no metadata
      },
    ]);
    const baseline = await store.query({});
    const withEmpty = await store.query({ metadata_match: {} });
    expect(withEmpty.map((e) => e.content)).toEqual(baseline.map((e) => e.content));
  });

  it('rows whose metadata key is absent (or non-string) are skipped under match', async () => {
    await seed([
      {
        source: 'fs:cursor',
        timestamp: '2026-05-10T10:00:00.000Z',
        content: 'no-md',
        // no metadata at all
      },
      {
        source: 'fs:cursor',
        timestamp: '2026-05-10T11:00:00.000Z',
        content: 'has-md',
        metadata: { composer_id: 'COMP-X' },
      },
    ]);
    const got = await store.query({ metadata_match: { composer_id: 'COMP-X' } });
    expect(got.map((e) => e.content)).toEqual(['has-md']);
  });
});
