import type { ArtifactRef, NormalizedContextEvent } from '../normalize/types.js';

export type ArtifactKey = string;

export interface ArtifactHint {
  provider: string;
  type: string;
  id: string;
}

export type ResponseFormat = 'full' | 'minimal' | 'skeleton';

export interface Query {
  since: string;
  until: string;
  artifact_hint?: ArtifactHint;
  window_hours?: number;
  limit?: number;
  format?: ResponseFormat;
  /** Item 037 / AC4: optional work-artifact (repo) scope. The trace
   *  builder itself does not filter on this — storage applies the
   *  metadata_match — but the value rides through Query → QueryEcho so
   *  callers can see what scoped their result set. */
  repo_path?: string;
}

export interface QueryEcho {
  since: string;
  until: string;
  artifact_hint: ArtifactHint | null;
  format: ResponseFormat;
  window_hours: number;
  /** Item 037 / AC4: the normalised `repo_path` that scoped this
   *  response. `null` when omitted by the caller. */
  repo_path: string | null;
}

export type EdgeKind = 'shared_artifact';

export type Confidence = 'high' | 'medium' | 'low';

export interface Edge {
  from: string;
  to: string;
  kind: EdgeKind;
  artifact_ids: ArtifactKey[];
  confidence: Confidence;
}

export type OpenLoopHintKind =
  | 'ends_with_question'
  | 'unresolved_assistant_q'
  | 'contains_todo'
  | 'explicit_followup';

export interface OpenLoopHintEnriched {
  atom_id: string;
  kind: OpenLoopHintKind;
  text: string;
  confidence: Confidence;
  resolved: boolean;
  resolved_by_atom_id?: string;
}

export interface Cluster {
  cluster_id: string;
  rank: number;
  rank_reason: string[];
  label?: string;
  anchor_artifacts: ArtifactRef[];
  atom_ids: string[];
  edges: Edge[];
  open_loop_hints: OpenLoopHintEnriched[];
  source_breakdown: Record<string, number>;
  time_range: { from: string; to: string };
}

export interface Truncation {
  atoms_returned: number;
  atoms_total_in_window: number;
  clusters_returned: number;
  clusters_total: number;
  truncated: boolean;
  // Per-source atom counts across the entire window, computed BEFORE
  // rank-and-truncate drops sibling clusters. Lets a consumer answer
  // "was source X active in this window?" even when source X's cluster
  // got dropped from `clusters[]` by `limit`. Item 029.
  source_breakdown?: Record<string, number>;
}

export interface RecentWorkContextResponse {
  schema_version: 1;
  tool: 'get_recent_work_context';
  query: QueryEcho;
  clusters: Cluster[];
  atoms: Record<string, NormalizedContextEvent>;
  truncation: Truncation;
  warnings: string[];
}

export interface RankSignals {
  recent_activity: boolean;
  matches_artifact_hint: boolean;
  has_unresolved_open_loop: boolean;
  has_open_loop: boolean;
  code_session_anchor: boolean;
  dense: boolean;
  cross_tool: boolean;
}

export interface Graph {
  nodes: string[];
  edges: Edge[];
  /** True when finite graph work/edge budgets omitted additional relations. */
  truncated?: boolean;
}

export interface RawCluster {
  atom_ids: string[];
  edges: Edge[];
}
