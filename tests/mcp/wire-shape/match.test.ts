import { describe, expect, it } from 'vitest';
import { WIRE_SHAPE_CAPS } from '../../../src/mcp/wire-shape/caps.js';
import { projectMatch } from '../../../src/mcp/wire-shape/match.js';
import type { CaptureEvent } from '../../../src/storage/interface.js';

function ev(overrides: Partial<CaptureEvent>): CaptureEvent {
  return {
    id: 'fixed-id',
    source: 'fs:/tmp/x.jsonl',
    timestamp: '2026-05-08T22:00:00.000Z',
    content: '',
    ...overrides,
  };
}

describe('projectMatch — content cap', () => {
  it('content under cap passes verbatim, no bytes_elided field', () => {
    const m = projectMatch(ev({ content: 'short turn that fits' }));
    expect(m.content).toBe('short turn that fits');
    expect(m.bytes_elided).toBeUndefined();
  });

  it('content over cap is clipped to head + marker + tail; bytes_elided populated', () => {
    const head = 'HEAD_SENTINEL_' + 'a'.repeat(50_000);
    const tail = 'b'.repeat(50_000) + '_TAIL_SENTINEL';
    const big = head + tail;
    const m = projectMatch(ev({ content: big }));
    expect(m.content.length).toBeLessThanOrEqual(WIRE_SHAPE_CAPS.match_content + 100);
    expect(m.content.startsWith('HEAD_SENTINEL_')).toBe(true);
    expect(m.content.endsWith('_TAIL_SENTINEL')).toBe(true);
    expect(m.content).toMatch(/\[\d+\s*chars elided\]/);
    expect(m.bytes_elided).toBeGreaterThan(0);
  });
});

describe('projectMatch — per-metadata-value cap', () => {
  it('all-small metadata passes verbatim, no metadata_*_elided fields', () => {
    const m = projectMatch(
      ev({
        metadata: {
          session_id: 'abc',
          turn_index: 5,
          git_state: { branch: 'main', head_sha: 'deadbeef' },
        },
      }),
    );
    expect(m.metadata).toEqual({
      session_id: 'abc',
      turn_index: 5,
      git_state: { branch: 'main', head_sha: 'deadbeef' },
    });
    expect(m.metadata_bytes_elided).toBeUndefined();
    expect(m.metadata_keys_elided).toBeUndefined();
  });

  it('large variadic value (e.g. tool_calls) is replaced; small neighbours pass through', () => {
    const big_tool_calls = Array.from({ length: 50 }, (_, i) => ({
      name: 'Bash',
      args: 'a'.repeat(2_000),
      output: 'b'.repeat(4_000),
      call_id: `call_${i}`,
    }));
    const m = projectMatch(
      ev({
        metadata: {
          session_id: 'abc',
          tool_calls: big_tool_calls,
          git_state: { branch: 'main' },
        },
      }),
    );
    // V1.5.6.1: tool_calls is now PROJECTED to its name trajectory
    // (preserving workflow shape) instead of being opaqued out. Small
    // structured neighbours still pass through verbatim.
    expect(m.metadata).toBeDefined();
    expect(m.metadata!['session_id']).toBe('abc');
    expect(m.metadata!['git_state']).toEqual({ branch: 'main' });
    expect(m.metadata!['tool_calls']).toEqual(Array(50).fill('Bash'));
    expect(m.metadata!['tool_calls_by_name']).toEqual({ Bash: 50 });
    // Projected, not elided — distinct semantic.
    expect(m.metadata_keys_projected).toEqual(['tool_calls']);
    expect(m.metadata_keys_elided).toBeUndefined();
    expect(m.metadata_bytes_elided).toBeGreaterThan(0);
  });

  it('multiple oversized keys: all replaced, keys_elided lists each', () => {
    const m = projectMatch(
      ev({
        metadata: {
          a: 'x'.repeat(5_000),
          b: { nested: 'y'.repeat(5_000) },
          ok: 'small',
        },
      }),
    );
    expect(m.metadata!['ok']).toBe('small');
    expect(m.metadata_keys_elided?.sort()).toEqual(['a', 'b']);
    expect(m.metadata_bytes_elided).toBeGreaterThan(0);
  });
});

