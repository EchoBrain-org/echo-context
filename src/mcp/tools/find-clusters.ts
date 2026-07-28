// V1.6 (item 030) — `find_clusters`: cheap, cross-source discovery primitive.
//
// Counterpart to `get_atoms` (which materialises bodies for ids you already
// have). The pair replaces the compound `get_recent_work_context` tool, whose
// >90% of envelope/truncation friction in V1.5 traced back to the all-in-one
// shape: discovery and body fetch shared one tool, so cap tuning could only
// trade off one against the other.
//
// Re-uses the trace cluster builder via `getRecentWorkContext` so the
// no-args 4h→24h auto-expand + TZ-naive warning + storage-cap warning
// machinery is shared. Differences from `get_recent_work_context`'s
// `format='skeleton'` wire shape:
//
//   - atom_ids[] stays complete for the trace builder's bounded membership
//     when the response budget permits. If it does not, explicit
//     atom_ids_truncated/atom_ids_total signals accompany a head+tail slice;
//     response shaping shrinks membership before dropping a sibling header.
//     Work windows above the trace builder's MAX_LIMIT are already a bounded
//     partial view and surface result_caps.truncated.
//   - `result_caps` (renamed from `truncation`) describes RESPONSE-LEVEL
//     budget application. `truncations: string[]` (per-FIELD clipping
//     inside an atom) lives on `get_atoms` results, not here. Different
//     concepts; different names. Spec §1 footnote.
//   - No atoms map — find_clusters is body-less discovery.
//   - Per-cluster `atom_ids_truncated`/`atom_ids_total` flags fire if a
//     single cluster's atom_ids alone would overflow the response budget.

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Storage } from '../../storage/interface.js';
import type { Cluster, ResponseFormat } from '../../trace/types.js';
import {
  DiscoveryCursorError,
  FIND_CLUSTERS_CURSOR_MAX_CHARS,
  FIND_CLUSTERS_GROUP_PAGE_MAX,
  FIND_CLUSTERS_REPRESENTATIVE_MAX,
  type DiscoveryGroup,
  type DiscoveryGroupBy,
} from '../internal/discovery-groups.js';
import { findGroupedClusters } from '../internal/grouped-find-clusters.js';
import { jsonByteLength } from '../wire-shape/bytes.js';
import { compactCluster, type ViewMode } from '../wire-shape/compact.js';
// Item 038 / AC3: find_clusters calls the canonical cluster engine directly
// (skeleton wire-shape constants still come from the deprecated tool shim
// — they describe the MCP-tool surface, not the engine).
import { getRecentWorkContext, MAX_LIMIT } from '../internal/cluster-engine.js';
import { isoString } from '../util/iso8601.js';
import { SKELETON_CLUSTER_OPEN_LOOP_HINTS_CAP } from './recent-work-context.js';

const SCHEMA_VERSION = 1;

// Hard interactive ceiling for `JSON.stringify(result)`. Same 25k convention
// used by search/tail/recent-work-context tests. find_clusters is the cheap
// discovery counterpart — staying well under the ceiling is the whole point.
export const FIND_CLUSTERS_RESPONSE_BYTE_CEILING = 25_000;

// Per-cluster atom_ids[] is the load-bearing input to `get_atoms`. If a
// single cluster's atom_ids[] is large enough to dominate the response
// budget on its own (atom UUIDs are ~36 chars, so 200 IDs ≈ 7-8KB), we
// set `atom_ids_truncated: true` AND `atom_ids_total: number` so the
// consumer can either narrow the window OR explicitly accept partial
// coverage. Pre-computed cap: leave headroom for envelope + other
// clusters by capping at half the response ceiling. In practice almost
// no clusters trip this; it's a safety net, not a routine path.
export const PER_CLUSTER_ATOM_IDS_HARD_CAP = 200;

