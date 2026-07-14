import type { EventId, Storage } from '../storage/interface.js';
import { gate, type RejectionReason } from './gate.js';
import {
  canonicalizeTimestamp,
  processCandidateWithPolicy,
  type CaptureSourcePolicy,
} from './pipeline-core.js';

/** Gate rejections plus the pipeline's own post-gate canonicalization
 *  rejection: the gate only requires a non-empty timestamp string, so an
 *  unparseable instant (e.g. "n/a") is detected here, not there. */
export type PipelineRejectionReason = RejectionReason | 'invalid_timestamp';

export type PipelineResult =
  | { accepted: true; id: EventId }
  | { accepted: false; reason: PipelineRejectionReason };

export { canonicalizeTimestamp };

const GATE_ACCEPTED_POLICY: CaptureSourcePolicy<never> = Object.freeze({
  validateSource: () => ({ accepted: true, reason: 'allowlisted' }) as const,
});

export async function processCandidate(event: unknown, storage: Storage): Promise<PipelineResult> {
  const gated = gate(event);
  if (!gated.accepted) return gated;
  return processCandidateWithPolicy(event, storage, GATE_ACCEPTED_POLICY);
}
