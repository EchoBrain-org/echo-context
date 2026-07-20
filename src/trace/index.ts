import { createHash } from 'node:crypto';
import type { CaptureEvent } from '../storage/interface.js';
import type { ArtifactRef, NormalizedContextEvent } from '../normalize/types.js';
import {
  artifactKey,
  buildGraph,
  connectedComponents,
  DEFAULT_WINDOW_HOURS,
  filterRedundantEdges,
} from './cluster.js';
import { enrichHints } from './hints.js';
import { heuristicLabel } from './labels.js';
import { rankClusters, rankReasonsFor } from './rank.js';
import type {
  Cluster,
  Query,
  RecentWorkContextResponse,
} from './types.js';

export type {
  ArtifactHint,
  ArtifactKey,
  Cluster,
  Confidence,
  Edge,
  EdgeKind,
  Graph,
  OpenLoopHintEnriched,
  OpenLoopHintKind,
  Query,
  QueryEcho,
  RankSignals,
  RawCluster,
  RecentWorkContextResponse,
  ResponseFormat,
  Truncation,
} from './types.js';
export {
  artifactKey,
  buildGraph,
  connectedComponents,
  DEFAULT_WINDOW_HOURS,
  filterRedundantEdges,
} from './cluster.js';
export { rankClusters, rankReasonsFor } from './rank.js';
export { heuristicLabel } from './labels.js';
export { enrichHints } from './hints.js';
export { roleOf } from './role.js';
export type { ArtifactRole } from './role.js';

const SCHEMA_VERSION = 1;

