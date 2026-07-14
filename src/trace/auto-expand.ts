// V1.6 (item 032) — single-source-recent predicate for the no-args
// auto-expand and rank-demotion paths.
//
// Empirical trigger: 2026-05-10 13:06 PDT first-real-resume call on the
// 030 toolkit. The 4h no-args pass returned 1 cluster — but that cluster
// was just the calling AI client's own session noise (2 atoms within the
// last few minutes, `source_breakdown={claude_code: 2}`). The existing
// empty-only auto-expand short-circuited on `clusters.length >= 1` and
// never widened to 24h, so the prior work session sitting at 5+ hours ago
// stayed invisible. AC1's predicate generalizes the auto-expand trigger
// to ALSO fire when every returned cluster is single-source-recent.
//
// Naming: per Codex review Cx2, the predicate uses observable fields
// (single source app + recent timestamp) and does NOT claim to identify
// the calling session — the MCP request shape carries no caller-session
// identity. "single-source-recent" is honest about the heuristic.

import type { NormalizedContextEvent } from '../normalize/types.js';
import type { Cluster } from './types.js';

// 5 minutes — judgment-bound by the AI-client's typical
// "user just sent a message + got a response" turnaround. Calibrated to
// the empirical trigger where the calling-session noise was a few
// minutes old.
export const SINGLE_SOURCE_RECENT_THRESHOLD_MS = 300_000;

/** Single-source-recent iff BOTH:
 *   - cluster.source_breakdown has exactly 1 key (single source app), AND
 *   - the latest NormalizedContextEvent.time.occurred_at of any atom in
 *     the cluster is within SINGLE_SOURCE_RECENT_THRESHOLD_MS of nowMs.
 *
 *  Operates on normalized cluster + atom map. Atoms missing from the map
 *  are skipped (they cannot contribute to the "latest" decision); if no
 *  atom in the cluster has a parsable timestamp, returns false (the
 *  cluster cannot prove its recency, so it is not demoted as noise). */
export function isSingleSourceRecent(
  cluster: Cluster,
  atomsById: Map<string, NormalizedContextEvent>,
  nowMs: number,
): boolean {
  const sourceCount = Object.keys(cluster.source_breakdown).length;
  if (sourceCount !== 1) return false;

  let latestMs = -Infinity;
  for (const id of cluster.atom_ids) {
    const a = atomsById.get(id);
    if (a === undefined) continue;
    const t = Date.parse(a.time.occurred_at);
    if (Number.isNaN(t)) continue;
    if (t > latestMs) latestMs = t;
  }
  if (latestMs === -Infinity) return false;
  return nowMs - latestMs <= SINGLE_SOURCE_RECENT_THRESHOLD_MS;
}

/** True iff EVERY cluster in the input is single-source-recent.
 *  The empty set is vacuously true — preserves the existing empty-only
 *  auto-expand behavior as a degenerate case (AC1). */
export function noUsefulCluster(
  clusters: readonly Cluster[],
  atomsById: Map<string, NormalizedContextEvent>,
  nowMs: number,
): boolean {
  for (const c of clusters) {
    if (!isSingleSourceRecent(c, atomsById, nowMs)) return false;
  }
  return true;
}
