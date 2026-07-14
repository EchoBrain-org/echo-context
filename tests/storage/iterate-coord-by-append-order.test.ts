// 057a AC3 (storage seam parity) — iterateCoordAtomsByAppendOrder + getCurrentCoordSequence
// across SqliteStorage + MemoryStorage. AC8 entry per spec line 184:
//   - same-timestamp atoms replay in append order
//   - sinceSeq half-open returns expected subset
//   - out-of-order emitted_at does NOT affect iteration order
//   - getCurrentCoordSequence parity (both backends agree after N appends;
//     value is 0 when no coord atoms have been appended)
//   - boundary safety: after watermarking at getCurrentCoordSequence(),
//     appending one more atom and re-iterating from
//     last_full_replay_watermark + 1 returns exactly that new atom (r4
//     codex F1 MED)

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
  cleanup: () => void;
}

let sqliteTmp: string;

const TS = '2026-05-16T08:00:00.000Z';

beforeEach(() => {
  sqliteTmp = mkdtempSync(join(tmpdir(), 'echo-coord-seam-test-'));
});

afterEach(() => {
  rmSync(sqliteTmp, { recursive: true, force: true });
});

function backends(): Backend[] {
  return [
    {
      name: 'MemoryStorage',
      make: () => new MemoryStorage(),
      cleanup: () => {
        /* no-op */
      },
    },
    {
      name: 'SqliteStorage',
      make: () => new SqliteStorage(join(sqliteTmp, 'echo.db')),
      cleanup: () => {
        /* close handled by test lifecycle via SqliteStorage.close */
      },
    },
  ];
}

