import type { CaptureEvent, EventId } from '../storage/interface.js';

export interface NormalizedContextEvent {
  schema_version: 1;
  id: EventId;
  time: TimeRef;
  source: SourceRef;
  actors: ActorRef[];
  action: ActionRef;
  artifacts: ArtifactRef[];
  context?: ContextRef;
  state?: ObservedState;
  conversation?: ConversationRef;
  open_loop_hints?: string[];
  provenance: ProvenanceRef;
  warnings?: string[];
}

export interface TimeRef {
  occurred_at: string;
  observed_at?: string;
  duration_ms?: number;
}

export interface SourceRef {
  app: string;
  surface?: string;
  account?: string;
  raw_pointer: string;
}

export interface ActorRef {
  role: string;
  name?: string;
  model?: string;
  provider?: string;
}

export interface ActionRef {
  kind: string;
  verb?: string;
  input?: string;
  output?: string;
  status?: string;
}

export interface ArtifactRef {
  type: string;
  provider: string;
  id: string;
  label?: string;
  locator?: string;
}

export interface ContextRef {
  visible?: string[];
  selected?: string;
  ambient?: Record<string, string>;
}

export interface SnapshotRef {
  artifact_id: string;
  hash?: string;
  summary?: string;
}

export interface DeltaRef {
  artifact_id: string;
  kind: string;
  detail?: string;
}

export type ObservedState =
  | { snapshot: SnapshotRef; delta?: never }
  | { delta: DeltaRef; snapshot?: never };

export interface ConversationRef {
  provider: string;
  session_id: string;
  turn_index?: number;
  parent_event_id?: EventId;
}

export interface ProvenanceRef {
  source_event_id: EventId;
  raw_payload_hash: string;
  extractor_version: string;
  redacted_fields?: string[];
  parse_warnings?: string[];
}

export type Adapter = (event: CaptureEvent) => NormalizedContextEvent | null;

export interface AdapterRegistration {
  name: string;
  version: string;
  matches: (source: string) => boolean;
  adapter: Adapter;
}
