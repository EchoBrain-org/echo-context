import { createHash } from 'node:crypto';
import { isAbsolute } from 'node:path';
import type { NormalizedContextEvent } from '../../normalize/types.js';
import { projectKeyForCanonicalRoot } from '../../project-identity.js';
import type { RecentWorkContextResponse } from '../../trace/types.js';
import { compareTimestampInstants } from '../../util/timestamp.js';
import { normaliseRepoPath } from '../util/repo-path.js';

export type DiscoveryGroupBy = 'project' | 'thread';
export type DiscoveryIdentityQuality = 'canonical' | 'fallback';

export const FIND_CLUSTERS_GROUP_PAGE_DEFAULT = 20;
export const FIND_CLUSTERS_GROUP_PAGE_MAX = 20;
export const FIND_CLUSTERS_REPRESENTATIVE_DEFAULT = 3;
export const FIND_CLUSTERS_REPRESENTATIVE_MAX = 5;
export const FIND_CLUSTERS_MEMBER_PAGE_MAX = 50;
export const FIND_CLUSTERS_CURSOR_MAX_CHARS = 16_384;

export interface DiscoveryGroup {
  group_id: string;
  identity_quality: DiscoveryIdentityQuality;
  project_key: string | null;
  canonical_root: string | null;
  /** Canonical value to pass back as `repo_path`; null when no truthful route
   * can be derived from the retained logical atoms. */
  repo_path: string | null;
  provider?: string;
  root_thread_id?: string;
  unique_turn_count: number;
  raw_observation_count: number;
  collapsed_observation_count: number;
  representative_atom_ids: string[];
  source_breakdown: Record<string, number>;
  time_range: { from: string; to: string };
  thread_count?: number;
  /** Starts immediately after representative_atom_ids. Concatenating the
   * representatives with every member page yields complete membership once. */
  membership_cursor: string | null;
}

export interface DiscoveryGroupModel {
  wire: Omit<DiscoveryGroup, 'membership_cursor'>;
  member_order: string[];
  snapshot_digest: string;
}

export interface DiscoveryCursor {
  version: 1;
  kind: 'groups' | 'members';
  group_by: DiscoveryGroupBy;
  since: string;
  until: string;
  window_hours: number;
  repo_path: string | null;
  offset: number;
  page_size: number;
  representative_limit: number;
  snapshot_digest: string;
  group_id?: string;
}

interface CompactDiscoveryCursorBody {
  v: 1;
  k: 'g' | 'm';
  b: 'p' | 't';
  s: string;
  u: string;
  w: number;
  r: string | null;
  o: number;
  n: number;
  l: number;
  d: string;
  g?: string;
}

interface CompactDiscoveryCursor extends CompactDiscoveryCursorBody {
  c: string;
}

interface ThreadIdentity {
  key: string;
  quality: DiscoveryIdentityQuality;
  projectKey: string | null;
  provider?: string;
  rootThreadId?: string;
}

interface MutableGroup {
  identity: ThreadIdentity;
  atoms: Map<string, NormalizedContextEvent>;
  threadKeys: Set<string>;
}

export class DiscoveryCursorError extends Error {
  constructor(code: 'INVALID' | 'STALE', detail: string) {
    super(
      `[FIND_CLUSTERS_CURSOR_${code}] ${detail}; pass back the prior cursor verbatim`,
    );
    this.name = 'DiscoveryCursorError';
  }
}

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex');
}

function groupId(groupBy: DiscoveryGroupBy, identityKey: string): string {
  return `grp_${groupBy}_${digest(identityKey).slice(0, 16)}`;
}

function nonEmpty(value: string | undefined): string | undefined {
  return value !== undefined && value.length > 0 ? value : undefined;
}

function rawObservationCount(atom: NormalizedContextEvent): number {
  const count = atom.provenance.raw_observation_count;
  return Number.isInteger(count) && (count ?? 0) > 0 ? count! : 1;
}

function compareNewest(
  left: NormalizedContextEvent,
  right: NormalizedContextEvent,
): number {
  const byTime = compareTimestampInstants(
    right.time.occurred_at,
    left.time.occurred_at,
  );
  return byTime === 0 ? left.id.localeCompare(right.id) : byTime;
}

