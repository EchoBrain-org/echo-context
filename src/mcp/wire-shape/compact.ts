export type ViewMode = 'compact' | 'rich';

export interface CompactClusterInput {
  cluster_id: string;
  rank?: number;
  rank_reason?: readonly string[];
  atom_ids: string[];
  atom_ids_truncated?: true;
  atom_ids_total?: number;
  source_breakdown: Record<string, number>;
  time_range: { from: string; to: string };
  label?: string;
  open_loop_hints: { atom_id: string; resolved: boolean }[];
  open_loop_hints_omitted?: number;
}

export type CompactRankReason =
  | 'has_open_loop'
  | 'has_unresolved_open_loop'
  | 'code_session_anchor';

export interface CompactCluster {
  cluster_id: string;
  rank?: number;
  atom_ids: string[];
  source_breakdown: Record<string, number>;
  time_range: { from: string; to: string };
  label?: string | null;
  open_loop_hints: { atom_id: string; resolved: boolean }[];
  open_loop_hints_omitted?: number;
  atom_ids_truncated?: true;
  atom_ids_total?: number;
  rank_reason?: CompactRankReason[];
}

export interface CompactAtomInput {
  id: string;
  source: string;
  timestamp: string;
  content?: string;
  metadata?: Record<string, unknown>;
  truncations: string[];
}

export interface CompactAtom {
  id: string;
  source: string;
  timestamp: string;
  content?: string;
  metadata?: Record<string, unknown>;
  truncations: string[];
}

const UUID_FALLBACK_LABEL =
  /^discussion about [0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const COMPACT_RANK_REASONS = new Set<string>([
  'has_open_loop',
  'has_unresolved_open_loop',
  'code_session_anchor',
]);

function isCompactRankReason(reason: string): reason is CompactRankReason {
  return COMPACT_RANK_REASONS.has(reason);
}

export function compactCluster(cluster: CompactClusterInput): CompactCluster {
  const out: CompactCluster = {
    cluster_id: cluster.cluster_id,
    atom_ids: cluster.atom_ids,
    source_breakdown: cluster.source_breakdown,
    time_range: cluster.time_range,
    open_loop_hints: cluster.open_loop_hints,
  };
  if (cluster.rank !== undefined) out.rank = cluster.rank;
  if (cluster.label !== undefined) {
    out.label = UUID_FALLBACK_LABEL.test(cluster.label) ? null : cluster.label;
  }
  if (cluster.open_loop_hints_omitted !== undefined) {
    out.open_loop_hints_omitted = cluster.open_loop_hints_omitted;
  }
  if (cluster.atom_ids_truncated !== undefined) out.atom_ids_truncated = cluster.atom_ids_truncated;
  if (cluster.atom_ids_total !== undefined) out.atom_ids_total = cluster.atom_ids_total;
  const rankReason = (cluster.rank_reason ?? []).filter(isCompactRankReason);
  if (rankReason.length > 0) out.rank_reason = rankReason;
  return out;
}

export function compactAtom(atom: CompactAtomInput): CompactAtom {
  const out: CompactAtom = {
    id: atom.id,
    source: atom.source,
    timestamp: atom.timestamp,
    truncations: [...atom.truncations],
  };
  if (atom.content !== undefined) out.content = atom.content;

  const metadata = compactMetadata(atom.source, atom.content ?? '', atom.metadata);
  if (metadata !== undefined) out.metadata = metadata;

  return out;
}

function compactMetadata(
  source: string,
  content: string,
  metadata: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (metadata === undefined) return undefined;
  const out: Record<string, unknown> = {};

  copyIfPresent(metadata, out, 'session_id');
  copyIfPresent(metadata, out, 'repo_root');
  copyIfPositiveNumber(metadata, out, 'tool_call_total');
  copyIfPresent(metadata, out, 'had_tool_use');
  copyIfPresent(metadata, out, 'tool_calls_by_name');
  copyIfPresent(metadata, out, 'files_referenced');

  const sourceKind = inferSourceKind(source, metadata);
  if (sourceKind === 'claude_code') {
    copyIfPresent(metadata, out, 'model');
    if (metadata['permission_mode'] !== undefined && metadata['permission_mode'] !== 'default') {
      out['permission_mode'] = metadata['permission_mode'];
    }
    const branch = metadata['branch'] ?? recordValue(metadata['git_state'])?.['branch'];
    if (branch !== undefined) out['branch'] = branch;
  } else if (sourceKind === 'cursor') {
    if (metadata['is_continuation'] === true) out['is_continuation'] = true;
    const context = compactCursorContext(metadata['context']);
    if (context !== undefined) out['context'] = context;
    const thinking = metadata['thinking'];
    if (typeof thinking === 'string' && thinking.length > 0 && !content.startsWith(thinking)) {
      out['thinking'] = thinking;
    }
  } else if (sourceKind === 'codex') {
    const codex = compactCodexConfig(metadata['codex']);
    if (codex !== undefined) out['codex'] = codex;
    const git = compactCodexGit(metadata['git'], metadata['git_state']);
    if (git !== undefined) out['git'] = git;
  }

  return Object.keys(out).length > 0 ? out : undefined;
}

function copyIfPresent(
  src: Record<string, unknown>,
  dest: Record<string, unknown>,
  key: string,
): void {
  if (src[key] !== undefined) dest[key] = src[key];
}

function copyIfPositiveNumber(
  src: Record<string, unknown>,
  dest: Record<string, unknown>,
  key: string,
): void {
  const value = src[key];
  if (typeof value === 'number' && value > 0) dest[key] = value;
}

function compactCursorContext(value: unknown): Record<string, unknown> | undefined {
  const ctx = recordValue(value);
  if (ctx === undefined) return undefined;
  const out: Record<string, unknown> = {};
  copyIfPresent(ctx, out, 'attached_files');
  copyIfPresent(ctx, out, 'referenced_files');
  copyIfPresent(ctx, out, 'deleted_files');
  return Object.keys(out).length > 0 ? out : undefined;
}

function compactCodexConfig(value: unknown): Record<string, unknown> | undefined {
  const codex = recordValue(value);
  if (codex === undefined) return undefined;
  const out: Record<string, unknown> = {};
  copyIfPresent(codex, out, 'model');
  copyIfPresent(codex, out, 'reasoning_effort');
  return Object.keys(out).length > 0 ? out : undefined;
}

function compactCodexGit(
  gitValue: unknown,
  gitStateValue: unknown,
): Record<string, unknown> | undefined {
  const git = recordValue(gitValue);
  const gitState = recordValue(gitStateValue);
  const branch = git?.['branch'] ?? gitState?.['branch'];
  return branch !== undefined ? { branch } : undefined;
}

function inferSourceKind(
  source: string,
  metadata: Record<string, unknown>,
): 'claude_code' | 'cursor' | 'codex' | 'git' | 'unknown' {
  const surface = metadata['surface'];
  if (surface === 'claude_code' || surface === 'cursor' || surface === 'codex') return surface;
  if (source.startsWith('git:')) return 'git';
  if (source.includes('/.claude/projects/')) return 'claude_code';
  if (source.includes('/.codex/sessions/')) return 'codex';
  if (source.includes('/Cursor/User/') || source.endsWith('.vscdb')) return 'cursor';
  return 'unknown';
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}