export const FIND_CLUSTERS_DESCRIPTION =
  'Discover recent work threads across captured sources without fetching atom bodies. Use `since`/`until` for the lookback. `window_hours` explicitly overrides the fixed 4-hour maximum gap used to join atoms; it is not the lookback. With no time bounds, an unhelpful 4-hour result may auto-expand once to 24 hours and emits `[AUTO_EXPAND]`.\n\n' +
  'Omit `group_by` for the unchanged ranked-cluster response. Use `group_by="project"` for canonical project routes or `group_by="thread"` for provider-scoped root threads. Grouped mode returns unique-turn versus raw-observation counts, a few directly hydratable representative IDs, and opaque cursors. Pass a top-level `next_cursor` by itself to continue group headers. For complete membership, hydrate the representatives first, then pass that group’s `membership_cursor` by itself; member pages continue through top-level `next_cursor` without repeating IDs.\n\n' +
  '`view="rich"` is the legacy default; `compact` keeps ranking, IDs, source counts, time range, and trust signals while dropping low-value detail. Group headers have one fixed lean shape. `format="skeleton"` is compatibility-only and can be omitted. The 25,000-byte result budget never silently drops a grouped header or member ID: shortened pages always carry a cursor. In legacy mode, inspect `atom_ids_truncated`, `atom_ids_total`, `result_caps`, and coded warnings before claiming full coverage.';

const formatSchema = z.enum(['skeleton']);
const viewSchema = z.enum(['compact', 'rich']);
const groupBySchema = z.enum(['project', 'thread']);

export interface FindClustersParams {
  since?: string;
  until?: string;
  window_hours?: number;
  format?: 'skeleton';
  view?: ViewMode;
  /** Item 037 / AC4: absolute project root path. Pass-through to the
   *  underlying cluster query; scopes the candidate set cross-source by
   *  canonical project identity. Echoed in `query.repo_path`. */
  repo_path?: string;
  /** Scope 6: opt-in agent-routing projection. Absence preserves the legacy
   * ranked-cluster response byte-for-byte. */
  group_by?: DiscoveryGroupBy;
  /** Group headers per page. Grouped initial calls only. */
  page_size?: number;
  /** Directly hydratable preview IDs per group. Grouped initial calls only. */
  representative_limit?: number;
  /** Opaque grouped continuation. Continuation calls are cursor-only. */
  cursor?: string;
}

export interface FindClustersCluster {
  cluster_id: string;
  rank: number;
  rank_reason: string[];
  /** FULL atom_ids[] — load-bearing input to `get_atoms`. Capped only by
   *  the per-cluster hard cap (very rarely fires). When the cap fires,
   *  `atom_ids_truncated: true` + `atom_ids_total: N` are set. */
  atom_ids: string[];
  /** Set ONLY when this cluster's atom_ids[] was clipped by the
   *  per-cluster hard cap. */
  atom_ids_truncated?: true;
  /** Set ONLY when atom_ids_truncated is true. The original count. */
  atom_ids_total?: number;
  source_breakdown: Record<string, number>;
  time_range: { from: string; to: string };
  label?: string;
  /** Body-less open-loop hints. Capped at SKELETON_CLUSTER_OPEN_LOOP_HINTS_CAP
   *  (head+tail). Useful for "is anything still open in this cluster?" without
   *  paying for hint text bodies. */
  open_loop_hints: { atom_id: string; resolved: boolean }[];
  /** Set when open_loop_hints[] was clipped by its cap. */
  open_loop_hints_omitted?: number;
}

