import { describe, expect, it } from 'vitest';
import type { NormalizedContextEvent } from '../../src/normalize/types.js';
import {
  isSingleSourceRecent,
  noUsefulCluster,
  SINGLE_SOURCE_RECENT_THRESHOLD_MS,
} from '../../src/trace/auto-expand.js';
import type { Cluster } from '../../src/trace/types.js';
import { makeAtom } from './fixtures/atoms.js';

// V1.6 (item 032) — AC4 predicate unit tests.
// Four fixture cases: empty, all-single-source-recent, all-single-source-
// but-old, mixed. `noUsefulCluster` returns true only for empty + all-
// single-source-recent.

function buildAtomMap(atoms: NormalizedContextEvent[]): Map<string, NormalizedContextEvent> {
  return new Map(atoms.map((a) => [a.id, a]));
}

function makeCluster(opts: {
  id: string;
  atom_ids: string[];
  source_breakdown: Record<string, number>;
}): Cluster {
  return {
    cluster_id: opts.id,
    rank: 0,
    rank_reason: [],
    anchor_artifacts: [],
    atom_ids: opts.atom_ids,
    edges: [],
    open_loop_hints: [],
    source_breakdown: opts.source_breakdown,
    time_range: { from: '', to: '' },
  };
}

const NOW = new Date('2026-05-10T20:00:00.000Z');
const NOW_MS = NOW.getTime();
// 1 minute ago — well inside SINGLE_SOURCE_RECENT_THRESHOLD_MS (5 minutes)
const RECENT_TS = new Date(NOW_MS - 60_000).toISOString();
// 10 minutes ago — outside the 5min threshold
const OLD_TS = new Date(NOW_MS - 10 * 60_000).toISOString();

describe('isSingleSourceRecent', () => {
  it('returns true when source_breakdown has exactly one key AND latest atom is within threshold', () => {
    const a = makeAtom({
      id: 'a1',
      app: 'claude_code',
      occurred_at: RECENT_TS,
      artifacts: [],
    });
    const c = makeCluster({
      id: 'ctx_1',
      atom_ids: ['a1'],
      source_breakdown: { claude_code: 1 },
    });
    expect(isSingleSourceRecent(c, buildAtomMap([a]), NOW_MS)).toBe(true);
  });

  it('returns false when source_breakdown has multiple keys (multi-source)', () => {
    const a1 = makeAtom({
      id: 'a1',
      app: 'claude_code',
      occurred_at: RECENT_TS,
      artifacts: [],
    });
    const a2 = makeAtom({
      id: 'a2',
      app: 'git',
      occurred_at: RECENT_TS,
      artifacts: [],
    });
    const c = makeCluster({
      id: 'ctx_2',
      atom_ids: ['a1', 'a2'],
      source_breakdown: { claude_code: 1, git: 1 },
    });
    expect(isSingleSourceRecent(c, buildAtomMap([a1, a2]), NOW_MS)).toBe(false);
  });

  it('returns false when single-source but latest atom is outside the threshold (old)', () => {
    const a = makeAtom({
      id: 'a1',
      app: 'claude_code',
      occurred_at: OLD_TS,
      artifacts: [],
    });
    const c = makeCluster({
      id: 'ctx_3',
      atom_ids: ['a1'],
      source_breakdown: { claude_code: 1 },
    });
    expect(isSingleSourceRecent(c, buildAtomMap([a]), NOW_MS)).toBe(false);
  });

  it('uses the LATEST atom in the cluster for the recency check (not oldest)', () => {
    // Mixed atoms: one old + one recent in the SAME single-source cluster.
    // The cluster is recent overall because its newest atom is fresh.
    const aOld = makeAtom({
      id: 'a_old',
      app: 'claude_code',
      occurred_at: OLD_TS,
      artifacts: [],
    });
    const aRecent = makeAtom({
      id: 'a_recent',
      app: 'claude_code',
      occurred_at: RECENT_TS,
      artifacts: [],
    });
    const c = makeCluster({
      id: 'ctx_4',
      atom_ids: ['a_old', 'a_recent'],
      source_breakdown: { claude_code: 2 },
    });
    expect(isSingleSourceRecent(c, buildAtomMap([aOld, aRecent]), NOW_MS)).toBe(true);
  });

  it('exact threshold boundary is inclusive (≤ threshold passes)', () => {
    const boundaryTs = new Date(NOW_MS - SINGLE_SOURCE_RECENT_THRESHOLD_MS).toISOString();
    const a = makeAtom({
      id: 'a1',
      app: 'claude_code',
      occurred_at: boundaryTs,
      artifacts: [],
    });
    const c = makeCluster({
      id: 'ctx_5',
      atom_ids: ['a1'],
      source_breakdown: { claude_code: 1 },
    });
    expect(isSingleSourceRecent(c, buildAtomMap([a]), NOW_MS)).toBe(true);
  });
});

describe('noUsefulCluster', () => {
  // (a) empty → vacuously true
  it('returns true for the empty cluster set (vacuous truth — preserves empty auto-expand)', () => {
    expect(noUsefulCluster([], new Map(), NOW_MS)).toBe(true);
  });

  // (b) all clusters single-source-recent → true
  it('returns true when every cluster is single-source-recent', () => {
    const a1 = makeAtom({
      id: 'a1',
      app: 'claude_code',
      occurred_at: RECENT_TS,
      artifacts: [],
    });
    const a2 = makeAtom({
      id: 'a2',
      app: 'claude_code',
      occurred_at: RECENT_TS,
      artifacts: [],
    });
    const c1 = makeCluster({
      id: 'ctx_1',
      atom_ids: ['a1'],
      source_breakdown: { claude_code: 1 },
    });
    const c2 = makeCluster({
      id: 'ctx_2',
      atom_ids: ['a2'],
      source_breakdown: { claude_code: 1 },
    });
    expect(noUsefulCluster([c1, c2], buildAtomMap([a1, a2]), NOW_MS)).toBe(true);
  });

  // (c) all single-source but ALL old → false (the predicate keys on recency)
  it('returns false when every cluster is single-source but all old (outside 5min)', () => {
    const a = makeAtom({
      id: 'a1',
      app: 'claude_code',
      occurred_at: OLD_TS,
      artifacts: [],
    });
    const c = makeCluster({
      id: 'ctx_1',
      atom_ids: ['a1'],
      source_breakdown: { claude_code: 1 },
    });
    expect(noUsefulCluster([c], buildAtomMap([a]), NOW_MS)).toBe(false);
  });

  // (d) mixed — at least one non-single-source-recent → false
  it('returns false when the set contains BOTH single-source-recent AND multi-source-recent clusters', () => {
    const aNoise = makeAtom({
      id: 'a_noise',
      app: 'claude_code',
      occurred_at: RECENT_TS,
      artifacts: [],
    });
    const aWork1 = makeAtom({
      id: 'a_work_1',
      app: 'claude_code',
      occurred_at: RECENT_TS,
      artifacts: [],
    });
    const aWork2 = makeAtom({
      id: 'a_work_2',
      app: 'git',
      occurred_at: RECENT_TS,
      artifacts: [],
    });
    const cNoise = makeCluster({
      id: 'ctx_noise',
      atom_ids: ['a_noise'],
      source_breakdown: { claude_code: 1 },
    });
    const cWork = makeCluster({
      id: 'ctx_work',
      atom_ids: ['a_work_1', 'a_work_2'],
      source_breakdown: { claude_code: 1, git: 1 },
    });
    expect(noUsefulCluster([cNoise, cWork], buildAtomMap([aNoise, aWork1, aWork2]), NOW_MS)).toBe(
      false,
    );
  });
});
