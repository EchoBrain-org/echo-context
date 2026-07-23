import { describe, expect, it } from 'vitest';
import type { CaptureEvent } from '../../src/storage/interface.js';
import type { NormalizedContextEvent } from '../../src/normalize/types.js';
import { buildRecentWorkContext } from '../../src/trace/index.js';
import { roleOf } from '../../src/trace/role.js';
import type { Query } from '../../src/trace/types.js';
import { makeAtom, type AtomSpec } from './fixtures/atoms.js';

// An ArtifactKey is `${provider}:${type}:${id}` where id may itself contain
// colons. Mirror the parser used in src/trace/cluster.ts.
function typeFromArtifactKey(key: string): string {
  const first = key.indexOf(':');
  if (first < 0) return '';
  const second = key.indexOf(':', first + 1);
  if (second < 0) return key.slice(first + 1);
  return key.slice(first + 1, second);
}

function asCapture(specs: AtomSpec[]): {
  events: CaptureEvent[];
  normalize: (e: CaptureEvent) => NormalizedContextEvent | null;
} {
  const map = new Map<string, NormalizedContextEvent>();
  const events: CaptureEvent[] = [];
  for (const s of specs) {
    map.set(s.id, makeAtom(s));
    events.push({
      id: s.id,
      source: `fixture:${s.app}`,
      timestamp: s.occurred_at,
      content: '',
    });
  }
  const normalize = (e: CaptureEvent): NormalizedContextEvent | null =>
    map.get(e.id) ?? null;
  return { events, normalize };
}

const QUERY: Query = {
  since: '2026-05-06T05:00:00.000Z',
  until: '2026-05-06T09:00:00.000Z',
};

