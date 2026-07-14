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
//   - atom_ids[] is FULL (un-capped). Skeleton's 50-cap on atom_ids was the
//     load-bearing breakage — atom_ids is the input to `get_atoms`, so
//     silently dropping the tail of a >50-atom cluster would silently lose
//     bodies. The 50-cap stays for `open_loop_hints[]` only.
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
  // discriminator one-liner per item 025 MCP best-practices
  "Use when you need cross-source DISCOVERY of recent work threads — clusters of related events grouped by shared artifacts (files, repos, conversations) — but NOT the atom bodies. Pair with `get_atoms` to materialise bodies for any returned cluster's `atom_ids[]`.\n\n" +
  // cost class
  'Cost: cheap. Typical < 10k chars even on full-day windows; the discovery counterpart to the targeted `get_atoms` body fetch. Hard envelope ceiling: 25k chars.\n\n' +
  // params
  'PARAMETERS — IMPORTANT distinction (most-common foot-gun):\n' +
  '  • `window_hours` controls the **maximum cluster-gap** (the temporal gap allowed between atoms in a single cluster), NOT lookback. Default 4h cluster-gap.\n' +
  '  • `since` / `until` control the **lookback window** (which atoms are considered).\n' +
  '  Pass `since=now-24h` for a 24h LOOKBACK; passing `window_hours=24` widens the cluster-gap, which is rarely what you want.\n\n' +
  // no-args resume
  "NO-ARGS RESUME: when called with neither `since` nor `until`, the default 4h lookback auto-expands to 24h on a single retry if the 4h pass returned 0 clusters OR only single-source-recent clusters (the calling session's own activity from the last 5 minutes); when the single-source-recent expand fires AND prior multi-source work exists in 24h, the single-source-recent cluster is demoted in rank so the prior work appears as clusters[0]. Auto-expand fires a `[AUTO_EXPAND] <trigger>`-prefixed warning (trigger: `empty` or `single-source-recent`) so the implicit widen is visible.\n\n" +
  // shape
  'RETURNS: per-cluster {cluster_id, rank, rank_reason, atom_ids[] (FULL, un-capped — feed straight to `get_atoms`), source_breakdown ({source_app: count}), time_range, label?, open_loop_hints? (capped at ' +
  String(SKELETON_CLUSTER_OPEN_LOOP_HINTS_CAP) +
  ")}. No atom bodies. `result_caps` describes response-level budget application; per-cluster `atom_ids_truncated: true` + `atom_ids_total: N` fires if a single cluster's atom_ids[] would dominate the ceiling.";

const formatSchema = z.enum(['skeleton']);
const viewSchema = z.enum(['compact', 'rich']);

