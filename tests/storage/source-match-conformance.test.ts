import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CaptureEvent, Storage } from '../../src/storage/interface.js';
import { MemoryStorage } from '../../src/storage/memory.js';
import { SqliteStorage } from '../../src/storage/sqlite.js';

function eventInput(overrides: Partial<Omit<CaptureEvent, 'id'>> = {}): Omit<CaptureEvent, 'id'> {
  return {
    source: 'fs:test',
    timestamp: '2026-04-30T12:00:00.000Z',
    content: 'hello',
    ...overrides,
  };
}

// Conformance suite: the SAME table of source / source_prefix cases runs
// against BOTH storage adapters. MemoryStorage's normalization semantics
// (src/storage/source-match.ts — backslash→slash, trailing-slash strip,
// Windows case-folding, component-boundary prefix matching) ARE the
// contract; SqliteStorage must produce identical results, not raw
// `source = ?` / ASCII-case-insensitive `LIKE prefix%` results.
const backends = [
  { name: 'MemoryStorage', create: (): Storage => new MemoryStorage() },
  { name: 'SqliteStorage', create: (): Storage => new SqliteStorage(':memory:') },
];

describe.each(backends)('source matching conformance — $name', ({ create }) => {
  let store: Storage;

  beforeEach(() => {
    store = create();
  });

  afterEach(() => {
    if (store instanceof SqliteStorage) store.close();
  });

  // 101-retro r2 codex MED refutation pin: `source` + `source_prefix`
  // together is structurally impossible — every adapter throws before any
  // predicate is built, so the "prefix branch overwrites the exact-source
  // predicate" scenario cannot be reached. This case makes the contract
  // visible in the conformance table (the guard sits above the diff hunks
  // a packet-only reviewer sees).
  it('rejects source + source_prefix together (mutually exclusive by contract)', async () => {
    await store.append(eventInput({ source: 'fs:/a/b/c.jsonl' }));
    await expect(
      store.query({ source: 'fs:/a/b/c.jsonl', source_prefix: 'fs:/a/b' }),
    ).rejects.toThrow(/mutually exclusive/);
  });

  describe('path-like normalization (divergence class: Windows separators + case)', () => {
    it('matches a backslash-stored Windows source via a forward-slash source_prefix', async () => {
      await store.append(
        eventInput({ source: 'C:\\Users\\me\\.codex\\sessions\\a.jsonl', content: 'win-row' }),
      );
      const r = await store.query({ source_prefix: 'C:/Users/me/.codex/sessions/' });
      expect(r.map((e) => e.content)).toEqual(['win-row']);
    });

    it('matches a backslash-stored Windows source via a forward-slash exact source', async () => {
      await store.append(
        eventInput({ source: 'C:\\Users\\me\\.codex\\sessions\\a.jsonl', content: 'win-row' }),
      );
      const r = await store.query({ source: 'C:/Users/me/.codex/sessions/a.jsonl' });
      expect(r.map((e) => e.content)).toEqual(['win-row']);
    });

    it('case-folds Windows drive-letter paths on both sides of a prefix match', async () => {
      await store.append(
        eventInput({ source: 'C:\\DEV\\Project_echo\\notes.md', content: 'case-row' }),
      );
      const r = await store.query({ source_prefix: 'c:/dev/project_echo' });
      expect(r.map((e) => e.content)).toEqual(['case-row']);
    });
  });

  describe('source-family candidates', () => {
    it('keeps the finite app-family vocabulary aligned across adapters', async () => {
      const cases = [
        ['cursor', 'fs:/home/Library/Application Support/Cursor/session.jsonl'],
        ['claude_code', 'fs:/home/.claude/projects/session.jsonl'],
        ['codex', 'fs:/home/.codex/sessions/session.jsonl'],
        ['git', 'git:/repo'],
        ['granola', 'api:granola'],
      ] as const;
      for (const [index, [family, source]] of cases.entries()) {
        await store.append(
          eventInput({
            source,
            timestamp: `2026-04-30T12:0${index}:00.000Z`,
            content: family,
          }),
        );
      }
      for (const [family] of cases) {
        expect((await store.query({ source_family: family })).map((e) => e.content)).toEqual([
          family,
        ]);
      }
    });

    it('classifies a backslash-stored app source without changing prefix authority', async () => {
      await store.append(
        eventInput({
          source: 'fs:C:\\Users\\me\\.codex\\sessions\\a.jsonl',
          content: 'windows-codex',
        }),
      );
      const r = await store.query({
        source_family: 'codex',
        source_prefix: 'fs:C:/Users/me/.codex/sessions',
      });
      expect(r.map((e) => e.content)).toEqual(['windows-codex']);
    });

    it('keeps the canonical prefix authoritative over same-family candidates', async () => {
      await store.append(
        eventInput({
          source: 'fs:/other-home/.codex/sessions/newer.jsonl',
          timestamp: '2026-04-30T12:01:00.000Z',
          content: 'wrong-home',
        }),
      );
      await store.append(
        eventInput({
          source: 'fs:/current-home/.codex/sessions/wanted.jsonl',
          content: 'wanted-home',
        }),
      );
      const r = await store.query({
        source_family: 'codex',
        source_prefix: 'fs:/current-home/.codex/sessions',
      });
      expect(r.map((e) => e.content)).toEqual(['wanted-home']);
    });

    it('allows synthetic paths to belong to every embedded app family', async () => {
      await store.append(
        eventInput({
          source: 'fs:/home/.codex/sessions/nested/.claude/projects/a.jsonl',
          content: 'overlapping-markers',
        }),
      );
      expect((await store.query({ source_family: 'codex' })).map((e) => e.content)).toEqual([
        'overlapping-markers',
      ]);
      expect((await store.query({ source_family: 'claude_code' })).map((e) => e.content)).toEqual([
        'overlapping-markers',
      ]);
    });
  });

  describe('component-boundary prefix matching (divergence class: raw LIKE prefix%)', () => {
    it('source_prefix "fs:/a/b" does NOT match "fs:/a/bc" (boundary enforced)', async () => {
      await store.append(eventInput({ source: 'fs:/a/bc', content: 'sibling' }));
      await store.append(
        eventInput({
          source: 'fs:/a/b/leaf',
          timestamp: '2026-04-30T12:01:00.000Z',
          content: 'child',
        }),
      );
      const r = await store.query({ source_prefix: 'fs:/a/b' });
      expect(r.map((e) => e.content)).toEqual(['child']);
    });
  });

  describe('case sensitivity for non-path-like prefixes (divergence class: ASCII-insensitive LIKE)', () => {
    it('source_prefix "GIT:" does NOT match a "git:..." source', async () => {
      await store.append(eventInput({ source: 'git:repo-events', content: 'git-row' }));
      expect(await store.query({ source_prefix: 'GIT:' })).toHaveLength(0);
    });
  });

  describe('trailing-slash equality (divergence class: raw source = ?)', () => {
    it('a trailing-slash-stored path-like source matches the slashless exact source', async () => {
      await store.append(eventInput({ source: 'fs:/repo/dir/', content: 'dir-row' }));
      const r = await store.query({ source: 'fs:/repo/dir' });
      expect(r.map((e) => e.content)).toEqual(['dir-row']);
    });
  });

  describe('limit composes with source_prefix matching (page must not run short)', () => {
    it('limit counts only rows the prefix predicate accepts', async () => {
      // Newest row is a boundary NON-match — if the adapter applies LIMIT
      // before the real predicate (e.g. SQL LIMIT over a LIKE superset),
      // the page comes back short with 1 row instead of 2.
      await store.append(
        eventInput({
          source: 'fs:/a/b/one',
          timestamp: '2026-04-30T12:00:00.000Z',
          content: 'one',
        }),
      );
      await store.append(
        eventInput({ source: 'fs:/a/bc', timestamp: '2026-04-30T12:02:00.000Z', content: 'noise' }),
      );
      await store.append(
        eventInput({
          source: 'fs:/a/b/two',
          timestamp: '2026-04-30T12:01:00.000Z',
          content: 'two',
        }),
      );
      const r = await store.query({ source_prefix: 'fs:/a/b', limit: 2 });
      expect(r.map((e) => e.content)).toEqual(['two', 'one']);
    });
  });

  describe('canonical inputs (regression anchors — already pass on both adapters)', () => {
    it('exact non-path-like source match stays exact', async () => {
      await store.append(eventInput({ source: 'fs:cursor', content: 'cur' }));
      await store.append(
        eventInput({ source: 'api:github', timestamp: '2026-04-30T12:01:00.000Z', content: 'gh' }),
      );
      const r = await store.query({ source: 'fs:cursor' });
      expect(r.map((e) => e.content)).toEqual(['cur']);
      expect(await store.query({ source: 'api:slack' })).toHaveLength(0);
    });

    it('non-path-like scheme prefix "coord:" matches coord atoms case-sensitively', async () => {
      await store.append(eventInput({ source: 'coord:claude:tick', content: 'coord-row' }));
      await store.append(
        eventInput({ source: 'git:repo', timestamp: '2026-04-30T12:01:00.000Z', content: 'other' }),
      );
      const r = await store.query({ source_prefix: 'coord:' });
      expect(r.map((e) => e.content)).toEqual(['coord-row']);
    });

    it('canonical forward-slash prefix matches a deeper canonical path', async () => {
      await store.append(
        eventInput({
          source: 'fs:/Users/zhen/.claude/projects/abc/s.jsonl',
          content: 'session-row',
        }),
      );
      const r = await store.query({ source_prefix: 'fs:/Users/zhen/.claude/' });
      expect(r.map((e) => e.content)).toEqual(['session-row']);
    });
  });
});
