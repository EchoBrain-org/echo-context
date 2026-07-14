import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CaptureEvent, Storage } from '../../src/storage/interface.js';
import { MemoryStorage } from '../../src/storage/memory.js';
import { SqliteStorage } from '../../src/storage/sqlite.js';

// Run the same suite against both storage backends so the order-preserving
// + missing-id-drops contract is enforced uniformly. Required by item 030
// (V1.6 `get_atoms` MCP tool depends on Storage.getByIds).

function eventInput(
  overrides: Partial<Omit<CaptureEvent, 'id'>> = {},
): Omit<CaptureEvent, 'id'> {
  return {
    source: 'fs:test',
    timestamp: '2026-04-30T12:00:00.000Z',
    content: 'hello',
    ...overrides,
  };
}

interface Backend {
  name: string;
  factory: () => Storage & { close?: () => void };
}

const backends: Backend[] = [
  { name: 'MemoryStorage', factory: () => new MemoryStorage() },
  { name: 'SqliteStorage', factory: () => new SqliteStorage(':memory:') },
];

for (const backend of backends) {
  describe(`${backend.name}.getByIds`, () => {
    let store: Storage & { close?: () => void };

    beforeEach(() => {
      store = backend.factory();
    });

    afterEach(() => {
      store.close?.();
    });

    it('returns empty array for empty input without hitting storage', async () => {
      // No append; verifies getByIds([]) is a fast no-op even when the store
      // is empty, mirroring the get_atoms contract.
      const out = await store.getByIds([]);
      expect(out).toEqual([]);
    });

    it('returns events in the order requested, regardless of insertion order', async () => {
      const id1 = await store.append(eventInput({ content: 'first' }));
      const id2 = await store.append(eventInput({ content: 'second' }));
      const id3 = await store.append(eventInput({ content: 'third' }));

      // Request in reverse-of-insertion order — both backends MUST honour
      // it. The SQLite naive impl returns IN-clause rows in storage order,
      // not request order; the explicit reorder closes that gap.
      const out = await store.getByIds([id3, id1, id2]);
      expect(out.map((e) => e.content)).toEqual(['third', 'first', 'second']);
      expect(out.map((e) => e.id)).toEqual([id3, id1, id2]);
    });

    it('silently drops missing ids (caller diffs the input vs output id sets)', async () => {
      const id1 = await store.append(eventInput({ content: 'present' }));
      const fakeId = '00000000-0000-0000-0000-000000000000';

      const out = await store.getByIds([id1, fakeId]);
      expect(out).toHaveLength(1);
      expect(out[0]!.id).toBe(id1);
    });

    it('preserves order even when some requested ids are missing', async () => {
      const id1 = await store.append(eventInput({ content: 'a' }));
      const id2 = await store.append(eventInput({ content: 'b' }));
      const fakeId = '00000000-0000-0000-0000-000000000000';

      const out = await store.getByIds([fakeId, id2, id1]);
      // Missing ids are dropped; surviving ids stay in input order.
      expect(out.map((e) => e.content)).toEqual(['b', 'a']);
    });

    it('preserves all fields (metadata, embedding) on returned events', async () => {
      const id = await store.append(
        eventInput({
          source: 'api:github',
          timestamp: '2026-04-30T10:00:00.000Z',
          content: '{"issue":234}',
          metadata: { repo: 'echo', kind: 'issue' },
          embedding: [0.1, 0.2, 0.3],
        }),
      );

      const out = await store.getByIds([id]);
      expect(out).toHaveLength(1);
      const ev = out[0]!;
      expect(ev.source).toBe('api:github');
      expect(ev.timestamp).toBe('2026-04-30T10:00:00.000Z');
      expect(ev.content).toBe('{"issue":234}');
      expect(ev.metadata).toEqual({ repo: 'echo', kind: 'issue' });
      // sqlite's Float32Array round-trip introduces tiny precision drift —
      // assert by close-ish values rather than strict equality.
      expect(ev.embedding).toBeDefined();
      const emb = ev.embedding!;
      expect(emb).toHaveLength(3);
      expect(emb[0]).toBeCloseTo(0.1, 5);
      expect(emb[1]).toBeCloseTo(0.2, 5);
      expect(emb[2]).toBeCloseTo(0.3, 5);
    });

    it('handles duplicates in input by returning the event multiple times', async () => {
      // The contract is "events in input order"; if the caller passes the
      // same id twice they get two copies. Documented as such so get_atoms
      // can rely on `len(out) === len(input) - drops`.
      const id1 = await store.append(eventInput({ content: 'dup' }));
      const out = await store.getByIds([id1, id1, id1]);
      expect(out).toHaveLength(3);
      expect(out.every((e) => e.id === id1)).toBe(true);
    });
  });
}
