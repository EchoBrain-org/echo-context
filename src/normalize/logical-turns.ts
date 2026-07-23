import type { NormalizedContextEvent } from './types.js';
import { compareTimestampInstants } from '../util/timestamp.js';
import { isValidLogicalTurnId } from './logical-turn-id.js';

export interface LogicalTurnProjection {
  atoms: NormalizedContextEvent[];
  raw_observation_count: number;
  logical_turn_count: number;
  collapsed_observation_count: number;
  inherited_only_count: number;
}

function logicalKey(atom: NormalizedContextEvent): string | undefined {
  const conversation = atom.conversation;
  if (
    conversation === undefined ||
    !isValidLogicalTurnId(conversation.logical_turn_id) ||
    (conversation.observation_kind !== 'original' &&
      conversation.observation_kind !== 'inherited')
  ) {
    return undefined;
  }
  return `${conversation.provider}\u0000${conversation.logical_turn_id}`;
}

function observationPriority(atom: NormalizedContextEvent): number {
  switch (atom.conversation?.observation_kind) {
    case 'original':
      return 0;
    case 'unknown':
      return 1;
    case 'inherited':
      return 2;
    default:
      return 1;
  }
}

function observedAt(atom: NormalizedContextEvent): string {
  return atom.time.observed_at ?? atom.time.occurred_at;
}

function chooseRepresentative(
  observations: readonly NormalizedContextEvent[],
): NormalizedContextEvent {
  return [...observations].sort((left, right) => {
    const priority = observationPriority(left) - observationPriority(right);
    if (priority !== 0) return priority;
    const leftObserved = observedAt(left);
    const rightObserved = observedAt(right);
    const observedOrder = compareTimestampInstants(leftObserved, rightObserved);
    if (observedOrder !== 0) return observedOrder;
    return left.id.localeCompare(right.id);
  })[0]!;
}

/** Collapse physical observations onto provider-stable logical turns.
 *
 * Raw event ids remain the only ids exposed: the representative is always one
 * stored observation, so callers can hydrate it through get_atoms. The trace
 * layer filters by canonical occurrence time before this projection, so an
 * inherited-only group that reaches here is retained: its original may simply
 * be absent from this ledger.
 */
export function projectLogicalTurns(
  observations: readonly NormalizedContextEvent[],
): LogicalTurnProjection {
  const groups = new Map<string, NormalizedContextEvent[]>();
  const unkeyed: NormalizedContextEvent[] = [];
  for (const atom of observations) {
    const key = logicalKey(atom);
    if (key === undefined) {
      unkeyed.push(atom);
      continue;
    }
    const group = groups.get(key);
    if (group === undefined) groups.set(key, [atom]);
    else group.push(atom);
  }

  const projected: NormalizedContextEvent[] = [...unkeyed];
  let inheritedOnlyCount = 0;
  for (const group of groups.values()) {
    if (
      group.length > 0 &&
      group.every((atom) => atom.conversation?.observation_kind === 'inherited')
    ) {
      inheritedOnlyCount += group.length;
    }
    const representative = chooseRepresentative(group);
    let latestObserved = observedAt(representative);
    for (const atom of group) {
      const candidate = observedAt(atom);
      if (compareTimestampInstants(candidate, latestObserved) > 0) {
        latestObserved = candidate;
      }
    }
    projected.push({
      ...representative,
      time: {
        ...representative.time,
        observed_at: latestObserved,
      },
      provenance: {
        ...representative.provenance,
        raw_observation_count: group.length,
      },
    });
  }

  return {
    atoms: projected,
    raw_observation_count: observations.length,
    logical_turn_count: projected.length,
    collapsed_observation_count: observations.length - projected.length,
    inherited_only_count: inheritedOnlyCount,
  };
}
