import type { EventId, Storage } from '../storage/interface.js';
import { createHash } from 'node:crypto';
import { gate, type RejectionReason } from './gate.js';
import { _isAllowedPathIn, normalizeRepoPath } from './sources.js';
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

export interface ExtractorFilesystemScope {
  /** Directory roots. Descendants and the root itself are accepted. */
  roots?: readonly string[];
  /** Individual files. Only normalized exact equality is accepted. */
  files?: readonly string[];
}

/**
 * Build a private fs-only source policy for one extractor instance.
 *
 * Runtime path overrides must not mutate CAPTURED_SOURCES: doing so would
 * silently widen POST /v1/capture and every unrelated capture surface. The
 * returned policy is instead closed over a snapshot of only that extractor's
 * configured roots/files and is passed directly to processCandidateWithPolicy.
 */
export function createExtractorFilesystemPolicy(
  scope: ExtractorFilesystemScope,
): CaptureSourcePolicy<'unknown_path'> {
  const roots = [...(scope.roots ?? [])];
  const exactFiles = new Set((scope.files ?? []).map(normalizeRepoPath));
  return Object.freeze({
    validateSource(source: string) {
      if (!source.startsWith('fs:') || source.length <= 'fs:'.length) {
        return { accepted: false, reason: 'unknown_path' } as const;
      }
      const path = source.slice('fs:'.length);
      if (
        exactFiles.has(normalizeRepoPath(path)) ||
        _isAllowedPathIn(path, roots)
      ) {
        return { accepted: true, reason: 'allowlisted' } as const;
      }
      return { accepted: false, reason: 'unknown_path' } as const;
    },
  });
}

export function processExtractorCandidate(
  event: unknown,
  storage: Storage,
  policy: CaptureSourcePolicy<'unknown_path'>,
): Promise<PipelineResult> {
  return processCandidateWithPolicy(event, storage, policy);
}

export function captureDedupeKey(
  extractor: 'codex' | 'claude-code',
  parts: readonly (string | number)[],
): string {
  const digest = createHash('sha256')
    .update(JSON.stringify(parts))
    .digest('hex');
  return `${extractor}:${digest}`;
}

const GATE_ACCEPTED_POLICY: CaptureSourcePolicy<never> = Object.freeze({
  validateSource: () => ({ accepted: true, reason: 'allowlisted' }) as const,
});

export async function processCandidate(event: unknown, storage: Storage): Promise<PipelineResult> {
  const gated = gate(event);
  if (!gated.accepted) return gated;
  return processCandidateWithPolicy(event, storage, GATE_ACCEPTED_POLICY);
}
