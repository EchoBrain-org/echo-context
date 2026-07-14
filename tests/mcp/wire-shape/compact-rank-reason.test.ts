import { describe, expect, it } from 'vitest';
import { compactCluster } from '../../../src/mcp/wire-shape/compact.js';

const BASE_CLUSTER = {
  cluster_id: 'ctx_12345678',
  atom_ids: ['a1'],
  source_breakdown: { codex: 1 },
  time_range: { from: '2026-05-20T10:00:00.000Z', to: '2026-05-20T10:05:00.000Z' },
  label: 'work on hero',
  open_loop_hints: [{ atom_id: 'a1', resolved: false }],
};

describe('compactCluster rank_reason allowlist', () => {
  it('preserves the three compact rank reasons in original order', () => {
    const cluster = compactCluster({
      ...BASE_CLUSTER,
      rank_reason: ['has_open_loop', 'has_unresolved_open_loop', 'code_session_anchor'],
    });
    expect(cluster.rank_reason).toEqual([
      'has_open_loop',
      'has_unresolved_open_loop',
      'code_session_anchor',
    ]);
  });

  it('drops future reason strings until compact projection explicitly allows them', () => {
    const cluster = compactCluster({
      ...BASE_CLUSTER,
      rank_reason: ['some_future_reason', 'has_open_loop'],
    });
    expect(cluster.rank_reason).toEqual(['has_open_loop']);
  });
});