export interface FindClustersResult {
  schema_version: 1;
  tool: 'find_clusters';
  query: {
    since: string;
    until: string;
    window_hours: number;
    format: 'skeleton';
    /** Item 037 / AC4: echoes the normalized canonical-project filter.
     * `null` when not passed. */
    repo_path: string | null;
    /** Present only in the opt-in grouped response. */
    group_by?: DiscoveryGroupBy;
    /** Present only in the opt-in grouped response. */
    page_size?: number;
    /** Present only in the opt-in grouped response. */
    representative_limit?: number;
  };
  clusters: FindClustersCluster[];
  /** Present only in grouped mode; legacy mode omits it. */
  mode?: 'groups' | 'members';
  /** Present only in grouped mode; never overloaded into clusters[]. */
  groups?: DiscoveryGroup[];
  /** Present only when a membership cursor is being consumed. */
  membership_page?: {
    group_id: string;
    atom_ids: string[];
    atoms_returned: number;
    atoms_total: number;
  };
  /** Group-page or member-page continuation. Present only in grouped mode. */
  next_cursor?: string | null;
  /** RESPONSE-LEVEL budget application — distinct from per-FIELD clipping
   *  inside an atom (which lives in `truncations: string[]` on `get_atoms`
   *  results). Two different concepts; two different names. */
  result_caps: {
    clusters_returned: number;
    clusters_total: number;
    atoms_returned: number;
    atoms_total_in_window: number;
    /** Source counts across the scanned window before rank/response caps. */
    source_breakdown: Record<string, number>;
    truncated: boolean;
    /** Grouped-mode coverage fields. Omitted from the legacy response. */
    groups_returned?: number;
    groups_total?: number;
    unique_turns_total?: number;
    raw_observations_total?: number;
    counts_complete?: boolean;
  };
  warnings: string[];
}

function validateView(view: unknown): ViewMode {
  if (view === undefined) return 'rich';
  if (view === 'compact' || view === 'rich') return view;
  throw new Error('find_clusters: view must be one of "compact" or "rich"');
}

function clipOpenLoopHintsArray<T>(arr: readonly T[], cap: number): { kept: T[]; omitted: number } {
  if (arr.length <= cap) return { kept: [...arr], omitted: 0 };
  const headN = Math.floor(cap / 2);
  const tailN = cap - headN;
  return {
    kept: [...arr.slice(0, headN), ...arr.slice(arr.length - tailN)],
    omitted: arr.length - cap,
  };
}

function projectCluster(
  c: Cluster,
  atomIdCap: number = PER_CLUSTER_ATOM_IDS_HARD_CAP,
): FindClustersCluster {
  // Per-cluster atom_ids hard cap. Keep head+tail so the consumer still
  // sees both ends of the cluster (relevant when the consumer paginates
  // get_atoms over the slice). Atom IDs are ~36 chars — even at the cap
  // this is ~7-8KB per cluster, well under the response ceiling.
  let atomIds: string[];
  let atomIdsTruncated: true | undefined;
  let atomIdsTotal: number | undefined;
  if (c.atom_ids.length <= atomIdCap) {
    atomIds = [...c.atom_ids];
  } else {
    const headN = Math.floor(atomIdCap / 2);
    const tailN = atomIdCap - headN;
    atomIds = [...c.atom_ids.slice(0, headN), ...c.atom_ids.slice(c.atom_ids.length - tailN)];
    atomIdsTruncated = true;
    atomIdsTotal = c.atom_ids.length;
  }
  const visibleAtomIds = new Set(atomIds);
  // Hints are only actionable when their originating atom and any resolver
  // evidence are present in the directly hydratable ID slice. Treat all other
  // hints as omitted instead of returning dangling references.
  const visibleHints = c.open_loop_hints.filter(
    (hint) =>
      visibleAtomIds.has(hint.atom_id) &&
      (hint.resolved_by_atom_id === undefined ||
        visibleAtomIds.has(hint.resolved_by_atom_id)),
  );
  const hints = clipOpenLoopHintsArray(
    visibleHints,
    SKELETON_CLUSTER_OPEN_LOOP_HINTS_CAP,
  );
  const hintsOmitted = c.open_loop_hints.length - hints.kept.length;

  const out: FindClustersCluster = {
    cluster_id: c.cluster_id,
    rank: c.rank,
    rank_reason: c.rank_reason,
    atom_ids: atomIds,
    source_breakdown: c.source_breakdown,
    time_range: c.time_range,
    open_loop_hints: hints.kept.map((h) => ({
      atom_id: h.atom_id,
      resolved: h.resolved,
    })),
  };
  if (c.label !== undefined) out.label = c.label;
  if (atomIdsTruncated !== undefined) out.atom_ids_truncated = atomIdsTruncated;
  if (atomIdsTotal !== undefined) out.atom_ids_total = atomIdsTotal;
  if (hintsOmitted > 0) out.open_loop_hints_omitted = hintsOmitted;
  return out;
}