function representatives(
  atoms: readonly NormalizedContextEvent[],
  limit: number,
): NormalizedContextEvent[] {
  const newest = [...atoms].sort(compareNewest);
  const newestPerSource = new Map<string, NormalizedContextEvent>();
  for (const atom of newest) {
    if (!newestPerSource.has(atom.source.app)) {
      newestPerSource.set(atom.source.app, atom);
    }
  }

  const selected: NormalizedContextEvent[] = [];
  const selectedIds = new Set<string>();
  for (const atom of [...newestPerSource.values()].sort(compareNewest)) {
    if (selected.length >= limit) break;
    selected.push(atom);
    selectedIds.add(atom.id);
  }
  for (const atom of newest) {
    if (selected.length >= limit) break;
    if (selectedIds.has(atom.id)) continue;
    selected.push(atom);
    selectedIds.add(atom.id);
  }
  return selected;
}

function canonicalRouteFor(atoms: readonly NormalizedContextEvent[]): string | null {
  const roots = atoms
    .map((atom) => atom.project?.canonical_root)
    .filter((root): root is string => root !== undefined && root.length > 0);
  if (roots.length === 0 || roots.some((root) => !isAbsolute(root))) return null;
  const normalizedRoots = new Set(roots.map(normaliseRepoPath));
  if (normalizedRoots.size !== 1) return null;
  const normalizedRoot = [...normalizedRoots][0]!;
  const routeKey = projectKeyForCanonicalRoot(normalizedRoot);
  return atoms.every((atom) => atom.project?.key === routeKey)
    ? normalizedRoot
    : null;
}

function projectIdentity(
  atom: NormalizedContextEvent,
  clusterId: string,
): ThreadIdentity {
  const projectKey = nonEmpty(atom.project?.key);
  if (projectKey !== undefined) {
    return {
      key: `project\u0000${projectKey}`,
      quality: 'canonical',
      projectKey,
    };
  }
  // Missing identity must not create a machine-wide "unknown project" bucket.
  // The current bounded cluster is the widest truthful fallback boundary.
  return {
    key: `project-fallback\u0000${clusterId}`,
    quality: 'fallback',
    projectKey: null,
  };
}

function explicitThreadIdentity(
  atom: NormalizedContextEvent,
  clusterId: string,
): ThreadIdentity | undefined {
  const conversation = atom.conversation;
  if (conversation === undefined) return undefined;
  const projectKey = nonEmpty(atom.project?.key);
  const projectPart = projectKey ?? `fallback-project:${clusterId}`;
  const provider = nonEmpty(conversation.provider);
  if (provider === undefined) return undefined;

  const rootThreadId = nonEmpty(conversation.root_thread_id);
  if (rootThreadId !== undefined) {
    return {
      key: `thread\u0000${projectPart}\u0000${provider}\u0000root\u0000${rootThreadId}`,
      quality: projectKey === undefined ? 'fallback' : 'canonical',
      projectKey: projectKey ?? null,
      provider,
      rootThreadId,
    };
  }

  const sessionId = nonEmpty(conversation.session_id);
  if (sessionId === undefined) return undefined;
  return {
    key: `thread\u0000${projectPart}\u0000${provider}\u0000session\u0000${sessionId}`,
    quality: 'fallback',
    projectKey: projectKey ?? null,
    provider,
  };
}

function fallbackThreadIdentity(
  atom: NormalizedContextEvent,
  clusterId: string,
): ThreadIdentity {
  const projectKey = nonEmpty(atom.project?.key);
  const projectPart = projectKey ?? `fallback-project:${clusterId}`;
  return {
    key: `thread-fallback\u0000${projectPart}\u0000${clusterId}`,
    quality: 'fallback',
    projectKey: projectKey ?? null,
  };
}

function addToGroup(
  groups: Map<string, MutableGroup>,
  identity: ThreadIdentity,
  atom: NormalizedContextEvent,
  threadKey?: string,
): void {
  let group = groups.get(identity.key);
  if (group === undefined) {
    group = {
      identity,
      atoms: new Map<string, NormalizedContextEvent>(),
      threadKeys: new Set<string>(),
    };
    groups.set(identity.key, group);
  }
  group.atoms.set(atom.id, atom);
  if (threadKey !== undefined) group.threadKeys.add(threadKey);
}

