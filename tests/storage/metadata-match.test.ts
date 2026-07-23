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

  it('project_key keeps explicit identity authoritative and bounds legacy descendant aliases', async () => {
    const projectKey = 'local:workspace:/repo-a';
    await seed([
      {
        source: 'fs:explicit',
        timestamp: '2026-05-10T10:00:00.000Z',
        content: 'explicit',
        metadata: { project_key: projectKey, repo_root: '/nested/observation' },
      },
      {
        source: 'fs:explicit-mismatch',
        timestamp: '2026-05-10T11:00:00.000Z',
        content: 'explicit-mismatch',
        metadata: {
          project_key: 'local:workspace:/other',
          repo_root: '/repo-a/packages/app',
        },
      },
      {
        source: 'fs:canonical',
        timestamp: '2026-05-10T12:00:00.000Z',
        content: 'canonical-fallback',
        metadata: { canonical_root: '/repo-a', repo_root: '/elsewhere' },
      },
      {
        source: 'fs:canonical-mismatch',
        timestamp: '2026-05-10T13:00:00.000Z',
        content: 'canonical-mismatch',
        metadata: {
          canonical_root: '/other',
          repo_root: '/repo-a/packages/app',
        },
      },
      {
        source: 'fs:legacy',
        timestamp: '2026-05-10T14:00:00.000Z',
        content: 'repo-root-fallback',
        metadata: { repo_root: '/repo-a' },
      },
      {
        source: 'fs:legacy-descendant',
        timestamp: '2026-05-10T15:00:00.000Z',
        content: 'repo-root-descendant',
        metadata: { repo_root: '/repo-a/packages/app' },
      },
      {
        source: 'fs:legacy-alias',
        timestamp: '2026-05-10T16:00:00.000Z',
        content: 'normalized-caller-alias',
        metadata: { repo_root: '/workspace-link/packages/app' },
      },
      {
        source: 'fs:sibling-prefix',
        timestamp: '2026-05-10T17:00:00.000Z',
        content: 'sibling-prefix',
        metadata: { repo_root: '/repo-ab/packages/app' },
      },
      {
        source: 'fs:explicit-null',
        timestamp: '2026-05-10T18:00:00.000Z',
        content: 'explicit-null',
        metadata: { project_key: null, repo_root: '/repo-a/packages/app' },
      },
      {
        source: 'fs:canonical-null',
        timestamp: '2026-05-10T19:00:00.000Z',
        content: 'canonical-null',
        metadata: { canonical_root: null, repo_root: '/repo-a/packages/app' },
      },
    ]);

    const got = await store.query({
      project_key: projectKey,
      legacy_project_roots: ['/repo-a/', '/workspace-link'],
    });

    expect(got.map((event) => event.content)).toEqual([
      'normalized-caller-alias',
      'repo-root-descendant',
      'repo-root-fallback',
      'canonical-fallback',
      'explicit',
    ]);
  });

  it('exact legacy Git source scans past newer authoritative mismatches without widening project scope', async () => {
    const projectKey = 'local:workspace:/repo-a';
    const source = 'git:/repo-a';
    const poisonedRows: Array<Omit<CaptureEvent, 'id'>> = [];
    for (let minute = 1; minute <= 10; minute += 1) {
      const metadata: Record<string, unknown> =
        minute % 4 === 0
          ? { project_key: 'local:workspace:/other', repo_root: '/repo-a' }
          : minute % 4 === 1
            ? { project_key: null, repo_root: '/repo-a' }
            : minute % 4 === 2
              ? { canonical_root: '/other', repo_root: '/repo-a' }
              : { canonical_root: null, repo_root: '/repo-a' };
      poisonedRows.push({
        source,
        timestamp: new Date(Date.UTC(2026, 4, 11, 10, minute)).toISOString(),
        content: `ineligible-${minute}`,
        metadata,
      });
    }
    await seed([
      {
        source,
        timestamp: '2026-05-11T10:00:00.000Z',
        content: 'metadata-less-legacy',
      },
      ...poisonedRows,
    ]);

    const exact = await store.query({
      source,
      project_key: projectKey,
      legacy_project_roots: ['/repo-a'],
      limit: 1,
    });
    expect(exact.map((event) => event.content)).toEqual(['metadata-less-legacy']);

    const prefix = await store.query({
      source_prefix: 'git:',
      project_key: projectKey,
      legacy_project_roots: ['/repo-a'],
    });
    expect(prefix).toEqual([]);
  });

  it('normalizes and deduplicates the bounded legacy root aliases', async () => {
    await seed([
      {
        source: 'fs:legacy',
        timestamp: '2026-05-10T10:00:00.000Z',
        content: 'legacy',
        metadata: { repo_root: '/repo-a/packages/app' },
      },
    ]);

    const got = await store.query({
      project_key: 'local:workspace:/repo-a',
      legacy_project_roots: ['/repo-a/', '/repo-a'],
    });
    expect(got.map((event) => event.content)).toEqual(['legacy']);
  });

  it('rejects unbounded or unscoped legacy project aliases before scanning', async () => {
    await expect(
      store.query({
        project_key: 'local:workspace:/repo-a',
        legacy_project_roots: ['/repo-a', '/alias-a', '/alias-b', '/alias-c'],
      }),
    ).rejects.toThrow(/at most 3 roots/);

    await expect(
      store.query({ legacy_project_roots: ['/repo-a'] }),
    ).rejects.toThrow(/requires project_key/);
  });
});
