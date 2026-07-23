// Item 038 / AC3: canonical home for the cluster-discovery engine.
//
// Moved from `src/mcp/tools/recent-work-context.ts` (where it was tangled
// with the now-deprecated MCP-tool wrapper). The engine is a strategy-
// internal helper — it's NOT exposed as an MCP tool. Its consumers are:
//   - `src/mcp/tools/find-clusters.ts` (the V1.6 split's discovery half)
//   - `src/mcp/tools/recent-work-context.ts` (deprecated; stays as a
//     wrapper until the 2026-05-17 follow-up removes the registration)
//
// `repo_path` is normalized once at engine entry and converted to the shared
// canonical project key used by all retrieval tools.

import { normalizeEvent } from '../../context-adapters/normalization.js';
import type { NormalizedContextEvent } from '../../normalize/types.js';
import {
  eventStoredBytes,
  StorageScanBudgetExceededError,
} from '../../storage/budgets.js';
import type { CaptureEvent, QueryFilter, Storage } from '../../storage/interface.js';
import { noUsefulCluster } from '../../trace/auto-expand.js';
import { buildRecentWorkContext, rankClusters, rankReasonsFor } from '../../trace/index.js';
import type {
  ArtifactHint,
  Query,
  RecentWorkContextResponse,
  ResponseFormat,
} from '../../trace/types.js';
import { withFsExclusion } from '../util/fs-exclusion.js';
import { hasTzMarker, TZ_NAIVE_WARNING } from '../util/iso8601.js';
import {
  assertAbsoluteRepoPath,
  normaliseRepoPath,
  projectKeyForRepoPath,
} from '../util/repo-path.js';
import { WIRE_SHAPE_CAPS } from '../wire-shape/caps.js';

// Cost-safer defaults (item 025): every retrieval today blew the consumer's
// 25k-char tool-result budget on first try (dogfooding 2026-05-08 entries
// 13:27 PDT and 14:43 PDT) even with explicit `format='minimal'`, `limit=50`.
// limit=20 produces ~22k envelopes on realistic 200-atom multi-file fixtures.
export const DEFAULT_LIMIT = 20;
export const MAX_LIMIT = 500;
export const DEFAULT_WINDOW_HOURS = 4;
export const STORAGE_OVERFETCH = 10;
export const CLUSTER_MAX_STORAGE_SCAN_WINDOWS = 16;
export const CLUSTER_STORAGE_PAGE_ROWS = 500;
export const CLUSTER_MAX_RAW_OBSERVATIONS = 4_000;
export const CLUSTER_MAX_RAW_STORED_BYTES = 32 * 1024 * 1024;

// V1.5.7 polish (2026-05-09): no-args resume auto-expand. The 4h default
// is right for "what just happened" but wrong for "where did I leave off
// after a quiet stretch."
export const NO_ARGS_AUTO_EXPAND_WINDOW_HOURS = 24;

// V1.5.6: re-export from the shared wire-shape caps table so all three
// retrieval tools see one source of truth.
export const MINIMAL_CONTENT_CAP = WIRE_SHAPE_CAPS.minimal_action;

export interface RecentWorkContextParams {
  since?: string;
  until?: string;
  artifact_hint?: ArtifactHint;
  limit?: number;
  window_hours?: number;
  format?: ResponseFormat;
  /** Item 037 / AC4: absolute project root path. When set, scopes the
   *  candidate set by canonical metadata.project_key, with bounded legacy
   *  fallback through canonical_root/repo_root. Cross-source; no source_app
   *  gating. */
  repo_path?: string;
}

export function truncateForMinimal(s: string | undefined): string | undefined {
  if (s === undefined) return undefined;
  if (s.length <= MINIMAL_CONTENT_CAP) return s;
  const dropped = s.length - MINIMAL_CONTENT_CAP;
  return (
    s.slice(0, MINIMAL_CONTENT_CAP) +
    `… [truncated; ${dropped} chars omitted; fetch full atom via search_memories]`
  );
}

function applyMinimal(atom: NormalizedContextEvent): NormalizedContextEvent {
  const input = truncateForMinimal(atom.action.input);
  const output = truncateForMinimal(atom.action.output);
  if (input === atom.action.input && output === atom.action.output) {
    return atom;
  }
  const nextAction: NormalizedContextEvent['action'] = { ...atom.action };
  if (input === undefined) delete nextAction.input;
  else nextAction.input = input;
  if (output === undefined) delete nextAction.output;
  else nextAction.output = output;
  return { ...atom, action: nextAction };
}

function clampLimit(input: number | undefined): number {
  if (input === undefined) return DEFAULT_LIMIT;
  const floored = Math.floor(input);
  return Math.min(Math.max(1, floored), MAX_LIMIT);
}

