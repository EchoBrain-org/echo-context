import { describe, expect, it } from 'vitest';
import {
  benchmarkForkStorm,
  buildForkStormFixture,
} from '../../tools/benchmark-context-topology.js';

describe('fork-storm-v1 logical topology benchmark', () => {
  it('preserves the raw ledger while projecting 460 observations to 123 turns', async () => {
    const fixture = await buildForkStormFixture();

    expect(await fixture.store.count()).toBe(460);
    expect(fixture.expectedLogicalTurns).toBe(123);
    expect(fixture.expectedCollapsedCopies).toBe(337);
  });

  it('returns seven complete thread headers and hydrates every representative ID', async () => {
    const report = await benchmarkForkStorm({
      warmup: 0,
      iterations: 1,
      enforceLatency: false,
    });

    expect(report).toMatchObject({
      raw_observations: 460,
      logical_turns: 123,
      collapsed_observations: 337,
      project_counts: { echo_brain: 72, echo_context: 38, hdc: 13 },
      clusters: 7,
      max_cluster_size: 24,
      hydrated_ids: 123,
      warnings: [],
    });
    expect(report.envelope_bytes).toBeLessThan(10_000);
  });
});
