import type { Storage } from '../../storage/interface.js';
import type { RecentWorkContextResponse } from '../../trace/types.js';
import {
  buildDiscoveryGroups,
  cursorForGroupPage,
  cursorForMemberPage,
  decodeDiscoveryCursor,
  DiscoveryCursorError,
  discoveryGroupSetDigest,
  FIND_CLUSTERS_GROUP_PAGE_DEFAULT,
  FIND_CLUSTERS_GROUP_PAGE_MAX,
  FIND_CLUSTERS_REPRESENTATIVE_DEFAULT,
  FIND_CLUSTERS_REPRESENTATIVE_MAX,
  type DiscoveryCursor,
  type DiscoveryGroup,
  type DiscoveryGroupBy,
  type DiscoveryGroupModel,
} from './discovery-groups.js';
import { getRecentWorkContext, MAX_LIMIT } from './cluster-engine.js';
import { jsonByteLength } from '../wire-shape/bytes.js';

export interface GroupedFindClustersParams {
  since?: string;
  until?: string;
  window_hours?: number;
  format?: 'skeleton';
  view?: 'compact' | 'rich';
  repo_path?: string;
  group_by?: DiscoveryGroupBy;
  page_size?: number;
  representative_limit?: number;
  cursor?: string;
}

export interface GroupedFindClustersMembershipPage {
  group_id: string;
  atom_ids: string[];
  atoms_returned: number;
  atoms_total: number;
}

export interface GroupedFindClustersResult {
  schema_version: 1;
  tool: 'find_clusters';
  query: {
    since: string;
    until: string;
    window_hours: number;
    format: 'skeleton';
    repo_path: string | null;
    group_by: DiscoveryGroupBy;
    page_size: number;
    representative_limit: number;
  };
  clusters: [];
  mode: 'groups' | 'members';
  groups: DiscoveryGroup[];
  membership_page?: GroupedFindClustersMembershipPage;
  next_cursor: string | null;
  result_caps: {
    clusters_returned: 0;
    clusters_total: number;
    atoms_returned: number;
    atoms_total_in_window: number;
    source_breakdown: Record<string, number>;
    truncated: boolean;
    groups_returned: number;
    groups_total: number;
    unique_turns_total: number;
    raw_observations_total: number;
    counts_complete: boolean;
  };
  warnings: string[];
}

function boundedInteger(
  value: number | undefined,
  fallback: number,
  field: string,
  max: number,
): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 1 || value > max) {
    throw new Error(`find_clusters: ${field} must be an integer from 1 to ${max}`);
  }
  return value;
}

function assertCursorOnly(params: GroupedFindClustersParams): void {
  const conflicting = (
    [
      'since',
      'until',
      'window_hours',
      'format',
      'view',
      'repo_path',
      'group_by',
      'page_size',
      'representative_limit',
    ] as const
  ).filter((key) => params[key] !== undefined);
  if (conflicting.length > 0) {
    throw new Error(
      `find_clusters: cursor continuation must be cursor-only; remove ${conflicting.join(', ')}`,
    );
  }
}

function validateView(view: GroupedFindClustersParams['view']): void {
  if (view === undefined || view === 'compact' || view === 'rich') return;
  throw new Error('find_clusters: view must be one of "compact" or "rich"');
}

function groupedRecentWorkParams(
  params: GroupedFindClustersParams,
  cursor: DiscoveryCursor | undefined,
): {
  group_by: DiscoveryGroupBy;
  page_size: number;
  representative_limit: number;
  recent: {
    since?: string;
    until?: string;
    window_hours?: number;
    repo_path?: string;
    limit: number;
    format: 'skeleton';
  };
} {
  if (cursor !== undefined) {
    return {
      group_by: cursor.group_by,
      page_size: cursor.page_size,
      representative_limit: cursor.representative_limit,
      recent: {
        since: cursor.since,
        until: cursor.until,
        window_hours: cursor.window_hours,
        ...(cursor.repo_path !== null ? { repo_path: cursor.repo_path } : {}),
        limit: MAX_LIMIT,
        format: 'skeleton',
      },
    };
  }
  if (params.group_by === undefined) {
    throw new Error('find_clusters: group_by is required for grouped discovery');
  }
  return {
    group_by: params.group_by,
    page_size: boundedInteger(
      params.page_size,
      FIND_CLUSTERS_GROUP_PAGE_DEFAULT,
      'page_size',
      FIND_CLUSTERS_GROUP_PAGE_MAX,
    ),
    representative_limit: boundedInteger(
      params.representative_limit,
      FIND_CLUSTERS_REPRESENTATIVE_DEFAULT,
      'representative_limit',
      FIND_CLUSTERS_REPRESENTATIVE_MAX,
    ),
    recent: {
      ...(params.since !== undefined ? { since: params.since } : {}),
      ...(params.until !== undefined ? { until: params.until } : {}),
      ...(params.window_hours !== undefined ? { window_hours: params.window_hours } : {}),
      ...(params.repo_path !== undefined ? { repo_path: params.repo_path } : {}),
      limit: MAX_LIMIT,
      format: 'skeleton',
    },
  };
}