function buildMutableGroups(
  response: RecentWorkContextResponse,
  groupBy: DiscoveryGroupBy,
): Map<string, MutableGroup> {
  const groups = new Map<string, MutableGroup>();
  for (const cluster of response.clusters) {
    const clusterAtoms = cluster.atom_ids
      .map((id) => response.atoms[id])
      .filter((atom): atom is NormalizedContextEvent => atom !== undefined);

    const explicitByKey = new Map<string, ThreadIdentity>();
    for (const atom of clusterAtoms) {
      const identity = explicitThreadIdentity(atom, cluster.cluster_id);
      if (identity !== undefined) explicitByKey.set(identity.key, identity);
    }
    const soleExplicit =
      explicitByKey.size === 1 ? [...explicitByKey.values()][0] : undefined;

    if (groupBy === 'project') {
      for (const atom of clusterAtoms) {
        const thread =
          explicitThreadIdentity(atom, cluster.cluster_id) ??
          soleExplicit ??
          fallbackThreadIdentity(atom, cluster.cluster_id);
        addToGroup(
          groups,
          projectIdentity(atom, cluster.cluster_id),
          atom,
          thread.key,
        );
      }
      continue;
    }

    for (const atom of clusterAtoms) {
      const identity =
        explicitThreadIdentity(atom, cluster.cluster_id) ??
        soleExplicit ??
        fallbackThreadIdentity(atom, cluster.cluster_id);
      addToGroup(groups, identity, atom);
    }
  }
  return groups;
}

export function buildDiscoveryGroups(
  response: RecentWorkContextResponse,
  groupBy: DiscoveryGroupBy,
  representativeLimit: number,
): DiscoveryGroupModel[] {
  const mutable = buildMutableGroups(response, groupBy);
  const models: DiscoveryGroupModel[] = [];

  for (const group of mutable.values()) {
    const atoms = [...group.atoms.values()];
    const reps = representatives(atoms, representativeLimit);
    const representativeIds = reps.map((atom) => atom.id);
    const representativeSet = new Set(representativeIds);
    const remaining = atoms
      .filter((atom) => !representativeSet.has(atom.id))
      .sort(compareNewest);
    const memberOrder = [...representativeIds, ...remaining.map((atom) => atom.id)];

    const sourceBreakdown: Record<string, number> = {};
    let rawCount = 0;
    for (const atom of atoms) {
      sourceBreakdown[atom.source.app] = (sourceBreakdown[atom.source.app] ?? 0) + 1;
      rawCount += rawObservationCount(atom);
    }
    const sorted = [...atoms].sort((left, right) => {
      const byTime = compareTimestampInstants(
        left.time.occurred_at,
        right.time.occurred_at,
      );
      return byTime === 0 ? left.id.localeCompare(right.id) : byTime;
    });
    // A route is only truthful when every retained atom that carries a root
    // agrees on the same value. Do not fall back to the first atom's root when
    // inconsistent legacy rows share a project key.
    const canonicalRoot = canonicalRouteFor(atoms);
    const wire: Omit<DiscoveryGroup, 'membership_cursor'> = {
      group_id: groupId(groupBy, group.identity.key),
      identity_quality: group.identity.quality,
      project_key: group.identity.projectKey,
      canonical_root: canonicalRoot,
      repo_path: canonicalRoot,
      unique_turn_count: atoms.length,
      raw_observation_count: rawCount,
      collapsed_observation_count: rawCount - atoms.length,
      representative_atom_ids: representativeIds,
      source_breakdown: Object.fromEntries(
        Object.entries(sourceBreakdown).sort(([left], [right]) =>
          left.localeCompare(right),
        ),
      ),
      time_range: {
        from: sorted[0]?.time.occurred_at ?? '',
        to: sorted[sorted.length - 1]?.time.occurred_at ?? '',
      },
    };
    if (group.identity.provider !== undefined) {
      wire.provider = group.identity.provider;
    }
    if (group.identity.rootThreadId !== undefined) {
      wire.root_thread_id = group.identity.rootThreadId;
    }
    if (groupBy === 'project') {
      wire.thread_count = group.threadKeys.size;
    }

    models.push({
      wire,
      member_order: memberOrder,
      snapshot_digest: digest({
        group_id: wire.group_id,
        member_order: memberOrder,
        raw_observation_count: rawCount,
      }),
    });
  }

  models.sort((left, right) => {
    const byTime = compareTimestampInstants(
      right.wire.time_range.to,
      left.wire.time_range.to,
    );
    return byTime === 0
      ? left.wire.group_id.localeCompare(right.wire.group_id)
      : byTime;
  });
  return models;
}

