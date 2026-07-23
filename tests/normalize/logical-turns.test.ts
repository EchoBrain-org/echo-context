import { describe, expect, it } from 'vitest';
import { projectLogicalTurns } from '../../src/normalize/logical-turns.js';
import { makeAtom } from '../trace/fixtures/atoms.js';

function observation(input: {
  id: string;
  provider?: string;
  logicalTurnId?: string;
  kind?: 'original' | 'inherited' | 'unknown';
  occurredAt?: string;
  observedAt?: string;
  content?: string;
}) {
  return makeAtom({
    id: input.id,
    app: input.provider ?? 'codex',
    occurred_at: input.occurredAt ?? '2026-07-22T18:00:00.000Z',
    observed_at: input.observedAt,
    input: input.content ?? 'same logical turn',
    artifacts: [],
    conversation: {
      provider: input.provider ?? 'codex',
      session_id: `session-${input.id}`,
      ...(input.logicalTurnId !== undefined
        ? { logical_turn_id: input.logicalTurnId }
        : {}),
      ...(input.kind !== undefined ? { observation_kind: input.kind } : {}),
    },
  });
}

describe('projectLogicalTurns', () => {
  it('keeps the raw ledger count while collapsing copies onto a stored representative id', () => {
    const projected = projectLogicalTurns([
      observation({
        id: 'original',
        logicalTurnId: 'turn-1',
        kind: 'original',
        observedAt: '2026-07-22T18:01:00.000Z',
      }),
      observation({
        id: 'copy-a',
        logicalTurnId: 'turn-1',
        kind: 'inherited',
        observedAt: '2026-07-22T21:30:00.000Z',
      }),
      observation({
        id: 'copy-b',
        logicalTurnId: 'turn-1',
        kind: 'inherited',
        observedAt: '2026-07-22T21:45:00.000Z',
      }),
    ]);

    expect(projected.raw_observation_count).toBe(3);
    expect(projected.logical_turn_count).toBe(1);
    expect(projected.collapsed_observation_count).toBe(2);
    expect(projected.atoms[0]!.id).toBe('original');
    expect(projected.atoms[0]!.time.occurred_at).toBe('2026-07-22T18:00:00.000Z');
    expect(projected.atoms[0]!.time.observed_at).toBe('2026-07-22T21:45:00.000Z');
    expect(projected.atoms[0]!.provenance.raw_observation_count).toBe(3);
  });

  it('retains one inherited-only representative when the caller admitted its occurrence', () => {
    const projected = projectLogicalTurns([
      observation({ id: 'copy-a', logicalTurnId: 'old', kind: 'inherited' }),
      observation({ id: 'copy-b', logicalTurnId: 'old', kind: 'inherited' }),
    ]);
    expect(projected.atoms).toHaveLength(1);
    expect(projected.atoms[0]!.id).toBe('copy-a');
    expect(projected.collapsed_observation_count).toBe(1);
    expect(projected.inherited_only_count).toBe(2);
  });

  it('never content-deduplicates different logical ids or missing ids', () => {
    const projected = projectLogicalTurns([
      observation({ id: 'a', logicalTurnId: 'turn-a', kind: 'original' }),
      observation({ id: 'b', logicalTurnId: 'turn-b', kind: 'original' }),
      observation({ id: 'c' }),
      observation({ id: 'd' }),
    ]);
    expect(projected.atoms.map((atom) => atom.id).sort()).toEqual(['a', 'b', 'c', 'd']);
  });

  it('provider is part of logical identity', () => {
    const projected = projectLogicalTurns([
      observation({ id: 'codex', provider: 'codex', logicalTurnId: 'same', kind: 'original' }),
      observation({
        id: 'claude',
        provider: 'claude_code',
        logicalTurnId: 'same',
        kind: 'original',
      }),
    ]);
    expect(projected.logical_turn_count).toBe(2);
  });
});
