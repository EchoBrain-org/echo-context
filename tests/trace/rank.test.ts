import { describe, expect, it } from 'vitest';
import type { ArtifactRef } from '../../src/normalize/types.js';
import type { NormalizedContextEvent } from '../../src/normalize/types.js';
import { rankClusters, rankReasonsFor, signalsFor } from '../../src/trace/rank.js';
import type { Cluster, Query } from '../../src/trace/types.js';
import { makeAtom } from './fixtures/atoms.js';

function buildAtomMap(atoms: NormalizedContextEvent[]): Map<string, NormalizedContextEvent> {
  return new Map(atoms.map((a) => [a.id, a]));
}

function makeCluster(opts: {
  id: string;
  atom_ids: string[];
  open_loop_hints?: Cluster['open_loop_hints'];
  source_breakdown?: Record<string, number>;
  anchor_artifacts?: ArtifactRef[];
}): Cluster {
  return {
    cluster_id: opts.id,
    rank: 0,
    rank_reason: [],
    anchor_artifacts: opts.anchor_artifacts ?? [],
    atom_ids: opts.atom_ids,
    edges: [],
    open_loop_hints: opts.open_loop_hints ?? [],
    source_breakdown: opts.source_breakdown ?? {},
    time_range: { from: '', to: '' },
  };
}

const QUERY: Query = {
  since: '2026-05-06T05:00:00.000Z',
  until: '2026-05-06T09:00:00.000Z',
};