describe('buildRecentWorkContext', () => {
  it('returns valid response shape with empty input', () => {
    const { events, normalize } = asCapture([]);
    const r = buildRecentWorkContext(events, QUERY, normalize);
    expect(r.schema_version).toBe(1);
    expect(r.tool).toBe('get_recent_work_context');
    expect(r.clusters).toEqual([]);
    expect(r.atoms).toEqual({});
    expect(r.truncation).toEqual({
      atoms_returned: 0,
      atoms_total_in_window: 0,
      clusters_returned: 0,
      clusters_total: 0,
      truncated: false,
      // Item 029: window-wide source_breakdown is always present, empty when
      // there are no atoms in window.
      source_breakdown: {},
    });
    expect(r.warnings).toEqual([]);
    expect(r.query).toEqual({
      since: QUERY.since,
      until: QUERY.until,
      artifact_hint: null,
      format: 'full',
      window_hours: 4,
      repo_path: null,
    });
  });

  it('does not exhaust a graph budget for dense scope-only activity', () => {
    const { events, normalize } = asCapture(
      Array.from({ length: 1_000 }, (_, index) => ({
        id: `dense-${String(index).padStart(4, '0')}`,
        app: 'cursor',
        occurred_at: '2026-05-06T08:00:00.000Z',
        artifacts: [{ provider: 'local_fs', type: 'file', id: 'shared.ts' }],
      })),
    );
    const response = buildRecentWorkContext(
      events,
      { ...QUERY, limit: 1_000 },
      normalize,
    );
    expect(response.truncation.truncated).toBe(false);
    expect(response.warnings.some((warning) => warning.startsWith('[GRAPH_BUDGET]'))).toBe(
      false,
    );
  });

  it('drops atoms with timestamps outside since/until window', () => {
    const { events, normalize } = asCapture([
      {
        id: 'inside_a',
        app: 'cursor',
        occurred_at: '2026-05-06T07:00:00.000Z',
        artifacts: [{ provider: 'local_fs', type: 'file', id: 'r::a.ts' }],
      },
      {
        id: 'inside_b',
        app: 'cursor',
        occurred_at: '2026-05-06T08:00:00.000Z',
        artifacts: [{ provider: 'local_fs', type: 'file', id: 'r::a.ts' }],
      },
      {
        id: 'before',
        app: 'cursor',
        occurred_at: '2026-05-06T04:00:00.000Z',
        artifacts: [],
      },
      {
        id: 'after',
        app: 'cursor',
        occurred_at: '2026-05-06T10:00:00.000Z',
        artifacts: [],
      },
    ]);
    const r = buildRecentWorkContext(events, QUERY, normalize);
    expect(r.truncation.atoms_total_in_window).toBe(2);
    expect(r.clusters).toHaveLength(1);
    expect(r.clusters[0]!.atom_ids).toEqual(['inside_a', 'inside_b']);
  });

  it('cluster_id is deterministic for same atom set', () => {
    const specs: AtomSpec[] = [
      {
        id: 'a',
        app: 'cursor',
        occurred_at: '2026-05-06T08:00:00.000Z',
        artifacts: [{ provider: 'local_fs', type: 'file', id: 'r::x.ts' }],
      },
      {
        id: 'b',
        app: 'cursor',
        occurred_at: '2026-05-06T08:30:00.000Z',
        artifacts: [{ provider: 'local_fs', type: 'file', id: 'r::x.ts' }],
      },
    ];
    const r1 = buildRecentWorkContext(
      asCapture(specs).events,
      QUERY,
      asCapture(specs).normalize,
    );
    const r2 = buildRecentWorkContext(
      asCapture(specs).events,
      QUERY,
      asCapture(specs).normalize,
    );
    expect(r1.clusters[0]!.cluster_id).toBe(r2.clusters[0]!.cluster_id);
    expect(r1.clusters[0]!.cluster_id).toMatch(/^ctx_[0-9a-f]{8}$/);
  });

  it('atoms are returned inline keyed by id', () => {
    const { events, normalize } = asCapture([
      {
        id: 'a',
        app: 'cursor',
        occurred_at: '2026-05-06T08:00:00.000Z',
        artifacts: [{ provider: 'local_fs', type: 'file', id: 'r::x.ts' }],
      },
      {
        id: 'b',
        app: 'cursor',
        occurred_at: '2026-05-06T08:30:00.000Z',
        artifacts: [{ provider: 'local_fs', type: 'file', id: 'r::x.ts' }],
      },
    ]);
    const r = buildRecentWorkContext(events, QUERY, normalize);
    expect(Object.keys(r.atoms).sort()).toEqual(['a', 'b']);
    expect(r.atoms['a']!.id).toBe('a');
  });

  it('artifact_hint filters to clusters that touch it', () => {
    const { events, normalize } = asCapture([
      {
        id: 'a1',
        app: 'cursor',
        occurred_at: '2026-05-06T07:00:00.000Z',
        artifacts: [{ provider: 'local_fs', type: 'file', id: 'r::hinted.ts' }],
      },
      {
        id: 'a2',
        app: 'cursor',
        occurred_at: '2026-05-06T07:30:00.000Z',
        artifacts: [{ provider: 'local_fs', type: 'file', id: 'r::hinted.ts' }],
      },
      {
        id: 'b1',
        app: 'cursor',
        occurred_at: '2026-05-06T08:00:00.000Z',
        artifacts: [{ provider: 'local_fs', type: 'file', id: 'r::other.ts' }],
      },
      {
        id: 'b2',
        app: 'cursor',
        occurred_at: '2026-05-06T08:30:00.000Z',
        artifacts: [{ provider: 'local_fs', type: 'file', id: 'r::other.ts' }],
      },
    ]);
    const q: Query = {
      ...QUERY,
      artifact_hint: { provider: 'local_fs', type: 'file', id: 'r::hinted.ts' },
    };
    const r = buildRecentWorkContext(events, q, normalize);
    expect(r.clusters).toHaveLength(1);
    expect(r.clusters[0]!.atom_ids.sort()).toEqual(['a1', 'a2']);
    expect(r.clusters[0]!.rank_reason).toContain('matches_artifact_hint');
  });

  it('truncates atoms when total exceeds limit; sets truncated=true', () => {
    const specs: AtomSpec[] = [];
    for (let i = 0; i < 10; i++) {
      specs.push({
        id: `evt_${i}`,
        app: 'cursor',
        occurred_at: `2026-05-06T08:${String(i).padStart(2, '0')}:00.000Z`,
        artifacts: [{ provider: 'local_fs', type: 'file', id: 'r::shared.ts' }],
      });
    }
    const { events, normalize } = asCapture(specs);
    const r = buildRecentWorkContext(events, { ...QUERY, limit: 5 }, normalize);
    expect(r.truncation.truncated).toBe(true);
    expect(r.truncation.atoms_returned).toBe(5);
    expect(r.truncation.atoms_total_in_window).toBe(10);
    // Single-cluster truncation does not drop a whole cluster — no warning.
    expect(
      r.warnings.some((w) => w.includes('limit dropped') && w.includes('cluster')),
    ).toBe(false);
  });

  it('emits a warning when limit drops entire clusters', () => {
    // Three disjoint clusters (no shared artifacts), 4 atoms each → 12 total.
    // Limit=5 forces the lowest-rank cluster to drop entirely.
    const specs: AtomSpec[] = [];
    const files = ['r::a.ts', 'r::b.ts', 'r::c.ts'];
    files.forEach((file, threadIdx) => {
      for (let i = 0; i < 4; i++) {
        specs.push({
          id: `t${threadIdx}_${i}`,
          app: 'cursor',
          occurred_at: `2026-05-06T0${threadIdx + 6}:${String(i * 5).padStart(2, '0')}:00.000Z`,
          artifacts: [{ provider: 'local_fs', type: 'file', id: file }],
        });
      }
    });
    const { events, normalize } = asCapture(specs);
    const r = buildRecentWorkContext(events, { ...QUERY, limit: 5 }, normalize);
    expect(r.truncation.clusters_total).toBe(3);
    expect(r.truncation.clusters_returned).toBeLessThan(3);
    const dropped = r.truncation.clusters_total - r.truncation.clusters_returned;
    expect(
      r.warnings.some(
        (w) => w.includes(`dropped ${dropped} entire cluster`) && w.includes('limit'),
      ),
    ).toBe(true);
  });

  it('roundtrips through JSON.parse/stringify without loss', () => {
    const { events, normalize } = asCapture([
      {
        id: 'a',
        app: 'cursor',
        occurred_at: '2026-05-06T08:00:00.000Z',
        artifacts: [
          { provider: 'local_fs', type: 'file', id: 'r::x.ts', label: 'x.ts' },
        ],
        verb: 'edit',
      },
      {
        id: 'b',
        app: 'cursor',
        occurred_at: '2026-05-06T08:30:00.000Z',
        artifacts: [
          { provider: 'local_fs', type: 'file', id: 'r::x.ts', label: 'x.ts' },
        ],
        verb: 'edit',
      },
    ]);
    const r = buildRecentWorkContext(events, QUERY, normalize);
    const parsed = JSON.parse(JSON.stringify(r));
    expect(parsed).toEqual(r);
  });

  it('end-to-end: 3 separate work threads produce 3 clusters with rank 1..3', () => {
    const { events, normalize } = asCapture([
      // Thread 1: shared types.ts
      {
        id: 't1_a',
        app: 'claude_code',
        occurred_at: '2026-05-06T08:00:00.000Z',
        artifacts: [
          { provider: 'local_fs', type: 'file', id: 'r::types.ts', label: 'types.ts' },
        ],
        verb: 'message',
      },
      {
        id: 't1_b',
        app: 'cursor',
        occurred_at: '2026-05-06T08:30:00.000Z',
        artifacts: [
          { provider: 'local_fs', type: 'file', id: 'r::types.ts', label: 'types.ts' },
        ],
        verb: 'edit',
      },
      // Thread 2: shared sqlite.ts (older)
      {
        id: 't2_a',
        app: 'cursor',
        occurred_at: '2026-05-06T05:30:00.000Z',
        artifacts: [
          { provider: 'local_fs', type: 'file', id: 'r::sqlite.ts', label: 'sqlite.ts' },
        ],
        verb: 'edit',
      },
      {
        id: 't2_b',
        app: 'cursor',
        occurred_at: '2026-05-06T06:00:00.000Z',
        artifacts: [
          { provider: 'local_fs', type: 'file', id: 'r::sqlite.ts', label: 'sqlite.ts' },
        ],
        verb: 'edit',
      },
      // Thread 3: lone atom (singleton)
      {
        id: 't3_a',
        app: 'git',
        occurred_at: '2026-05-06T07:00:00.000Z',
        artifacts: [{ provider: 'local', type: 'repo', id: 'local:/echo' }],
        verb: 'commit',
      },
    ]);
    const r = buildRecentWorkContext(events, QUERY, normalize);
    expect(r.clusters).toHaveLength(3);
    expect(r.clusters.map((c) => c.rank)).toEqual([1, 2, 3]);
  });

  it('survives a normalizer that throws on some events; surfaces deduped warnings', () => {
    const { events: goodEvents, normalize: goodNormalize } = asCapture([
      {
        id: 'good_1',
        app: 'cursor',
        occurred_at: '2026-05-06T06:00:00.000Z',
        artifacts: [{ provider: 'local_fs', type: 'file', id: 'r::a.ts' }],
      },
      {
        id: 'good_2',
        app: 'cursor',
        occurred_at: '2026-05-06T06:30:00.000Z',
        artifacts: [{ provider: 'local_fs', type: 'file', id: 'r::a.ts' }],
      },
    ]);
    const failingEvents: CaptureEvent[] = [
      {
        id: 'bad_1',
        source: 'fixture:cursor',
        timestamp: '2026-05-06T06:15:00.000Z',
        content: '',
      },
      {
        id: 'bad_2',
        source: 'fixture:cursor',
        timestamp: '2026-05-06T06:45:00.000Z',
        content: '',
      },
      {
        id: 'bad_distinct',
        source: 'fixture:cursor',
        timestamp: '2026-05-06T07:00:00.000Z',
        content: '',
      },
    ];
    const normalize = (e: CaptureEvent): NormalizedContextEvent | null => {
      if (e.id === 'bad_1' || e.id === 'bad_2') throw new Error('shared boom');
      if (e.id === 'bad_distinct') throw new Error('distinct boom');
      return goodNormalize(e);
    };
    const r = buildRecentWorkContext(
      [...goodEvents, ...failingEvents],
      QUERY,
      normalize,
    );
    // Good events still cluster.
    expect(r.clusters.length).toBeGreaterThan(0);
    expect(r.truncation.atoms_total_in_window).toBe(2);
    // Warnings dedupe by message: shared boom (2×) collapses; distinct boom is its own entry.
    expect(r.warnings).toHaveLength(2);
    expect(r.warnings.some((w) => w.includes('shared boom') && w.includes('2×'))).toBe(
      true,
    );
    expect(r.warnings.some((w) => w.includes('distinct boom') && w.includes('1 event'))).toBe(
      true,
    );
  });

  it('performance: 500 atoms processed in <500ms', () => {
    const specs: AtomSpec[] = [];
    const baseTs = Date.parse('2026-05-06T05:00:00.000Z');
    for (let i = 0; i < 500; i++) {
      // Distribute across 5 shared files; each file gets ~100 atoms within window
      const fileId = `r::file_${i % 5}.ts`;
      specs.push({
        id: `evt_${i}`,
        app: i % 2 === 0 ? 'cursor' : 'claude_code',
        occurred_at: new Date(baseTs + i * 1000).toISOString(),
        artifacts: [{ provider: 'local_fs', type: 'file', id: fileId }],
      });
    }
    const { events, normalize } = asCapture(specs);
    const start = performance.now();
    const r = buildRecentWorkContext(
      events,
      { ...QUERY, limit: 500 },
      normalize,
    );
    const elapsed = performance.now() - start;
    expect(r.clusters.length).toBeGreaterThan(0);
    expect(elapsed).toBeLessThan(500);
  });

  describe('V1.5 trace edge-filter (item 019)', () => {
    it('every retained edge has at least one work-role or unknown-role artifact', () => {
      // Mixed cluster: same repo + same conversation; some pairs additionally
      // share a specific file. After filter, only pairs with the file edge
      // should survive — and every retained edge should carry a non-scope,
      // non-session artifact.
      const baseTs = Date.parse('2026-05-06T08:00:00.000Z');
      const specs: AtomSpec[] = [];
      for (let i = 0; i < 6; i++) {
        const arts = [
          { provider: 'local', type: 'repo', id: 'local:/echo' },
          { provider: 'claude_code', type: 'conversation', id: 'claude_code:s1' },
        ];
        if (i < 3) {
          arts.push({ provider: 'local_fs', type: 'file', id: 'r::shared.ts' });
        }
        specs.push({
          id: `evt_${i}`,
          app: 'claude_code',
          occurred_at: new Date(baseTs + i * 60 * 1000).toISOString(),
          artifacts: arts,
        });
      }
      const { events, normalize } = asCapture(specs);
      const r = buildRecentWorkContext(events, QUERY, normalize);
      expect(r.clusters).toHaveLength(4);
      const cluster = r.clusters.find((candidate) => candidate.atom_ids.length === 3)!;
      expect(cluster.atom_ids).toEqual(['evt_0', 'evt_1', 'evt_2']);
      for (const edge of cluster.edges) {
        const hasSignal = edge.artifact_ids.some((key) => {
          const role = roleOf(typeFromArtifactKey(key));
          return role === 'work' || role === 'unknown';
        });
        expect(hasSignal).toBe(true);
      }
      // The 3 file-sharing atoms use a two-edge spanning tree.
      expect(cluster.edges).toHaveLength(2);
    });

    it('scope and generic session artifacts do not create thread membership', () => {
      const baseTs = Date.parse('2026-05-06T08:00:00.000Z');
      const specs: AtomSpec[] = [];
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
      const { events, normalize } = asCapture(specs);
      const r = buildRecentWorkContext(events, QUERY, normalize);
      expect(r.clusters).toHaveLength(5);
      expect(r.clusters.every((cluster) => cluster.atom_ids.length === 1)).toBe(true);
      expect(r.clusters.every((cluster) => cluster.edges.length === 0)).toBe(true);
    });

    it('format defaults to "full" and is echoed in query', () => {
      const { events, normalize } = asCapture([]);
      const r = buildRecentWorkContext(events, QUERY, normalize);
      expect(r.query.format).toBe('full');
    });

    it('format echoes the request value (minimal)', () => {
      const { events, normalize } = asCapture([]);
      const r = buildRecentWorkContext(
        events,
        { ...QUERY, format: 'minimal' },
        normalize,
      );
      expect(r.query.format).toBe('minimal');
    });
  });

  describe('V1 trace patch — open-loop resolution heuristics (item 020)', () => {
    it('enriched hints in cluster.open_loop_hints[] carry resolved + resolved_by_atom_id fields', () => {
      const { events, normalize } = asCapture([
        {
          id: 'evt_q',
          app: 'claude_code',
          occurred_at: '2026-05-06T08:00:00.000Z',
          artifacts: [
            { provider: 'local_fs', type: 'file', id: 'r::x.ts' },
            { provider: 'claude_code', type: 'conversation', id: 'claude_code:s1' },
          ],
          input: 'should I refactor it?',
          output: '',
          hints: ['ends_with_question'],
        },
        {
          id: 'evt_ans',
          app: 'claude_code',
          occurred_at: '2026-05-06T08:01:00.000Z',
          artifacts: [
            { provider: 'local_fs', type: 'file', id: 'r::x.ts' },
            { provider: 'claude_code', type: 'conversation', id: 'claude_code:s1' },
          ],
          input: 'sure go ahead',
          output: 'will do.',
        },
      ]);
      const r = buildRecentWorkContext(events, QUERY, normalize);
      expect(r.clusters).toHaveLength(1);
      const hints = r.clusters[0]!.open_loop_hints;
      expect(hints).toHaveLength(1);
      expect(hints[0]!.resolved).toBe(true);
      expect(hints[0]!.resolved_by_atom_id).toBe('evt_ans');
    });

    it('at least one resolved hint and one unresolved hint coexist in the same cluster on a fixture mixing closed and open loops', () => {
      const { events, normalize } = asCapture([
        // Closed loop: question + later non-question reply, same conversation.
        {
          id: 'evt_q_closed',
          app: 'claude_code',
          occurred_at: '2026-05-06T08:00:00.000Z',
          artifacts: [
            { provider: 'local_fs', type: 'file', id: 'r::shared.ts' },
            { provider: 'claude_code', type: 'conversation', id: 'claude_code:s1' },
          ],
          input: 'should I refactor it?',
          output: '',
          hints: ['ends_with_question'],
        },
        {
          id: 'evt_ans_closed',
          app: 'claude_code',
          occurred_at: '2026-05-06T08:01:00.000Z',
          artifacts: [
            { provider: 'local_fs', type: 'file', id: 'r::shared.ts' },
            { provider: 'claude_code', type: 'conversation', id: 'claude_code:s1' },
          ],
          input: 'yes go ahead',
          output: 'will do.',
        },
        // Open loop: explicit_followup, never resolves per R1.FU.
        {
          id: 'evt_open_fu',
          app: 'claude_code',
          occurred_at: '2026-05-06T08:02:00.000Z',
          artifacts: [
            { provider: 'local_fs', type: 'file', id: 'r::shared.ts' },
            { provider: 'claude_code', type: 'conversation', id: 'claude_code:s1' },
          ],
          input: 'we will follow up next week',
          output: '',
          hints: ['explicit_followup'],
        },
      ]);
      const r = buildRecentWorkContext(events, QUERY, normalize);
      expect(r.clusters).toHaveLength(1);
      const hints = r.clusters[0]!.open_loop_hints;
      const closed = hints.filter((h) => h.resolved);
      const open = hints.filter((h) => !h.resolved);
      expect(closed.length).toBeGreaterThanOrEqual(1);
      expect(open.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('V1.5 cross-gap (item 021)', () => {
    it('atoms returned to the trace builder are re-sorted ascending after DESC fetch (cluster determinism preserved)', () => {
      // Storage now defaults to DESC; the trace layer must re-sort ASC so
      // cluster_id (a hash of sorted atom ids) and edge construction stay
      // deterministic regardless of upstream order.
      const specs: AtomSpec[] = [
        {
          id: 'evt_b',
          app: 'cursor',
          occurred_at: '2026-05-06T08:00:00.000Z',
          artifacts: [{ provider: 'local_fs', type: 'file', id: 'r::a.ts' }],
        },
        {
          id: 'evt_a',
          app: 'cursor',
          occurred_at: '2026-05-06T07:00:00.000Z',
          artifacts: [{ provider: 'local_fs', type: 'file', id: 'r::a.ts' }],
        },
        {
          id: 'evt_c',
          app: 'cursor',
          occurred_at: '2026-05-06T08:30:00.000Z',
          artifacts: [{ provider: 'local_fs', type: 'file', id: 'r::a.ts' }],
        },
      ];
      // Build twice with different feed orders; cluster_id must match because
      // the trace layer sorts internally.
      const desc = asCapture([...specs].sort((a, b) => (a.occurred_at < b.occurred_at ? 1 : -1)));
      const asc = asCapture([...specs].sort((a, b) => (a.occurred_at < b.occurred_at ? -1 : 1)));
      const rDesc = buildRecentWorkContext(desc.events, QUERY, desc.normalize);
      const rAsc = buildRecentWorkContext(asc.events, QUERY, asc.normalize);
      expect(rDesc.clusters[0]!.cluster_id).toBe(rAsc.clusters[0]!.cluster_id);
      // Atoms list is implementation-detail-ordered, but the cluster id (which
      // sorts internally) and the time_range bounds must be stable.
      expect(rDesc.clusters[0]!.time_range).toEqual(rAsc.clusters[0]!.time_range);
    });

    it('explicit window_hours in input is echoed verbatim', () => {
      const { events, normalize } = asCapture([]);
      const r = buildRecentWorkContext(
        events,
        { ...QUERY, window_hours: 24 },
        normalize,
      );
      expect(r.query.window_hours).toBe(24);
    });

    it('cluster spans the full (since, until) window when window_hours = span (atoms 5h apart in same project DO cluster together)', () => {
      // Without raising window_hours above 4, two atoms 5h apart sharing only
      // a file artifact would never form an edge. With window_hours = 24,
      // they should cluster.
      const specs: AtomSpec[] = [
        {
          id: 'morning',
          app: 'cursor',
          occurred_at: '2026-05-06T01:00:00.000Z',
          artifacts: [{ provider: 'local_fs', type: 'file', id: 'r::a.ts' }],
        },
        {
          id: 'evening',
          app: 'cursor',
          occurred_at: '2026-05-06T22:00:00.000Z',
          artifacts: [{ provider: 'local_fs', type: 'file', id: 'r::a.ts' }],
        },
      ];
      const { events, normalize } = asCapture(specs);
      const wideQuery: Query = {
        since: '2026-05-06T00:00:00.000Z',
        until: '2026-05-07T00:00:00.000Z',
        window_hours: 24,
      };
      const r = buildRecentWorkContext(events, wideQuery, normalize);
      expect(r.clusters).toHaveLength(1);
      expect(r.clusters[0]!.atom_ids.sort()).toEqual(['evening', 'morning']);
    });
  });
});
