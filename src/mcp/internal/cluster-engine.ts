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
  StorageBudgetExceededError,
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
  resolveRepoPath,
  type ResolvedRepoPath,
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
export const CLUSTER_MAX_DELAYED_STORAGE_SCAN_WINDOWS = 4;
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
  logicalCandidateCount: number;
  onTimeTruncationReason?: ClusterInputTruncationReason;
  delayedTruncationReason?: ClusterInputTruncationReason;
}

interface CandidateWindow {
  sinceMs?: number;
  untilMs?: number;
}

const LOCAL_WORKSPACE_PROJECT_PREFIX = 'local:workspace:';

/** A repo-scoped storage query deliberately admits pre-project-identity rows
 * through their legacy repo_root. Normalize only those admitted legacy rows
 * onto the query's authoritative local-workspace identity before adapters run.
 * This keeps nested historical working directories in one project partition
 * while preserving the actually observed root for provenance. Rows carrying
 * either explicit identity field remain authoritative and are never changed. */
function normalizeLegacyProjectObservation(
  event: CaptureEvent,
  projectKey: string | undefined,
): CaptureEvent {
  if (
    projectKey === undefined ||
    !projectKey.startsWith(LOCAL_WORKSPACE_PROJECT_PREFIX)
  ) {
    return event;
  }
  const canonicalRoot = projectKey.slice(LOCAL_WORKSPACE_PROJECT_PREFIX.length);
  if (canonicalRoot.length === 0) return event;

  const metadata = event.metadata;
  if (
    metadata === undefined ||
    Object.prototype.hasOwnProperty.call(metadata, 'project_key') ||
    Object.prototype.hasOwnProperty.call(metadata, 'canonical_root')
  ) {
    return event;
  }
  const observedRoot = metadata['repo_root'];
  if (typeof observedRoot !== 'string') return event;

  return {
    ...event,
    metadata: {
      ...metadata,
      project_key: projectKey,
      canonical_root: canonicalRoot,
      observed_root: observedRoot,
    },
  };
}

interface LogicalCandidateInspection {
  inWindow: boolean;
  logicalKey?: string;
}

function inspectLogicalCandidate(
  event: CaptureEvent,
  window: CandidateWindow,
): LogicalCandidateInspection {
  let atom: NormalizedContextEvent | null;
  try {
    atom = normalizeEvent(event);
  } catch {
    return { inWindow: false };
  }
  if (atom === null) return { inWindow: false };

  const occurredMs = Date.parse(atom.time.occurred_at);
  if (Number.isNaN(occurredMs)) return { inWindow: false };
  if (window.sinceMs !== undefined && occurredMs < window.sinceMs) {
    return { inWindow: false };
  }
  if (window.untilMs !== undefined && occurredMs >= window.untilMs) {
    return { inWindow: false };
  }
  const conversation = atom.conversation;
  // Mirror projectLogicalTurns' fail-closed identity contract exactly:
  // inherited rows remain available as representatives but cannot satisfy the
  // early-stop target before an older stored original is fetched. Unknown or
  // absent observation markers remain distinct physical candidates even when
  // they carry a syntactically valid logical id.
  if (conversation?.observation_kind === 'inherited') {
    return { inWindow: true };
  }
  const logicalTurnId = conversation?.logical_turn_id;
  if (
    conversation?.observation_kind === 'original' &&
    logicalTurnId !== undefined
  ) {
    return {
      inWindow: true,
      logicalKey: `${conversation.provider}\u0000${logicalTurnId}`,
    };
  }
  return { inWindow: true, logicalKey: `raw\u0000${event.id}` };
}

function isRequestTooLarge(
  error: unknown,
  operation: 'query' | 'getByIds',
): error is StorageBudgetExceededError {
  return (
    error instanceof StorageBudgetExceededError &&
    error.code === 'request_too_large' &&
    error.operation === operation
  );
}

interface AdaptiveQueryPage {
  rows: CaptureEvent[];
  rowLimit: number;
}

/** SQLite admits payload bytes only after its bounded descriptor pass. A row
 * request can therefore be count-safe but byte-unsafe. Retry the same keyset
 * boundary with a smaller row limit until one byte-safe page is available;
 * the caller advances only after that successful page, so no row is skipped. */
async function queryClusterPage(
  storage: Storage,
  filter: QueryFilter,
  rowLimit: number,
): Promise<AdaptiveQueryPage> {
  try {
    return {
      rows: await storage.query({ ...filter, limit: rowLimit }),
      rowLimit,
    };
  } catch (error) {
    if (!isRequestTooLarge(error, 'query') || rowLimit <= 1) throw error;
    return queryClusterPage(storage, filter, Math.max(1, Math.floor(rowLimit / 2)));
  }
}

type ClusterInputTruncationReason =
  'storage_windows' | 'raw_observations' | 'raw_bytes';
type ClusterRowConsumer = (
  rows: readonly CaptureEvent[],
) => ClusterInputTruncationReason | undefined;