interface ClusterStoragePage {
  events: CaptureEvent[];
  scanTruncated: boolean;
  logicalCandidateCount: number;
  inputTruncationReason?: 'storage_windows' | 'raw_observations' | 'raw_bytes';
}

function sourceProvider(source: string): string {
  if (source.includes('/.codex/sessions/')) return 'codex';
  if (source.includes('/.claude/projects/')) return 'claude_code';
  return source.split(':', 1)[0] ?? source;
}

function logicalCandidateKey(
  event: CaptureEvent,
  since: string | undefined,
  until: string | undefined,
): string | undefined {
  const metadata = event.metadata;
  const occurred =
    typeof metadata?.['occurred_at'] === 'string'
      ? metadata['occurred_at']
      : event.timestamp;
  if (since !== undefined && occurred < since) return undefined;
  if (until !== undefined && occurred >= until) return undefined;
  if (metadata?.['observation_kind'] === 'inherited') return undefined;
  const logicalTurnId = metadata?.['logical_turn_id'];
  return typeof logicalTurnId === 'string'
    ? `${sourceProvider(event.source)}\u0000${logicalTurnId}`
    : `raw\u0000${event.id}`;
}

async function hydrateClusterMatches(
  storage: Storage,
  ids: readonly string[],
): Promise<CaptureEvent[]> {
  const events: CaptureEvent[] = [];
  for (let offset = 0; offset < ids.length; offset += 100) {
    events.push(...(await storage.getByIds(ids.slice(offset, offset + 100))));
  }
  return events;
}

function captureEventStoredBytes(event: CaptureEvent): number {
  const encodedMetadata =
    event.metadata === undefined ? null : (JSON.stringify(event.metadata) ?? null);
  return eventStoredBytes({
    id: event.id,
    source: event.source,
    timestamp: event.timestamp,
    content: event.content,
    metadataJson: encodedMetadata,
    embeddingBytes: (event.embedding?.length ?? 0) * Float32Array.BYTES_PER_ELEMENT,
  });
}

/** Continue a descending cluster query across a finite number of sparse
 * descriptor windows. This consumes the storage adapter's lossless
 * `matched_ids + resume_cursor` contract without exposing the hard scan
 * boundary as an MCP failure. */
async function queryClusterEvents(
  storage: Storage,
  filter: QueryFilter,
  requested: number,
): Promise<ClusterStoragePage> {
  const events: CaptureEvent[] = [];
  const seen = new Set<string>();
  const logicalCandidates = new Set<string>();
  let retainedBytes = 0;
  let before = filter.before;

  const finish = (
    scanTruncated: boolean,
    inputTruncationReason?: ClusterStoragePage['inputTruncationReason'],
  ): ClusterStoragePage => {
    events.sort(compareCaptureEventsNewestFirst);
    return {
      events,
      scanTruncated,
      logicalCandidateCount: logicalCandidates.size,
      ...(inputTruncationReason !== undefined ? { inputTruncationReason } : {}),
    };
  };

  const appendUnique = (
    rows: readonly CaptureEvent[],
  ): ClusterStoragePage['inputTruncationReason'] => {
    for (const event of rows) {
      if (seen.has(event.id)) continue;
      if (events.length >= CLUSTER_MAX_RAW_OBSERVATIONS) {
        return 'raw_observations';
      }
      const storedBytes = captureEventStoredBytes(event);
      if (retainedBytes + storedBytes > CLUSTER_MAX_RAW_STORED_BYTES) {
        return 'raw_bytes';
      }
      seen.add(event.id);
      events.push(event);
      retainedBytes += storedBytes;
      const logicalKey = logicalCandidateKey(event, filter.since, filter.until);
      if (logicalKey !== undefined) logicalCandidates.add(logicalKey);
    }
    return undefined;
  };

  for (let window = 0; window < CLUSTER_MAX_STORAGE_SCAN_WINDOWS; window += 1) {
    const remaining = requested - logicalCandidates.size;
    if (remaining <= 0) {
      return finish(false);
    }
    const pageLimit = Math.min(
      CLUSTER_STORAGE_PAGE_ROWS,
      Math.max(remaining, Math.min(requested, 100)),
    );
    try {
      const rows = await storage.query({ ...filter, before, limit: pageLimit });
      const truncationReason = appendUnique(rows);
      if (truncationReason !== undefined) {
        const truncated = logicalCandidates.size < requested;
        return finish(truncated, truncated ? truncationReason : undefined);
      }
      if (logicalCandidates.size >= requested || rows.length < pageLimit) {
        return finish(false);
      }
      const last = rows[rows.length - 1];
      if (last === undefined) break;
      before = { timestamp: last.timestamp, id: last.id };
    } catch (error) {
      if (!(error instanceof StorageScanBudgetExceededError)) throw error;
      const truncationReason = appendUnique(
        await hydrateClusterMatches(storage, error.matched_ids),
      );
      if (truncationReason !== undefined) {
        const truncated = logicalCandidates.size < requested;
        return finish(truncated, truncated ? truncationReason : undefined);
      }
      before = error.resume_cursor;
    }
  }

  const truncated = logicalCandidates.size < requested;
  return finish(truncated, truncated ? 'storage_windows' : undefined);
}

