import { describe, expect, it } from 'vitest';
import { heuristicLabel } from '../../src/trace/labels.js';
import { makeAtom } from './fixtures/atoms.js';

describe('heuristicLabel', () => {
  it('returns undefined for empty input', () => {
    expect(heuristicLabel([])).toBeUndefined();
  });

  it('returns undefined when no artifact appears ≥2 times', () => {
    const a = makeAtom({
      id: 'evt_a',
      app: 'cursor',
      occurred_at: '2026-05-06T08:00:00.000Z',
      artifacts: [{ provider: 'local_fs', type: 'file', id: 'r::a.ts' }],
      verb: 'edit',
    });
    expect(heuristicLabel([a])).toBeUndefined();
  });

  it('returns undefined for conversation-only cluster with no useful label', () => {
    const a = makeAtom({
      id: 'evt_a',
      app: 'claude_code',
      occurred_at: '2026-05-06T08:00:00.000Z',
      artifacts: [
        { provider: 'claude_code', type: 'conversation', id: 'claude_code:opaque-id-1' },
      ],
      verb: 'message',
    });
    const b = makeAtom({
      id: 'evt_b',
      app: 'claude_code',
      occurred_at: '2026-05-06T08:30:00.000Z',
      artifacts: [
        { provider: 'claude_code', type: 'conversation', id: 'claude_code:opaque-id-1' },
      ],
      verb: 'message',
    });
    expect(heuristicLabel([a, b])).toBeUndefined();
  });

  it('"message" verb maps to "discussion about <file>"', () => {
    const a = makeAtom({
      id: 'evt_a',
      app: 'claude_code',
      occurred_at: '2026-05-06T08:00:00.000Z',
      artifacts: [
        { provider: 'local_fs', type: 'file', id: 'r::types.ts', label: 'src/normalize/types.ts' },
      ],
      kind: 'message',
    });
    const b = makeAtom({
      id: 'evt_b',
      app: 'claude_code',
      occurred_at: '2026-05-06T08:30:00.000Z',
      artifacts: [
        { provider: 'local_fs', type: 'file', id: 'r::types.ts', label: 'src/normalize/types.ts' },
      ],
      kind: 'message',
    });
    expect(heuristicLabel([a, b])).toBe('discussion about src/normalize/types.ts');
  });

  it('"commit" verb maps to "work on"', () => {
    const a = makeAtom({
      id: 'evt_a',
      app: 'git',
      occurred_at: '2026-05-06T08:00:00.000Z',
      artifacts: [
        { provider: 'local_fs', type: 'file', id: 'gh:foo/bar', label: 'bar' },
      ],
      verb: 'commit',
    });
    const b = makeAtom({
      id: 'evt_b',
      app: 'git',
      occurred_at: '2026-05-06T08:30:00.000Z',
      artifacts: [
        { provider: 'local_fs', type: 'file', id: 'gh:foo/bar', label: 'bar' },
      ],
      verb: 'commit',
    });
    expect(heuristicLabel([a, b])).toBe('work on bar');
  });

  it('"edit" verb maps to "edits to <file>"', () => {
    const a = makeAtom({
      id: 'evt_a',
      app: 'cursor',
      occurred_at: '2026-05-06T08:00:00.000Z',
      artifacts: [
        { provider: 'local_fs', type: 'file', id: 'r::sqlite.ts', label: 'src/storage/sqlite.ts' },
      ],
      verb: 'edit',
    });
    const b = makeAtom({
      id: 'evt_b',
      app: 'cursor',
      occurred_at: '2026-05-06T08:30:00.000Z',
      artifacts: [
        { provider: 'local_fs', type: 'file', id: 'r::sqlite.ts', label: 'src/storage/sqlite.ts' },
      ],
      verb: 'edit',
    });
    expect(heuristicLabel([a, b])).toBe('edits to src/storage/sqlite.ts');
  });

  it('falls back to id-tail when artifact has no label', () => {
    const a = makeAtom({
      id: 'evt_a',
      app: 'git',
      occurred_at: '2026-05-06T08:00:00.000Z',
      artifacts: [{ provider: 'local_fs', type: 'file', id: 'local:/Users/zhen/echo' }],
      verb: 'commit',
    });
    const b = makeAtom({
      id: 'evt_b',
      app: 'git',
      occurred_at: '2026-05-06T08:30:00.000Z',
      artifacts: [{ provider: 'local_fs', type: 'file', id: 'local:/Users/zhen/echo' }],
      verb: 'commit',
    });
    expect(heuristicLabel([a, b])).toBe('work on echo');
  });

  it('prefers non-conversation artifact when both tie in count', () => {
    const a = makeAtom({
      id: 'evt_a',
      app: 'claude_code',
      occurred_at: '2026-05-06T08:00:00.000Z',
      artifacts: [
        { provider: 'local_fs', type: 'file', id: 'r::a.ts', label: 'a.ts' },
        { provider: 'claude_code', type: 'conversation', id: 'claude_code:s1' },
      ],
      verb: 'message',
    });
    const b = makeAtom({
      id: 'evt_b',
      app: 'claude_code',
      occurred_at: '2026-05-06T08:30:00.000Z',
      artifacts: [
        { provider: 'local_fs', type: 'file', id: 'r::a.ts', label: 'a.ts' },
        { provider: 'claude_code', type: 'conversation', id: 'claude_code:s1' },
      ],
      verb: 'message',
    });
    expect(heuristicLabel([a, b])).toBe('discussion about a.ts');
  });

  it('unknown verb falls back to "work on"', () => {
    const a = makeAtom({
      id: 'evt_a',
      app: 'cursor',
      occurred_at: '2026-05-06T08:00:00.000Z',
      artifacts: [{ provider: 'local_fs', type: 'file', id: 'r::a.ts', label: 'a.ts' }],
      kind: 'wiggle',
    });
    const b = makeAtom({
      id: 'evt_b',
      app: 'cursor',
      occurred_at: '2026-05-06T08:30:00.000Z',
      artifacts: [{ provider: 'local_fs', type: 'file', id: 'r::a.ts', label: 'a.ts' }],
      kind: 'wiggle',
    });
    expect(heuristicLabel([a, b])).toBe('work on a.ts');
  });
});