function groupWithMembershipCursor(
  response: RecentWorkContextResponse,
  groupBy: DiscoveryGroupBy,
  representativeLimit: number,
  model: DiscoveryGroupModel,
): DiscoveryGroup {
  const representativeCount = model.wire.representative_atom_ids.length;
  return {
    ...model.wire,
    membership_cursor:
      model.member_order.length > representativeCount
        ? cursorForMemberPage({
            response,
            group_by: groupBy,
            group: model,
            offset: representativeCount,
            representative_limit: representativeLimit,
          })
        : null,
  };
}

function groupedResult(input: {
  response: RecentWorkContextResponse;
  models: readonly DiscoveryGroupModel[];
  group_by: DiscoveryGroupBy;
  page_size: number;
  representative_limit: number;
  mode: 'groups' | 'members';
  groups: DiscoveryGroup[];
  atomIdsOnWire: readonly string[];
  next_cursor: string | null;
  membership_page?: GroupedFindClustersMembershipPage;
  extraWarnings?: readonly string[];
}): GroupedFindClustersResult {
  const uniqueTurns = input.models.reduce(
    (sum, group) => sum + group.wire.unique_turn_count,
    0,
  );
  const rawObservations = input.models.reduce(
    (sum, group) => sum + group.wire.raw_observation_count,
    0,
  );
  const result: GroupedFindClustersResult = {
    schema_version: 1,
    tool: 'find_clusters',
    query: {
      since: input.response.query.since,
      until: input.response.query.until,
      window_hours: input.response.query.window_hours,
      format: 'skeleton',
      repo_path: input.response.query.repo_path,
      group_by: input.group_by,
      page_size: input.page_size,
      representative_limit: input.representative_limit,
    },
    clusters: [],
    mode: input.mode,
    groups: input.groups,
    next_cursor: input.next_cursor,
    result_caps: {
      clusters_returned: 0,
      clusters_total: input.response.truncation.clusters_total,
      atoms_returned: new Set(input.atomIdsOnWire).size,
      atoms_total_in_window: input.response.truncation.atoms_total_in_window,
      source_breakdown: input.response.truncation.source_breakdown ?? {},
      truncated: input.response.truncation.truncated,
      groups_returned: input.groups.length,
      groups_total: input.models.length,
      unique_turns_total: uniqueTurns,
      raw_observations_total: rawObservations,
      counts_complete: !input.response.truncation.truncated,
    },
    warnings: [...input.response.warnings, ...(input.extraWarnings ?? [])],
  };
  if (input.membership_page !== undefined) {
    result.membership_page = input.membership_page;
  }
  return result;
}

function assertFreshCursor(
  cursor: DiscoveryCursor,
  actualDigest: string,
  subject: string,
): void {
  if (cursor.snapshot_digest !== actualDigest) {
    throw new DiscoveryCursorError(
      'STALE',
      `${subject} changed inside the frozen window; restart grouped discovery`,
    );
  }
}

function buildGroupPage(input: {
  response: RecentWorkContextResponse;
  models: readonly DiscoveryGroupModel[];
  group_by: DiscoveryGroupBy;
  offset: number;
  requestedPageSize: number;
  representative_limit: number;
  snapshot_digest: string;
  responseByteCeiling: number;
}): GroupedFindClustersResult {
  if (input.offset > input.models.length) {
    throw new DiscoveryCursorError('STALE', 'group offset is beyond the current result set');
  }
  const available = input.models.length - input.offset;
  let returnedCount = Math.min(input.requestedPageSize, available);
  let shapedForBudget = false;

  while (true) {
    const pageModels = input.models.slice(
      input.offset,
      input.offset + returnedCount,
    );
    const groups = pageModels.map((model) =>
      groupWithMembershipCursor(
        input.response,
        input.group_by,
        input.representative_limit,
        model,
      ),
    );
    const nextOffset = input.offset + returnedCount;
    const nextCursor =
      nextOffset < input.models.length
        ? cursorForGroupPage({
            response: input.response,
            group_by: input.group_by,
            offset: nextOffset,
            page_size: input.requestedPageSize,
            representative_limit: input.representative_limit,
            snapshot_digest: input.snapshot_digest,
          })
        : null;
    const result = groupedResult({
      response: input.response,
      models: input.models,
      group_by: input.group_by,
      page_size: input.requestedPageSize,
      representative_limit: input.representative_limit,
      mode: 'groups',
      groups,
      atomIdsOnWire: groups.flatMap((group) => group.representative_atom_ids),
      next_cursor: nextCursor,
      ...(shapedForBudget
        ? {
            extraWarnings: [
              `[FIND_CLUSTERS_GROUP_PAGE_BUDGET] returned ${returnedCount} group headers instead of the requested ${input.requestedPageSize}; pass next_cursor to continue`,
            ],
          }
        : {}),
    });
    if (jsonByteLength(result) <= input.responseByteCeiling) return result;
    if (returnedCount <= 1) {
      throw new Error(
        `find_clusters: one grouped header exceeds the ${input.responseByteCeiling}-byte response ceiling`,
      );
    }
    returnedCount -= 1;
    shapedForBudget = true;
  }
}

