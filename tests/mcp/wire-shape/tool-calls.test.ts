import { describe, expect, it } from 'vitest';
import { projectToolCallsTrajectory } from '../../../src/mcp/wire-shape/tool-calls.js';

describe('projectToolCallsTrajectory — workflow trajectory projection', () => {
  it('happy path: array of {name, ...} → trajectory string list + by_name histogram', () => {
    const tool_calls = [
      { name: 'git_status', args: 'a'.repeat(2_000), output: 'b'.repeat(1_000), call_id: 'c1' },
      { name: 'Read', args: '{path: x}', output: 'file contents', call_id: 'c2' },
      { name: 'Read', args: '{path: y}', output: 'file contents', call_id: 'c3' },
      { name: 'Edit', args: '{path: x, old, new}', output: 'ok', call_id: 'c4' },
      { name: 'Bash', args: 'npm test', output: 'b'.repeat(4_000), call_id: 'c5' },
      { name: 'git_commit', args: '{msg}', output: 'ok', call_id: 'c6' },
    ];
    const r = projectToolCallsTrajectory(tool_calls);
    expect(r).not.toBeNull();
    expect(r!.trajectory).toEqual([
      'git_status',
      'Read',
      'Read',
      'Edit',
      'Bash',
      'git_commit',
    ]);
    expect(r!.by_name).toEqual({ git_status: 1, Read: 2, Edit: 1, Bash: 1, git_commit: 1 });
    expect(r!.original_count).toBe(6);
    // Bytes dropped is positive — original ~7-8KB, projected ~80B.
    expect(r!.bytes_elided).toBeGreaterThan(5_000);
  });

  it('100-entry tool_calls array fits in <2KB after projection (vs ~700KB original)', () => {
    const tool_calls = Array.from({ length: 100 }, (_, i) => ({
      name: ['Bash', 'Read', 'Edit', 'git_status'][i % 4]!,
      args: 'a'.repeat(2_000),
      output: 'b'.repeat(4_000),
      call_id: `call_${i}`,
    }));
    const r = projectToolCallsTrajectory(tool_calls);
    expect(r).not.toBeNull();
    expect(r!.trajectory).toHaveLength(100);
    // Histogram preserves the workflow distribution.
    expect(r!.by_name).toEqual({ Bash: 25, Read: 25, Edit: 25, git_status: 25 });
    // Projected serialized size — both the trajectory + by_name fit
    // comfortably under the 1KB metadata_value cap (well, trajectory
    // alone is ~1KB at 100 entries × ~10 chars each — fits with
    // marker overhead).
    const projected = JSON.stringify({ tool_calls: r!.trajectory, tool_calls_by_name: r!.by_name });
    expect(projected.length).toBeLessThan(2_000);
    // Original would have been > 600KB; this is the load-bearing claim.
    expect(r!.bytes_elided).toBeGreaterThan(500_000);
  });

  it('empty array → empty trajectory + empty histogram (consistent shape)', () => {
    const r = projectToolCallsTrajectory([]);
    expect(r).not.toBeNull();
    expect(r!.trajectory).toEqual([]);
    expect(r!.by_name).toEqual({});
    expect(r!.original_count).toBe(0);
    expect(r!.bytes_elided).toBe(0);
  });

  it('non-array value → null (caller falls back to standard cap)', () => {
    expect(projectToolCallsTrajectory('not an array')).toBeNull();
    expect(projectToolCallsTrajectory(42)).toBeNull();
    expect(projectToolCallsTrajectory({ some: 'object' })).toBeNull();
    expect(projectToolCallsTrajectory(null)).toBeNull();
    expect(projectToolCallsTrajectory(undefined)).toBeNull();
  });

  it('array with shape-foreign entries → null (no partial projection that misleads consumer)', () => {
    expect(
      projectToolCallsTrajectory([{ name: 'ok' }, { not_a_name: 'x' }]),
    ).toBeNull();
    expect(projectToolCallsTrajectory([{ name: 'ok' }, 'string-entry'])).toBeNull();
  });
});