export function buildRecentWorkContext(
  events: CaptureEvent[],
  query: Query,
  normalize: (event: CaptureEvent) => NormalizedContextEvent | null,
): RecentWorkContextResponse {
  const sinceMs = Date.parse(query.since);
  const untilMs = Date.parse(query.until);
  const limit = query.limit ?? 100;
  const windowHours = query.window_hours ?? DEFAULT_WINDOW_HOURS;

  // 1. Normalize and filter to window
  const atoms: NormalizedContextEvent[] = [];
  // Per-error-message counts; we dedupe and surface as warnings so a single bad
  // event class (e.g., a malformed metadata field) doesn't spam thousands of
  // identical warnings.
  const errCounts = new Map<string, number>();
  for (const e of events) {
    let a: NormalizedContextEvent | null;
    try {
      a = normalize(e);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errCounts.set(msg, (errCounts.get(msg) ?? 0) + 1);
      continue;
    }
    if (a === null) continue;
    const t = Date.parse(a.time.occurred_at);
    if (Number.isNaN(t)) continue;
    if (t < sinceMs || t > untilMs) continue;
    atoms.push(a);
  }
  // Storage now defaults to DESC for "keep the newest N" semantics (item 021);
  // the trace layer's window filtering and cluster determinism assume ascending
  // order. Sort in-memory after normalization using compareByOccurredAt (the
  // canonical sort defined below). Cost is bounded by the upstream overfetch
  // cap (typically ≤ limit * STORAGE_OVERFETCH events).
  atoms.sort(compareByOccurredAt);
  const atomsById = new Map(atoms.map((a) => [a.id, a]));
  const atomsTotalInWindow = atoms.length;
  // Window-wide source_breakdown computed pre-truncate, so the consumer can
  // see every source active in (since, until) even when limit drops the
  // sibling cluster carrying that source. Cluster-level source_breakdown is
  // unchanged. Item 029 — a Cursor-only sibling cluster was being dropped at
  // default limit=20, hiding "cursor was active" from
  // `cluster[rank=1].source_breakdown`.
  const windowSourceBreakdown = countByApp(atoms);

  // 2. Compute open-loop hints once, before clustering — resolution scans
  //    over the full sorted atom list so the result is cluster-agnostic
  //    (item 020). Hints are then filtered per-cluster by atom membership.
  const allHints = enrichHints(atoms);
  const hintsByAtomId = new Map<string, typeof allHints>();
  for (const h of allHints) {
    const arr = hintsByAtomId.get(h.atom_id);
    if (arr === undefined) hintsByAtomId.set(h.atom_id, [h]);
    else arr.push(h);
  }

  // 3. Graph + components
  const graph = buildGraph(atoms, windowHours);
  const rawClusters = connectedComponents(graph);

  // 4. Compute cluster fields
  let clusters: Cluster[] = rawClusters.map((rc) => {
    const clusterAtoms = rc.atom_ids
      .map((id) => atomsById.get(id))
      .filter((a): a is NormalizedContextEvent => a !== undefined);
    const cluster_id = makeClusterId(rc.atom_ids);
    const label = heuristicLabel(clusterAtoms);
    const open_loop_hints = rc.atom_ids.flatMap(
      (id) => hintsByAtomId.get(id) ?? [],
    );
    const anchor_artifacts = topArtifacts(clusterAtoms, 3);
    const source_breakdown = countByApp(clusterAtoms);
    const time_range = computeTimeRange(clusterAtoms);
    const cluster: Cluster = {
      cluster_id,
      rank: 0,
      rank_reason: [],
      anchor_artifacts,
      atom_ids: rc.atom_ids,
      // Drop scope/session-only edges. Cluster membership (`atom_ids`) is
      // computed from the unfiltered graph above; this filter trims redundant
      // pairwise restatements without changing topology. See
      // `raw/internal/decisions/2026-05-07-trace-edge-filter-design.md`.
      edges: filterRedundantEdges(rc.edges),
      open_loop_hints,
      source_breakdown,
      time_range,
    };
    if (label !== undefined) cluster.label = label;
    return cluster;
  });

  // 5. Filter by artifact_hint if provided
  if (query.artifact_hint !== undefined) {
    const hintKey = `${query.artifact_hint.provider}:${query.artifact_hint.type}:${query.artifact_hint.id}`;
    clusters = clusters.filter((c) => {
      for (const id of c.atom_ids) {
        const a = atomsById.get(id);
        if (a === undefined) continue;
        if (a.artifacts.some((art) => artifactKey(art) === hintKey)) return true;
      }
      return false;
    });
  }

  // 6. Rank
  clusters = rankClusters(clusters, atomsById, query);
  clusters.forEach((c, i) => {
    c.rank = i + 1;
    c.rank_reason = rankReasonsFor(c, atomsById, query);
  });

  const clustersTotal = clusters.length;

  // 7. Truncate by atom limit (lowest-rank cluster atoms drop first)
  const truncated = truncate(clusters, atomsById, limit);

  // 8. Build atoms map (only those still referenced)
  const atomsMap: Record<string, NormalizedContextEvent> = {};
  for (const c of truncated.clusters) {
    for (const id of c.atom_ids) {
      const a = atomsById.get(id);
      if (a !== undefined) atomsMap[id] = a;
    }
  }

  const warnings = buildWarnings(errCounts);
  if (graph.truncated === true) {
    warnings.push(
      '[GRAPH_BUDGET] shared-artifact graph reached its finite pair/edge budget; ' +
        'cluster relations may be partial. Narrow the time/repo scope and retry.',
    );
  }
  // Loud signal when truncation drops entire clusters — the structured
  // `truncation.clusters_returned` vs `clusters_total` difference is easy for
  // a consumer to miss, and the silently-lost cluster is exactly what the
  // user was asking about more than half the time (see 2026-05-07 dogfooding
  // 16:33 + Round 3 themes).
  const clustersDropped = clustersTotal - truncated.clusters.length;
  if (clustersDropped > 0) {
    warnings.push(
      `limit dropped ${clustersDropped} entire cluster(s); ` +
        'raise `limit` or narrow the (since, until) window to retain them',
    );
  }

  const response: RecentWorkContextResponse = {
    schema_version: SCHEMA_VERSION,
    tool: 'get_recent_work_context',
    query: {
      since: query.since,
      until: query.until,
      artifact_hint: query.artifact_hint ?? null,
      format: query.format ?? 'full',
      window_hours: windowHours,
      repo_path: query.repo_path ?? null,
    },
    clusters: truncated.clusters,
    atoms: atomsMap,
    truncation: {
      atoms_returned: truncated.atomsReturned,
      atoms_total_in_window: atomsTotalInWindow,
      clusters_returned: truncated.clusters.length,
      clusters_total: clustersTotal,
      truncated: truncated.didTruncate || graph.truncated === true,
      source_breakdown: windowSourceBreakdown,
    },
    warnings,
  };
  return response;
}

function buildWarnings(errCounts: Map<string, number>): string[] {
  const out: string[] = [];
  for (const [msg, count] of errCounts) {
    out.push(
      count > 1 ? `${msg} (${count}× events skipped)` : `${msg} (1 event skipped)`,
    );
  }
  return out;
}

