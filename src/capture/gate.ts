import { isNonEmptyString } from '../guards.js';
import { createLogger } from '../logging/index.js';
import {
  isAllowedApi,
  isAllowedApp,
  isAllowedDomain,
  isAllowedPath,
  isAllowedRepo,
} from './sources.js';

export interface CandidateEvent {
  source: string;
  timestamp: string;
  content: string;
  metadata?: Record<string, unknown>;
}

export type RejectionReason =
  | 'unknown_app'
  | 'unknown_domain'
  | 'unknown_path'
  | 'unknown_api'
  | 'unknown_repo'
  | 'malformed_event';

export type GateResult =
  | { accepted: true; reason: 'allowlisted' }
  | { accepted: false; reason: RejectionReason };

type SourceKind = 'app' | 'domain' | 'fs' | 'api' | 'git';

const log = createLogger('capture.gate');

const SOURCE_KIND_TO_REJECTION: Record<
  SourceKind,
  Extract<RejectionReason, `unknown_${string}`>
> = {
  app: 'unknown_app',
  domain: 'unknown_domain',
  fs: 'unknown_path',
  api: 'unknown_api',
  git: 'unknown_repo',
};

const SOURCE_KIND_TO_PREDICATE: Record<SourceKind, (id: string) => boolean> = {
  app: isAllowedApp,
  domain: isAllowedDomain,
  fs: isAllowedPath,
  api: isAllowedApi,
  git: isAllowedRepo,
};

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function parseSource(source: string): { kind: SourceKind; id: string } | null {
  const sep = source.indexOf(':');
  if (sep <= 0 || sep === source.length - 1) return null;
  const kind = source.slice(0, sep);
  const id = source.slice(sep + 1);
  if (
    kind === 'app' ||
    kind === 'domain' ||
    kind === 'fs' ||
    kind === 'api' ||
    kind === 'git'
  ) {
    return { kind, id };
  }
  return null;
}

export function gate(event: unknown): GateResult {
  if (!isPlainObject(event)) {
    log.warn('rejected', { reason: 'malformed_event' });
    return { accepted: false, reason: 'malformed_event' };
  }

  const { source, timestamp, content, metadata } = event;

  if (!isNonEmptyString(source) || !isNonEmptyString(timestamp) || typeof content !== 'string') {
    log.warn('rejected', {
      reason: 'malformed_event',
      source: typeof source === 'string' ? source : undefined,
    });
    return { accepted: false, reason: 'malformed_event' };
  }

  if (metadata !== undefined && !isPlainObject(metadata)) {
    log.warn('rejected', { reason: 'malformed_event', source });
    return { accepted: false, reason: 'malformed_event' };
  }

  const parsed = parseSource(source);
  if (parsed === null) {
    log.warn('rejected', { reason: 'malformed_event', source });
    return { accepted: false, reason: 'malformed_event' };
  }

  if (SOURCE_KIND_TO_PREDICATE[parsed.kind](parsed.id)) {
    log.info('accepted', { source, timestamp });
    return { accepted: true, reason: 'allowlisted' };
  }

  const reason = SOURCE_KIND_TO_REJECTION[parsed.kind];
  log.warn('rejected', { reason, source });
  return { accepted: false, reason };
}