describe('rankReasonsFor', () => {
  it('fires recent_activity when an atom is within the last 1h of query.until', () => {
    const a = makeAtom({
      id: 'evt_recent',
      app: 'cursor',
      occurred_at: '2026-05-06T08:30:00.000Z',
      artifacts: [],
    });
    const c = makeCluster({ id: 'ctx_1', atom_ids: ['evt_recent'] });
    expect(rankReasonsFor(c, buildAtomMap([a]), QUERY)).toContain('recent_activity');
  });

  it('does NOT fire recent_activity when all atoms are older than 1h', () => {
    const a = makeAtom({
      id: 'evt_old',
      app: 'cursor',
      occurred_at: '2026-05-06T06:00:00.000Z',
      artifacts: [],
    });
    const c = makeCluster({ id: 'ctx_1', atom_ids: ['evt_old'] });
    expect(rankReasonsFor(c, buildAtomMap([a]), QUERY)).not.toContain('recent_activity');
  });

  it('fires matches_artifact_hint when cluster touches the hint artifact', () => {
    const a = makeAtom({
      id: 'evt_a',
      app: 'cursor',
      occurred_at: '2026-05-06T08:30:00.000Z',
      artifacts: [{ provider: 'local_fs', type: 'file', id: 'r::a.ts' }],
    });
    const c = makeCluster({ id: 'ctx_1', atom_ids: ['evt_a'] });
    const q: Query = {
      ...QUERY,
      artifact_hint: { provider: 'local_fs', type: 'file', id: 'r::a.ts' },
    };
    expect(rankReasonsFor(c, buildAtomMap([a]), q)).toContain('matches_artifact_hint');
  });

  it('fires only the truthful unresolved open-loop reason', () => {
    const c = makeCluster({
      id: 'ctx_1',
      atom_ids: [],
      open_loop_hints: [
        {
          atom_id: 'evt_a',
          kind: 'contains_todo',
          text: 'TODO: x',
          confidence: 'high',
          resolved: false,
        },
      ],
    });
    expect(rankReasonsFor(c, new Map(), QUERY)).toContain('has_unresolved_open_loop');
    expect(rankReasonsFor(c, new Map(), QUERY)).not.toContain('has_open_loop');
  });

  it('fires dense when cluster has ≥5 atoms', () => {
    const c = makeCluster({
      id: 'ctx_1',
      atom_ids: ['1', '2', '3', '4', '5'],
    });
    expect(rankReasonsFor(c, new Map(), QUERY)).toContain('dense');
  });

  it('fires cross_tool when source_breakdown has ≥3 distinct apps', () => {
    const c = makeCluster({
      id: 'ctx_1',
      atom_ids: [],
      source_breakdown: { cursor: 1, claude_code: 1, git: 1 },
    });
    expect(rankReasonsFor(c, new Map(), QUERY)).toContain('cross_tool');
  });

  it('resolved hints do not produce an open-loop signal or rank reason', () => {
    const c = makeCluster({
      id: 'ctx_resolved',
      atom_ids: [],
      open_loop_hints: [
        {
          atom_id: 'evt_a',
          kind: 'contains_todo',
          text: 'TODO: x',
          confidence: 'high',
          resolved: true,
          resolved_by_atom_id: 'evt_b',
        },
        {
          atom_id: 'evt_c',
          kind: 'ends_with_question',
          text: 'done?',
          confidence: 'high',
          resolved: true,
          resolved_by_atom_id: 'evt_d',
        },
      ],
    });
    const signals = signalsFor(c, new Map(), QUERY);
    expect(signals.has_open_loop).toBe(false);
    expect(signals.has_unresolved_open_loop).toBe(false);
    expect(rankReasonsFor(c, new Map(), QUERY)).not.toContain('has_open_loop');
    expect(rankReasonsFor(c, new Map(), QUERY)).not.toContain('has_unresolved_open_loop');
  });

  it('fires has_unresolved_open_loop and code_session_anchor via three source apps', () => {
    const c = makeCluster({
      id: 'ctx_cross_tool',
      atom_ids: [],
      source_breakdown: { cursor: 1, claude_code: 1, codex: 1 },
      open_loop_hints: [
        {
          atom_id: 'evt_a',
          kind: 'contains_todo',
          text: 'TODO: x',
          confidence: 'high',
          resolved: false,
        },
      ],
    });
    const signals = signalsFor(c, new Map(), QUERY);
    const reasons = rankReasonsFor(c, new Map(), QUERY);
    expect(signals.has_unresolved_open_loop).toBe(true);
    expect(signals.code_session_anchor).toBe(true);
    expect(reasons).toContain('has_unresolved_open_loop');
    expect(reasons).toContain('code_session_anchor');
  });

  it('fires code_session_anchor from repo/file/commit anchor artifact type', () => {
    const c = makeCluster({
      id: 'ctx_file_anchor',
      atom_ids: [],
      source_breakdown: { codex: 1 },
      anchor_artifacts: [{ provider: 'local_fs', type: 'file', id: '/repo/src/app.ts' }],
      open_loop_hints: [
        {
          atom_id: 'evt_a',
          kind: 'contains_todo',
          text: 'TODO: x',
          confidence: 'high',
          resolved: false,
        },
      ],
    });
    expect(signalsFor(c, new Map(), QUERY).code_session_anchor).toBe(true);
  });

  it('fires code_session_anchor from any atom whose source.app is git', () => {
    const gitAtom = makeAtom({
      id: 'evt_git',
      app: 'git',
      occurred_at: '2026-05-06T08:30:00.000Z',
      artifacts: [],
    });
    const c = makeCluster({
      id: 'ctx_git_atom',
      atom_ids: ['evt_git'],
      source_breakdown: { codex: 1 },
      open_loop_hints: [
        {
          atom_id: 'evt_a',
          kind: 'contains_todo',
          text: 'TODO: x',
          confidence: 'high',
          resolved: false,
        },
      ],
    });
    expect(signalsFor(c, buildAtomMap([gitAtom]), QUERY).code_session_anchor).toBe(true);
  });

  it('does not treat cluster_id alone as code_session_anchor', () => {
    const c = makeCluster({
      id: 'ctx_unanchored',
      atom_ids: [],
      source_breakdown: { codex: 1 },
      open_loop_hints: [
        {
          atom_id: 'evt_a',
          kind: 'contains_todo',
          text: 'TODO: x',
          confidence: 'high',
          resolved: false,
        },
      ],
    });
    const signals = signalsFor(c, new Map(), QUERY);
    expect(signals.has_unresolved_open_loop).toBe(true);
    expect(signals.code_session_anchor).toBe(false);
  });
});

