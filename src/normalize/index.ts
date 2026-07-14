import type { CaptureEvent } from '../storage/interface.js';
import { findAdapter } from './dispatch.js';
import type { NormalizedContextEvent } from './types.js';

export type {
  Adapter,
  AdapterRegistration,
  ActionRef,
  ActorRef,
  ArtifactRef,
  ContextRef,
  ConversationRef,
  DeltaRef,
  NormalizedContextEvent,
  ObservedState,
  ProvenanceRef,
  SnapshotRef,
  SourceRef,
  TimeRef,
} from './types.js';
export { NormalizationError } from './errors.js';
export {
  branchArtifact,
  commitArtifact,
  conversationArtifact,
  fileArtifact,
  normalizeRemoteUrl,
  repoArtifact,
} from './artifacts.js';
export { findAdapter, getRegistry } from './dispatch.js';

export function normalizeEvent(event: CaptureEvent): NormalizedContextEvent | null {
  const reg = findAdapter(event.source);
  if (reg === null) return null;
  return reg.adapter(event);
}

export function normalizeEvents(events: CaptureEvent[]): NormalizedContextEvent[] {
  const out: NormalizedContextEvent[] = [];
  for (const e of events) {
    const n = normalizeEvent(e);
    if (n !== null) out.push(n);
  }
  return out;
}