describe('projectMatch — truncations vocabulary (V1.6 item 030)', () => {
  it('is always present (empty array when nothing was clipped or projected)', () => {
    const m = projectMatch(
      ev({
        content: 'small',
        metadata: { session_id: 'abc', git_state: { branch: 'main' } },
      }),
    );
    expect(m.truncations).toEqual([]);
  });

  it('content cap fires → truncations contains "content"', () => {
    const big = 'a'.repeat(WIRE_SHAPE_CAPS.match_content + 100);
    const m = projectMatch(ev({ content: big }));
    expect(m.truncations).toContain('content');
  });

  it('per-key metadata cap fires → truncations contains "metadata.<key>"', () => {
    const m = projectMatch(
      ev({
        metadata: { huge_key: { nested: 'x'.repeat(5_000) }, ok: 'small' },
      }),
    );
    expect(m.truncations).toContain('metadata.huge_key');
    expect(m.truncations).not.toContain('metadata.ok');
  });

  it('projector reshape (tool_calls) → truncations contains "metadata.<key>:projected" (NOT "metadata.<key>")', () => {
    // Critical: the :projected suffix lets consumers distinguish
    // "this got clipped" from "this got rewritten by a known projector
    // with a documented schema."
    const big_tool_calls = Array.from({ length: 30 }, () => ({
      name: 'Bash',
      args: 'a'.repeat(2_000),
      output: 'b'.repeat(1_000),
    }));
    const m = projectMatch(ev({ metadata: { tool_calls: big_tool_calls } }));
    expect(m.truncations).toContain('metadata.tool_calls:projected');
    expect(m.truncations).not.toContain('metadata.tool_calls');
  });

  it('multiple events: content + projector + cap all emit distinct entries', () => {
    const big_tool_calls = Array.from({ length: 30 }, () => ({
      name: 'Bash',
      args: 'a'.repeat(2_000),
      output: 'b'.repeat(1_000),
    }));
    const m = projectMatch(
      ev({
        content: 'a'.repeat(WIRE_SHAPE_CAPS.match_content + 100),
        metadata: {
          tool_calls: big_tool_calls,
          huge: { nested: 'x'.repeat(5_000) },
        },
      }),
    );
    expect(m.truncations.sort()).toEqual(
      ['content', 'metadata.huge', 'metadata.tool_calls:projected'].sort(),
    );
  });
});

describe('projectMatch — realistic-density envelope', () => {
  it('10 matches, each carrying 100KB tool_calls (the 16:14 PDT failure mode), serialize under 25k bytes', () => {
    // Reproduce the live failure: substring-grep over a busy Codex window
    // returns ~10 matches, each atom carries ~100KB tool_calls metadata
    // alongside ~1KB content. Pre-projector this overflowed at 305k chars.
    const matches = Array.from({ length: 10 }, (_, i) =>
      projectMatch(
        ev({
          id: `id_${i}`,
          source: `fs:/Users/redacted/.codex/sessions/rollout-${i}.jsonl`,
          timestamp: `2026-05-08T22:00:${i.toString().padStart(2, '0')}.000Z`,
          content: `USER: question ${i} about JSON-RPC\n\nASSISTANT: long answer about ` +
            'm'.repeat(600), // ~640 chars of content (well under match_content cap)
          metadata: {
            session_id: `019e09${i}d`,
            turn_index: i,
            cwd: '/Users/redacted/Desktop/Project_echo',
            byte_offset: 100_000 + i * 1000,
            git_state: { branch: 'main', head_sha: 'deadbeef' },
            tool_calls: Array.from({ length: 30 }, (_, j) => ({
              name: 'exec_command',
              args: 'a'.repeat(2_000),
              output: 'b'.repeat(1_000),
              call_id: `c_${j}`,
            })), // ~95KB serialized — the dominant byte source pre-fix
          },
        }),
      ),
    );
    const envelope = JSON.stringify({ matches });
    expect(envelope.length).toBeLessThan(25_000);
    // V1.5.6.1: every match's tool_calls is now PROJECTED to a name
    // trajectory (workflow shape preserved), not opaqued out.
    expect(matches.every((m) => m.metadata_keys_projected?.includes('tool_calls'))).toBe(
      true,
    );
    // Trajectory survives — first match's tool_calls is the 30-entry
    // exec_command sequence.
    expect(matches[0]!.metadata!['tool_calls']).toEqual(Array(30).fill('exec_command'));
    expect(matches[0]!.metadata!['tool_calls_by_name']).toEqual({ exec_command: 30 });
  });

  it('V1.5.6.1: tool_calls trajectory preserves the workflow shape across MIXED tool names', () => {
    // The whole point of the trajectory: a consumer should be able to
    // infer agent intent from the ordered name list. e.g.
    // "git_status → Read → Read → Edit → Bash → git_commit" reads as
    // "the agent investigated, read two files, edited one, ran tests,
    // committed." Pre-V1.5.6.1 the consumer got tool_call_total: 6 — a
    // useless count. Post: the trajectory + histogram answer "what was
    // the agent doing?".
    const m = projectMatch(
      ev({
        metadata: {
          tool_calls: [
            { name: 'git_status', args: 'a'.repeat(2_000), output: '' },
            { name: 'Read', args: '{path: a}', output: 'a'.repeat(2_000) },
            { name: 'Read', args: '{path: b}', output: 'a'.repeat(2_000) },
            { name: 'Edit', args: '{path: a}', output: 'a'.repeat(2_000) },
            { name: 'Bash', args: 'npm test', output: 'a'.repeat(4_000) },
            { name: 'git_commit', args: '{msg}', output: '' },
          ],
        },
      }),
    );
    expect(m.metadata!['tool_calls']).toEqual([
      'git_status',
      'Read',
      'Read',
      'Edit',
      'Bash',
      'git_commit',
    ]);
    expect(m.metadata!['tool_calls_by_name']).toEqual({
      git_status: 1,
      Read: 2,
      Edit: 1,
      Bash: 1,
      git_commit: 1,
    });
  });
});