describe('rankClusters', () => {
  it('artifact_hint match dominates ordering', () => {
    const a = makeAtom({
      id: 'evt_a',
      app: 'cursor',
      occurred_at: '2026-05-06T07:00:00.000Z',
      artifacts: [{ provider: 'local_fs', type: 'file', id: 'r::a.ts' }],
    });
    const b = makeAtom({
      id: 'evt_b',
      app: 'cursor',
      occurred_at: '2026-05-06T08:30:00.000Z',
      artifacts: [{ provider: 'local_fs', type: 'file', id: 'r::b.ts' }],
    });
    const cA = makeCluster({ id: 'ctx_a', atom_ids: ['evt_a'] });
    const cB = makeCluster({ id: 'ctx_b', atom_ids: ['evt_b'] });
    const map = buildAtomMap([a, b]);
    const q: Query = {
      ...QUERY,
      artifact_hint: { provider: 'local_fs', type: 'file', id: 'r::a.ts' },
    };
    const sorted = rankClusters([cB, cA], map, q);
    expect(sorted.map((c) => c.cluster_id)).toEqual(['ctx_a', 'ctx_b']);
  });

  it('without hint: open-loop cluster ranks above non-open-loop of same size', () => {
    const a = makeAtom({
      id: 'evt_a',
      app: 'claude_code',
      occurred_at: '2026-05-06T08:30:00.000Z',
      artifacts: [],
    });
    const b = makeAtom({
      id: 'evt_b',
      app: 'cursor',
      occurred_at: '2026-05-06T08:30:00.000Z',
      artifacts: [],
    });
    const cWithLoop = makeCluster({
      id: 'ctx_loop',
      atom_ids: ['evt_a'],
      open_loop_hints: [
        {
          atom_id: 'evt_a',
          kind: 'ends_with_question',
          text: 'q?',
          confidence: 'high',
          resolved: false,
        },
      ],
    });
    const cNoLoop = makeCluster({ id: 'ctx_plain', atom_ids: ['evt_b'] });
    const sorted = rankClusters([cNoLoop, cWithLoop], buildAtomMap([a, b]), QUERY);
    expect(sorted[0]!.cluster_id).toBe('ctx_loop');
  });

  // V1.6 (item 032) AC4 — strict-partition demotion. R2-2: a per-signal
  // override (recent_activity=0) is insufficient because `hint` and
  // `openLoop` sort AHEAD of `recent` in the existing 5-key chain; the
  // demotion must be a NEW primary sort key that dominates the entire chain.
  it('demoteSingleSourceRecent=true: single-source-recent cluster sorts BELOW non-single-source-recent clusters even when its hint+openLoop+recent signals dominate (strict partition, R2-2)', () => {
    // The single-source-recent cluster has the strongest signals
    // (matches_artifact_hint=1, has_open_loop=1, recent=1, large size).
    // The two non-single-source-recent clusters have weak signals
    // (hint=0, openLoop=0, recent=0, smaller size). Under the existing
    // 5-key chain alone, the noise cluster would rank FIRST. The primary
    // partition must override and place BOTH non-single-source-recent
    // clusters AHEAD of the single-source-recent one.
    const NOW = new Date('2026-05-10T20:00:00.000Z');
    const NOW_MS = NOW.getTime();
    const RECENT_TS = new Date(NOW_MS - 60_000).toISOString(); // 1 min ago — single-source-recent
    const OLD_TS = '2026-05-10T15:00:00.000Z'; // 5h ago — old, multi-source

    // Single-source-recent noise cluster (claude_code only, 20 atoms,
    // recent timestamps). Carries the strongest rank signals.
    const noiseAtoms = Array.from({ length: 20 }, (_, i) =>
      makeAtom({
        id: `noise_${i}`,
        app: 'claude_code',
        occurred_at: RECENT_TS,
        artifacts: [{ provider: 'local_fs', type: 'file', id: 'r::hot.ts' }],
        hints: ['TODO: still working'],
      }),
    );
    const cNoise: Cluster = {
      cluster_id: 'ctx_noise',
      rank: 0,
      rank_reason: [],
      anchor_artifacts: [],
      atom_ids: noiseAtoms.map((a) => a.id),
      edges: [],
      open_loop_hints: [
        {
          atom_id: 'noise_0',
          kind: 'contains_todo',
          text: 'TODO',
          confidence: 'high',
          resolved: false,
        },
      ],
      source_breakdown: { claude_code: 20 },
      time_range: { from: RECENT_TS, to: RECENT_TS },
    };

    // Two multi-source-old clusters (prior work). Weak signals:
    // no hint, no open-loop, no recent_activity, small size (5 each).
    const workA = makeAtom({
      id: 'work_a1',
      app: 'claude_code',
      occurred_at: OLD_TS,
      artifacts: [],
    });
    const workB = makeAtom({
      id: 'work_a2',
      app: 'git',
      occurred_at: OLD_TS,
      artifacts: [],
    });
    const workC = makeAtom({
      id: 'work_b1',
      app: 'cursor',
      occurred_at: OLD_TS,
      artifacts: [],
    });
    const workD = makeAtom({
      id: 'work_b2',
      app: 'git',
      occurred_at: OLD_TS,
      artifacts: [],
    });
    const cWorkA: Cluster = {
      cluster_id: 'ctx_work_a',
      rank: 0,
      rank_reason: [],
      anchor_artifacts: [],
      atom_ids: [workA.id, workB.id],
      edges: [],
      open_loop_hints: [],
      source_breakdown: { claude_code: 1, git: 1 },
      time_range: { from: OLD_TS, to: OLD_TS },
    };
    const cWorkB: Cluster = {
      cluster_id: 'ctx_work_b',
      rank: 0,
      rank_reason: [],
      anchor_artifacts: [],
      atom_ids: [workC.id, workD.id],
      edges: [],
      open_loop_hints: [],
      source_breakdown: { cursor: 1, git: 1 },
      time_range: { from: OLD_TS, to: OLD_TS },
    };

    const map = buildAtomMap([...noiseAtoms, workA, workB, workC, workD]);
    const q: Query = {
      since: '2026-05-10T10:00:00.000Z',
      until: NOW.toISOString(),
      artifact_hint: { provider: 'local_fs', type: 'file', id: 'r::hot.ts' },
    };

    // Baseline (no demotion): noise ranks FIRST because hint+openLoop+recent
    // dominate the 5-key chain.
    const baseline = rankClusters([cWorkA, cWorkB, cNoise], map, q);
    expect(baseline[0]!.cluster_id).toBe('ctx_noise');

    // With demotion: noise sorts STRICTLY BELOW both work clusters.
    const demoted = rankClusters([cWorkA, cWorkB, cNoise], map, q, {
      demoteSingleSourceRecent: true,
      nowMs: NOW_MS,
    });
    expect(demoted[demoted.length - 1]!.cluster_id).toBe('ctx_noise');
    // Both work clusters are ahead of noise — the strict partition
    // guarantee (not just "noise dropped one rank").
    const orderedIds = demoted.map((c) => c.cluster_id);
    expect(orderedIds.indexOf('ctx_work_a')).toBeLessThan(orderedIds.indexOf('ctx_noise'));
    expect(orderedIds.indexOf('ctx_work_b')).toBeLessThan(orderedIds.indexOf('ctx_noise'));
  });

  it('demoteSingleSourceRecent=true with ONLY single-source-recent clusters: existing 5-key chain decides tiebreaker (no synthetic empty)', () => {
    // Degenerate input: every cluster is single-source-recent. The
    // partition is uniform → existing 5-key chain orders within the
    // partition. Larger cluster wins.
    const NOW = new Date('2026-05-10T20:00:00.000Z');
    const NOW_MS = NOW.getTime();
    const RECENT_TS = new Date(NOW_MS - 60_000).toISOString();

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
    const a3 = makeAtom({
      id: 'a3',
      app: 'claude_code',
      occurred_at: RECENT_TS,
      artifacts: [],
    });
    const big: Cluster = {
      cluster_id: 'ctx_big',
      rank: 0,
      rank_reason: [],
      anchor_artifacts: [],
      atom_ids: ['a1', 'a2', 'a3'],
      edges: [],
      open_loop_hints: [],
      source_breakdown: { claude_code: 3 },
      time_range: { from: RECENT_TS, to: RECENT_TS },
    };
    const small: Cluster = {
      ...big,
      cluster_id: 'ctx_small',
      atom_ids: ['a1'],
      source_breakdown: { claude_code: 1 },
    };
    const q: Query = {
      since: '2026-05-10T10:00:00.000Z',
      until: NOW.toISOString(),
    };
    const sorted = rankClusters([small, big], buildAtomMap([a1, a2, a3]), q, {
      demoteSingleSourceRecent: true,
      nowMs: NOW_MS,
    });
    // Both single-source-recent — partition uniform. Larger wins.
    expect(sorted.map((c) => c.cluster_id)).toEqual(['ctx_big', 'ctx_small']);
  });

  it('ties: larger cluster ranks higher', () => {
    const ts = '2026-05-06T08:30:00.000Z';
    const atoms = [
      makeAtom({
        id: 'a1',
        app: 'cursor',
        occurred_at: ts,
        artifacts: [],
      }),
      makeAtom({
        id: 'a2',
        app: 'cursor',
        occurred_at: ts,
        artifacts: [],
      }),
      makeAtom({
        id: 'a3',
        app: 'cursor',
        occurred_at: ts,
        artifacts: [],
      }),
      makeAtom({
        id: 'b1',
        app: 'cursor',
        occurred_at: ts,
        artifacts: [],
      }),
    ];
    const big = makeCluster({ id: 'ctx_big', atom_ids: ['a1', 'a2', 'a3'] });
    const small = makeCluster({ id: 'ctx_small', atom_ids: ['b1'] });
    const sorted = rankClusters([small, big], buildAtomMap(atoms), QUERY);
    expect(sorted[0]!.cluster_id).toBe('ctx_big');
  });
});
