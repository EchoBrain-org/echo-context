import { describe, expect, it } from 'vitest';
import {
  resolveSources,
  waitForNewTurns,
  WAIT_MAX_SOURCES,
} from '../../src/mcp/tools/wait-for-new-turns.js';
import { MemoryStorage } from '../../src/storage/memory.js';
import type { CaptureEvent } from '../../src/storage/interface.js';

function ev(source: string, ts: string, content = 'turn'): Omit<CaptureEvent, 'id'> {
  return { source, timestamp: ts, content };
}

describe('wait_for_new_turns — source resolution', () => {
  it('source_app names map to PREFIX MATCH (different from echo_resolve_mru MRU)', () => {
    const r = resolveSources(['cursor', 'claude_code']);
    expect(r.exact).toEqual([]);
    expect(r.prefixes).toHaveLength(2);
    expect(r.prefixes[0]).toContain('Cursor');
    expect(r.prefixes[1]).toContain('.claude/projects');
  });

  it('literal source paths are EXACT match', () => {
    const r = resolveSources(['fs:/Users/x/state.vscdb', 'git:/repo']);
    expect(r.exact).toEqual(['fs:/Users/x/state.vscdb', 'git:/repo']);
    expect(r.prefixes).toEqual([]);
  });

  it('mixed: literals + source_apps in one call', () => {
    const r = resolveSources(['fs:/exact.jsonl', 'codex']);
    expect(r.exact).toEqual(['fs:/exact.jsonl']);
    expect(r.prefixes).toHaveLength(1);
    expect(r.prefixes[0]).toContain('.codex/sessions');
  });
});

describe('wait_for_new_turns — validation', () => {
  it('rejects empty sources', async () => {
    const store = new MemoryStorage();
    await expect(
      waitForNewTurns(store, { sources: [], since: '2026-05-09T00:00:00.000Z' }),
    ).rejects.toThrow(/non-empty/);
  });

  it('rejects sources > WAIT_MAX_SOURCES', async () => {
    const store = new MemoryStorage();
    const sources = Array.from({ length: WAIT_MAX_SOURCES + 1 }, (_, i) => `fs:/x-${i}`);
    await expect(
      waitForNewTurns(store, { sources, since: '2026-05-09T00:00:00.000Z' }),
    ).rejects.toThrow(/max/);
  });

  it('rejects malformed since', async () => {
    const store = new MemoryStorage();
    await expect(
      waitForNewTurns(store, { sources: ['fs:/x'], since: 'not-a-date' }),
    ).rejects.toThrow(/ISO 8601/);
  });

  it('rejects invalid ISO calendar since', async () => {
    const store = new MemoryStorage();
    await expect(
      waitForNewTurns(store, { sources: ['fs:/x'], since: '2026-05-99T00:00:00.000Z' }),
    ).rejects.toThrow(/invalid timestamp: 2026-05-99T00:00:00.000Z/);
  });

  it('accepts timeout=0 (no wait, immediate return)', async () => {
    const store = new MemoryStorage();
    const startMs = Date.now();
    const r = await waitForNewTurns(
      store,
      { sources: ['fs:/nope'], since: '2026-05-09T00:00:00.000Z', timeout: 0 },
      { pollIntervalMs: 10 },
    );
    // Cheap path: should return well under 1s — only the initial poll runs.
    expect(Date.now() - startMs).toBeLessThan(1_000);
    expect(r.timed_out).toBe(true);
  });

  // Cap-at-WAIT_MAX_TIMEOUT_SECONDS is a 1-line clamp in the impl; we don't
  // runtime-verify the 60s cap because the test would have to actually wait
  // 60+ seconds to falsify a missing clamp. Lint + the impl is the contract;
  // dogfooding catches any regression.
});

