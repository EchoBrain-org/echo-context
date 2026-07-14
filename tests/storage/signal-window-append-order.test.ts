// 113 AC3 — generalized append-order seam (`iterateAtomsByAppendOrder` +
// `getCurrentSequence`) backend parity for SqliteStorage + MemoryStorage:
//   - sequence_id monotonicity across all sources
//   - half-open sinceSeq boundary (includes k, excludes k-1)
//   - sinceSeq omitted starts at 1
//   - optional sourcePrefixes filter
//   - generalized watermark (max over in-scope; 0 on empty store)
//   - cursor durability across SQLite close+reopen (no rowid renumber)
//   - SQLite and Memory yield identical sequences for the same append order

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MemoryStorage } from '../../src/storage/memory.js';
import { SqliteStorage } from '../../src/storage/sqlite.js';
import type { Storage } from '../../src/storage/interface.js';

interface Backend {
  name: string;
  make: () => Storage;
}

let sqliteTmp: string;

const TS = '2026-07-04T08:00:00.000Z';

beforeEach(() => {
  sqliteTmp = mkdtempSync(join(tmpdir(), 'echo-signal-window-seam-test-'));
});

afterEach(() => {
  rmSync(sqliteTmp, { recursive: true, force: true });
});

function backends(): Backend[] {
  return [
    { name: 'MemoryStorage', make: () => new MemoryStorage() },
    { name: 'SqliteStorage', make: () => new SqliteStorage(join(sqliteTmp, 'echo.db')) },
  ];
}

function close(s: Storage): void {
  if ('close' in s) (s as { close: () => void }).close();
}

for (const backend of backends()) {
  describe(`113 AC3 generalized append-order seam — ${backend.name}`, () => {
    it('empty store: getCurrentSequence() is 0; iterate is []', async () => {
      const s = backend.make();
      try {
        expect(await s.getCurrentSequence()).toBe(0);
        expect(await s.getCurrentSequence({ sourcePrefixes: ['fs:'] })).toBe(0);
        expect(await s.iterateAtomsByAppendOrder()).toEqual([]);
      } finally {
        close(s);
      }
    });

    it('iterates all sources in append order with monotonic sequence_id', async () => {
      const s = backend.make();
      try {
        const a = await s.append({ source: 'fs:/x', timestamp: TS, content: 'a' });
        const b = await s.append({ source: 'git:/r', timestamp: TS, content: 'b' });
        const c = await s.append({ source: 'derived:team-decisions', timestamp: TS, content: 'c' });
        const all = await s.iterateAtomsByAppendOrder();
        expect(all.map((r) => r.id)).toEqual([a, b, c]);
        expect(all[0]!.sequence_id).toBeLessThan(all[1]!.sequence_id);
        expect(all[1]!.sequence_id).toBeLessThan(all[2]!.sequence_id);
      } finally {
        close(s);
      }
    });

    it('half-open sinceSeq: includes k, excludes k-1; omitted starts at 1', async () => {
      const s = backend.make();
      try {
        const ids: string[] = [];
        for (let i = 0; i < 5; i++) {
          ids.push(await s.append({ source: 'fs:/x', timestamp: TS, content: `atom-${i}` }));
        }
        const all = await s.iterateAtomsByAppendOrder();
        expect(all.map((r) => r.id)).toEqual(ids); // omitted sinceSeq == from 1
        const thirdSeq = all[2]!.sequence_id;
        const fromThird = await s.iterateAtomsByAppendOrder({ sinceSeq: thirdSeq });
        expect(fromThird.map((r) => r.id)).toEqual(ids.slice(2)); // includes k
        const afterThird = await s.iterateAtomsByAppendOrder({ sinceSeq: thirdSeq + 1 });
        expect(afterThird.map((r) => r.id)).toEqual(ids.slice(3)); // excludes k
      } finally {
        close(s);
      }
    });

    it('optional sourcePrefixes filter restricts to matching sources', async () => {
      const s = backend.make();
      try {
        const fsId = await s.append({ source: 'fs:/x', timestamp: TS, content: 'fs' });
        await s.append({ source: 'git:/r', timestamp: TS, content: 'git' });
        const derivedId = await s.append({
          source: 'derived:granola-signals',
          timestamp: TS,
          content: 'sig',
        });
        const machine = await s.iterateAtomsByAppendOrder({ sourcePrefixes: ['fs:', 'git:'] });
        expect(machine.map((r) => r.content).sort()).toEqual(['fs', 'git']);
        const derived = await s.iterateAtomsByAppendOrder({ sourcePrefixes: ['derived:'] });
        expect(derived.map((r) => r.id)).toEqual([derivedId]);
        const fsOnly = await s.iterateAtomsByAppendOrder({ sourcePrefixes: ['fs:'] });
        expect(fsOnly.map((r) => r.id)).toEqual([fsId]);
      } finally {
        close(s);
      }
    });

    it('getCurrentSequence returns max(sequence_id) over the in-scope atoms', async () => {
      const s = backend.make();
      try {
        await s.append({ source: 'fs:/x', timestamp: TS, content: 'fs1' });
        await s.append({ source: 'git:/r', timestamp: TS, content: 'git1' });
        const derivedId = await s.append({
          source: 'derived:team-decisions',
          timestamp: TS,
          content: 'd1',
        });
        const all = await s.iterateAtomsByAppendOrder();
        const globalMax = all.reduce((acc, r) => Math.max(acc, r.sequence_id), 0);
        expect(await s.getCurrentSequence()).toBe(globalMax);
        // Scoped watermark: max over just the derived atom (the last append).
        const derivedSeq = all.find((r) => r.id === derivedId)!.sequence_id;
        expect(await s.getCurrentSequence({ sourcePrefixes: ['derived:'] })).toBe(derivedSeq);
        // A scope with no atoms → 0.
        expect(await s.getCurrentSequence({ sourcePrefixes: ['api:granola'] })).toBe(0);
      } finally {
        close(s);
      }
    });

    it('limit caps the append-ordered result', async () => {
      const s = backend.make();
      try {
        for (let i = 0; i < 5; i++) {
          await s.append({ source: 'fs:/x', timestamp: TS, content: `atom-${i}` });
        }
        const capped = await s.iterateAtomsByAppendOrder({ limit: 2 });
        expect(capped).toHaveLength(2);
      } finally {
        close(s);
      }
    });
  });
}

