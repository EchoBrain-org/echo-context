import type { NormalizedContextEvent } from '../normalize/types.js';
import { isSingleSourceRecent } from './auto-expand.js';
import { artifactKey } from './cluster.js';
import type { Cluster, Query, RankSignals } from './types.js';

const RECENT_HOURS = 1;
const CODE_SESSION_ARTIFACT_TYPES = new Set(['repo', 'file', 'commit']);

// `has_open_loop` is retained in the internal signal shape for compatibility,
// but now means an unresolved loop. Resolved hints are evidence, not urgency.

// V1.6 (item 032) — options for the no-args auto-expand demotion path.
// When `demoteSingleSourceRecent` is true, a new PRIMARY sort key is added
// BEFORE the existing 5-key chain (hint > recent > openLoop > size >
// negMedianAge): single-source-recent clusters sort STRICTLY BELOW all
// non-single-source-recent clusters. This is a strict partition, not a
// per-signal nudge — an earlier R1 draft tried to neutralize the `recent`
// signal alone, but `rank.ts`'s 5-key chain still places `hint` ahead of
// `recent`, so a noise cluster carrying `matches_artifact_hint=1` could
// still outrank prior multi-source work. The strict partition is the
// structural guarantee the demo bar requires
// (clusters[0] = prior multi-source work whenever prior work exists in
// 24h). See AC1 + R2-2 in the item 032 spec.
//
// Default `demoteSingleSourceRecent=false` preserves all existing rank
// semantics for non-auto-expand callers (direct rankClusters consumers,
// caller-specified since/until, the empty-trigger auto-expand path).
export interface RankOptions {
  demoteSingleSourceRecent?: boolean;
  /** Required when demoteSingleSourceRecent=true. The reference instant
   *  for the single-source-recent threshold. Pass the caller's `now` so
   *  the predicate stays consistent with the auto-expand trigger that
   *  set demote=true upstream. */
  nowMs?: number;
}

export function rankReasonsFor(
  cluster: Cluster,
  atomsById: Map<string, NormalizedContextEvent>,
  query: Query,
): string[] {
  const signals = signalsFor(cluster, atomsById, query);
  const reasons: string[] = [];
  if (signals.recent_activity) reasons.push('recent_activity');
  if (signals.matches_artifact_hint) reasons.push('matches_artifact_hint');
  if (signals.has_unresolved_open_loop) reasons.push('has_unresolved_open_loop');
  if (signals.code_session_anchor) reasons.push('code_session_anchor');
  if (signals.dense) reasons.push('dense');
  if (signals.cross_tool) reasons.push('cross_tool');
  return reasons;
}

export function signalsFor(
  cluster: Cluster,
  atomsById: Map<string, NormalizedContextEvent>,
  query: Query,
): RankSignals {
  const untilMs = Date.parse(query.until);
  const recentCutoff = untilMs - RECENT_HOURS * 60 * 60 * 1000;
  let recent = false;
  for (const id of cluster.atom_ids) {
    const a = atomsById.get(id);
    if (a === undefined) continue;
    const t = Date.parse(a.time.occurred_at);
    if (!Number.isNaN(t) && t >= recentCutoff && t <= untilMs) {
      recent = true;
      break;
    }
  }

  let touchesHint = false;
  if (query.artifact_hint !== undefined) {
    const hintKey = `${query.artifact_hint.provider}:${query.artifact_hint.type}:${query.artifact_hint.id}`;
    for (const id of cluster.atom_ids) {
      const a = atomsById.get(id);
      if (a === undefined) continue;
      if (a.artifacts.some((art) => artifactKey(art) === hintKey)) {
        touchesHint = true;
        break;
      }
    }
  }

  const hasUnresolvedOpenLoop = cluster.open_loop_hints.some((h) => h.resolved === false);
  const hasCodeArtifact = cluster.anchor_artifacts.some((a) =>
    CODE_SESSION_ARTIFACT_TYPES.has(a.type),
  );
  let hasGitAtom = false;
  for (const id of cluster.atom_ids) {
    const a = atomsById.get(id);
    if (a?.source.app === 'git') {
      hasGitAtom = true;
      break;
    }
  }
  const dense = cluster.atom_ids.length >= 5;
  const distinctApps = Object.keys(cluster.source_breakdown).length;
  const crossTool = distinctApps >= 3;
  const codeSessionAnchor = hasCodeArtifact || hasGitAtom || crossTool;

  return {
    recent_activity: recent,
    matches_artifact_hint: touchesHint,
    has_unresolved_open_loop: hasUnresolvedOpenLoop,
    has_open_loop: hasUnresolvedOpenLoop,
    code_session_anchor: codeSessionAnchor,
    dense,
    cross_tool: crossTool,
  };
}