for (const backend of backends()) {
  describe(`AC3 storage seam — ${backend.name}`, () => {
    it('empty ledger: getCurrentCoordSequence returns 0', async () => {
      const s = backend.make();
      try {
        expect(await s.getCurrentCoordSequence()).toBe(0);
        const empty = await s.iterateCoordAtomsByAppendOrder();
        expect(empty).toEqual([]);
      } finally {
        backend.cleanup();
        if ('close' in s) (s as { close: () => void }).close();
      }
    });

    it('iterates coord atoms in append order; ignores non-coord rows', async () => {
      const s = backend.make();
      try {
        // Interleave coord + non-coord appends to verify the seam filters
        // by source LIKE 'coord:%' AND that non-coord rows don't take up
        // sequence_id slots in iteration output.
        const idCoordA = await s.append({
          source: 'coord:codex',
          timestamp: TS,
          content: 'a',
        });
        await s.append({ source: 'fs:/x', timestamp: TS, content: 'unrelated' });
        const idCoordB = await s.append({
          source: 'coord:codex-ops',
          timestamp: TS,
          content: 'b',
        });
        const idCoordC = await s.append({
          source: 'coord:claude',
          timestamp: TS,
          content: 'c',
        });

        const all = await s.iterateCoordAtomsByAppendOrder();
        expect(all.map((r) => r.id)).toEqual([idCoordA, idCoordB, idCoordC]);
        // sequence_ids monotonic increasing
        expect(all[0]!.sequence_id).toBeLessThan(all[1]!.sequence_id);
        expect(all[1]!.sequence_id).toBeLessThan(all[2]!.sequence_id);
      } finally {
        if ('close' in s) (s as { close: () => void }).close();
      }
    });

    it('sinceSeq filters half-open [sinceSeq, +∞)', async () => {
      const s = backend.make();
      try {
        const ids: string[] = [];
        for (let i = 0; i < 5; i++) {
          ids.push(
            await s.append({
              source: 'coord:codex',
              timestamp: TS,
              content: `atom-${i}`,
            }),
          );
        }
        const all = await s.iterateCoordAtomsByAppendOrder();
        expect(all).toHaveLength(5);
        const thirdSeq = all[2]!.sequence_id;
        const fromThird = await s.iterateCoordAtomsByAppendOrder({ sinceSeq: thirdSeq });
        // Half-open includes thirdSeq.
        expect(fromThird.map((r) => r.id)).toEqual(ids.slice(2));
      } finally {
        if ('close' in s) (s as { close: () => void }).close();
      }
    });

    it('limit caps iteration', async () => {
      const s = backend.make();
      try {
        for (let i = 0; i < 5; i++) {
          await s.append({
            source: 'coord:codex',
            timestamp: TS,
            content: `atom-${i}`,
          });
        }
        const capped = await s.iterateCoordAtomsByAppendOrder({ limit: 2 });
        expect(capped).toHaveLength(2);
      } finally {
        if ('close' in s) (s as { close: () => void }).close();
      }
    });

    it('same-timestamp atoms replay in append order', async () => {
      const s = backend.make();
      try {
        // All three atoms share the same emitted_at; iteration order must
        // come from durable append order, not timestamp resolution.
        const a = await s.append({ source: 'coord:codex', timestamp: TS, content: 'A' });
        const b = await s.append({ source: 'coord:codex', timestamp: TS, content: 'B' });
        const c = await s.append({ source: 'coord:codex', timestamp: TS, content: 'C' });
        const all = await s.iterateCoordAtomsByAppendOrder();
        expect(all.map((r) => r.id)).toEqual([a, b, c]);
      } finally {
        if ('close' in s) (s as { close: () => void }).close();
      }
    });

    it('out-of-order emitted_at does NOT affect iteration order (r2 codex F1 HIGH + r2 codex-ops F6 MED)', async () => {
      const s = backend.make();
      try {
        // Append order: A(t=100), B(t=001), C(t=200). Iteration must be
        // A, B, C — NOT the emitted_at order A, C, B.
        const a = await s.append({
          source: 'coord:codex',
          timestamp: '2026-05-16T08:00:00.100Z',
          content: 'A-skewed-middle',
        });
        const b = await s.append({
          source: 'coord:codex',
          timestamp: '2026-05-16T08:00:00.001Z',
          content: 'B-skewed-earliest',
        });
        const c = await s.append({
          source: 'coord:codex',
          timestamp: '2026-05-16T08:00:00.200Z',
          content: 'C-skewed-latest',
        });

        const all = await s.iterateCoordAtomsByAppendOrder();
        expect(all.map((r) => r.id)).toEqual([a, b, c]);
      } finally {
        if ('close' in s) (s as { close: () => void }).close();
      }
    });

    it('getCurrentCoordSequence: 0 when empty; matches max(seq_id) after appends', async () => {
      const s = backend.make();
      try {
        expect(await s.getCurrentCoordSequence()).toBe(0);
        await s.append({ source: 'fs:/x', timestamp: TS, content: 'non-coord' });
        // Non-coord row must NOT bump getCurrentCoordSequence.
        expect(await s.getCurrentCoordSequence()).toBe(0);
        await s.append({ source: 'coord:codex', timestamp: TS, content: 'c1' });
        await s.append({ source: 'coord:codex', timestamp: TS, content: 'c2' });
        const all = await s.iterateCoordAtomsByAppendOrder();
        const maxSeq = all.reduce((acc, r) => Math.max(acc, r.sequence_id), 0);
        expect(await s.getCurrentCoordSequence()).toBe(maxSeq);
      } finally {
        if ('close' in s) (s as { close: () => void }).close();
      }
    });

    it('boundary safety: watermark + sinceSeq = last_full_replay_watermark + 1 returns only new atoms (r4 codex F1 MED)', async () => {
      const s = backend.make();
      try {
        await s.append({ source: 'coord:codex', timestamp: TS, content: 'a' });
        await s.append({ source: 'coord:codex', timestamp: TS, content: 'b' });
        const watermark = await s.getCurrentCoordSequence();
        expect(watermark).toBeGreaterThan(0);
        // Append one more atom after capturing the watermark.
        const cId = await s.append({ source: 'coord:codex', timestamp: TS, content: 'c' });
        // Re-iterate from watermark + 1 — must return exactly `c`, no skip
        // (forward boundary) and no re-deliver of a/b (backward boundary).
        const tail = await s.iterateCoordAtomsByAppendOrder({ sinceSeq: watermark + 1 });
        expect(tail).toHaveLength(1);
        expect(tail[0]!.id).toBe(cId);
      } finally {
        if ('close' in s) (s as { close: () => void }).close();
      }
    });
  });
}