describe('wait_for_new_turns — happy path', () => {
  it('returns immediately when content already exists newer than `since`', async () => {
    const store = new MemoryStorage();
    await store.append(ev('fs:/A', '2026-05-09T10:01:00.000Z'));
    const r = await waitForNewTurns(
      store,
      {
        sources: ['fs:/A'],
        since: '2026-05-09T10:00:00.000Z',
        timeout: 30,
      },
      { pollIntervalMs: 50 },
    );
    expect(r.turn_ids).toHaveLength(1);
    const [atom] = await store.getByIds(r.turn_ids);
    expect(atom!.source).toBe('fs:/A');
    expect(r.timed_out).toBe(false);
  });

  it('STRICT-after `since`: rows AT the boundary timestamp are dropped (acceptance #3)', async () => {
    const store = new MemoryStorage();
    const boundary = '2026-05-09T10:00:00.000Z';
    await store.append(ev('fs:/A', boundary, 'boundary turn (must be dropped)'));
    await store.append(ev('fs:/A', '2026-05-09T10:00:01.000Z', 'after turn (must be kept)'));
    const r = await waitForNewTurns(
      store,
      { sources: ['fs:/A'], since: boundary, timeout: 5 },
      { pollIntervalMs: 50 },
    );
    expect(r.turn_ids).toHaveLength(1);
    const [atom] = await store.getByIds(r.turn_ids);
    expect(atom!.content).toContain('after turn');
  });

  it('STRICT-after `since` with +0900 offset excludes the boundary turn', async () => {
    const store = new MemoryStorage();
    await store.append(ev('fs:/A', '2026-05-09T14:00:00.000Z', 'boundary turn (must be dropped)'));
    await store.append(ev('fs:/A', '2026-05-09T14:00:01.000Z', 'after turn (must be kept)'));
    const r = await waitForNewTurns(
      store,
      { sources: ['fs:/A'], since: '2026-05-09T23:00:00.000+0900', timeout: 5 },
      { pollIntervalMs: 50 },
    );
    expect(r.turn_ids).toHaveLength(1);
    const [atom] = await store.getByIds(r.turn_ids);
    expect(atom!.content).toContain('after turn');
  });

  it('times out with empty turn_ids + timed_out=true when no content lands', async () => {
    const store = new MemoryStorage();
    const r = await waitForNewTurns(
      store,
      { sources: ['fs:/A'], since: '2026-05-09T10:00:00.000Z', timeout: 0 },
      { pollIntervalMs: 50 },
    );
    expect(r.turn_ids).toEqual([]);
    expect(r.timed_out).toBe(true);
    // Fix ⑤ lossless chaining: on a timed-out-empty return, next_since
    // echoes the canonicalized caller `since` back — NEVER a wall-clock
    // read, which would permanently skip turns that ingest late.
    expect(r.next_since).toBe('2026-05-09T10:00:00.000Z');
  });

  it('wakes when content lands during the wait (poll loop)', async () => {
    const store = new MemoryStorage();
    // Schedule an append after a short delay; the poll loop should wake.
    setTimeout(() => {
      void store.append(ev('fs:/A', '2026-05-09T10:01:00.000Z', 'late arrival'));
    }, 30);

    const r = await waitForNewTurns(
      store,
      { sources: ['fs:/A'], since: '2026-05-09T10:00:00.000Z', timeout: 2 },
      { pollIntervalMs: 20 },
    );
    expect(r.turn_ids.length).toBeGreaterThanOrEqual(1);
    expect(r.timed_out).toBe(false);
  });

  it('source_app PREFIX match catches content under the app prefix (NOT just MRU exact-source)', async () => {
    const store = new MemoryStorage();
    // Two stored historical Cursor sources; both match the compatibility
    // prefix even though no live Cursor extractor remains.
    await store.append(
      ev(
        // canonical cursor prefix is `fs:<HOME>/Library/Application Support/Cursor/...`
        // see buildSourceAppMap; we rebuild a synthetic match here.
        `fs:${process.env['HOME'] ?? ''}/Library/Application Support/Cursor/sess-1.vscdb`,
        '2026-05-09T10:01:00.000Z',
        'cursor session 1',
      ),
    );
    await store.append(
      ev(
        `fs:${process.env['HOME'] ?? ''}/Library/Application Support/Cursor/sess-2.vscdb`,
        '2026-05-09T10:02:00.000Z',
        'cursor session 2',
      ),
    );

    const r = await waitForNewTurns(
      store,
      { sources: ['cursor'], since: '2026-05-09T10:00:00.000Z', timeout: 1 },
      { pollIntervalMs: 50 },
    );
    expect(r.turn_ids.length).toBeGreaterThanOrEqual(2);
  });
});

