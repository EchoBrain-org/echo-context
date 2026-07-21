// Item 038 / AC3: canonical home for the cluster-discovery engine.
//
// Moved from `src/mcp/tools/recent-work-context.ts` (where it was tangled
// with the now-deprecated MCP-tool wrapper). The engine is a strategy-
// internal helper — it's NOT exposed as an MCP tool. Its consumers are:
//   - `src/mcp/tools/find-clusters.ts` (the V1.6 split's discovery half)
//   - `src/mcp/tools/recent-work-context.ts` (deprecated; stays as a
//     wrapper until the 2026-05-17 follow-up removes the registration)
//
// The engine inherits 037's `repo_path` forwarding verbatim: when set, it
// is normalised once at the engine entry and forwarded as
// `metadata_match: {repo_root: normalised}` into the storage query. Mirrors
// the contract that the four retrieval tools agreed on in 037.

import { normalizeEvent } from '../../context-adapters/normalization.js';
import type { NormalizedContextEvent } from '../../normalize/types.js';
import { StorageScanBudgetExceededError } from '../../storage/budgets.js';
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
import { assertAbsoluteRepoPath, normaliseRepoPath } from '../util/repo-path.js';
import { WIRE_SHAPE_CAPS } from '../wire-shape/caps.js';

// Cost-safer defaults (item 025): every retrieval today blew the consumer's
// 25k-char tool-result budget on first try (dogfooding 2026-05-08 entries
// 13:27 PDT and 14:43 PDT) even with explicit `format='minimal'`, `limit=50`.
// limit=20 produces ~22k envelopes on realistic 200-atom multi-file fixtures.
export const DEFAULT_LIMIT = 20;
export const MAX_LIMIT = 500;
export const DEFAULT_WINDOW_HOURS = 4;
export const STORAGE_OVERFETCH = 10;
export const CLUSTER_MAX_STORAGE_SCAN_WINDOWS = 4;

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
  /** Item 037 / AC4: absolute repo root path. When set, scopes the
   *  candidate event set to atoms whose `metadata.repo_root` matches —
   *  cross-source (no source_app gating). Legacy git atoms without
   *  repo_root metadata are out of scope when this is set. */
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
  let before = filter.before;

  const appendUnique = (rows: readonly CaptureEvent[]): void => {
    for (const event of rows) {
      if (seen.has(event.id)) continue;
      seen.add(event.id);
      events.push(event);
    }
  };

  for (let window = 0; window < CLUSTER_MAX_STORAGE_SCAN_WINDOWS; window += 1) {
    const remaining = requested - events.length;
    if (remaining <= 0) return { events, scanTruncated: false };
    try {
      appendUnique(await storage.query({ ...filter, before, limit: remaining }));
      events.sort((left, right) => {
        if (left.timestamp < right.timestamp) return 1;
        if (left.timestamp > right.timestamp) return -1;
        if (left.id < right.id) return 1;
        if (left.id > right.id) return -1;
        return 0;
      });
      return { events: events.slice(0, requested), scanTruncated: false };
    } catch (error) {
      if (!(error instanceof StorageScanBudgetExceededError)) throw error;
      appendUnique(await hydrateClusterMatches(storage, error.matched_ids));
      before = error.resume_cursor;
    }
  }

  events.sort((left, right) => {
    if (left.timestamp < right.timestamp) return 1;
    if (left.timestamp > right.timestamp) return -1;
    if (left.id < right.id) return 1;
    if (left.id > right.id) return -1;
    return 0;
  });
  return {
    events: events.slice(0, requested),
    scanTruncated: events.length < requested,
  };
}

// Span-driven default for window_hours. When the caller passes an explicit
// value, that wins. Otherwise: short spans (≤4h) reuse the span exactly so a
// 1h "what did I just do" query produces a tight 1h cluster cap; longer spans
// cap at 24h to prevent week-long mega-clusters but still let overnight gaps
// resolve into a single cluster.
export function inferWindowHours(
  sinceMs: number,
  untilMs: number,
  explicit: number | undefined,
): number {
  if (explicit !== undefined) return explicit;
  const spanHours = (untilMs - sinceMs) / 3_600_000;
  if (!Number.isFinite(spanHours) || spanHours <= 0) return DEFAULT_WINDOW_HOURS;
  if (spanHours <= 4) return spanHours;
  return Math.min(spanHours, 24);
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
      // Item 037 / AC4: cross-source repo scoping. Storage matches
      // metadata.repo_root by string equality — git atoms without that
      // metadata are not in the filtered set.
      ...(normalisedRepoPath !== null ? { metadata_match: { repo_root: normalisedRepoPath } } : {}),
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
  if (events.length === storageCap) {
    response.warnings.push(
      'storage cap hit (events.length === limit * STORAGE_OVERFETCH); ' +
        'atoms in window may be silently truncated. ' +
        'Raise limit or narrow (since, until) to retain them.',
    );
  }
  if (storagePage.scanTruncated) {
    response.warnings.push(
      `[STORAGE_SCAN_BUDGET] cluster input exhausted ${CLUSTER_MAX_STORAGE_SCAN_WINDOWS} bounded storage windows; clusters may omit older matching atoms. Narrow since/until/repo scope and retry.`,
    );
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