function compareByOccurredAt(
  a: NormalizedContextEvent,
  b: NormalizedContextEvent,
): number {
  const ta = a.time.occurred_at;
  const tb = b.time.occurred_at;
  if (ta < tb) return -1;
  if (ta > tb) return 1;
  return 0;
}

function makeClusterId(atomIds: string[]): string {
  const sorted = [...atomIds].sort();
  const payload = `${SCHEMA_VERSION}${sorted.join(',')}`;
  const digest = createHash('sha256').update(payload, 'utf8').digest('hex');
  return `ctx_${digest.slice(0, 8)}`;
}

function topArtifacts(
  atoms: NormalizedContextEvent[],
  n: number,
): ArtifactRef[] {
  const counts = new Map<string, { count: number; ref: ArtifactRef }>();
  for (const atom of atoms) {
    const seen = new Set<string>();
    for (const art of atom.artifacts) {
      const key = artifactKey(art);
      if (seen.has(key)) continue;
      seen.add(key);
      const cur = counts.get(key);
      if (cur === undefined) counts.set(key, { count: 1, ref: art });
      else cur.count += 1;
    }
  }
  const entries = Array.from(counts.entries());
  entries.sort((a, b) => {
    if (b[1].count !== a[1].count) return b[1].count - a[1].count;
    if (a[0] < b[0]) return -1;
    if (a[0] > b[0]) return 1;
    return 0;
  });
  return entries.slice(0, n).map((e) => e[1].ref);
}

function countByApp(atoms: NormalizedContextEvent[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const a of atoms) {
    out[a.source.app] = (out[a.source.app] ?? 0) + 1;
  }
  return out;
}

function computeTimeRange(atoms: NormalizedContextEvent[]): {
  from: string;
  to: string;
} {
  if (atoms.length === 0) return { from: '', to: '' };
  let minTs = atoms[0]!.time.occurred_at;
  let maxTs = atoms[0]!.time.occurred_at;
  for (const a of atoms) {
    if (a.time.occurred_at < minTs) minTs = a.time.occurred_at;
    if (a.time.occurred_at > maxTs) maxTs = a.time.occurred_at;
  }
  return { from: minTs, to: maxTs };
}

interface TruncResult {
  clusters: Cluster[];
  didTruncate: boolean;
  atomsReturned: number;
}

function truncate(
  clusters: Cluster[],
  atomsById: Map<string, NormalizedContextEvent>,
  limit: number,
): TruncResult {
  let total = 0;
  for (const c of clusters) total += c.atom_ids.length;
  if (total <= limit) {
    return { clusters, didTruncate: false, atomsReturned: total };
  }

  // Drop atoms from lowest-rank clusters first; if a cluster ends up empty, drop it.
  // Within a cluster we drop by oldest atom first.
  const reversed = [...clusters].reverse(); // lowest rank first
  let toDrop = total - limit;
  const droppedFromCluster = new Map<string, Set<string>>();
  for (const c of reversed) {
    if (toDrop <= 0) break;
    const ordered = [...c.atom_ids].sort((a, b) => {
      const ta = atomsById.get(a)?.time.occurred_at ?? '';
      const tb = atomsById.get(b)?.time.occurred_at ?? '';
      if (ta < tb) return -1;
      if (ta > tb) return 1;
      return 0;
    });
    const dropped = new Set<string>();
    for (const id of ordered) {
      if (toDrop <= 0) break;
      dropped.add(id);
      toDrop--;
    }
    if (dropped.size > 0) droppedFromCluster.set(c.cluster_id, dropped);
  }

  const out: Cluster[] = [];
  let returned = 0;
  for (const c of clusters) {
    const dropped = droppedFromCluster.get(c.cluster_id);
    if (dropped === undefined || dropped.size === 0) {
      out.push(c);
      returned += c.atom_ids.length;
      continue;
    }
    const keptIds = c.atom_ids.filter((id) => !dropped.has(id));
    if (keptIds.length === 0) continue;
    const keptSet = new Set(keptIds);
    const trimmed: Cluster = {
      ...c,
      atom_ids: keptIds,
      edges: c.edges.filter((e) => keptSet.has(e.from) && keptSet.has(e.to)),
    };
    out.push(trimmed);
    returned += keptIds.length;
  }
  return { clusters: out, didTruncate: true, atomsReturned: returned };
}