function buildMemberPage(input: {
  response: RecentWorkContextResponse;
  models: readonly DiscoveryGroupModel[];
  group: DiscoveryGroupModel;
  group_by: DiscoveryGroupBy;
  offset: number;
  requestedPageSize: number;
  representative_limit: number;
  responseByteCeiling: number;
}): GroupedFindClustersResult {
  if (input.offset >= input.group.member_order.length) {
    throw new DiscoveryCursorError('STALE', 'member offset is beyond the current group');
  }
  const available = input.group.member_order.length - input.offset;
  let returnedCount = Math.min(input.requestedPageSize, available);
  let shapedForBudget = false;

  while (true) {
    const atomIds = input.group.member_order.slice(
      input.offset,
      input.offset + returnedCount,
    );
    const nextOffset = input.offset + returnedCount;
    const nextCursor =
      nextOffset < input.group.member_order.length
        ? cursorForMemberPage({
            response: input.response,
            group_by: input.group_by,
            group: input.group,
            offset: nextOffset,
            representative_limit: input.representative_limit,
          })
        : null;
    const group: DiscoveryGroup = {
      ...input.group.wire,
      membership_cursor: null,
    };
    const result = groupedResult({
      response: input.response,
      models: input.models,
      group_by: input.group_by,
      page_size: input.requestedPageSize,
      representative_limit: input.representative_limit,
      mode: 'members',
      groups: [group],
      atomIdsOnWire: atomIds,
      next_cursor: nextCursor,
      membership_page: {
        group_id: input.group.wire.group_id,
        atom_ids: atomIds,
        atoms_returned: atomIds.length,
        atoms_total: input.group.member_order.length,
      },
      ...(shapedForBudget
        ? {
            extraWarnings: [
              `[FIND_CLUSTERS_MEMBER_PAGE_BUDGET] returned ${returnedCount} member IDs instead of ${input.requestedPageSize}; pass next_cursor to continue`,
            ],
          }
        : {}),
    });
    if (jsonByteLength(result) <= input.responseByteCeiling) return result;
    if (returnedCount <= 1) {
      throw new Error(
        `find_clusters: one member ID exceeds the ${input.responseByteCeiling}-byte response ceiling`,
      );
    }
    returnedCount -= 1;
    shapedForBudget = true;
  }
}

export async function findGroupedClusters(
  storage: Storage,
  params: GroupedFindClustersParams,
  now: Date,
  responseByteCeiling: number,
): Promise<GroupedFindClustersResult> {
  let cursor: DiscoveryCursor | undefined;
  if (params.cursor !== undefined) {
    assertCursorOnly(params);
    cursor = decodeDiscoveryCursor(params.cursor);
  } else {
    // Preserve the established validation error for an invalid view even
    // though grouped headers intentionally have one fixed lean projection.
    validateView(params.view);
  }

  const request = groupedRecentWorkParams(params, cursor);
  const response = await getRecentWorkContext(storage, request.recent, now);
  const models = buildDiscoveryGroups(
    response,
    request.group_by,
    request.representative_limit,
  );

  if (cursor?.kind === 'members') {
    const group = models.find((candidate) => candidate.wire.group_id === cursor!.group_id);
    if (group === undefined) {
      throw new DiscoveryCursorError(
        'STALE',
        'selected group no longer exists inside the frozen window',
      );
    }
    assertFreshCursor(cursor, group.snapshot_digest, 'selected group membership');
    return buildMemberPage({
      response,
      models,
      group,
      group_by: request.group_by,
      offset: cursor.offset,
      requestedPageSize: cursor.page_size,
      representative_limit: request.representative_limit,
      responseByteCeiling,
    });
  }

  const snapshotDigest = discoveryGroupSetDigest(models);
  if (cursor !== undefined) {
    assertFreshCursor(cursor, snapshotDigest, 'group result set');
  }
  return buildGroupPage({
    response,
    models,
    group_by: request.group_by,
    offset: cursor?.offset ?? 0,
    requestedPageSize: request.page_size,
    representative_limit: request.representative_limit,
    snapshot_digest: snapshotDigest,
    responseByteCeiling,
  });
}