describe('wait_for_new_turns — stateless (acceptance #3 — 3 parallel calls with disjoint sources)', () => {
  it('3 parallel calls with disjoint `sources[]` are independent of each other (no cross-talk)', async () => {
    const store = new MemoryStorage();
    await store.append(ev('fs:/A', '2026-05-09T10:01:00.000Z', 'A turn'));
    await store.append(ev('fs:/B', '2026-05-09T10:02:00.000Z', 'B turn'));
    await store.append(ev('fs:/C', '2026-05-09T10:03:00.000Z', 'C turn'));

    const since = '2026-05-09T10:00:00.000Z';
    const [rA, rB, rC] = await Promise.all([
      waitForNewTurns(store, { sources: ['fs:/A'], since, timeout: 1 }, { pollIntervalMs: 30 }),
      waitForNewTurns(store, { sources: ['fs:/B'], since, timeout: 1 }, { pollIntervalMs: 30 }),
      waitForNewTurns(store, { sources: ['fs:/C'], since, timeout: 1 }, { pollIntervalMs: 30 }),
    ]);

    // Each call sees only its own source — no cross-contamination from
    // a shared subscriber registry or module-level mutable state. Item 038
    // / AC4: bodies are no longer bundled; hydrate via storage.getByIds to
    // verify the per-source slice.
    const [atomA] = await store.getByIds(rA.turn_ids);
    const [atomB] = await store.getByIds(rB.turn_ids);
    const [atomC] = await store.getByIds(rC.turn_ids);
    expect(atomA!.source).toBe('fs:/A');
    expect(atomB!.source).toBe('fs:/B');
    expect(atomC!.source).toBe('fs:/C');
  });

  it('a second invocation with same sources returns the same result (idempotent — no per-call state)', async () => {
    const store = new MemoryStorage();
    await store.append(ev('fs:/A', '2026-05-09T10:01:00.000Z', 'A turn'));
    const since = '2026-05-09T10:00:00.000Z';
    const r1 = await waitForNewTurns(
      store,
      { sources: ['fs:/A'], since, timeout: 0 },
      { pollIntervalMs: 30 },
    );
    const r2 = await waitForNewTurns(
      store,
      { sources: ['fs:/A'], since, timeout: 0 },
      { pollIntervalMs: 30 },
    );
    expect(r1.turn_ids).toEqual(r2.turn_ids);
  });
});

// Item 037 / AC5 — repo_path filter.
describe('wait_for_new_turns repo_path (item 037 / AC5)', () => {
  it('AC5: baseline (no repo_path) returns all matching turns', async () => {
    const store = new MemoryStorage();
    await store.append({
      source: 'fs:/A',
      timestamp: '2026-05-09T10:01:00.000Z',
      content: 'turn',
      metadata: { repo_root: '/repo-a' },
    });
    const r = await waitForNewTurns(
      store,
      { sources: ['fs:/A'], since: '2026-05-09T10:00:00.000Z', timeout: 0 },
      { pollIntervalMs: 30 },
    );
    expect(r.turn_ids).toHaveLength(1);
  });

  it('AC5: filters per-source results by metadata.repo_root', async () => {
    const store = new MemoryStorage();
    await store.append({
      source: 'fs:/A',
      timestamp: '2026-05-09T10:01:00.000Z',
      content: 'in repo a',
      metadata: { repo_root: '/repo-a' },
    });
    await store.append({
      source: 'fs:/A',
      timestamp: '2026-05-09T10:02:00.000Z',
      content: 'in repo b',
      metadata: { repo_root: '/repo-b' },
    });
    const r = await waitForNewTurns(
      store,
      {
        sources: ['fs:/A'],
        since: '2026-05-09T10:00:00.000Z',
        timeout: 0,
        repo_path: '/repo-a',
      },
      { pollIntervalMs: 30 },
    );
    const atoms = await store.getByIds(r.turn_ids);
    expect(atoms.map((a) => a.content)).toEqual(['in repo a']);
  });

  it('AC5: rejects non-absolute repo_path with a clear error', async () => {
    const store = new MemoryStorage();
    await expect(
      waitForNewTurns(
        store,
        {
          sources: ['fs:/A'],
          since: '2026-05-09T10:00:00.000Z',
          timeout: 0,
          repo_path: 'relative',
        },
        { pollIntervalMs: 30 },
      ),
    ).rejects.toThrow(/repo_path must be absolute/);
  });

  it('AC5: trailing-slash normalises to no-slash form', async () => {
    const store = new MemoryStorage();
    await store.append({
      source: 'fs:/A',
      timestamp: '2026-05-09T10:01:00.000Z',
      content: 'normalised',
      metadata: { repo_root: '/Users/x/Project_echo' },
    });
    const r = await waitForNewTurns(
      store,
      {
        sources: ['fs:/A'],
        since: '2026-05-09T10:00:00.000Z',
        timeout: 0,
        repo_path: '/Users/x/Project_echo/',
      },
      { pollIntervalMs: 30 },
    );
    const atoms = await store.getByIds(r.turn_ids);
    expect(atoms.map((a) => a.content)).toEqual(['normalised']);
  });
});