export async function findClusters(
  storage: Storage,
  params: FindClustersParams,
  now: Date = new Date(),
): Promise<FindClustersResult> {
  if (params.group_by !== undefined || params.cursor !== undefined) {
    return findGroupedClusters(
      storage,
      params,
      now,
      FIND_CLUSTERS_RESPONSE_BYTE_CEILING,
    );
  }
  if (params.page_size !== undefined || params.representative_limit !== undefined) {
    throw new Error(
      'find_clusters: page_size and representative_limit require group_by',
    );
  }
  // Re-use getRecentWorkContext for: no-args 4h→24h auto-expand,
  // TZ-naive warning, storage-cap warning, exclude_metadata_surface=['fs'].
  // Pass MAX_LIMIT to maximize the trace builder's bounded membership. A work
  // window above this limit remains explicitly partial through
  // result_caps.truncated; the trace builder rebuilds every returned cluster
  // summary from the membership it actually retained.
  //
  // `format: 'skeleton'` is passed through as a marker for the query echo,
  // even though we don't use the skeleton wire shape ourselves — atoms
  // map is computed but discarded; cost is bounded by MAX_LIMIT events.
  const format: ResponseFormat = params.format ?? 'skeleton';
  const view = validateView(params.view);
  const rwc = await getRecentWorkContext(
    storage,
    {
      ...(params.since !== undefined ? { since: params.since } : {}),
      ...(params.until !== undefined ? { until: params.until } : {}),
      ...(params.window_hours !== undefined ? { window_hours: params.window_hours } : {}),
      // Item 037 / AC4: pass-through. recent_work_context's
      // `getRecentWorkContext` validates + normalises; we just forward the
      // raw value. The normalised form rides through rwc.query.repo_path
      // and is re-surfaced in find_clusters' own envelope below.
      ...(params.repo_path !== undefined ? { repo_path: params.repo_path } : {}),
      limit: MAX_LIMIT,
      format,
    },
    now,
  );

  const projectClusters = (atomIdCap: number): FindClustersCluster[] => {
    const rich = rwc.clusters.map((cluster) => projectCluster(cluster, atomIdCap));
    return view === 'compact'
      ? (rich.map(compactCluster) as FindClustersCluster[])
      : rich;
  };
  let activeAtomIdCap = PER_CLUSTER_ATOM_IDS_HARD_CAP;
  let projectedClusters = projectClusters(activeAtomIdCap);

  // Apply the response-level envelope ceiling. Trim trailing clusters
  // (lowest-rank first; rwc.clusters is rank-ordered) until the
  // serialized envelope fits under the ceiling. Reserve headroom for the
  // cap-fired warning so adding it post-trim doesn't push the envelope
  // back over the ceiling. (Codex+Cursor post-build review 2026-05-10:
  // FIND_CLUSTERS_RESPONSE_BYTE_CEILING was previously declared but
  // never enforced.)
  const CAP_WARNING_RESERVE_BYTES = 1_024;
  const sizeBudget = FIND_CLUSTERS_RESPONSE_BYTE_CEILING - CAP_WARNING_RESERVE_BYTES;
  let clusters = projectedClusters;
  let responseCapFired = false;
  let idBudgetFired = false;
  const buildResult = (cs: FindClustersCluster[], extraWarnings: string[]): FindClustersResult => {
    const perClusterCapFired = cs.some((cluster) => cluster.atom_ids_truncated === true);
    return {
      schema_version: SCHEMA_VERSION,
      tool: 'find_clusters',
      query: {
        since: rwc.query.since,
        until: rwc.query.until,
        window_hours: rwc.query.window_hours,
        format,
        // Item 037 / AC4: surface the same normalised path the underlying
        // storage filter saw, so callers see what scoped their result set
        // (and can detect a trailing-slash normalisation).
        repo_path: rwc.query.repo_path,
      },
      clusters: cs,
      result_caps: {
        clusters_returned: cs.length,
        clusters_total: rwc.truncation.clusters_total,
        atoms_returned: cs.reduce((s, c) => s + c.atom_ids.length, 0),
        atoms_total_in_window: rwc.truncation.atoms_total_in_window,
        source_breakdown: rwc.truncation.source_breakdown ?? {},
        // truncated reflects ANY truncation: upstream (rwc cluster cap),
        // per-cluster (atom_ids hard cap), or response-level (this trim).
        // Previously only mirrored upstream — consumers relying on this
        // signal couldn't tell when atom_ids[] was clipped per-cluster or
        // when trailing clusters were dropped to fit the envelope.
        truncated:
          rwc.truncation.truncated || perClusterCapFired || idBudgetFired || responseCapFired,
      },
      warnings: [...rwc.warnings, ...extraWarnings],
    };
  };

  const fits = (candidate: FindClustersCluster[], warnings: string[] = []): boolean =>
    jsonByteLength(buildResult(candidate, warnings)) <= sizeBudget;

  // Preserve every cluster header before dropping a sibling. Full ID lists
  // remain intact when they fit; only an over-budget response steps down to
  // directly hydratable slices and then progressively smaller evidence slices.
  for (const cap of [50, 25, 12, 6, 3, 1]) {
    if (fits(clusters)) break;
    activeAtomIdCap = cap;
    projectedClusters = projectClusters(activeAtomIdCap);
    clusters = projectedClusters;
    idBudgetFired ||= projectedClusters.some((cluster) => cluster.atom_ids_truncated === true);
  }

  while (clusters.length > 0 && !fits(clusters)) {
    clusters = clusters.slice(0, -1);
    responseCapFired = true;
  }

  const extraWarnings: string[] = [];
  if (idBudgetFired) {
    extraWarnings.push(
      `[FIND_CLUSTERS_ID_BUDGET] retained at most ${activeAtomIdCap} IDs per cluster to preserve cluster headers; use atom_ids_total and narrow the time window for full membership`,
    );
  } else if (clusters.some((cluster) => cluster.atom_ids_truncated === true)) {
    extraWarnings.push(
      `[FIND_CLUSTERS_ID_CAP] a cluster exceeded the ${PER_CLUSTER_ATOM_IDS_HARD_CAP}-ID safety cap; narrow the time window for full membership`,
    );
  }
  if (responseCapFired) {
    extraWarnings.push(
      `[FIND_CLUSTERS_RESPONSE_CAP] response retained ${clusters.length} of ${rwc.clusters.length} clusters under the ${FIND_CLUSTERS_RESPONSE_BYTE_CEILING}-byte ceiling; narrow since/until for full coverage`,
    );
  }

  return buildResult(clusters as FindClustersCluster[], extraWarnings);
}

