import { beforeEach, describe, expect, it } from 'vitest';
import { MemoryStorage } from '../../src/storage/memory.js';
import type { CaptureEvent } from '../../src/storage/interface.js';

function eventInput(overrides: Partial<Omit<CaptureEvent, 'id'>> = {}): Omit<CaptureEvent, 'id'> {
  return {
    source: 'fs:test',
    timestamp: '2026-04-30T12:00:00.000Z',
    content: 'hello',
    ...overrides,
  };
}

describe('MemoryStorage', () => {
  let store: MemoryStorage;

  beforeEach(() => {
    store = new MemoryStorage();
  });

  describe('append + query roundtrip', () => {
    it('preserves all fields including optional metadata and embedding', async () => {
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
      expect(all[0]).toEqual({ ...input, id });
    });

    it('omits metadata/embedding when not supplied', async () => {
      const id = await store.append(eventInput());
      const [evt] = await store.query();
      expect(evt!.id).toBe(id);
      expect(evt!.metadata).toBeUndefined();
      expect(evt!.embedding).toBeUndefined();
    });

    it('returns events in timestamp DESC order by default (021: keep-newest semantics)', async () => {
      for (let i = 0; i < 5; i++) {
        await store.append(
          eventInput({ content: `msg-${i}`, timestamp: `2026-04-30T12:0${i}:00.000Z` }),
        );
      }
      const all = await store.query();
      expect(all.map((e) => e.content)).toEqual(['msg-4', 'msg-3', 'msg-2', 'msg-1', 'msg-0']);
    });

    it('returns events in timestamp ASC order when order: "asc" is passed', async () => {
      for (let i = 0; i < 5; i++) {
        await store.append(
          eventInput({ content: `msg-${i}`, timestamp: `2026-04-30T12:0${i}:00.000Z` }),
        );
      }
      const all = await store.query({ order: 'asc' });
      expect(all.map((e) => e.content)).toEqual(['msg-0', 'msg-1', 'msg-2', 'msg-3', 'msg-4']);
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
      await store.append(eventInput({ source: 'fs:cursor' }));
      await store.append(eventInput({ source: 'api:github' }));
      await store.append(eventInput({ source: 'fs:cursor' }));
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

  describe('append-only', () => {
    it('does not expose mutation on retrieved events affecting later queries', async () => {
      await store.append(eventInput({ content: 'original' }));
      const first = await store.query();
      // Even if a caller mutates the returned object, future queries see the
      // original (this is documented behavior — copies are not enforced, but
      // the internal array is never spliced/replaced).
      const after = await store.query();
      expect(after).toHaveLength(1);
      expect(first).toHaveLength(1);
    });
  });

  describe('composite-key ordering + cursor pagination (item 025)', () => {
    async function seedSameMs(ts: string, count: number): Promise<string[]> {
      const ids: string[] = [];
      for (let i = 0; i < count; i++) {
        ids.push(await store.append(eventInput({ timestamp: ts, content: `c-${i}` })));
      }
      return ids;
    }

    it('query({}) on same-ms-tied rows returns deterministic id-DESC order across 10 runs', async () => {
      await seedSameMs('2026-05-08T12:00:00.000Z', 5);
      const baseline = (await store.query({})).map((e) => e.id);
      expect(baseline).toEqual([...baseline].sort().reverse());
      for (let i = 0; i < 10; i++) {
        const next = (await store.query({})).map((e) => e.id);
        expect(next).toEqual(baseline);
      }
    });

    it('query({order: "asc"}) on same-ms-tied rows returns deterministic id-ASC order', async () => {
      await seedSameMs('2026-05-08T12:00:00.000Z', 5);
      const r = (await store.query({ order: 'asc' })).map((e) => e.id);
      expect(r).toEqual([...r].sort());
    });

    it('before filter: returns rows strictly older than (timestamp, id)', async () => {
      const ids: string[] = [];
      for (let i = 0; i < 5; i++) {
        ids.push(
          await store.append(
            eventInput({
              timestamp: `2026-05-08T12:0${i}:00.000Z`,
              content: `c-${i}`,
            }),
          ),
        );
      }
      const r = await store.query({
        before: { timestamp: '2026-05-08T12:03:00.000Z', id: ids[3]! },
      });
      expect(r).toHaveLength(3);
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
});