// Item 038 / AC4 — IDs-only contract.
describe('wait_for_new_turns — AC4 IDs-only response shape', () => {
  it('(a) returned `turn_ids` carries the matched atom ids in chronological (ASC) delivery order', async () => {
    // Fix ⑤ lossless chaining: delivery order changed from newest-first
    // (DESC) to oldest-first ASC (timestamp, id) so that the overflow page
    // ("oldest cap-sized page") and the no-overflow page share one ordering
    // contract. The id SET is unchanged from the AC4 contract.
    const store = new MemoryStorage();
    const idA = await store.append({
      source: 'fs:/A',
      timestamp: '2026-05-09T10:01:00.000Z',
      content: 'turn 1',
    });
    const idB = await store.append({
      source: 'fs:/A',
      timestamp: '2026-05-09T10:02:00.000Z',
      content: 'turn 2',
    });
    const idC = await store.append({
      source: 'fs:/A',
      timestamp: '2026-05-09T10:03:00.000Z',
      content: 'turn 3',
    });
    const r = await waitForNewTurns(
      store,
      { sources: ['fs:/A'], since: '2026-05-09T10:00:00.000Z', timeout: 0 },
      { pollIntervalMs: 30 },
    );
    // Oldest-first order, all three captured.
    expect(r.turn_ids).toEqual([idA, idB, idC]);
  });

  it('(b) no `content`, `metadata`, or `truncations` fields appear on the response', async () => {
    const store = new MemoryStorage();
    await store.append({
      source: 'fs:/A',
      timestamp: '2026-05-09T10:01:00.000Z',
      content: 'large content '.repeat(10_000),
      metadata: { workspace_id: 'a' },
    });
    const r = await waitForNewTurns(
      store,
      { sources: ['fs:/A'], since: '2026-05-09T10:00:00.000Z', timeout: 0 },
      { pollIntervalMs: 30 },
    );
    // Top-level shape carries only: schema_version, tool, turn_ids,
    // next_since, timed_out, warnings.
    expect(Object.keys(r).sort()).toEqual([
      'next_since',
      'schema_version',
      'timed_out',
      'tool',
      'turn_ids',
      'warnings',
    ]);
    // No accidental body fields exposed by structural type drift.
    expect((r as unknown as Record<string, unknown>)['turns']).toBeUndefined();
    expect((r as unknown as Record<string, unknown>)['content']).toBeUndefined();
    expect((r as unknown as Record<string, unknown>)['metadata']).toBeUndefined();
    // The envelope is bounded by ~36 chars per UUID + ~80 chars envelope,
    // even with a 130KB atom. Pre-AC4, the projected match body alone
    // would have pushed JSON.stringify(r) toward the 25KB ceiling.
    expect(JSON.stringify(r).length).toBeLessThan(1_000);
  });

  it('(c) integration: wait → get_atoms round-trip recovers the same atom bodies a single-call wait_for_new_turns would have returned pre-038', async () => {
    const store = new MemoryStorage();
    const idA = await store.append({
      source: 'fs:/A',
      timestamp: '2026-05-09T10:01:00.000Z',
      content: 'pre-038 body A',
    });
    const idB = await store.append({
      source: 'fs:/A',
      timestamp: '2026-05-09T10:02:00.000Z',
      content: 'pre-038 body B',
    });

    const w = await waitForNewTurns(
      store,
      { sources: ['fs:/A'], since: '2026-05-09T10:00:00.000Z', timeout: 0 },
      { pollIntervalMs: 30 },
    );
    // Fix ⑤: delivery order is now chronological ASC (was [idB, idA]).
    expect(w.turn_ids).toEqual([idA, idB]);
    // Compose the canonical wake → fetch pattern.
    const atoms = await store.getByIds(w.turn_ids);
    expect(atoms.map((a) => a.content)).toEqual(['pre-038 body A', 'pre-038 body B']);
  });
});