interface SortKey {
  /** V1.6 (item 032) — primary partition. 1 when cluster is single-source-
   *  recent AND demoteSingleSourceRecent is true; 0 otherwise. Sorted
   *  ASCENDING so non-single-source-recent clusters (key=0) come first.
   *  When demoteSingleSourceRecent is false, every cluster's key is 0 and
   *  this partition is a no-op — the existing 5-key chain decides order. */
  singleSourceRecent: number;
  hint: number;
  openLoop: number;
  recent: number;
  size: number;
  negMedianAge: number;
  cluster: Cluster;
}

export function rankClusters(
  clusters: Cluster[],
  atomsById: Map<string, NormalizedContextEvent>,
  query: Query,
  options: RankOptions = {},
): Cluster[] {
  const untilMs = Date.parse(query.until);
  const demote = options.demoteSingleSourceRecent === true;
  const nowMs = options.nowMs;
  const decorated: SortKey[] = clusters.map((c) => {
    const sig = signalsFor(c, atomsById, query);
    const ages: number[] = [];
    for (const id of c.atom_ids) {
      const a = atomsById.get(id);
      if (a === undefined) continue;
      const t = Date.parse(a.time.occurred_at);
      if (!Number.isNaN(t)) ages.push(untilMs - t);
    }
    ages.sort((x, y) => x - y);
    let median = 0;
    if (ages.length > 0) {
      const mid = Math.floor(ages.length / 2);
      median =
        ages.length % 2 === 0
          ? ((ages[mid - 1] as number) + (ages[mid] as number)) / 2
          : (ages[mid] as number);
    }
    // Primary partition only fires when the caller opts in AND nowMs is
    // supplied. Without nowMs the predicate cannot evaluate recency, so
    // we skip demotion (defensive: callers that pass demote=true without
    // nowMs degenerate to no-op rather than throwing).
    const partition =
      demote && nowMs !== undefined && isSingleSourceRecent(c, atomsById, nowMs) ? 1 : 0;
    return {
      singleSourceRecent: partition,
      hint: sig.matches_artifact_hint ? 1 : 0,
      openLoop: sig.has_unresolved_open_loop ? 1 : 0,
      recent: sig.recent_activity ? 1 : 0,
      size: c.atom_ids.length,
      negMedianAge: -median,
      cluster: c,
    };
  });

  decorated.sort((a, b) => {
    // V1.6 (item 032) — primary partition: single-source-recent clusters
    // sort STRICTLY BELOW non-single-source-recent. Ascending: 0 first.
    if (a.singleSourceRecent !== b.singleSourceRecent)
      return a.singleSourceRecent - b.singleSourceRecent;
    if (a.hint !== b.hint) return b.hint - a.hint;
    if (a.recent !== b.recent) return b.recent - a.recent;
    if (a.openLoop !== b.openLoop) return b.openLoop - a.openLoop;
    if (a.size !== b.size) return b.size - a.size;
    if (a.negMedianAge !== b.negMedianAge) return b.negMedianAge - a.negMedianAge;
    if (a.cluster.cluster_id < b.cluster.cluster_id) return -1;
    if (a.cluster.cluster_id > b.cluster.cluster_id) return 1;
    return 0;
  });

  return decorated.map((d) => d.cluster);
}