const findClustersOutputSchema = {
  schema_version: z.literal(1),
  tool: z.literal('find_clusters'),
  query: z
    .object({
      since: z.string(),
      until: z.string(),
      window_hours: z.number(),
      format: z.literal('skeleton'),
      repo_path: z.string().nullable(),
      group_by: groupBySchema.optional(),
      page_size: z.number().int().positive().optional(),
      representative_limit: z.number().int().positive().optional(),
    }),
  clusters: z.array(z.record(z.string(), z.unknown())),
  mode: z.enum(['groups', 'members']).optional(),
  groups: z
    .array(
      z.object({
        group_id: z.string(),
        identity_quality: z.enum(['canonical', 'fallback']),
        project_key: z.string().nullable(),
        canonical_root: z.string().nullable(),
        repo_path: z.string().nullable(),
        provider: z.string().optional(),
        root_thread_id: z.string().optional(),
        unique_turn_count: z.number().int().nonnegative(),
        raw_observation_count: z.number().int().nonnegative(),
        collapsed_observation_count: z.number().int().nonnegative(),
        representative_atom_ids: z.array(z.string()),
        source_breakdown: z.record(z.string(), z.number().int().nonnegative()),
        time_range: z.object({ from: z.string(), to: z.string() }),
        thread_count: z.number().int().nonnegative().optional(),
        membership_cursor: z.string().nullable(),
      }),
    )
    .optional(),
  membership_page: z
    .object({
      group_id: z.string(),
      atom_ids: z.array(z.string()),
      atoms_returned: z.number().int().nonnegative(),
      atoms_total: z.number().int().nonnegative(),
    })
    .optional(),
  next_cursor: z.string().nullable().optional(),
  result_caps: z
    .object({
      clusters_returned: z.number(),
      clusters_total: z.number(),
      atoms_returned: z.number(),
      atoms_total_in_window: z.number(),
      source_breakdown: z.record(z.string(), z.number().int().nonnegative()),
      truncated: z.boolean(),
      groups_returned: z.number().int().nonnegative().optional(),
      groups_total: z.number().int().nonnegative().optional(),
      unique_turns_total: z.number().int().nonnegative().optional(),
      raw_observations_total: z.number().int().nonnegative().optional(),
      counts_complete: z.boolean().optional(),
    }),
  warnings: z.array(z.string()),
};

