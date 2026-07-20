import { isNonEmptyString } from '../guards.js';
import { createLogger } from '../logging/index.js';
import type { CaptureEvent, EventId, Storage } from '../storage/interface.js';

const log = createLogger('capture.pipeline-core');
const TZ_MARKER_RE = /Z$|[+-]\d{2}(?::?\d{2})?$/;

export interface CandidateEvent {
  source: string;
  timestamp: string;
  content: string;
  metadata?: Record<string, unknown>;
  dedupe_key?: string;
}

export type CandidateShapeRejection = 'malformed_event';
export type PipelineCoreRejection = CandidateShapeRejection | 'invalid_timestamp';

export interface CaptureSourcePolicy<Reason extends string = string> {
  validateSource(
    source: string,
  ):
    | { accepted: true; reason: 'allowlisted' }
    | { accepted: false; reason: Reason };
}

export type PipelineCoreResult<Reason extends string> =
  | { accepted: true; id: EventId }
  | { accepted: false; reason: PipelineCoreRejection | Reason };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function validateCandidateShape(
  event: unknown,
):
  | { accepted: true; event: CandidateEvent }
  | { accepted: false; reason: CandidateShapeRejection } {
  if (!isPlainObject(event)) return { accepted: false, reason: 'malformed_event' };
  const { source, timestamp, content, metadata, dedupe_key: dedupeKey } = event;
  if (!isNonEmptyString(source) || !isNonEmptyString(timestamp) || typeof content !== 'string') {
    return { accepted: false, reason: 'malformed_event' };
  }
  if (metadata !== undefined && !isPlainObject(metadata)) {
    return { accepted: false, reason: 'malformed_event' };
  }
  if (dedupeKey !== undefined && !isNonEmptyString(dedupeKey)) {
    return { accepted: false, reason: 'malformed_event' };
  }
  return {
    accepted: true,
    event: {
      source,
      timestamp,
      content,
      ...(metadata !== undefined ? { metadata } : {}),
      ...(dedupeKey !== undefined ? { dedupe_key: dedupeKey } : {}),
    },
  };
}

export function canonicalizeTimestamp(timestamp: string): string {
  const withTz = TZ_MARKER_RE.test(timestamp) ? timestamp : `${timestamp}Z`;
  return new Date(withTz).toISOString();
}

export async function processCandidateWithPolicy<Reason extends string>(
  candidate: unknown,
  storage: Storage,
  policy: CaptureSourcePolicy<Reason>,
): Promise<PipelineCoreResult<Reason>> {
  const shaped = validateCandidateShape(candidate);
  if (!shaped.accepted) {
    log.warn('rejected', { reason: shaped.reason });
    return shaped;
  }
  const sourceResult = policy.validateSource(shaped.event.source);
  if (!sourceResult.accepted) {
    log.warn('rejected', { reason: sourceResult.reason, source: shaped.event.source });
    return sourceResult;
  }
  const withTz = TZ_MARKER_RE.test(shaped.event.timestamp)
    ? shaped.event.timestamp
    : `${shaped.event.timestamp}Z`;
  if (Number.isNaN(new Date(withTz).getTime())) {
    log.warn('rejected', { reason: 'invalid_timestamp', source: shaped.event.source });
    return { accepted: false, reason: 'invalid_timestamp' };
  }
  const toAppend: Omit<CaptureEvent, 'id'> = {
    source: shaped.event.source,
    timestamp: canonicalizeTimestamp(shaped.event.timestamp),
    content: shaped.event.content,
  };
  if (shaped.event.metadata !== undefined) toAppend.metadata = shaped.event.metadata;
  const id = await storage.append(
    toAppend,
    shaped.event.dedupe_key !== undefined
      ? { dedupeKey: shaped.event.dedupe_key }
      : undefined,
  );
  return { accepted: true, id };
}
