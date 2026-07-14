// Item 038 / AC3: recent_work_context is now a thin wrapper around the
// canonical cluster-discovery engine at `src/mcp/internal/cluster-engine.ts`.
//
// The MCP-tool registration ITSELF stays in place until the 2026-05-17
// follow-up — the 031 deprecation gate (≥1 week post-030) covers removal
// of the tool surface, not just the file. Founder declined override at
// 2026-05-11 ~20:11 PDT, so 038's scope is pure internal refactor:
//   - cluster engine internals (~340 lines) → `internal/cluster-engine.ts`
//   - skeleton wire-shape transform → stays here (part of the MCP tool surface)
//   - MCP-tool registration handler → stays here, calls the internal engine

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Storage } from '../../storage/interface.js';
import type { NormalizedContextEvent, SourceRef, TimeRef } from '../../normalize/types.js';
import type { Cluster, RecentWorkContextResponse, ResponseFormat } from '../../trace/types.js';
import { getRecentWorkContext, type RecentWorkContextParams } from '../internal/cluster-engine.js';
import { isoString } from '../util/iso8601.js';
import { WIRE_SHAPE_CAPS } from '../wire-shape/caps.js';

// Re-export the cluster engine + non-skeleton constants so existing
// consumers (find-clusters.ts) keep working without an import-path change.
export {
  DEFAULT_LIMIT,
  DEFAULT_WINDOW_HOURS,
  getRecentWorkContext,
  inferWindowHours,
  MAX_LIMIT,
  MINIMAL_CONTENT_CAP,
  NO_ARGS_AUTO_EXPAND_WINDOW_HOURS,
  STORAGE_OVERFETCH,
  truncateForMinimal,
  type RecentWorkContextParams,
} from '../internal/cluster-engine.js';

// V1.5.7 (Gap 6): TZ-marker check now lives in src/mcp/util/iso8601.ts so
// search_memories (and any future since/until-bearing tool) shares the
// same validation. Re-exported here for backward compatibility.
export { hasTzMarker, TZ_NAIVE_WARNING } from '../util/iso8601.js';

// V1.6 (item 030) deprecation marker. Removal is gated on item 031 after a
// 1–2 week dogfooding period — keeping the tool callable in the meantime so
// in-flight consumers don't break. The 2026-05-17 follow-up removes the
// registration entirely (per R2 Codex HIGH #1 + founder no-override).
export const RECENT_WORK_CONTEXT_DEPRECATION_MARKER =
  '**[DEPRECATED 2026-05-09 — use `find_clusters` + `get_atoms` instead. ' +
  'This tool will be removed in item 031 after a 1-2 week dogfooding period. ' +
  'Migration recipe in description below.]**\n\n' +
  'Migration:\n' +
  "  OLD: get_recent_work_context(window_hours=24, format='minimal')\n" +
  '       // window_hours=24 in the OLD shape was being misused as lookback —\n' +
  '       // it actually controls cluster-gap (the temporal gap allowed between\n' +
  '       // atoms in a single cluster). The default lookback was 4h via the\n' +
  '       // V1.5.7 auto-expand path. Migration uses since= for explicit\n' +
  '       // lookback, NOT window_hours=.\n' +
  '\n' +
  '  NEW: c = find_clusters(since=now-24h)        // explicit 24h lookback\n' +
  "       // (omit since= to get find_clusters' V1.5.7-equivalent no-args\n" +
  '       // semantics: 4h default, auto-expand to 24h if the 4h pass\n' +
  '       // returns 0 clusters OR only single-source-recent clusters (the\n' +
  "       // calling session's own ≤5-min activity); in the single-source-\n" +
  '       // recent case, the noise cluster is demoted in rank so prior\n' +
  '       // multi-source work surfaces at clusters[0].)\n' +
  '       //\n' +
  '       // Inspect c.clusters[]: each has rank, label, source_breakdown,\n' +
  '       // time_range, atom_ids[]. Pick the cluster matching your intent\n' +
  '       // (typically rank-1 for "where did I leave off", but read label +\n' +
  '       // source_breakdown before picking — the resume target may be a\n' +
  '       // sibling).\n' +
  '       picked = c.clusters[0]                   // or whichever matches intent\n' +
  '       //\n' +
  '       // get_atoms accepts ≤50 ids per call. If picked.atom_ids.length > 50,\n' +
  '       // partition into chunks and concat results:\n' +
  '       //   chunks = chunk(picked.atom_ids, 50)\n' +
  "       //   a = flatMap(chunks, ids => get_atoms(ids, format='minimal'))\n" +
  "       a = get_atoms(picked.atom_ids, format='minimal')   // single call if ≤50\n" +
  '\n' +
  '  RESUME-STYLE QUERIES (item 032): for "where did I leave off after a gap":\n' +
  "       - Pass `prefer='newest_first'` to `get_atoms` so the prefix-drop on\n" +
  '         envelope overflow drops the OLDEST atom (and missing IDs) first,\n' +
  '         not the freshest — the freshest is exactly what the resume caller\n' +
  '         needs.\n' +
  '       - No-args `find_clusters()` now auto-expands to 24h when the only\n' +
  "         returned cluster is the calling session's own recent activity\n" +
  '         (single-source-recent), AND demotes that cluster so prior\n' +
  '         multi-source work surfaces at clusters[0].\n' +
  '\n' +
  '---\n\n';

