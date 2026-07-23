import { describe, expect, it } from 'vitest';
import { enrichHints } from '../../src/trace/hints.js';
import { makeAtom } from './fixtures/atoms.js';

describe('enrichHints', () => {
  it('marks a user question answered in the same turn as resolved', () => {
    const atom = makeAtom({
      id: 'answered',
      app: 'codex',
      occurred_at: '2026-05-06T08:00:00.000Z',
      artifacts: [{ provider: 'codex', type: 'conversation', id: 'codex:s1' }],
      input: 'Is this ready?',
      output: 'Yes, all checks pass.',
      hints: ['ends_with_question'],
    });
    expect(enrichHints([atom])[0]).toMatchObject({
      atom_id: 'answered',
      resolved: true,
      resolved_by_atom_id: 'answered',
    });
  });

  it('does not turn agent-originated prompts into founder open loops', () => {
    const atom = makeAtom({
      id: 'agent-task',
      app: 'codex',
      occurred_at: '2026-05-06T08:00:00.000Z',
      artifacts: [],
      input: 'Review this?',
      hints: ['ends_with_question'],
      conversation: {
        provider: 'codex',
        session_id: 'child',
        initiator: 'agent',
      },
    });
    expect(enrichHints([atom])).toEqual([]);
  });
  it('returns empty array for atoms with no hints', () => {
    const a = makeAtom({
      id: 'evt_a',
      app: 'cursor',
      occurred_at: '2026-05-06T08:00:00.000Z',
      artifacts: [],
    });
    expect(enrichHints([a])).toEqual([]);
  });

  it('ends_with_question pulls last question from input with high confidence', () => {
    const a = makeAtom({
      id: 'evt_a',
      app: 'claude_code',
      occurred_at: '2026-05-06T08:00:00.000Z',
      artifacts: [],
      input: 'I am stuck. Should I use approach A or approach B?',
      output: 'Lets think about it.',
      hints: ['ends_with_question'],
    });
    const out = enrichHints([a]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      atom_id: 'evt_a',
      kind: 'ends_with_question',
      text: 'Should I use approach A or approach B?',
      confidence: 'high',
    });
  });

  it('unresolved_assistant_q pulls last question from output with medium confidence', () => {
    const a = makeAtom({
      id: 'evt_a',
      app: 'claude_code',
      occurred_at: '2026-05-06T08:00:00.000Z',
      artifacts: [],
      input: 'help me',
      output: 'Did you want me to also wire up the second tool?',
      hints: ['unresolved_assistant_q'],
    });
    const out = enrichHints([a]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      atom_id: 'evt_a',
      kind: 'unresolved_assistant_q',
      confidence: 'medium',
    });
    expect(out[0]!.text).toContain('wire up the second tool');
  });

  it('contains_todo extracts the TODO snippet with high confidence', () => {
    const a = makeAtom({
      id: 'evt_a',
      app: 'cursor',
      occurred_at: '2026-05-06T08:00:00.000Z',
      artifacts: [],
      input: '',
      output: 'looks good\n// TODO: handle the empty-state case here\nrest',
      hints: ['contains_todo'],
    });
    const out = enrichHints([a]);
    expect(out).toHaveLength(1);
    expect(out[0]!.kind).toBe('contains_todo');
    expect(out[0]!.text).toMatch(/TODO/);
    expect(out[0]!.confidence).toBe('high');
  });

  it('explicit_followup extracts the surrounding line with medium confidence', () => {
    const a = makeAtom({
      id: 'evt_a',
      app: 'claude_code',
      occurred_at: '2026-05-06T08:00:00.000Z',
      artifacts: [],
      input: 'lets follow up on the migration tomorrow',
      output: '',
      hints: ['explicit_followup'],
    });
    const out = enrichHints([a]);
    expect(out).toHaveLength(1);
    expect(out[0]!.kind).toBe('explicit_followup');
    expect(out[0]!.confidence).toBe('medium');
    expect(out[0]!.text).toContain('follow up');
  });

  it('multiple hints on one atom enrich into multiple results', () => {
    const a = makeAtom({
      id: 'evt_a',
      app: 'claude_code',
      occurred_at: '2026-05-06T08:00:00.000Z',
      artifacts: [],
      input: 'should I commit this?',
      output: 'TODO: revisit threshold',
      hints: ['ends_with_question', 'contains_todo'],
    });
    const out = enrichHints([a]);
    expect(out).toHaveLength(2);
    expect(out.map((h) => h.kind).sort()).toEqual([
      'contains_todo',
      'ends_with_question',
    ]);
  });

  it('drops a hint when the corresponding text cannot be extracted', () => {
    const a = makeAtom({
      id: 'evt_a',
      app: 'cursor',
      occurred_at: '2026-05-06T08:00:00.000Z',
      artifacts: [],
      input: '',
      output: '',
      hints: ['ends_with_question'],
    });
    expect(enrichHints([a])).toEqual([]);
  });

  it('ignores unknown hint kinds', () => {
    const a = makeAtom({
      id: 'evt_a',
      app: 'cursor',
      occurred_at: '2026-05-06T08:00:00.000Z',
      artifacts: [],
      input: 'hi?',
      output: 'hi',
      hints: ['some_future_kind'],
    });
    expect(enrichHints([a])).toEqual([]);
  });

  it('processes multiple atoms preserving order', () => {
    const a = makeAtom({
      id: 'evt_a',
      app: 'claude_code',
      occurred_at: '2026-05-06T08:00:00.000Z',
      artifacts: [],
      input: 'Q1?',
      output: '',
      hints: ['ends_with_question'],
    });
    const b = makeAtom({
      id: 'evt_b',
      app: 'claude_code',
      occurred_at: '2026-05-06T08:30:00.000Z',
      artifacts: [],
      input: '',
      output: 'TODO: do X',
      hints: ['contains_todo'],
    });
    const out = enrichHints([a, b]);
    expect(out.map((h) => h.atom_id)).toEqual(['evt_a', 'evt_b']);
  });

  describe('R1 resolution (item 020)', () => {
    const CONV_S1 = {
      provider: 'claude_code',
      type: 'conversation',
      id: 'claude_code:s1',
    };
    const CONV_S2 = {
      provider: 'claude_code',
      type: 'conversation',
      id: 'claude_code:s2',
    };
    const FILE_X = { provider: 'local_fs', type: 'file', id: 'r::x.ts' };
    const FILE_Y = { provider: 'local_fs', type: 'file', id: 'r::y.ts' };

    it('R1.Q resolves a user question with a later non-question turn in same conversation', () => {
      const q = makeAtom({
        id: 'evt_q',
        app: 'claude_code',
        occurred_at: '2026-05-06T08:00:00.000Z',
        artifacts: [CONV_S1],
        input: 'should I refactor it?',
        output: '',
        hints: ['ends_with_question'],
      });
      const ans = makeAtom({
        id: 'evt_ans',
        app: 'claude_code',
        occurred_at: '2026-05-06T08:01:00.000Z',
        artifacts: [CONV_S1],
        input: 'sure go ahead',
        output: 'will do.',
      });
      const out = enrichHints([q, ans]);
      expect(out).toHaveLength(1);
      expect(out[0]!.kind).toBe('ends_with_question');
      expect(out[0]!.resolved).toBe(true);
      expect(out[0]!.resolved_by_atom_id).toBe('evt_ans');
    });

    it('R1.Q does NOT resolve when the only later turn is itself a question', () => {
      const q1 = makeAtom({
        id: 'evt_q1',
        app: 'claude_code',
        occurred_at: '2026-05-06T08:00:00.000Z',
        artifacts: [CONV_S1],
        input: 'should I refactor it?',
        output: '',
        hints: ['ends_with_question'],
      });
      const q2 = makeAtom({
        id: 'evt_q2',
        app: 'claude_code',
        occurred_at: '2026-05-06T08:01:00.000Z',
        artifacts: [CONV_S1],
        input: 'or maybe rewrite?',
        output: '',
        hints: ['ends_with_question'],
      });
      const out = enrichHints([q1, q2]);
      const q1Hint = out.find((h) => h.atom_id === 'evt_q1');
      expect(q1Hint).toBeDefined();
      expect(q1Hint!.resolved).toBe(false);
      expect(q1Hint!.resolved_by_atom_id).toBeUndefined();
    });

    it('R1.Q does NOT resolve across conversation boundaries (different conversation artifact id)', () => {
      const q = makeAtom({
        id: 'evt_q',
        app: 'claude_code',
        occurred_at: '2026-05-06T08:00:00.000Z',
        artifacts: [CONV_S1],
        input: 'should I refactor it?',
        output: '',
        hints: ['ends_with_question'],
      });
      const otherConvAns = makeAtom({
        id: 'evt_other',
        app: 'claude_code',
        occurred_at: '2026-05-06T08:01:00.000Z',
        artifacts: [CONV_S2],
        input: 'unrelated reply',
        output: '',
      });
      const out = enrichHints([q, otherConvAns]);
      expect(out).toHaveLength(1);
      expect(out[0]!.resolved).toBe(false);
      expect(out[0]!.resolved_by_atom_id).toBeUndefined();
    });

    it('R1.Q does NOT resolve when hint atom has no conversation artifact', () => {
      const q = makeAtom({
        id: 'evt_q',
        app: 'claude_code',
        occurred_at: '2026-05-06T08:00:00.000Z',
        artifacts: [], // no conversation artifact
        input: 'should I refactor it?',
        output: '',
        hints: ['ends_with_question'],
      });
      const ans = makeAtom({
        id: 'evt_ans',
        app: 'claude_code',
        occurred_at: '2026-05-06T08:01:00.000Z',
        artifacts: [],
        input: 'sure',
        output: '',
      });
      const out = enrichHints([q, ans]);
      expect(out).toHaveLength(1);
      expect(out[0]!.resolved).toBe(false);
    });

    it('R1.AQ resolves an assistant question with a 1-char user reply', () => {
      const aq = makeAtom({
        id: 'evt_aq',
        app: 'claude_code',
        occurred_at: '2026-05-06T08:00:00.000Z',
        artifacts: [CONV_S1],
        input: 'help',
        output: 'did you want me to wire up the second tool?',
        hints: ['unresolved_assistant_q'],
        actors: [{ role: 'assistant' }],
      });
      const reply = makeAtom({
        id: 'evt_reply',
        app: 'claude_code',
        occurred_at: '2026-05-06T08:01:00.000Z',
        artifacts: [CONV_S1],
        input: 'ok',
        output: '',
        actors: [{ role: 'user' }],
      });
      const out = enrichHints([aq, reply]);
      const aqHint = out.find((h) => h.kind === 'unresolved_assistant_q');
      expect(aqHint).toBeDefined();
      expect(aqHint!.resolved).toBe(true);
      expect(aqHint!.resolved_by_atom_id).toBe('evt_reply');
    });

    it('R1.AQ does NOT resolve when the only later turn is also from assistant role', () => {
      const aq = makeAtom({
        id: 'evt_aq',
        app: 'claude_code',
        occurred_at: '2026-05-06T08:00:00.000Z',
        artifacts: [CONV_S1],
        input: '',
        output: 'did you want me to wire it up?',
        hints: ['unresolved_assistant_q'],
        actors: [{ role: 'assistant' }],
      });
      const assistantFollowup = makeAtom({
        id: 'evt_a2',
        app: 'claude_code',
        occurred_at: '2026-05-06T08:01:00.000Z',
        artifacts: [CONV_S1],
        input: '',
        output: 'I will proceed.',
        actors: [{ role: 'assistant' }],
      });
      const out = enrichHints([aq, assistantFollowup]);
      const aqHint = out.find((h) => h.kind === 'unresolved_assistant_q');
      expect(aqHint).toBeDefined();
      expect(aqHint!.resolved).toBe(false);
    });

    it('R1.TODO resolves when a later atom\'s state.delta.artifact_id matches a file artifact on the hint atom', () => {
      const todoAtom = makeAtom({
        id: 'evt_todo',
        app: 'cursor',
        occurred_at: '2026-05-06T08:00:00.000Z',
        artifacts: [FILE_X],
        input: '',
        output: '// TODO: handle empty case',
        hints: ['contains_todo'],
      });
      const editAtom = makeAtom({
        id: 'evt_edit',
        app: 'cursor',
        occurred_at: '2026-05-06T08:05:00.000Z',
        artifacts: [FILE_X],
        state: { delta: { artifact_id: FILE_X.id, kind: 'edit' } },
      });
      const out = enrichHints([todoAtom, editAtom]);
      expect(out).toHaveLength(1);
      expect(out[0]!.resolved).toBe(true);
      expect(out[0]!.resolved_by_atom_id).toBe('evt_edit');
    });

    it('R1.TODO does NOT resolve when the later edit is on a different file', () => {
      const todoAtom = makeAtom({
        id: 'evt_todo',
        app: 'cursor',
        occurred_at: '2026-05-06T08:00:00.000Z',
        artifacts: [FILE_X],
        input: '',
        output: '// TODO: handle empty case',
        hints: ['contains_todo'],
      });
      const editOtherFile = makeAtom({
        id: 'evt_edit_y',
        app: 'cursor',
        occurred_at: '2026-05-06T08:05:00.000Z',
        artifacts: [FILE_Y],
        state: { delta: { artifact_id: FILE_Y.id, kind: 'edit' } },
      });
      const out = enrichHints([todoAtom, editOtherFile]);
      expect(out).toHaveLength(1);
      expect(out[0]!.resolved).toBe(false);
    });

    it('R1.TODO does NOT resolve when the hint atom has no file artifacts', () => {
      const todoAtom = makeAtom({
        id: 'evt_todo',
        app: 'cursor',
        occurred_at: '2026-05-06T08:00:00.000Z',
        artifacts: [CONV_S1], // conversation only, no file
        input: '',
        output: '// TODO: handle empty case',
        hints: ['contains_todo'],
      });
      const editAtom = makeAtom({
        id: 'evt_edit',
        app: 'cursor',
        occurred_at: '2026-05-06T08:05:00.000Z',
        artifacts: [FILE_X],
        state: { delta: { artifact_id: FILE_X.id, kind: 'edit' } },
      });
      const out = enrichHints([todoAtom, editAtom]);
      expect(out).toHaveLength(1);
      expect(out[0]!.resolved).toBe(false);
    });

    it('R1.FU is always resolved: false (per rule)', () => {
      const fuAtom = makeAtom({
        id: 'evt_fu',
        app: 'claude_code',
        occurred_at: '2026-05-06T08:00:00.000Z',
        artifacts: [CONV_S1, FILE_X],
        input: 'we will follow up next week',
        output: '',
        hints: ['explicit_followup'],
      });
      // even with an extremely strong "closure-like" later atom in same conv + same file
      const closure = makeAtom({
        id: 'evt_closure',
        app: 'claude_code',
        occurred_at: '2026-05-06T08:30:00.000Z',
        artifacts: [CONV_S1, FILE_X],
        input: 'followed up — done.',
        output: 'shipped',
        state: { delta: { artifact_id: FILE_X.id, kind: 'edit' } },
        actors: [{ role: 'user' }],
      });
      const out = enrichHints([fuAtom, closure]);
      const fuHint = out.find((h) => h.kind === 'explicit_followup');
      expect(fuHint).toBeDefined();
      expect(fuHint!.resolved).toBe(false);
      expect(fuHint!.resolved_by_atom_id).toBeUndefined();
    });

    it('resolved_by_atom_id is set to the earliest qualifying atom id, not the latest', () => {
      const q = makeAtom({
        id: 'evt_q',
        app: 'claude_code',
        occurred_at: '2026-05-06T08:00:00.000Z',
        artifacts: [CONV_S1],
        input: 'should I refactor it?',
        output: '',
        hints: ['ends_with_question'],
      });
      const firstAns = makeAtom({
        id: 'evt_ans1',
        app: 'claude_code',
        occurred_at: '2026-05-06T08:01:00.000Z',
        artifacts: [CONV_S1],
        input: 'first answer',
        output: '',
      });
      const laterAns = makeAtom({
        id: 'evt_ans2',
        app: 'claude_code',
        occurred_at: '2026-05-06T08:02:00.000Z',
        artifacts: [CONV_S1],
        input: 'later non-question turn',
        output: '',
      });
      const out = enrichHints([q, firstAns, laterAns]);
      expect(out[0]!.resolved).toBe(true);
      expect(out[0]!.resolved_by_atom_id).toBe('evt_ans1');
    });

    it('resolved is false when no later atoms exist in the input list', () => {
      const q = makeAtom({
        id: 'evt_q',
        app: 'claude_code',
        occurred_at: '2026-05-06T08:00:00.000Z',
        artifacts: [CONV_S1],
        input: 'should I refactor it?',
        output: '',
        hints: ['ends_with_question'],
      });
      const out = enrichHints([q]);
      expect(out).toHaveLength(1);
      expect(out[0]!.resolved).toBe(false);
      expect(out[0]!.resolved_by_atom_id).toBeUndefined();
    });
  });
});