export function registerFindClusters(server: McpServer, storage: Storage): void {
  server.registerTool(
    'find_clusters',
    {
      description: FIND_CLUSTERS_DESCRIPTION,
      inputSchema: {
        since: isoString.optional(),
        until: isoString.optional(),
        window_hours: z.number().min(0.1).max(168).optional(),
        format: formatSchema
          .optional()
          .describe('Compatibility-only singleton; omit it. Discovery is always bodyless.'),
        view: viewSchema
          .optional()
          .describe(
            'Legacy cluster mode only: rich (default) or compact. Grouped headers have one lean shape.',
          ),
        repo_path: z
          .string()
          .max(4096)
          .optional()
          .describe(
            'Absolute project root. Filters candidate atoms by canonical project identity across nested adapter working directories.',
          ),
        group_by: groupBySchema
          .optional()
          .describe(
            'Opt in to canonical project headers or provider-scoped root-thread headers. Omit for the unchanged ranked-cluster response.',
          ),
        page_size: z
          .number()
          .int()
          .min(1)
          .max(FIND_CLUSTERS_GROUP_PAGE_MAX)
          .optional()
          .describe(
            `Grouped initial calls only: 1-${FIND_CLUSTERS_GROUP_PAGE_MAX} headers per page.`,
          ),
        representative_limit: z
          .number()
          .int()
          .min(1)
          .max(FIND_CLUSTERS_REPRESENTATIVE_MAX)
          .optional()
          .describe(
            `Grouped initial calls only: 1-${FIND_CLUSTERS_REPRESENTATIVE_MAX} directly hydratable preview IDs per group.`,
          ),
        cursor: z
          .string()
          .min(1)
          .max(FIND_CLUSTERS_CURSOR_MAX_CHARS)
          .optional()
          .describe(
            'Opaque grouped continuation. Pass it by itself; it freezes the prior query and fails closed if the result set changed.',
          ),
      },
      outputSchema: findClustersOutputSchema,
      annotations: { readOnlyHint: true },
    },
    async (input) => {
      const params = input as FindClustersParams;
      try {
        const result = await findClusters(storage, params);
        return {
          content: [{ type: 'text', text: JSON.stringify(result) }],
          structuredContent: result as unknown as Record<string, unknown>,
        };
      } catch (err) {
        // Item 037 / AC4: repo_path validation errors thrown from the
        // underlying `getRecentWorkContext` surface via `isError`.
        if (
          err instanceof Error &&
          (err instanceof DiscoveryCursorError ||
            err.message.startsWith('get_recent_work_context: ') ||
            err.message.startsWith('find_clusters: '))
        ) {
          return {
            isError: true,
            content: [{ type: 'text', text: err.message }],
          };
        }
        throw err;
      }
    },
  );
}