export const RECENT_WORK_CONTEXT_DESCRIPTION =
  RECENT_WORK_CONTEXT_DEPRECATION_MARKER +
  "Retrieve clusters of related events from the user's captured ECHO memories — " +
  'joined by shared artifacts (files, repos, conversations) within a recent time window. ' +
  'Use when the user asks open-ended questions about recent work across their tools — ' +
  'their own activity, or another agent/app on the same machine ("what is Codex/Claude ' +
  'Code working on?" — answered via `cluster.source_breakdown`, which counts atoms per ' +
  'app inside each cluster). Also: where they left off, or to bring prior context ' +
  '(Cursor + Claude Code + Codex + git) into the current conversation. Returns one ' +
  'cluster per coherent work thread; the AI client decides which to attend to. `cluster.edges[]` is signal-bearing — pairs joined ' +
  'only by scope (repo/workspace) or session (conversation/thread) artifacts are ' +
  'omitted, so `edges.length` is no longer guaranteed to equal C(N, 2); use ' +
  '`cluster.atom_ids[]` for membership. `cluster.open_loop_hints[].resolved` ' +
  'indicates whether the hint has a downstream closure signal in the same window ' +
  '(heuristic — treat as a hint, not a guarantee). ' +
  'DEFAULTS (cost-safer): `limit=20`, `format="minimal"` — every retrieval pays ' +
  "twice through tool-result budgets (the AI client's, then the user's chat), so " +
  'minimal is the right starting point. Three-format ladder by cost ordering: ' +
  '`format:"skeleton"` (cheapest — ids + label + counts only, drops artifacts/' +
  'actors/provenance/cluster-edges/open-loop-hint-bodies; typical < 10k chars ' +
  'even on full-day windows; use for low-budget context-pull / "where did I ' +
  'leave off" / resume calls), `format:"minimal"` (default — atom heads with ' +
  'action.input/output clipped to 500 chars; uncapped sub-collections still ' +
  'pass through, so realistic claude_code days can exceed the consumer 25k ' +
  'budget), `format:"full"` (debug — verbatim atom envelopes, only for offline ' +
  'inspection). `limit` may be raised up to MAX_LIMIT=500 for offline/batch ' +
  'consumers but is rarely the right choice for interactive AI-client paths. ' +
  'Pass `window_hours` to control the maximum temporal ' +
  'gap between atoms in a single cluster; when omitted it is inferred from the ' +
  '(since, until) span (equal to span when ≤ 4h, otherwise min(span, 24h)) — for ' +
  '"where did I leave off after a break" queries, span-equal inference lets a single ' +
  'cluster bridge an overnight gap. `since` and `until` should always carry an explicit ' +
  'timezone (`Z` for UTC or `+HH:MM` offset); naive ISO strings are parsed as local ' +
  'server time, which is rarely what an AI client intends. NO-ARGS RESUME: when ' +
  'called with neither `since` nor `until`, the default 4h window auto-expands to ' +
  '24h on a single retry if the 4h pass returns 0 clusters OR only single-source-' +
  'recent clusters (the calling session\'s own ≤5-min activity) — covers "where ' +
  'did I leave off after a quiet stretch" or "the calling session\'s own noise is ' +
  'the only thing in 4h" without forcing the caller to pre-pick a span. When the ' +
  'single-source-recent trigger fires AND prior multi-source work exists in 24h, ' +
  'the noise cluster is demoted below the prior work via a strict-partition rank ' +
  'rule so clusters[0] is the resume target, not the calling session. Auto-expand ' +
  'fires a `[AUTO_EXPAND]`-prefixed warning (`empty` or `single-source-recent` ' +
  'trigger) so the implicit widen is visible.';

