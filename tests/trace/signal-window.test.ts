// 113 — getSignalWindow contract tests (AC1/AC2/AC4/AC5/AC6 + the Tests
// section): union, caller-derived cursor advancement, limit-after-filter,
// full-fidelity round-trip, scope mapping, late-arrival, determinism, loop.

import { describe, expect, it } from 'vitest';
import { MemoryStorage } from '../../src/storage/memory.js';
import { getSignalWindow } from '../../src/trace/signal-window.js';

const TS = '2026-07-04T08:00:00.000Z';

function store(): MemoryStorage {
  return new MemoryStorage();
}

describe('113 AC1 — union of raw (adapters) + derived atoms; every entry carries sequence_id', () => {
  it('company scope unions api:granola (normalized) with derived atoms', async () => {
    const s = store();
    const granolaId = await s.append({
      source: 'api:granola',
      timestamp: TS,
      content: 'meeting note body',
      metadata: { note_id: 'n1', title: 'Standup' },
    });
    const sigId = await s.append({
      source: 'derived:granola-signals',
      timestamp: TS,
      content: 'signal',
      metadata: { canonical_subject: 'auth' },
    });
    const decId = await s.append({
      source: 'derived:team-decisions',
      timestamp: TS,
      content: 'we will use sqlite',
      metadata: { canonical_subject: 'storage' },
    });

    const entries = await getSignalWindow(s, { scope: 'company' });
    const ids = entries.map((e) => e.id).sort();
    expect(ids).toEqual([granolaId, sigId, decId].sort());
    for (const e of entries) {
      expect(typeof e.sequence_id).toBe('number');
      expect(e.sequence_id).toBeGreaterThan(0);
    }
    // Raw event carries a normalized projection (reused source adapter);
    // derived atoms have no adapter → normalized is null but full content rides.
    const granola = entries.find((e) => e.id === granolaId)!;
    expect(granola.normalized).not.toBeNull();
    const derived = entries.find((e) => e.id === sigId)!;
    expect(derived.normalized).toBeNull();
    expect(derived.content).toBe('signal');
  });
});

describe('113 — caller-derived cursor advancement', () => {
  it('limit-truncated advance by max(seq)+1 returns previously-truncated rows, skips none', async () => {
    const s = store();
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      ids.push(await s.append({ source: 'fs:/x', timestamp: TS, content: `atom-${i}` }));
    }
    const seen: string[] = [];
    let sinceSeq = 1;
    for (let guard = 0; guard < 10; guard++) {
      const page = await getSignalWindow(s, { scope: 'machine', cursor: { sinceSeq }, limit: 2 });
      if (page.length === 0) break;
      seen.push(...page.map((e) => e.id));
      // Caller-derived advancement: max seen sequence_id + 1.
      sinceSeq = Math.max(...page.map((e) => e.sequence_id)) + 1;
    }
    expect(seen).toEqual(ids); // all rows, in order, none skipped or duplicated
  });

  it('empty page leaves sinceSeq unchanged; a later append is picked up on re-poll', async () => {
    const s = store();
    await s.append({ source: 'fs:/x', timestamp: TS, content: 'seed' });
    const w = await s.getCurrentSequence();
    const sinceSeq = w + 1;
    // Tail is empty right now.
    const empty = await getSignalWindow(s, { scope: 'machine', cursor: { sinceSeq } });
    expect(empty).toEqual([]);
    // Append at/after the held cursor; re-poll the SAME sinceSeq returns it.
    const lateId = await s.append({ source: 'fs:/x', timestamp: TS, content: 'late' });
    const repoll = await getSignalWindow(s, { scope: 'machine', cursor: { sinceSeq } });
    expect(repoll.map((e) => e.id)).toEqual([lateId]);
  });

  it('limit-after-filter: leading filtered-out rows do not hide an eligible later row', async () => {
    const s = store();
    // Several leading company atoms whose subject does NOT match the loop...
    for (let i = 0; i < 3; i++) {
      await s.append({
        source: 'derived:granola-signals',
        timestamp: TS,
        content: `noise-${i}`,
        metadata: { canonical_subject: 'other' },
      });
    }
    // ...then one eligible atom deeper in the ledger.
    const targetId = await s.append({
      source: 'derived:team-decisions',
      timestamp: TS,
      content: 'target',
      metadata: { canonical_subject: 'auth' },
    });
    const page = await getSignalWindow(s, {
      scope: 'company',
      cursor: { sinceSeq: 1 },
      loop: 'auth',
      limit: 1,
    });
    expect(page.map((e) => e.id)).toEqual([targetId]);
  });
});

describe('113 — full-fidelity round-trip (no wire-shape caps in the path)', () => {
  it('carries content/metadata exceeding MCP wire-cap sizes exactly untruncated', async () => {
    const s = store();
    const bigContent = 'x'.repeat(5_000); // > match_content cap (2_000)
    const bigMeta = 'y'.repeat(3_000); // > metadata_value cap (1_000)
    const fsId = await s.append({
      source: 'fs:/big',
      timestamp: TS,
      content: bigContent,
      metadata: { blob: bigMeta },
    });
    const derivedId = await s.append({
      source: 'derived:team-decisions',
      timestamp: TS,
      content: bigContent,
      metadata: { canonical_subject: 'z', blob: bigMeta },
    });

    const machine = await getSignalWindow(s, { scope: 'machine' });
    const fsEntry = machine.find((e) => e.id === fsId)!;
    expect(fsEntry.content).toBe(bigContent);
    expect((fsEntry.metadata as { blob: string }).blob).toBe(bigMeta);

    const company = await getSignalWindow(s, { scope: 'company' });
    const derivedEntry = company.find((e) => e.id === derivedId)!;
    expect(derivedEntry.content).toBe(bigContent);
    expect((derivedEntry.metadata as { blob: string }).blob).toBe(bigMeta);
  });
});