export function discoveryGroupSetDigest(
  groups: readonly DiscoveryGroupModel[],
): string {
  return digest(groups.map((group) => [group.wire.group_id, group.snapshot_digest]));
}

function compactCursor(cursor: DiscoveryCursor): CompactDiscoveryCursorBody {
  return {
    v: 1,
    k: cursor.kind === 'groups' ? 'g' : 'm',
    b: cursor.group_by === 'project' ? 'p' : 't',
    s: cursor.since,
    u: cursor.until,
    w: cursor.window_hours,
    r: cursor.repo_path,
    o: cursor.offset,
    n: cursor.page_size,
    l: cursor.representative_limit,
    d: cursor.snapshot_digest,
    ...(cursor.group_id !== undefined ? { g: cursor.group_id } : {}),
  };
}

export function encodeDiscoveryCursor(cursor: DiscoveryCursor): string {
  const body = compactCursor(cursor);
  const compact: CompactDiscoveryCursor = { ...body, c: digest(body) };
  const encoded = Buffer.from(JSON.stringify(compact), 'utf8').toString('base64url');
  if (encoded.length > FIND_CLUSTERS_CURSOR_MAX_CHARS) {
    throw new DiscoveryCursorError('INVALID', 'cursor exceeds its bounded wire size');
  }
  return encoded;
}

function cursorInteger(
  value: unknown,
  field: string,
  min: number,
  max: number,
): number {
  if (!Number.isInteger(value) || (value as number) < min || (value as number) > max) {
    throw new DiscoveryCursorError('INVALID', `invalid ${field}`);
  }
  return value as number;
}