const artifactHintSchema = z.object({
  provider: z.string(),
  type: z.string(),
  id: z.string(),
});

const formatSchema = z.enum(['full', 'minimal', 'skeleton']);

// Item 028: caller-controlled head-clip on the surrogate `action.summary` we
// synthesize for skeleton atoms. 200 chars is enough to disambiguate the atom
// in a resume briefing without re-introducing the action.input/output bytes
// minimal mode already caps at 500.
export const SKELETON_SUMMARY_CAP = WIRE_SHAPE_CAPS.skeleton_summary;

// V1.5.7 (Gap 4, surfaced 2026-05-08 17:01 PDT v1.5-livetest): per-cluster
// bounds on skeleton-mode arrays. Cap shape: when a cluster's atom_ids or
// open_loop_hints exceeds the cap, keep first N/2 + last N/2 entries and
// emit a `*_omitted` integer field per omission.
export const SKELETON_CLUSTER_ATOM_IDS_CAP = 50;
export const SKELETON_CLUSTER_OPEN_LOOP_HINTS_CAP = 30;

export interface SkeletonAtom {
  id: NormalizedContextEvent['id'];
  time: TimeRef;
  source: SourceRef;
  action: {
    kind: NormalizedContextEvent['action']['kind'];
    summary?: string;
  };
}

export interface SkeletonOpenLoopHint {
  atom_id: string;
  resolved: boolean;
}

export interface SkeletonCluster {
  cluster_id: Cluster['cluster_id'];
  rank: Cluster['rank'];
  rank_reason: Cluster['rank_reason'];
  label?: Cluster['label'];
  atom_ids: Cluster['atom_ids'];
  source_breakdown: Cluster['source_breakdown'];
  time_range: Cluster['time_range'];
  open_loop_hints: SkeletonOpenLoopHint[];
  /** V1.5.7 (Gap 4): set only when atom_ids was clipped. */
  atom_ids_omitted?: number;
  /** V1.5.7 (Gap 4): set only when open_loop_hints was clipped. */
  open_loop_hints_omitted?: number;
  /** Convenience flag — true when EITHER atom_ids or open_loop_hints was clipped. */
  truncated?: boolean;
}

export interface SkeletonResponse {
  schema_version: RecentWorkContextResponse['schema_version'];
  tool: RecentWorkContextResponse['tool'];
  query: RecentWorkContextResponse['query'];
  truncation: RecentWorkContextResponse['truncation'];
  warnings: RecentWorkContextResponse['warnings'];
  clusters: SkeletonCluster[];
  atoms: Record<string, SkeletonAtom>;
}

export function applySkeletonAtom(atom: NormalizedContextEvent): SkeletonAtom {
  const summarySrc = atom.action.input ?? atom.action.output;
  const summary =
    summarySrc !== undefined && summarySrc.length > 0
      ? summarySrc.slice(0, SKELETON_SUMMARY_CAP)
      : undefined;
  const skeleton: SkeletonAtom = {
    id: atom.id,
    time: atom.time,
    source: atom.source,
    action: { kind: atom.action.kind },
  };
  if (summary !== undefined) {
    skeleton.action.summary = summary;
  }
  return skeleton;
}

function clipArray<T>(arr: readonly T[], cap: number): { kept: T[]; omitted: number } {
  if (arr.length <= cap) return { kept: [...arr], omitted: 0 };
  const headN = Math.floor(cap / 2);
  const tailN = cap - headN;
  return {
    kept: [...arr.slice(0, headN), ...arr.slice(arr.length - tailN)],
    omitted: arr.length - cap,
  };
}

