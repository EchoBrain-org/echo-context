import { describe, expect, it } from 'vitest';
import {
  artifactKey,
  buildGraph,
  connectedComponents,
  filterRedundantEdges,
} from '../../src/trace/cluster.js';
import type { Edge } from '../../src/trace/types.js';
import { makeAtom, type AtomSpec } from './fixtures/atoms.js';

describe('artifactKey', () => {
  it('joins provider:type:id', () => {
    expect(
      artifactKey({ provider: 'local_fs', type: 'file', id: 'abc' }),
    ).toBe('local_fs:file:abc');
  });
});

describe('buildGraph + connectedComponents', () => {
  it('returns empty graph and zero clusters for empty input', () => {
    const g = buildGraph([]);
    expect(g.nodes).toEqual([]);
    expect(g.edges).toEqual([]);
    expect(connectedComponents(g)).toEqual([]);
  });

  it('single atom forms a single cluster with no edges', () => {
    const a = makeAtom({
      id: 'evt_001',
      app: 'cursor',
      occurred_at: '2026-05-06T10:00:00.000Z',
      artifacts: [{ provider: 'local_fs', type: 'file', id: 'r::a.ts' }],
    });
    const g = buildGraph([a]);
    expect(g.nodes).toEqual(['evt_001']);
    expect(g.edges).toEqual([]);
    const cs = connectedComponents(g);
    expect(cs).toHaveLength(1);
    expect(cs[0]!.atom_ids).toEqual(['evt_001']);
  });

  it('two atoms sharing an artifact within window form one cluster with one edge', () => {
    const a = makeAtom({
      id: 'evt_001',
      app: 'cursor',
      occurred_at: '2026-05-06T10:00:00.000Z',
      artifacts: [{ provider: 'local_fs', type: 'file', id: 'r::a.ts' }],
    });
    const b = makeAtom({
      id: 'evt_002',
      app: 'claude_code',
      occurred_at: '2026-05-06T10:30:00.000Z',
      artifacts: [{ provider: 'local_fs', type: 'file', id: 'r::a.ts' }],
    });
    const g = buildGraph([a, b], 4);
    expect(g.edges).toHaveLength(1);
    expect(g.edges[0]).toMatchObject({
      from: 'evt_001',
      to: 'evt_002',
      kind: 'shared_artifact',
      artifact_ids: ['local_fs:file:r::a.ts'],
      confidence: 'high',
    });
    const cs = connectedComponents(g);
    expect(cs).toHaveLength(1);
    expect(cs[0]!.atom_ids).toEqual(['evt_001', 'evt_002']);
  });

  it('two atoms 5h apart sharing an artifact get NO edge with default 4h window', () => {
    const a = makeAtom({
      id: 'evt_001',
      app: 'cursor',
      occurred_at: '2026-05-06T05:00:00.000Z',
      artifacts: [{ provider: 'local_fs', type: 'file', id: 'r::a.ts' }],
    });
    const b = makeAtom({
      id: 'evt_002',
      app: 'cursor',
      occurred_at: '2026-05-06T10:01:00.000Z',
      artifacts: [{ provider: 'local_fs', type: 'file', id: 'r::a.ts' }],
    });
    const g = buildGraph([a, b], 4);
    expect(g.edges).toEqual([]);
    const cs = connectedComponents(g);
    // disjoint → 2 clusters
    expect(cs).toHaveLength(2);
  });

  it('window_hours is configurable: 6h includes the 5h-apart pair', () => {
    const a = makeAtom({
      id: 'evt_001',
      app: 'cursor',
      occurred_at: '2026-05-06T05:00:00.000Z',
      artifacts: [{ provider: 'local_fs', type: 'file', id: 'r::a.ts' }],
    });
    const b = makeAtom({
      id: 'evt_002',
      app: 'cursor',
      occurred_at: '2026-05-06T10:00:00.000Z',
      artifacts: [{ provider: 'local_fs', type: 'file', id: 'r::a.ts' }],
    });
    const g = buildGraph([a, b], 6);
    expect(g.edges).toHaveLength(1);
  });

  it('atoms with no shared artifacts produce disjoint clusters', () => {
    const a = makeAtom({
      id: 'evt_001',
      app: 'cursor',
      occurred_at: '2026-05-06T10:00:00.000Z',
      artifacts: [{ provider: 'local_fs', type: 'file', id: 'r::a.ts' }],
    });
    const b = makeAtom({
      id: 'evt_002',
      app: 'cursor',
      occurred_at: '2026-05-06T10:30:00.000Z',
      artifacts: [{ provider: 'local_fs', type: 'file', id: 'r::b.ts' }],
    });
    const g = buildGraph([a, b]);
    expect(g.edges).toEqual([]);
    expect(connectedComponents(g)).toHaveLength(2);
  });

  it('atoms with empty artifacts arrays form singleton clusters', () => {
    const a = makeAtom({
      id: 'evt_001',
      app: 'cursor',
      occurred_at: '2026-05-06T10:00:00.000Z',
      artifacts: [],
    });
    const b = makeAtom({
      id: 'evt_002',
      app: 'claude_code',
      occurred_at: '2026-05-06T10:01:00.000Z',
      artifacts: [],
    });
    const g = buildGraph([a, b]);
    expect(g.edges).toEqual([]);
    expect(connectedComponents(g)).toHaveLength(2);
  });

  it('three atoms in a chain via shared file form one cluster', () => {
    const a = makeAtom({
      id: 'evt_a',
      app: 'cursor',
      occurred_at: '2026-05-06T08:00:00.000Z',
      artifacts: [{ provider: 'local_fs', type: 'file', id: 'r::a.ts' }],
    });
    const b = makeAtom({
      id: 'evt_b',
      app: 'claude_code',
      occurred_at: '2026-05-06T08:30:00.000Z',
      artifacts: [
        { provider: 'local_fs', type: 'file', id: 'r::a.ts' },
        { provider: 'local_fs', type: 'file', id: 'r::b.ts' },
      ],
    });
    const c = makeAtom({
      id: 'evt_c',
      app: 'claude_code',
      occurred_at: '2026-05-06T09:00:00.000Z',
      artifacts: [
        { provider: 'local_fs', type: 'file', id: 'r::b.ts' },
      ],
    });
    const g = buildGraph([a, b, c], 4);
    expect(g.edges).toHaveLength(2);
    const cs = connectedComponents(g);
    expect(cs).toHaveLength(1);
    expect(cs[0]!.atom_ids).toEqual(['evt_a', 'evt_b', 'evt_c']);
    expect(cs[0]!.edges).toHaveLength(2);
  });

  it('two disjoint pairs form two distinct clusters', () => {
    const a = makeAtom({
      id: 'evt_a',
      app: 'cursor',
      occurred_at: '2026-05-06T08:00:00.000Z',
      artifacts: [{ provider: 'local_fs', type: 'file', id: 'r::x.ts' }],
    });
    const b = makeAtom({
      id: 'evt_b',
      app: 'cursor',
      occurred_at: '2026-05-06T08:30:00.000Z',
      artifacts: [{ provider: 'local_fs', type: 'file', id: 'r::x.ts' }],
    });
    const c = makeAtom({
      id: 'evt_c',
      app: 'cursor',
      occurred_at: '2026-05-06T09:00:00.000Z',
      artifacts: [{ provider: 'local_fs', type: 'file', id: 'r::y.ts' }],
    });
    const d = makeAtom({
      id: 'evt_d',
      app: 'cursor',
      occurred_at: '2026-05-06T09:30:00.000Z',
      artifacts: [{ provider: 'local_fs', type: 'file', id: 'r::y.ts' }],
    });
    const g = buildGraph([a, b, c, d]);
    const cs = connectedComponents(g);
    expect(cs).toHaveLength(2);
    expect(cs.map((c) => c.atom_ids)).toEqual([
      ['evt_a', 'evt_b'],
      ['evt_c', 'evt_d'],
    ]);
  });

  it('multiple shared artifacts between two atoms produces one edge with merged artifact_ids', () => {
    const a = makeAtom({
      id: 'evt_a',
      app: 'cursor',
      occurred_at: '2026-05-06T08:00:00.000Z',
      artifacts: [
        { provider: 'local_fs', type: 'file', id: 'r::a.ts' },
        { provider: 'local_fs', type: 'file', id: 'r::b.ts' },
      ],
    });
    const b = makeAtom({
      id: 'evt_b',
      app: 'cursor',
      occurred_at: '2026-05-06T08:30:00.000Z',
      artifacts: [
        { provider: 'local_fs', type: 'file', id: 'r::a.ts' },
        { provider: 'local_fs', type: 'file', id: 'r::b.ts' },
      ],
    });
    const g = buildGraph([a, b]);
    expect(g.edges).toHaveLength(1);
    expect(g.edges[0]!.artifact_ids).toEqual([
      'local_fs:file:r::a.ts',
      'local_fs:file:r::b.ts',
    ]);
  });

  it('uses a bounded spanning tree for a dense shared-artifact graph', () => {
    const atoms = Array.from({ length: 1_000 }, (_, index) =>
      makeAtom({
        id: `dense-${String(index).padStart(4, '0')}`,
        app: 'cursor',
        occurred_at: '2026-05-06T08:00:00.000Z',
        artifacts: [{ provider: 'local_fs', type: 'file', id: 'shared.ts' }],
      }),
    );
    const graph = buildGraph(atoms);
    expect(graph.edges).toHaveLength(999);
    expect(graph.edges.length).toBeLessThan(graph.nodes.length);
    expect(connectedComponents(graph)).toHaveLength(1);
  });
});