// Fix ⑤ — lossless chaining contract for `next_since` + overflow paging.
//
// The old contract lost turns two ways:
//   (a) next_since = server wall clock at return. Event timestamps can predate
//       late ingestion into storage. A turn that occurred before the return moment but
//       ingested after the final poll was permanently invisible to every
//       chained call (strict `> since` filter).
//   (b) per-poll cap kept the NEWEST 20 — a burst of >20 silently dropped
//       the oldest, with no truncation signal, and chaining skipped them
//       forever.
describe('wait_for_new_turns — Fix ⑤ lossless chaining (next_since + overflow paging)', () => {
  it('chaining-with-ingest-lag: a turn whose event-time predates the wall-clock return moment, appended after the response, is returned by the chained call', async () => {
    const store = new MemoryStorage();
    const tsA = '2026-05-09T10:01:00.000Z';
    const idA = await store.append(ev('fs:/A', tsA, 'turn A'));

    const r1 = await waitForNewTurns(
      store,
      { sources: ['fs:/A'], since: '2026-05-09T10:00:00.000Z', timeout: 0 },
      { pollIntervalMs: 10 },
    );
    expect(r1.turn_ids).toEqual([idA]);
    // Contract: next_since = max timestamp among RETURNED turns — never a
    // wall-clock read (the old code returned now(), i.e. real 2026-06 time,
    // which is far ahead of every event timestamp below).
    expect(r1.next_since).toBe(tsA);

    // Ingest lag: turn B occurred at 10:02 (before the wall-clock moment
    // r1 returned — all test timestamps are in the past) but lands in
    // storage only AFTER r1's response. Under the old wall-clock
    // next_since, B was permanently invisible to every chained call.
    const idB = await store.append(ev('fs:/A', '2026-05-09T10:02:00.000Z', 'turn B late ingest'));
    const r2 = await waitForNewTurns(
      store,
      { sources: ['fs:/A'], since: r1.next_since, timeout: 0 },
      { pollIntervalMs: 10 },
    );
    expect(r2.turn_ids).toEqual([idB]);
    expect(r2.timed_out).toBe(false);
  });

  it('burst of 25: first call returns the OLDEST 20 + overflow warning; chained call returns the remaining 5', async () => {
    const store = new MemoryStorage();
    const ids: string[] = [];
    for (let i = 1; i <= 25; i++) {
      const ts = `2026-05-09T10:00:${String(i).padStart(2, '0')}.000Z`;
      ids.push(await store.append(ev('fs:/A', ts, `burst turn ${i}`)));
    }

    const r1 = await waitForNewTurns(
      store,
      { sources: ['fs:/A'], since: '2026-05-09T10:00:00.000Z', timeout: 0 },
      { pollIntervalMs: 10 },
    );
    // Oldest cap-sized page, ascending by (timestamp, id).
    expect(r1.turn_ids).toEqual(ids.slice(0, 20));
    expect(r1.warnings.some((w) => /more than 20 new turns/.test(w))).toBe(true);
    expect(r1.next_since).toBe('2026-05-09T10:00:20.000Z');
    expect(r1.timed_out).toBe(false);

    // Chaining since=next_since pages through the backlog losslessly.
    const r2 = await waitForNewTurns(
      store,
      { sources: ['fs:/A'], since: r1.next_since, timeout: 0 },
      { pollIntervalMs: 10 },
    );
    expect(r2.turn_ids).toEqual(ids.slice(20));
    expect(r2.warnings).toEqual([]);
    expect(r2.next_since).toBe('2026-05-09T10:00:25.000Z');
  });

  it('timeout-empty: next_since echoes the canonicalized caller `since`, not a fresh clock value', async () => {
    const store = new MemoryStorage();
    const r = await waitForNewTurns(
      store,
      { sources: ['fs:/A'], since: '2026-05-09T23:00:00.000+0900', timeout: 0 },
      { pollIntervalMs: 10 },
    );
    expect(r.timed_out).toBe(true);
    expect(r.turn_ids).toEqual([]);
    // Canonical Z form of the +0900 input — NOT today's wall clock. Nothing
    // was delivered, so echoing `since` back can never re-deliver anything.
    expect(r.next_since).toBe('2026-05-09T14:00:00.000Z');
  });

  it('same-timestamp group at the page boundary is never split (page may exceed the cap by the tie count)', async () => {
    const store = new MemoryStorage();
    const ids: string[] = [];
    // 19 distinct-timestamp turns…
    for (let i = 1; i <= 19; i++) {
      const ts = `2026-05-09T10:00:${String(i).padStart(2, '0')}.000Z`;
      ids.push(await store.append(ev('fs:/A', ts, `tie test turn ${i}`)));
    }
    // …then 3 turns sharing the timestamp that lands at page index 19 (the
    // cap boundary). With strict `> since` chaining, splitting this group
    // would skip the unreturned members forever; the page must include all
    // three (22 returned > cap 20).
    const tieTs = '2026-05-09T10:00:20.000Z';
    for (let i = 0; i < 3; i++) {
      ids.push(await store.append(ev('fs:/A', tieTs, `tie group member ${i}`)));
    }

    const r1 = await waitForNewTurns(
      store,
      { sources: ['fs:/A'], since: '2026-05-09T10:00:00.000Z', timeout: 0 },
      { pollIntervalMs: 10 },
    );
    expect(r1.turn_ids).toHaveLength(22);
    expect(new Set(r1.turn_ids)).toEqual(new Set(ids));
    expect(r1.warnings.some((w) => /more than 20 new turns/.test(w))).toBe(true);
    expect(r1.next_since).toBe(tieTs);

    // Chained call: everything was delivered, so nothing remains.
    const r2 = await waitForNewTurns(
      store,
      { sources: ['fs:/A'], since: r1.next_since, timeout: 0 },
      { pollIntervalMs: 10 },
    );
    expect(r2.turn_ids).toEqual([]);
    expect(r2.timed_out).toBe(true);
    expect(r2.next_since).toBe(tieTs);
  });

  // 101-retro r3 codex MED: a boundary tie group TRUNCATED BY THE PER-SOURCE
  // FETCH WINDOW must not be treated as complete. 19 older rows + a 30-row
  // same-ms group = 49 rows; the 41-row window fetches only 22 of the group.
  // Extending the page through the FETCHED ties and advancing next_since to
  // the tie timestamp skipped the 8 unfetched members forever. Contract: a
  // tie group that cannot be proven complete (the window-full fetch ends at
  // its timestamp) is HELD BACK whole — the chained call re-fetches it with
  // the full window.
  it('window-truncated boundary tie group is held back whole; chaining delivers all 49 turns', async () => {
    const store = new MemoryStorage();
    const olderIds: string[] = [];
    for (let i = 1; i <= 19; i++) {
      const ts = `2026-05-09T10:00:${String(i).padStart(2, '0')}.000Z`;
      olderIds.push(await store.append(ev('fs:/A', ts, `pre-tie turn ${i}`)));
    }
    const tieTs = '2026-05-09T10:00:30.000Z';
    const tieIds: string[] = [];
    for (let i = 0; i < 30; i++) {
      tieIds.push(await store.append(ev('fs:/A', tieTs, `big tie member ${i}`)));
    }

    const r1 = await waitForNewTurns(
      store,
      { sources: ['fs:/A'], since: '2026-05-09T10:00:00.000Z', timeout: 0 },
      { pollIntervalMs: 10 },
    );
    // Only the 19 provably-complete older rows; the unprovable tie group is
    // held back entirely (NOT 22 of its 30 members).
    expect(r1.turn_ids).toEqual(olderIds);
    expect(r1.next_since).toBe('2026-05-09T10:00:19.000Z');
    expect(r1.warnings.some((w) => /chain immediately/.test(w))).toBe(true);

    // The chained call has the whole window for the tie group (30 ≤ 41) and
    // delivers it complete — zero loss across the chain.
    const r2 = await waitForNewTurns(
      store,
      { sources: ['fs:/A'], since: r1.next_since, timeout: 0 },
      { pollIntervalMs: 10 },
    );
    expect(new Set(r2.turn_ids)).toEqual(new Set(tieIds));
    expect(r2.turn_ids).toHaveLength(30);
    expect(r2.next_since).toBe(tieTs);
  });

  it('a single same-ms group larger than the per-source window is the documented lossy floor — and warns explicitly', async () => {
    const store = new MemoryStorage();
    const tieTs = '2026-05-09T10:00:30.000Z';
    for (let i = 0; i < 45; i++) {
      await store.append(ev('fs:/A', tieTs, `giant tie member ${i}`));
    }

    const r1 = await waitForNewTurns(
      store,
      { sources: ['fs:/A'], since: '2026-05-09T10:00:00.000Z', timeout: 0 },
      { pollIntervalMs: 10 },
    );
    // No older rows exist to return instead, so the fetched portion ships —
    // but with a loud, distinct warning that same-timestamp turns may be
    // skipped (the only remaining lossy case, by construction).
    expect(r1.turn_ids).toHaveLength(41);
    expect(r1.warnings.some((w) => /same-timestamp .*may .*skip|may be incomplete/i.test(w))).toBe(
      true,
    );
    expect(r1.next_since).toBe(tieTs);
  });
});