export function decodeDiscoveryCursor(raw: string): DiscoveryCursor {
  if (
    raw.length === 0 ||
    raw.length > FIND_CLUSTERS_CURSOR_MAX_CHARS ||
    !/^[A-Za-z0-9_-]+$/.test(raw)
  ) {
    throw new DiscoveryCursorError('INVALID', 'cursor is not bounded base64url');
  }

  let parsed: unknown;
  try {
    const decoded = Buffer.from(raw, 'base64url').toString('utf8');
    if (Buffer.from(decoded, 'utf8').toString('base64url') !== raw) {
      throw new Error('non-canonical base64url');
    }
    parsed = JSON.parse(decoded) as unknown;
  } catch {
    throw new DiscoveryCursorError('INVALID', 'cursor does not decode to canonical JSON');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new DiscoveryCursorError('INVALID', 'cursor JSON is not an object');
  }

  const obj = parsed as Partial<CompactDiscoveryCursor>;
  if (obj.v !== 1 || (obj.k !== 'g' && obj.k !== 'm')) {
    throw new DiscoveryCursorError('INVALID', 'unsupported cursor version or kind');
  }
  const allowedKeys = new Set([
    'v',
    'k',
    'b',
    's',
    'u',
    'w',
    'r',
    'o',
    'n',
    'l',
    'd',
    'c',
    ...(obj.k === 'm' ? ['g'] : []),
  ]);
  if (Object.keys(obj).some((key) => !allowedKeys.has(key))) {
    throw new DiscoveryCursorError('INVALID', 'cursor contains unexpected fields');
  }
  if (typeof obj.c !== 'string' || !/^[0-9a-f]{64}$/.test(obj.c)) {
    throw new DiscoveryCursorError('INVALID', 'cursor integrity tag is invalid');
  }
  const { c: integrityTag, ...integrityBody } = obj;
  if (integrityTag !== digest(integrityBody)) {
    throw new DiscoveryCursorError('INVALID', 'cursor integrity check failed');
  }
  if (obj.b !== 'p' && obj.b !== 't') {
    throw new DiscoveryCursorError('INVALID', 'invalid grouping mode');
  }
  if (
    typeof obj.s !== 'string' ||
    typeof obj.u !== 'string' ||
    !Number.isFinite(Date.parse(obj.s)) ||
    !Number.isFinite(Date.parse(obj.u)) ||
    Date.parse(obj.s) >= Date.parse(obj.u)
  ) {
    throw new DiscoveryCursorError('INVALID', 'invalid frozen time window');
  }
  if (obj.r !== null && (typeof obj.r !== 'string' || obj.r.length > 4096)) {
    throw new DiscoveryCursorError('INVALID', 'invalid repo_path');
  }
  if (typeof obj.d !== 'string' || !/^[0-9a-f]{64}$/.test(obj.d)) {
    throw new DiscoveryCursorError('INVALID', 'invalid result-set digest');
  }
  if (obj.k === 'm' && (typeof obj.g !== 'string' || obj.g.length === 0)) {
    throw new DiscoveryCursorError('INVALID', 'member cursor is missing group_id');
  }
  if (obj.k === 'g' && obj.g !== undefined) {
    throw new DiscoveryCursorError('INVALID', 'group cursor has an unexpected group_id');
  }

  const offset = cursorInteger(
    obj.o,
    'offset',
    obj.k === 'g' ? 1 : 0,
    500,
  );
  const pageSize = cursorInteger(
    obj.n,
    'page_size',
    1,
    obj.k === 'g'
      ? FIND_CLUSTERS_GROUP_PAGE_MAX
      : FIND_CLUSTERS_MEMBER_PAGE_MAX,
  );
  const representativeLimit = cursorInteger(
    obj.l,
    'representative_limit',
    1,
    FIND_CLUSTERS_REPRESENTATIVE_MAX,
  );
  if (obj.k === 'm' && pageSize !== FIND_CLUSTERS_MEMBER_PAGE_MAX) {
    throw new DiscoveryCursorError('INVALID', 'member cursor page_size is not canonical');
  }
  if (obj.k === 'm' && offset < representativeLimit) {
    throw new DiscoveryCursorError(
      'INVALID',
      'member cursor offset precedes the representative prefix',
    );
  }

  return {
    version: 1,
    kind: obj.k === 'g' ? 'groups' : 'members',
    group_by: obj.b === 'p' ? 'project' : 'thread',
    since: obj.s,
    until: obj.u,
    window_hours:
      typeof obj.w === 'number' && obj.w >= 0.1 && obj.w <= 168
        ? obj.w
        : (() => {
            throw new DiscoveryCursorError('INVALID', 'invalid window_hours');
          })(),
    repo_path: obj.r,
    offset,
    page_size: pageSize,
    representative_limit: representativeLimit,
    snapshot_digest: obj.d,
    ...(obj.g !== undefined ? { group_id: obj.g } : {}),
  };
}

export function cursorForGroupPage(input: {
  response: RecentWorkContextResponse;
  group_by: DiscoveryGroupBy;
  offset: number;
  page_size: number;
  representative_limit: number;
  snapshot_digest: string;
}): string {
  return encodeDiscoveryCursor({
    version: 1,
    kind: 'groups',
    group_by: input.group_by,
    since: input.response.query.since,
    until: input.response.query.until,
    window_hours: input.response.query.window_hours,
    repo_path: input.response.query.repo_path,
    offset: input.offset,
    page_size: input.page_size,
    representative_limit: input.representative_limit,
    snapshot_digest: input.snapshot_digest,
  });
}

export function cursorForMemberPage(input: {
  response: RecentWorkContextResponse;
  group_by: DiscoveryGroupBy;
  group: DiscoveryGroupModel;
  offset: number;
  representative_limit: number;
}): string {
  return encodeDiscoveryCursor({
    version: 1,
    kind: 'members',
    group_by: input.group_by,
    since: input.response.query.since,
    until: input.response.query.until,
    window_hours: input.response.query.window_hours,
    repo_path: input.response.query.repo_path,
    offset: input.offset,
    page_size: FIND_CLUSTERS_MEMBER_PAGE_MAX,
    representative_limit: input.representative_limit,
    snapshot_digest: input.group.snapshot_digest,
    group_id: input.group.wire.group_id,
  });
}