export interface FindClustersParams {
  since?: string;
  until?: string;
  window_hours?: number;
  format?: 'skeleton';
  view?: ViewMode;
  /** Item 037 / AC4: absolute repo root path. Pass-through to the
   *  underlying `recent_work_context` query; scopes the candidate set
   *  cross-source by `metadata.repo_root`. Echoed in `query.repo_path`. */
  repo_path?: string;
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
    /** Item 037 / AC4: echoes the normalised `repo_path` filter applied
     *  (cross-source `metadata.repo_root` match). `null` when not passed. */
    repo_path: string | null;
  };
  clusters: FindClustersCluster[];
  /** RESPONSE-LEVEL budget application — distinct from per-FIELD clipping
   *  inside an atom (which lives in `truncations: string[]` on `get_atoms`
   *  results). Two different concepts; two different names. */
  result_caps: {
    clusters_returned: number;
    clusters_total: number;
    atoms_returned: number;
    atoms_total_in_window: number;
    truncated: boolean;
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

function projectCluster(c: Cluster): FindClustersCluster {
  const hints = clipOpenLoopHintsArray(c.open_loop_hints, SKELETON_CLUSTER_OPEN_LOOP_HINTS_CAP);
  // Per-cluster atom_ids hard cap. Keep head+tail so the consumer still
  // sees both ends of the cluster (relevant when the consumer paginates
  // get_atoms over the slice). Atom IDs are ~36 chars — even at the cap
  // this is ~7-8KB per cluster, well under the response ceiling.
  let atomIds: string[];
  let atomIdsTruncated: true | undefined;
  let atomIdsTotal: number | undefined;
  if (c.atom_ids.length <= PER_CLUSTER_ATOM_IDS_HARD_CAP) {
    atomIds = [...c.atom_ids];
  } else {
    const headN = Math.floor(PER_CLUSTER_ATOM_IDS_HARD_CAP / 2);
    const tailN = PER_CLUSTER_ATOM_IDS_HARD_CAP - headN;
    atomIds = [...c.atom_ids.slice(0, headN), ...c.atom_ids.slice(c.atom_ids.length - tailN)];
    atomIdsTruncated = true;
    atomIdsTotal = c.atom_ids.length;
  }

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
  if (hints.omitted > 0) out.open_loop_hints_omitted = hints.omitted;
  return out;
}

export async function findClusters(
  storage: Storage,
  params: FindClustersParams,
  now: Date = new Date(),
): Promise<FindClustersResult> {
  // Re-use getRecentWorkContext for: no-args 4h→24h auto-expand,
  // TZ-naive warning, storage-cap warning, exclude_metadata_surface=['fs'].
  // Pass MAX_LIMIT so the trace-builder's atom-limit truncation does NOT
  // silently drop atom_ids from low-rank clusters — find_clusters' contract
  // is FULL atom_ids per returned cluster.
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

  const richClusters = rwc.clusters.map(projectCluster);
  const projectedClusters = view === 'compact' ? richClusters.map(compactCluster) : richClusters;
  const perClusterCapFired = projectedClusters.some((c) => c.atom_ids_truncated === true);

  // Apply the response-level envelope ceiling. Trim trailing clusters
  // (lowest-rank first; rwc.clusters is rank-ordered) until the
  // serialized envelope fits under the ceiling. Reserve headroom for the
  // cap-fired warning so adding it post-trim doesn't push the envelope
  // back over the ceiling. (Codex+Cursor post-build review 2026-05-10:
  // FIND_CLUSTERS_RESPONSE_BYTE_CEILING was previously declared but
  // never enforced.)
  const CAP_WARNING_RESERVE_BYTES = 300;
  const sizeBudget = FIND_CLUSTERS_RESPONSE_BYTE_CEILING - CAP_WARNING_RESERVE_BYTES;
  let clusters = projectedClusters;
  let responseCapFired = false;
  const buildResult = (cs: FindClustersCluster[], extraWarnings: string[]): FindClustersResult => {
    if (view === 'compact') {
      return {
        schema_version: SCHEMA_VERSION,
        tool: 'find_clusters',
        clusters: cs,
        warnings: [...rwc.warnings, ...extraWarnings],
      } as unknown as FindClustersResult;
    }
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
        // truncated reflects ANY truncation: upstream (rwc cluster cap),
        // per-cluster (atom_ids hard cap), or response-level (this trim).
        // Previously only mirrored upstream — consumers relying on this
        // signal couldn't tell when atom_ids[] was clipped per-cluster or
        // when trailing clusters were dropped to fit the envelope.
        truncated: rwc.truncation.truncated || perClusterCapFired || responseCapFired,
      },
      warnings: [...rwc.warnings, ...extraWarnings],
    };
  };

  while (
    clusters.length > 0 &&
    JSON.stringify(buildResult(clusters as FindClustersCluster[], [])).length > sizeBudget
  ) {
    clusters = clusters.slice(0, -1);
    responseCapFired = true;
  }

  const extraWarnings = responseCapFired
    ? [
        `[FIND_CLUSTERS_RESPONSE_CAP] response trimmed from ${projectedClusters.length} to ${clusters.length} clusters to stay under the ${FIND_CLUSTERS_RESPONSE_BYTE_CEILING}-char hard ceiling — narrow \`since\`/\`until\` for full coverage.`,
      ]
    : [];

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
    })
    .optional(),
  clusters: z.array(z.record(z.string(), z.unknown())),
  result_caps: z
    .object({
      clusters_returned: z.number(),
      clusters_total: z.number(),
      atoms_returned: z.number(),
      atoms_total_in_window: z.number(),
      truncated: z.boolean(),
    })
    .optional(),
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
        format: formatSchema.optional(),
        view: viewSchema.optional(),
        repo_path: z
          .string()
          .optional()
          .describe(
            "Item 037: absolute filesystem path to a repo root. When set, scopes the cluster candidate set to atoms whose `metadata.repo_root` matches (cross-source — find_clusters has no source_app gate). Legacy git atoms without that metadata are out of scope when passed; reach them via `source_prefix=git:<path>` on `search_memories`/`wait_for_new_turns`, or `echo_resolve_mru(sources=['git'], repo_path=...)` which has the two-path OR fallback.",
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
          (err.message.startsWith('get_recent_work_context: ') ||
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