function compareCaptureEventsNewestFirst(left: CaptureEvent, right: CaptureEvent): number {
  if (left.timestamp < right.timestamp) return 1;
  if (left.timestamp > right.timestamp) return -1;
  if (left.id < right.id) return 1;
  if (left.id > right.id) return -1;
  return 0;
}

// Thread continuity is independent of retrieval lookback. Auto-expanding a
// candidate window must not silently turn a four-hour work gap into a 24-hour
// merge gap.
export function inferWindowHours(
  _sinceMs: number,
  _untilMs: number,
  explicit: number | undefined,
): number {
  if (explicit !== undefined) return explicit;
  return DEFAULT_WINDOW_HOURS;
}

// Single-pass query + trace build. Extracted so the no-args auto-expand
// path can call it twice (4h, then 24h) without duplicating the storage
// query / cap-warning logic.
async function runRecentWorkContextPass(
  storage: Storage,
  since: string,
  until: string,
  limit: number,
  windowHours: number,
  format: ResponseFormat,
  artifactHint: ArtifactHint | undefined,
  normalisedRepoPath: string | null,
): Promise<RecentWorkContextResponse> {
  const storageCap = limit * STORAGE_OVERFETCH;
  // Historical raw-fs exclusion uses one shared retrieval helper.
  const storagePage = await queryClusterEvents(
    storage,
    withFsExclusion({
      since,
      until,
      // Item 037 / AC4: cross-source canonical project scoping. Storage uses
      // explicit project_key first, then bounded legacy canonical/root fields.
      ...(normalisedRepoPath !== null
        ? { project_key: projectKeyForRepoPath(normalisedRepoPath) }
        : {}),
    }),
    storageCap,
  );
  const events = storagePage.events;

  const query: Query = {
    since,
    until,
    limit,
    window_hours: windowHours,
    format,
  };
  if (artifactHint !== undefined) {
    query.artifact_hint = artifactHint;
  }
  if (normalisedRepoPath !== null) {
    query.repo_path = normalisedRepoPath;
  }

  const response = buildRecentWorkContext(events, query, normalizeEvent);

  // Storage-cap silent-truncation guard. When the storage query returned
  // exactly `limit * STORAGE_OVERFETCH` rows, additional in-window atoms may
  // have been silently dropped at the storage layer; surface a single warning
  // so the consumer can raise `limit` or narrow `(since, until)`.
  if (storagePage.logicalCandidateCount >= storageCap) {
    response.truncation.truncated = true;
    response.warnings.push(
      'storage cap hit (logical candidates >= limit * STORAGE_OVERFETCH); ' +
        'logical turns in window may be truncated. ' +
        'Raise limit or narrow (since, until) to retain them.',
    );
  }
  if (storagePage.scanTruncated) {
    response.truncation.truncated = true;
    if (storagePage.inputTruncationReason === 'storage_windows') {
      response.warnings.push(
        `[STORAGE_SCAN_BUDGET] cluster input exhausted ${CLUSTER_MAX_STORAGE_SCAN_WINDOWS} bounded storage windows; clusters may omit older matching atoms. Narrow since/until/repo scope and retry.`,
      );
    } else {
      const budget =
        storagePage.inputTruncationReason === 'raw_bytes'
          ? `${CLUSTER_MAX_RAW_STORED_BYTES} retained bytes`
          : `${CLUSTER_MAX_RAW_OBSERVATIONS} raw observations`;
      response.warnings.push(
        `[STORAGE_INPUT_BUDGET] cluster input reached its bounded ${budget}; clusters may omit older matching atoms. Narrow since/until/repo scope and retry.`,
      );
    }
  }

  return response;
}

/**
 * Core cluster-discovery engine. Returns clusters of related events from the
 * captured atom stream, joined by shared artifacts within a recent time window.
 * Honours the no-args 4h→24h auto-expand (with single-source-recent demotion),
 * historical raw-fs exclusion, repo_path forwarding (item 037), and minimal-mode
 * content trimming.
 *
 * Strategy-internal: NOT exposed as an MCP tool. The two consumers are
 * `find_clusters` (bodyless discovery, the V1.6 split) and the deprecated
 * `recent_work_context` wrapper (kept until the 2026-05-17 follow-up).
 */