describe('filterRedundantEdges (V1.5 trace edge-filter)', () => {
  function edge(
    from: string,
    to: string,
    artifact_ids: string[],
  ): Edge {
    return { from, to, kind: 'shared_artifact', artifact_ids, confidence: 'high' };
  }

  it('drops an edge whose only shared artifact is a repo (scope role)', () => {
    const e = edge('a', 'b', ['local:repo:r1']);
    expect(filterRedundantEdges([e])).toEqual([]);
  });

  it('drops an edge whose only shared artifact is a conversation (session role)', () => {
    const e = edge('a', 'b', ['claude_code:conversation:s1']);
    expect(filterRedundantEdges([e])).toEqual([]);
  });

  it('drops an edge sharing only repo + conversation (scope+session)', () => {
    const e = edge('a', 'b', [
      'local:repo:r1',
      'claude_code:conversation:s1',
    ]);
    expect(filterRedundantEdges([e])).toEqual([]);
  });

  it('keeps an edge with at least one work-role artifact', () => {
    const e = edge('a', 'b', ['local_fs:file:r::a.ts']);
    expect(filterRedundantEdges([e])).toEqual([e]);
  });

  it('keeps a mixed edge (work + scope) and does NOT trim artifact_ids', () => {
    const e = edge('a', 'b', [
      'local:repo:r1',
      'local_fs:file:r::a.ts',
      'claude_code:conversation:s1',
    ]);
    const out = filterRedundantEdges([e]);
    expect(out).toHaveLength(1);
    expect(out[0]!.artifact_ids).toEqual(e.artifact_ids); // full retention
  });

  it('keeps edges whose artifact type is unknown — generalizability default', () => {
    const e = edge('a', 'b', ['salesforce:opportunity:opp_123']);
    expect(filterRedundantEdges([e])).toEqual([e]);
  });

  it('keeps an edge with empty artifact_ids (degenerate case — no role to drop on)', () => {
    const e = edge('a', 'b', []);
    expect(filterRedundantEdges([e])).toEqual([e]);
  });

  it('end-to-end: scope/session artifacts never enter membership', () => {
    const specs: AtomSpec[] = [];
    const baseTs = Date.parse('2026-05-06T08:00:00.000Z');
    for (let i = 0; i < 5; i++) {
      specs.push({
        id: `evt_${i}`,
        app: 'claude_code',
        occurred_at: new Date(baseTs + i * 60 * 1000).toISOString(),
        artifacts: [
          { provider: 'local', type: 'repo', id: 'local:/echo' },
          { provider: 'claude_code', type: 'conversation', id: 'claude_code:s1' },
        ],
      });
    }
    const atoms = specs.map(makeAtom);
    const g = buildGraph(atoms, 4);
    expect(g.edges).toEqual([]);
    expect(connectedComponents(g)).toHaveLength(5);
    const filtered = filterRedundantEdges(g.edges);
    expect(filtered).toEqual([]);
  });

  it('end-to-end: K_5 sharing repo+conversation+one-shared-file keeps only file-sharing pairs', () => {
    // 5 atoms; atoms 0 and 1 also share a specific file. The only edge with a
    // work-role artifact should be the (0, 1) pair after filtering.
    const baseTs = Date.parse('2026-05-06T08:00:00.000Z');
    const commonArtifacts = [
      { provider: 'local', type: 'repo', id: 'local:/echo' },
      { provider: 'claude_code', type: 'conversation', id: 'claude_code:s1' },
    ];
    const specs: AtomSpec[] = [];
    for (let i = 0; i < 5; i++) {
      const arts = [...commonArtifacts];
      if (i === 0 || i === 1) {
        arts.push({ provider: 'local_fs', type: 'file', id: 'r::a.ts' });
      }
      specs.push({
        id: `evt_${i}`,
        app: 'claude_code',
        occurred_at: new Date(baseTs + i * 60 * 1000).toISOString(),
        artifacts: arts,
      });
    }
    const atoms = specs.map(makeAtom);
    const g = buildGraph(atoms, 4);
    const filtered = filterRedundantEdges(g.edges);
    expect(filtered).toHaveLength(1);
    expect(filtered[0]!.from).toBe('evt_0');
    expect(filtered[0]!.to).toBe('evt_1');
    expect(filtered[0]!.artifact_ids).toContain('local_fs:file:r::a.ts');
  });
});
