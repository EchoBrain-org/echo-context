import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  FIND_CLUSTERS_RESPONSE_BYTE_CEILING,
  findClusters,
} from '../../src/mcp/tools/find-clusters.js';
import { getAtoms } from '../../src/mcp/tools/get-atoms.js';
import type { Storage } from '../../src/storage/interface.js';
import { MemoryStorage } from '../../src/storage/memory.js';
import { buildForkStormFixture } from '../../tools/benchmark-context-topology.js';

const SINCE = '2026-07-22T10:00:00.000Z';
const UNTIL = '2026-07-22T14:00:00.000Z';
const PROJECT_ROOT = '/workspace/routing';

async function appendRoutingTurn(
  store: MemoryStorage,
  input: {
    provider: 'codex' | 'claude_code';
    occurredAt: string;
    logicalTurnId: string;
    sessionId: string;
    rootThreadId?: string;
    threadId?: string;
    projectRoot?: string;
    projectKey?: string;
    observationKind?: 'original' | 'inherited';
  },
): Promise<string> {
  const root = input.projectRoot ?? PROJECT_ROOT;
  const source =
    input.provider === 'codex'
      ? `fs:${root}/.codex/sessions/2026/07/22/${input.sessionId}.jsonl`
      : `fs:${root}/.claude/projects/benchmark/${input.sessionId}.jsonl`;
  return store.append({
    source,
    timestamp: input.occurredAt,
    content: `USER: Work on ${input.logicalTurnId}.\n\nASSISTANT: Completed ${input.logicalTurnId}.`,
    metadata: {
      session_id: input.sessionId,
      logical_turn_id: input.logicalTurnId,
      occurred_at: input.occurredAt,
      observed_at: input.occurredAt,
      observation_kind: input.observationKind ?? 'original',
      initiator: 'human',
      thread_id: input.threadId ?? input.sessionId,
      ...(input.rootThreadId !== undefined
        ? { root_thread_id: input.rootThreadId }
        : {}),
      repo_root: root,
      canonical_root: root,
      project_key: input.projectKey ?? `local:workspace:${root}`,
    },
  });
}

async function collectGroupPages(
  store: Storage,
  firstCursor: string | null,
): Promise<string[]> {
  const ids: string[] = [];
  let cursor = firstCursor;
  while (cursor !== null) {
    const page = await findClusters(store, { cursor });
    expect(Buffer.byteLength(JSON.stringify(page), 'utf8')).toBeLessThanOrEqual(
      FIND_CLUSTERS_RESPONSE_BYTE_CEILING,
    );
    ids.push(...(page.groups ?? []).map((group) => group.group_id));
    cursor = page.next_cursor ?? null;
  }
  return ids;
}