describe('113 AC3 — SQLite/Memory produce identical sequences for the same append order', () => {
  it('same ids + parity of sequence order across backends', async () => {
    const mem = new MemoryStorage();
    const sql = new SqliteStorage(join(sqliteTmp, 'echo.db'));
    try {
      const appends = [
        { source: 'fs:/x', timestamp: TS, content: 'a' },
        { source: 'git:/r', timestamp: TS, content: 'b' },
        { source: 'derived:granola-signals', timestamp: TS, content: 'c' },
        { source: 'api:granola', timestamp: TS, content: 'd' },
      ];
      const memIds: string[] = [];
      const sqlIds: string[] = [];
      for (const ev of appends) {
        memIds.push(await mem.append(ev));
        sqlIds.push(await sql.append(ev));
      }
      const memRows = await mem.iterateAtomsByAppendOrder();
      const sqlRows = await sql.iterateAtomsByAppendOrder();
      // Same content order (ids are random per-append, so compare by content).
      expect(memRows.map((r) => r.content)).toEqual(['a', 'b', 'c', 'd']);
      expect(sqlRows.map((r) => r.content)).toEqual(['a', 'b', 'c', 'd']);
      // sequence_ids strictly increasing in the same positions on both backends.
      for (let i = 1; i < memRows.length; i++) {
        expect(memRows[i]!.sequence_id).toBeGreaterThan(memRows[i - 1]!.sequence_id);
        expect(sqlRows[i]!.sequence_id).toBeGreaterThan(sqlRows[i - 1]!.sequence_id);
      }
      expect(memRows.map((r) => r.id)).toEqual(memIds);
      expect(sqlRows.map((r) => r.id)).toEqual(sqlIds);
    } finally {
      sql.close();
    }
  });
});

describe('113 AC3 — SQLite cursor durability across daemon reopen', () => {
  it('same sequence_ids for the same sinceSeq after close + reopen (no rowid renumber)', async () => {
    const dbPath = join(sqliteTmp, 'echo.db');
    const s1 = new SqliteStorage(dbPath);
    let recordedSeqs: number[];
    let sinceSeq: number;
    let idsFromSince: string[];
    try {
      for (let i = 0; i < 4; i++) {
        await s1.append({ source: 'derived:team-decisions', timestamp: TS, content: `d-${i}` });
      }
      const before = await s1.iterateAtomsByAppendOrder({ sourcePrefixes: ['derived:'] });
      recordedSeqs = before.map((r) => r.sequence_id);
      sinceSeq = before[2]!.sequence_id;
      idsFromSince = before
        .filter((r) => r.sequence_id >= sinceSeq)
        .map((r) => r.id);
    } finally {
      s1.close();
    }

    const s2 = new SqliteStorage(dbPath);
    try {
      const after = await s2.iterateAtomsByAppendOrder({ sourcePrefixes: ['derived:'] });
      expect(after.map((r) => r.sequence_id)).toEqual(recordedSeqs);
      const fromSince = await s2.iterateAtomsByAppendOrder({
        sinceSeq,
        sourcePrefixes: ['derived:'],
      });
      expect(fromSince.map((r) => r.id)).toEqual(idsFromSince);
    } finally {
      s2.close();
    }
  });
});