export async function getRecentWorkContext(
  storage: Storage,
  params: RecentWorkContextParams,
  now: Date = new Date(),
): Promise<RecentWorkContextResponse> {
  const limit = clampLimit(params.limit);
  const windowMs = DEFAULT_WINDOW_HOURS * 60 * 60 * 1000;
  const until = params.until ?? now.toISOString();
  const since = params.since ?? new Date(Date.parse(until) - windowMs).toISOString();
  // Default flipped to 'minimal' (item 025): full content envelopes routinely
  // exceed the consumer's 25k-char tool-result budget on first call.
  const format: ResponseFormat = params.format ?? 'minimal';

  // Item 037 / AC4: validate + normalise repo_path before either pass.
  let normalisedRepoPath: string | null = null;
  if (params.repo_path !== undefined) {
    assertAbsoluteRepoPath('get_recent_work_context', params.repo_path);
    normalisedRepoPath = normaliseRepoPath(params.repo_path);
  }

  const sinceMs = Date.parse(since);
  const untilMs = Date.parse(until);
  const windowHours = inferWindowHours(sinceMs, untilMs, params.window_hours);

  let response = await runRecentWorkContextPass(
    storage,
    since,
    until,
    limit,
    windowHours,
    format,
    params.artifact_hint,
    normalisedRepoPath,
  );

  // V1.5.7 polish (2026-05-09) + item 032 (2026-05-10): no-args auto-expand
  // with generalized trigger predicate (empty or single-source-recent).
  const isNoArgsShape = params.since === undefined && params.until === undefined;
  if (isNoArgsShape && NO_ARGS_AUTO_EXPAND_WINDOW_HOURS > DEFAULT_WINDOW_HOURS) {
    const nowMs = now.getTime();
    const atomsByIdFor = (r: RecentWorkContextResponse): Map<string, NormalizedContextEvent> =>
      new Map(Object.entries(r.atoms));
    const fourHourClustersAreUseless = noUsefulCluster(
      response.clusters,
      atomsByIdFor(response),
      nowMs,
    );
    if (fourHourClustersAreUseless) {
      const trigger: 'empty' | 'single-source-recent' =
        response.clusters.length === 0 ? 'empty' : 'single-source-recent';

      const expandedWindowMs = NO_ARGS_AUTO_EXPAND_WINDOW_HOURS * 60 * 60 * 1000;
      const expandedSince = new Date(Date.parse(until) - expandedWindowMs).toISOString();
      const expandedSinceMs = Date.parse(expandedSince);
      const expandedWindowHours = inferWindowHours(expandedSinceMs, untilMs, params.window_hours);
      response = await runRecentWorkContextPass(
        storage,
        expandedSince,
        until,
        limit,
        expandedWindowHours,
        format,
        params.artifact_hint,
        normalisedRepoPath,
      );

      // Apply the rank demotion ONLY when the single-source-recent trigger
      // fired. Strict-partition rank rule from item 032.
      if (trigger === 'single-source-recent') {
        const atomsById24h = atomsByIdFor(response);
        const queryEcho: Query = {
          since: response.query.since,
          until: response.query.until,
          limit,
          window_hours: response.query.window_hours,
          format,
        };
        if (params.artifact_hint !== undefined) {
          queryEcho.artifact_hint = params.artifact_hint;
        }
        if (normalisedRepoPath !== null) {
          queryEcho.repo_path = normalisedRepoPath;
        }
        const reranked = rankClusters(response.clusters, atomsById24h, queryEcho, {
          demoteSingleSourceRecent: true,
          nowMs,
        });
        reranked.forEach((c, i) => {
          c.rank = i + 1;
          c.rank_reason = rankReasonsFor(c, atomsById24h, queryEcho);
        });
        response.clusters = reranked;
      }

      response.warnings.push(
        `[AUTO_EXPAND] ${trigger} no-args call: 4h default ${
          trigger === 'empty'
            ? 'returned 0 clusters'
            : "returned only single-source-recent clusters (likely the calling session's own activity)"
        }; auto-expanded to ${NO_ARGS_AUTO_EXPAND_WINDOW_HOURS}h. ` +
          'Pass explicit `since`/`until` to suppress this fallback.',
      );
    }
  }

  // TZ-naive warning — caller passed timestamps without TZ markers.
  if (
    (params.since !== undefined && !hasTzMarker(params.since)) ||
    (params.until !== undefined && !hasTzMarker(params.until))
  ) {
    response.warnings.push(TZ_NAIVE_WARNING);
  }

  if (format === 'minimal') {
    const minimalAtoms: Record<string, NormalizedContextEvent> = {};
    for (const [id, atom] of Object.entries(response.atoms)) {
      minimalAtoms[id] = applyMinimal(atom);
    }
    return { ...response, atoms: minimalAtoms };
  }

  return response;
}