describe('113 AC2 — scope mapping', () => {
  it('one atom per source class lands in exactly its documented scope', async () => {
    const s = store();
    const fsId = await s.append({ source: 'fs:/x', timestamp: TS, content: 'fs' });
    const gitId = await s.append({ source: 'git:/r', timestamp: TS, content: 'git' });
    const granolaId = await s.append({
      source: 'api:granola',
      timestamp: TS,
      content: 'g',
      metadata: { note_id: 'n1' },
    });
    const derivedId = await s.append({
      source: 'derived:granola-signals',
      timestamp: TS,
      content: 'd',
      metadata: { canonical_subject: 'x' },
    });

    const machine = (await getSignalWindow(s, { scope: 'machine' })).map((e) => e.id).sort();
    const company = (await getSignalWindow(s, { scope: 'company' })).map((e) => e.id).sort();
    expect(machine).toEqual([fsId, gitId].sort());
    expect(company).toEqual([granolaId, derivedId].sort());
  });
});

describe('113 AC2 — bookkeeping exclusion (merge fixup: AC1/AC2 reconciliation)', () => {
  it('derived:granola-signals-index manifest atoms never appear in company windows', async () => {
    const s = store();
    const sigId = await s.append({
      source: 'derived:granola-signals',
      timestamp: TS,
      content: 'real signal',
      metadata: { canonical_subject: 'auth' },
    });
    await s.append({
      source: 'derived:granola-signals-index',
      timestamp: TS,
      content: '{"manifest":true}',
      metadata: { note_id: 'n1' },
    });

    const company = await getSignalWindow(s, { scope: 'company' });
    expect(company.map((e) => e.id)).toEqual([sigId]);
    expect(company.some((e) => e.source.startsWith('derived:granola-signals-index'))).toBe(false);
  });
});

describe('113 AC4 — late-arrival correctness (why two orderings exist)', () => {
  it('cursor read returns an old-timestamp late atom; event-time read excludes it', async () => {
    const s = store();
    // Recent company atoms establish a high-watermark.
    for (let i = 0; i < 3; i++) {
      await s.append({
        source: 'derived:team-decisions',
        timestamp: '2026-07-04T09:0' + i + ':00.000Z',
        content: `recent-${i}`,
        metadata: { canonical_subject: 's' },
      });
    }
    const w = await s.getCurrentSequence();
    // Late arrival: ingested now, but stamped with an OLD occurred-at.
    const lateId = await s.append({
      source: 'derived:team-decisions',
      timestamp: '2026-01-01T00:00:00.000Z',
      content: 'late-with-old-timestamp',
      metadata: { canonical_subject: 's' },
    });

    const cursorRead = await getSignalWindow(s, { scope: 'company', cursor: { sinceSeq: w + 1 } });
    expect(cursorRead.map((e) => e.id)).toEqual([lateId]); // A lands at W+1

    const eventTimeRead = await getSignalWindow(s, {
      scope: 'company',
      since: '2026-07-04T00:00:00.000Z',
    });
    expect(eventTimeRead.map((e) => e.id)).not.toContain(lateId); // old ts < since
    expect(eventTimeRead.length).toBe(3);
  });
});

describe('113 AC5 — determinism', () => {
  it('same opts + same state = deep-equal; stable across an unrelated-scope append', async () => {
    const s = store();
    await s.append({
      source: 'api:granola',
      timestamp: TS,
      content: 'note',
      metadata: { note_id: 'n1' },
    });
    await s.append({
      source: 'derived:team-decisions',
      timestamp: TS,
      content: 'dec',
      metadata: { canonical_subject: 'a' },
    });
    const first = await getSignalWindow(s, { scope: 'company' });
    const second = await getSignalWindow(s, { scope: 'company' });
    expect(second).toEqual(first);
    // Unrelated-scope append (machine) must not perturb the company read.
    await s.append({ source: 'fs:/x', timestamp: TS, content: 'unrelated' });
    const third = await getSignalWindow(s, { scope: 'company' });
    expect(third).toEqual(first);
  });
});

describe('113 AC6 — loop filter (dumb string-equality on canonical_subject)', () => {
  it('keeps only exact-subject matches; excludes keyless and mismatched entries', async () => {
    const s = store();
    const authId = await s.append({
      source: 'derived:team-decisions',
      timestamp: TS,
      content: 'auth decision',
      metadata: { canonical_subject: 'auth' },
    });
    await s.append({
      source: 'derived:team-decisions',
      timestamp: TS,
      content: 'billing decision',
      metadata: { canonical_subject: 'billing' },
    });
    await s.append({
      source: 'derived:granola-signals',
      timestamp: TS,
      content: 'keyless signal',
      metadata: { note_id: 'n1' }, // no canonical_subject
    });

    const filtered = await getSignalWindow(s, { scope: 'company', loop: 'auth' });
    expect(filtered.map((e) => e.id)).toEqual([authId]);
  });
});
