import type {
  ActorRef,
  ConversationRef,
  NormalizedContextEvent,
  ObservedState,
  ProjectRef,
} from '../../../src/normalize/types.js';

export interface AtomSpec {
  id: string;
  app: string;
  occurred_at: string;
  observed_at?: string;
  artifacts: { provider: string; type: string; id: string; label?: string }[];
  verb?: string;
  kind?: string;
  input?: string;
  output?: string;
  hints?: string[];
  actors?: ActorRef[];
  state?: ObservedState;
  conversation?: ConversationRef;
  project?: ProjectRef;
}

export function makeAtom(spec: AtomSpec): NormalizedContextEvent {
  const out: NormalizedContextEvent = {
    schema_version: 1,
    id: spec.id,
    time: {
      occurred_at: spec.occurred_at,
      ...(spec.observed_at !== undefined ? { observed_at: spec.observed_at } : {}),
    },
    source: { app: spec.app, raw_pointer: `fs:fixture/${spec.id}` },
    actors: spec.actors ?? [{ role: 'user' }],
    action: {
      kind: spec.kind ?? 'message',
    },
    artifacts: spec.artifacts.map((a) => ({
      type: a.type,
      provider: a.provider,
      id: a.id,
      ...(a.label !== undefined ? { label: a.label } : {}),
    })),
    provenance: {
      source_event_id: spec.id,
      raw_payload_hash: 'fixture',
      extractor_version: 'fixture@1',
    },
  };
  if (spec.verb !== undefined) out.action.verb = spec.verb;
  if (spec.input !== undefined) out.action.input = spec.input;
  if (spec.output !== undefined) out.action.output = spec.output;
  if (spec.hints !== undefined && spec.hints.length > 0) {
    out.open_loop_hints = spec.hints;
  }
  if (spec.state !== undefined) out.state = spec.state;
  if (spec.conversation !== undefined) out.conversation = spec.conversation;
  if (spec.project !== undefined) out.project = spec.project;
  return out;
}