export function applySkeletonCluster(cluster: Cluster): SkeletonCluster {
  const aIds = clipArray(cluster.atom_ids, SKELETON_CLUSTER_ATOM_IDS_CAP);
  const hints = clipArray(cluster.open_loop_hints, SKELETON_CLUSTER_OPEN_LOOP_HINTS_CAP);
  const skeleton: SkeletonCluster = {
    cluster_id: cluster.cluster_id,
    rank: cluster.rank,
    rank_reason: cluster.rank_reason,
    atom_ids: aIds.kept,
    source_breakdown: cluster.source_breakdown,
    time_range: cluster.time_range,
    open_loop_hints: hints.kept.map((h) => ({
      atom_id: h.atom_id,
      resolved: h.resolved,
    })),
  };
  if (cluster.label !== undefined) {
    skeleton.label = cluster.label;
  }
  if (aIds.omitted > 0) skeleton.atom_ids_omitted = aIds.omitted;
  if (hints.omitted > 0) skeleton.open_loop_hints_omitted = hints.omitted;
  if (aIds.omitted > 0 || hints.omitted > 0) skeleton.truncated = true;
  return skeleton;
}

// Item 028: build a skeleton-mode response by replacing every atom and cluster
// with its stripped variant.
export function buildSkeletonResponse(response: RecentWorkContextResponse): SkeletonResponse {
  const skeletonAtoms: Record<string, SkeletonAtom> = {};
  for (const [id, atom] of Object.entries(response.atoms)) {
    skeletonAtoms[id] = applySkeletonAtom(atom);
  }
  return {
    schema_version: response.schema_version,
    tool: response.tool,
    query: response.query,
    truncation: response.truncation,
    warnings: response.warnings,
    clusters: response.clusters.map(applySkeletonCluster),
    atoms: skeletonAtoms,
  };
}

// outputSchema for get_recent_work_context. Permissive on inner bodies so
// the agent isn't locked into deep validation while items 016–022 reshape them.
const recentWorkContextOutputSchema = {
  schema_version: z.literal(1),
  tool: z.literal('get_recent_work_context'),
  query: z.record(z.string(), z.unknown()),
  clusters: z.array(z.record(z.string(), z.unknown())),
  atoms: z.record(z.string(), z.record(z.string(), z.unknown())),
  truncation: z.record(z.string(), z.unknown()),
  warnings: z.array(z.string()),
};

export function registerRecentWorkContext(server: McpServer, storage: Storage): void {
  server.registerTool(
    'get_recent_work_context',
    {
      description: RECENT_WORK_CONTEXT_DESCRIPTION,
      inputSchema: {
        since: isoString.optional(),
        until: isoString.optional(),
        artifact_hint: artifactHintSchema.optional(),
        limit: z.number().optional(),
        window_hours: z.number().min(0.1).max(168).optional(),
        format: formatSchema.optional(),
        repo_path: z
          .string()
          .optional()
          .describe(
            "Item 037: absolute filesystem path to a repo root. When set, scopes the candidate event set to atoms whose `metadata.repo_root` matches (cross-source). Legacy git atoms without that metadata are out of scope when this is passed; reach them via `source_prefix=git:<path>` on `search_memories` or `echo_resolve_mru(sources=['git'], repo_path=...)` for the two-path OR fallback.",
          ),
      },
      outputSchema: recentWorkContextOutputSchema,
      annotations: { readOnlyHint: true },
    },
    async (input) => {
      const params = input as RecentWorkContextParams;
      let full: RecentWorkContextResponse;
      try {
        full = await getRecentWorkContext(storage, params);
      } catch (err) {
        if (err instanceof Error && err.message.startsWith('get_recent_work_context: ')) {
          return {
            isError: true,
            content: [{ type: 'text', text: err.message }],
          };
        }
        throw err;
      }
      const result: RecentWorkContextResponse | SkeletonResponse =
        params.format === 'skeleton' ? buildSkeletonResponse(full) : full;
      return {
        content: [{ type: 'text', text: JSON.stringify(result) }],
        structuredContent: result as unknown as Record<string, unknown>,
      };
    },
  );
}

// Re-export ResponseFormat for completeness — used by SkeletonResponse keys
// and by callers that need to thread the format type. Local to keep the
// shim's external surface stable across the future cluster-engine moves.
export type { ResponseFormat };