describe('find_clusters grouped routing contract', () => {
  it('keeps the omitted-group_by legacy envelope free of grouped fields', async () => {
    const fixture = await buildForkStormFixture();
    const result = await findClusters(fixture.store, {
      since: SINCE,
      until: UNTIL,
    });

    expect(Object.keys(result).sort()).toEqual([
      'clusters',
      'query',
      'result_caps',
      'schema_version',
      'tool',
      'warnings',
    ]);
    expect(Object.keys(result.query).sort()).toEqual([
      'format',
      'repo_path',
      'since',
      'until',
      'window_hours',
    ]);
  });

  it('groups the fork storm by canonical project with truthful raw/unique counts', async () => {
    const fixture = await buildForkStormFixture();
    const result = await findClusters(fixture.store, {
      since: SINCE,
      until: UNTIL,
      group_by: 'project',
    });

    expect(result.clusters).toEqual([]);
    expect(result.mode).toBe('groups');
    expect(result.next_cursor).toBeNull();
    expect(result.result_caps).toMatchObject({
      groups_returned: 3,
      groups_total: 3,
      unique_turns_total: 123,
      raw_observations_total: 460,
      counts_complete: true,
      truncated: false,
    });

    const groups = new Map(
      (result.groups ?? []).map((group) => [group.repo_path, group]),
    );
    expect(groups.get('/workspace/echo-brain')).toMatchObject({
      identity_quality: 'canonical',
      unique_turn_count: 72,
      raw_observation_count: 354,
      collapsed_observation_count: 282,
      thread_count: 3,
      source_breakdown: { codex: 72 },
    });
    expect(groups.get('/workspace/echo-context')).toMatchObject({
      unique_turn_count: 38,
      raw_observation_count: 93,
      collapsed_observation_count: 55,
      thread_count: 2,
      source_breakdown: { claude_code: 38 },
    });
    expect(groups.get('/workspace/hdc')).toMatchObject({
      unique_turn_count: 13,
      raw_observation_count: 13,
      collapsed_observation_count: 0,
      thread_count: 2,
    });

    const scoped = await findClusters(fixture.store, {
      since: SINCE,
      until: UNTIL,
      group_by: 'project',
      repo_path: '/workspace/echo-brain',
    });
    expect(scoped.groups).toEqual([
      expect.objectContaining({
        group_id: groups.get('/workspace/echo-brain')?.group_id,
        repo_path: '/workspace/echo-brain',
        unique_turn_count: 72,
      }),
    ]);

    const representativeIds = [...groups.values()].flatMap(
      (group) => group.representative_atom_ids,
    );
    const hydrated = await getAtoms(fixture.store, {
      atom_ids: representativeIds,
      fields: ['content'],
      view: 'compact',
    });
    expect(hydrated.atoms.map((atom) => atom.id)).toEqual(representativeIds);
    expect(hydrated.atoms_dropped).toBe(0);
  });

  it('groups root and child activity together without crossing provider boundaries', async () => {
    const store = new MemoryStorage();
    await appendRoutingTurn(store, {
      provider: 'codex',
      occurredAt: '2026-07-22T10:01:00.000Z',
      logicalTurnId: 'codex-r1-root',
      sessionId: 'codex-root-r1',
      rootThreadId: 'shared-root',
    });
    await appendRoutingTurn(store, {
      provider: 'codex',
      occurredAt: '2026-07-22T10:02:00.000Z',
      logicalTurnId: 'codex-r1-child',
      sessionId: 'codex-child-r1',
      threadId: 'codex-child-r1',
      rootThreadId: 'shared-root',
    });
    await appendRoutingTurn(store, {
      provider: 'codex',
      occurredAt: '2026-07-22T10:03:00.000Z',
      logicalTurnId: 'codex-r2',
      sessionId: 'codex-root-r2',
      rootThreadId: 'second-root',
    });
    await appendRoutingTurn(store, {
      provider: 'claude_code',
      occurredAt: '2026-07-22T10:04:00.000Z',
      logicalTurnId: 'claude-r1',
      sessionId: 'claude-root-r1',
      rootThreadId: 'shared-root',
    });
    await appendRoutingTurn(store, {
      provider: 'codex',
      occurredAt: '2026-07-22T10:05:00.000Z',
      logicalTurnId: 'legacy-session',
      sessionId: 'legacy-session',
    });

    const result = await findClusters(store, {
      since: SINCE,
      until: UNTIL,
      group_by: 'thread',
    });
    const groups = result.groups ?? [];

    expect(groups).toHaveLength(4);
    expect(
      groups.find(
        (group) =>
          group.provider === 'codex' &&
          group.root_thread_id === 'shared-root',
      ),
    ).toMatchObject({
      identity_quality: 'canonical',
      unique_turn_count: 2,
      source_breakdown: { codex: 2 },
    });
    expect(
      groups.find(
        (group) =>
          group.provider === 'claude_code' &&
          group.root_thread_id === 'shared-root',
      ),
    ).toMatchObject({ unique_turn_count: 1 });
    expect(
      groups.filter((group) => group.identity_quality === 'fallback'),
    ).toHaveLength(1);
  });

  it('does not advertise a repo route when retained roots disagree', async () => {
    const store = new MemoryStorage();
    for (const [index, root] of ['/workspace/one', '/workspace/two'].entries()) {
      await appendRoutingTurn(store, {
        provider: 'codex',
        occurredAt: `2026-07-22T10:0${index + 1}:00.000Z`,
        logicalTurnId: `conflicting-root-${index}`,
        sessionId: `conflicting-root-${index}`,
        rootThreadId: `conflicting-root-${index}`,
        projectRoot: root,
        projectKey: 'github.com/org/shared',
      });
    }

    const result = await findClusters(store, {
      since: SINCE,
      until: UNTIL,
      group_by: 'project',
    });

    expect(result.groups).toEqual([
      expect.objectContaining({
        project_key: 'github.com/org/shared',
        canonical_root: null,
        repo_path: null,
        unique_turn_count: 2,
      }),
    ]);
  });

  it('does not advertise a repo route that disagrees with the authoritative project key', async () => {
    const store = new MemoryStorage();
    await appendRoutingTurn(store, {
      provider: 'codex',
      occurredAt: '2026-07-22T10:01:00.000Z',
      logicalTurnId: 'remote-key-local-root',
      sessionId: 'remote-key-local-root',
      rootThreadId: 'remote-key-local-root',
      projectRoot: '/workspace/local-checkout',
      projectKey: 'github.com/org/repo',
    });

    const result = await findClusters(store, {
      since: SINCE,
      until: UNTIL,
      group_by: 'project',
    });

    expect(result.groups).toEqual([
      expect.objectContaining({
        identity_quality: 'canonical',
        project_key: 'github.com/org/repo',
        canonical_root: null,
        repo_path: null,
      }),
    ]);

    const structurallyUnnormalized = new MemoryStorage();
    await appendRoutingTurn(structurallyUnnormalized, {
      provider: 'codex',
      occurredAt: '2026-07-22T10:01:00.000Z',
      logicalTurnId: 'unnormalized-route',
      sessionId: 'unnormalized-route',
      rootThreadId: 'unnormalized-route',
      projectRoot: '/workspace/one/../one/',
      projectKey: 'local:workspace:/workspace/one/../one/',
    });
    const unnormalizedResult = await findClusters(structurallyUnnormalized, {
      since: SINCE,
      until: UNTIL,
      group_by: 'project',
    });
    expect(unnormalizedResult.groups).toEqual([
      expect.objectContaining({
        project_key: 'local:workspace:/workspace/one/../one/',
        canonical_root: null,
        repo_path: null,
      }),
    ]);
  });

  it('paginates every group exactly once and fails closed when the snapshot changes', async () => {
    const fixture = await buildForkStormFixture();
    const first = await findClusters(fixture.store, {
      since: SINCE,
      until: UNTIL,
      group_by: 'project',
      page_size: 1,
    });
    expect(first.groups).toHaveLength(1);
    expect(first.next_cursor).not.toBeNull();

    const repeatA = await findClusters(fixture.store, {
      cursor: first.next_cursor!,
    });
    const repeatB = await findClusters(fixture.store, {
      cursor: first.next_cursor!,
    });
    expect(JSON.stringify(repeatB)).toBe(JSON.stringify(repeatA));

    const remaining = await collectGroupPages(
      fixture.store,
      first.next_cursor ?? null,
    );
    const allIds = [
      ...(first.groups ?? []).map((group) => group.group_id),
      ...remaining,
    ];
    expect(new Set(allIds).size).toBe(3);

    const staleFixture = await buildForkStormFixture();
    const staleFirst = await findClusters(staleFixture.store, {
      since: SINCE,
      until: UNTIL,
      group_by: 'project',
      page_size: 1,
    });
    await appendRoutingTurn(staleFixture.store, {
      provider: 'codex',
      occurredAt: '2026-07-22T13:59:00.000Z',
      logicalTurnId: 'new-project-turn',
      sessionId: 'new-project-session',
      rootThreadId: 'new-project-root',
      projectRoot: '/workspace/new-project',
    });
    await expect(
      findClusters(staleFixture.store, { cursor: staleFirst.next_cursor! }),
    ).rejects.toThrow(/FIND_CLUSTERS_CURSOR_STALE/);

    await expect(
      findClusters(fixture.store, {
        cursor: first.next_cursor!,
        group_by: 'project',
      }),
    ).rejects.toThrow(/cursor-only/);
    await expect(
      findClusters(fixture.store, { cursor: 'not-a-cursor' }),
    ).rejects.toThrow(/FIND_CLUSTERS_CURSOR_INVALID/);

    const widenedPayload = JSON.parse(
      Buffer.from(first.next_cursor!, 'base64url').toString('utf8'),
    ) as Record<string, unknown>;
    widenedPayload['n'] = 50;
    const widenedCursor = Buffer.from(JSON.stringify(widenedPayload), 'utf8').toString(
      'base64url',
    );
    await expect(
      findClusters(fixture.store, { cursor: widenedCursor }),
    ).rejects.toThrow(/FIND_CLUSTERS_CURSOR_INVALID.*integrity/);

    const integrityBody = Object.fromEntries(
      Object.entries(widenedPayload).filter(([key]) => key !== 'c'),
    );
    widenedPayload['c'] = createHash('sha256')
      .update(JSON.stringify(integrityBody), 'utf8')
      .digest('hex');
    const retaggedWidenedCursor = Buffer.from(
      JSON.stringify(widenedPayload),
      'utf8',
    ).toString('base64url');
    await expect(
      findClusters(fixture.store, { cursor: retaggedWidenedCursor }),
    ).rejects.toThrow(/FIND_CLUSTERS_CURSOR_INVALID.*page_size/);
  });

  it('paginates full membership after representatives without duplicates or gaps', async () => {
    const fixture = await buildForkStormFixture();
    const result = await findClusters(fixture.store, {
      since: SINCE,
      until: UNTIL,
      group_by: 'project',
      representative_limit: 3,
    });
    const group = (result.groups ?? []).find(
      (candidate) => candidate.repo_path === '/workspace/echo-brain',
    )!;
    expect(group.representative_atom_ids).toHaveLength(3);
    expect(group.membership_cursor).not.toBeNull();

    const ids = [...group.representative_atom_ids];
    let cursor = group.membership_cursor;
    while (cursor !== null) {
      const page = await findClusters(fixture.store, { cursor });
      expect(page.mode).toBe('members');
      expect(page.membership_page?.group_id).toBe(group.group_id);
      ids.push(...(page.membership_page?.atom_ids ?? []));
      cursor = page.next_cursor ?? null;
    }

    expect(ids).toHaveLength(group.unique_turn_count);
    expect(new Set(ids).size).toBe(group.unique_turn_count);
    const hydrated = await fixture.store.getByIds(ids);
    expect(hydrated).toHaveLength(group.unique_turn_count);
  });

  it('marks grouped counts incomplete when the bounded logical-turn cap fires', async () => {
    const store = new MemoryStorage();
    for (let index = 0; index < 510; index += 1) {
      await appendRoutingTurn(store, {
        provider: 'codex',
        occurredAt: new Date(Date.parse(SINCE) + index * 1_000).toISOString(),
        logicalTurnId: `turn-${index}`,
        sessionId: `session-${index}`,
        rootThreadId: `root-${index}`,
        projectRoot: `/workspace/project-${index}`,
      });
    }

    const result = await findClusters(store, {
      since: SINCE,
      until: UNTIL,
      group_by: 'project',
      page_size: 20,
      representative_limit: 1,
    });

    expect(result.result_caps).toMatchObject({
      groups_total: 500,
      unique_turns_total: 500,
      atoms_total_in_window: 510,
      counts_complete: false,
      truncated: true,
    });
    expect(result.next_cursor).not.toBeNull();
    expect(result.warnings.join('\n')).toMatch(/limit dropped|truncat/i);
    expect(Buffer.byteLength(JSON.stringify(result), 'utf8')).toBeLessThanOrEqual(
      FIND_CLUSTERS_RESPONSE_BYTE_CEILING,
    );
  });
});