async function hydrateClusterIdBatch(
  storage: Storage,
  ids: readonly string[],
  consume: ClusterRowConsumer,
): Promise<ClusterInputTruncationReason | undefined> {
  if (ids.length === 0) return undefined;
  try {
    return consume(await storage.getByIds(ids));
  } catch (error) {
    if (!isRequestTooLarge(error, 'getByIds') || ids.length <= 1) throw error;
    const middle = Math.floor(ids.length / 2);
    const leftReason = await hydrateClusterIdBatch(storage, ids.slice(0, middle), consume);
    if (leftReason !== undefined) return leftReason;
    return hydrateClusterIdBatch(storage, ids.slice(middle), consume);
  }
}

/** Hydrate sparse-scan matches in input-budgeted increments. Adaptive binary
 * splitting handles variable row sizes, and consuming each successful batch
 * immediately prevents the combined hydrated set from exceeding the cluster
 * engine's retained-byte ceiling in memory. */
async function hydrateClusterMatches(
  storage: Storage,
  ids: readonly string[],
  consume: ClusterRowConsumer,
): Promise<ClusterInputTruncationReason | undefined> {
  for (let offset = 0; offset < ids.length; offset += 100) {
    const reason = await hydrateClusterIdBatch(
      storage,
      ids.slice(offset, offset + 100),
      consume,
    );
    if (reason !== undefined) return reason;
  }
  return undefined;
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

interface ClusterLaneScan {
  filter: QueryFilter;
  maxWindows: number;
  order: 'asc' | 'desc';
}

/** Retrieve cluster input through two bounded physical-time lanes. The first
 * lane is the indexed, authoritative `[since, until)` observation window. It
 * always runs first, so an unbounded tail of newer observations cannot evict
 * historical on-time results. Once that lane is exhausted, a smaller
 * ascending lane scans observations captured at or after `until` and retains
 * only those whose normalized occurrence time belongs to the requested
 * window. Both lanes consume sparse-storage resume cursors and share the same
 * retained row/byte ceilings; irrelevant delayed rows consume only the
 * delayed scan-window budget, never the retained-input budget. */
async function queryClusterEvents(
  storage: Storage,
  filter: QueryFilter,
  requested: number,
): Promise<ClusterStoragePage> {
  const events: CaptureEvent[] = [];
  const seen = new Set<string>();
  const logicalCandidates = new Set<string>();
  const candidateWindow: CandidateWindow = {
    ...(filter.since !== undefined
      ? { sinceMs: Date.parse(filter.since) }
      : {}),
    ...(filter.until !== undefined
      ? { untilMs: Date.parse(filter.until) }
      : {}),
  };
  let retainedBytes = 0;

  const appendUnique = (
    rows: readonly CaptureEvent[],
  ): ClusterInputTruncationReason | undefined => {
    for (const storedEvent of rows) {
      if (seen.has(storedEvent.id)) continue;
      const event = normalizeLegacyProjectObservation(
        storedEvent,
        filter.project_key,
      );
      const inspection = inspectLogicalCandidate(event, candidateWindow);
      seen.add(event.id);
      // Physical timestamp filters select observations; clustering selects
      // logical work. An inherited observation captured inside the indexed
      // lane can describe work that occurred outside the requested window.
      // Reject it before either retained-input ceiling is charged so an
      // irrelevant large-copy burst cannot evict valid in-window work.
      if (!inspection.inWindow) continue;
      if (events.length >= CLUSTER_MAX_RAW_OBSERVATIONS) {
        return 'raw_observations';
      }
      const storedBytes = captureEventStoredBytes(event);
      if (retainedBytes + storedBytes > CLUSTER_MAX_RAW_STORED_BYTES) {
        return 'raw_bytes';
      }
      events.push(event);
      retainedBytes += storedBytes;
      if (inspection.logicalKey !== undefined) {
        logicalCandidates.add(inspection.logicalKey);
      }
    }
    return undefined;
  };

  const scanLane = async (
    lane: ClusterLaneScan,
  ): Promise<ClusterInputTruncationReason | undefined> => {
    let cursor = lane.order === 'desc' ? lane.filter.before : lane.filter.after;
    let byteSafePageRows = CLUSTER_STORAGE_PAGE_ROWS;
    const consume: ClusterRowConsumer = appendUnique;

    for (let window = 0; window < lane.maxWindows; window += 1) {
      const remaining = requested - logicalCandidates.size;
      if (remaining <= 0) return undefined;
      const pageLimit = Math.min(
        byteSafePageRows,
        CLUSTER_STORAGE_PAGE_ROWS,
        Math.max(remaining, Math.min(requested, 100)),
      );
      try {
        const page = await queryClusterPage(
          storage,
          {
            ...lane.filter,
            ...(lane.order === 'desc' ? { before: cursor } : { after: cursor }),
          },
          pageLimit,
        );
        byteSafePageRows = Math.min(byteSafePageRows, page.rowLimit);
        const truncationReason = consume(page.rows);
        if (truncationReason !== undefined) {
          return logicalCandidates.size < requested
            ? truncationReason
            : undefined;
        }
        if (
          logicalCandidates.size >= requested ||
          page.rows.length < page.rowLimit
        ) {
          return undefined;
        }
        const last = page.rows[page.rows.length - 1];
        if (last === undefined) return undefined;
        cursor = { timestamp: last.timestamp, id: last.id };
      } catch (error) {
        if (!(error instanceof StorageScanBudgetExceededError)) throw error;
        const truncationReason = await hydrateClusterMatches(
          storage,
          error.matched_ids,
          consume,
        );
        if (truncationReason !== undefined) {
          return logicalCandidates.size < requested
            ? truncationReason
            : undefined;
        }
        cursor = error.resume_cursor;
      }
    }

    return logicalCandidates.size < requested ? 'storage_windows' : undefined;
  };

  const onTimeFilter: QueryFilter = {
    ...filter,
    order: 'desc',
  };
  delete onTimeFilter.after;
  const onTimeTruncationReason = await scanLane({
    filter: onTimeFilter,
    maxWindows: CLUSTER_MAX_STORAGE_SCAN_WINDOWS,
    order: 'desc',
  });

  let delayedTruncationReason: ClusterInputTruncationReason | undefined;
  if (
    onTimeTruncationReason === undefined &&
    logicalCandidates.size < requested &&
    filter.until !== undefined
  ) {
    const delayedFilter: QueryFilter = {
      ...filter,
      since: filter.until,
      order: 'asc',
    };
    delete delayedFilter.until;
    delete delayedFilter.before;
    delete delayedFilter.after;
    delayedTruncationReason = await scanLane({
      filter: delayedFilter,
      maxWindows: CLUSTER_MAX_DELAYED_STORAGE_SCAN_WINDOWS,
      order: 'asc',
    });
  }

  events.sort(compareCaptureEventsNewestFirst);
  return {
    events,
    logicalCandidateCount: logicalCandidates.size,
    ...(onTimeTruncationReason !== undefined ? { onTimeTruncationReason } : {}),
    ...(delayedTruncationReason !== undefined
      ? { delayedTruncationReason }
      : {}),
  };
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
  repoPath: ResolvedRepoPath | null,
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
      ...(repoPath !== null
        ? {
            project_key: repoPath.project_key,
            legacy_project_roots: repoPath.legacy_project_roots,
          }
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
  if (repoPath !== null) {
    query.repo_path = repoPath.normalized_path;
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
  if (storagePage.onTimeTruncationReason !== undefined) {
    response.truncation.truncated = true;
    if (storagePage.onTimeTruncationReason === 'storage_windows') {
      response.warnings.push(
        `[STORAGE_SCAN_BUDGET] indexed on-time cluster input exhausted ${CLUSTER_MAX_STORAGE_SCAN_WINDOWS} bounded storage windows; clusters may omit older matching atoms. Narrow since/until/repo scope and retry.`,
      );
    } else {
      const budget =
        storagePage.onTimeTruncationReason === 'raw_bytes'
          ? `${CLUSTER_MAX_RAW_STORED_BYTES} retained bytes`
          : `${CLUSTER_MAX_RAW_OBSERVATIONS} raw observations`;
      response.warnings.push(
        `[STORAGE_INPUT_BUDGET] indexed on-time cluster input reached its bounded ${budget}; clusters may omit older matching atoms. Narrow since/until/repo scope and retry.`,
      );
    }
  }
  if (storagePage.delayedTruncationReason !== undefined) {
    response.truncation.truncated = true;
    if (storagePage.delayedTruncationReason === 'storage_windows') {
      response.warnings.push(
        `[DELAYED_OBSERVATION_SCAN_BUDGET] delayed-observation recovery exhausted ${CLUSTER_MAX_DELAYED_STORAGE_SCAN_WINDOWS} bounded storage windows captured at or after the requested until. Indexed on-time results are preserved, but later-captured observations whose occurrence belongs to this window may be omitted. Use repo_path where available or inspect later capture ranges for complete delayed coverage.`,
      );
    } else {
      const budget =
        storagePage.delayedTruncationReason === 'raw_bytes'
          ? `${CLUSTER_MAX_RAW_STORED_BYTES} retained bytes`
          : `${CLUSTER_MAX_RAW_OBSERVATIONS} raw observations`;
      response.warnings.push(
        `[DELAYED_OBSERVATION_INPUT_BUDGET] delayed-observation recovery reached the shared bounded ${budget}. Indexed on-time results are preserved, but later-captured observations whose occurrence belongs to this window may be omitted. Use repo_path where available or inspect later capture ranges for complete delayed coverage.`,
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
  let repoPath: ResolvedRepoPath | null = null;
  if (params.repo_path !== undefined) {
    assertAbsoluteRepoPath('get_recent_work_context', params.repo_path);
    repoPath = await resolveRepoPath(params.repo_path);
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
    repoPath,
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
        repoPath,
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
        if (repoPath !== null) {
          queryEcho.repo_path = repoPath.normalized_path;
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
