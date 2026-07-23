import { describe, expect, it } from 'vitest';
import {
  CLUSTER_MAX_DELAYED_STORAGE_SCAN_WINDOWS,
  CLUSTER_MAX_RAW_OBSERVATIONS,
  CLUSTER_MAX_RAW_STORED_BYTES,
  CLUSTER_MAX_STORAGE_SCAN_WINDOWS,
  getRecentWorkContext,
} from '../../src/mcp/internal/cluster-engine.js';
import { echoResolveMru } from '../../src/mcp/tools/echo-resolve-mru.js';
import { findClusters } from '../../src/mcp/tools/find-clusters.js';
import { getAtoms } from '../../src/mcp/tools/get-atoms.js';
import { searchMemories } from '../../src/mcp/tools/search-memories.js';
import { waitForNewTurns } from '../../src/mcp/tools/wait-for-new-turns.js';
import { StorageScanBudgetExceededError } from '../../src/storage/budgets.js';
import type { CaptureEvent, QueryFilter } from '../../src/storage/interface.js';
import { MemoryStorage } from '../../src/storage/memory.js';
import { SqliteStorage } from '../../src/storage/sqlite.js';

/** Models SQLite reaching an 8,192-row sparse descriptor window while
 * retaining MemoryStorage's deterministic payload/query behavior afterward. */
class SparseWindowStorage extends MemoryStorage {
  queryCalls = 0;

  constructor(
    private remainingBoundaries: number,
    private readonly resumeCursor: { timestamp: string; id: string },
  ) {
    super();
  }

  override async query(filter?: QueryFilter): Promise<CaptureEvent[]> {
    this.queryCalls += 1;
    if (this.remainingBoundaries > 0) {
      this.remainingBoundaries -= 1;
      throw new StorageScanBudgetExceededError({
        order: filter?.order ?? 'desc',
        scanned_rows: 8_192,
        matched_ids: [],
        resume_cursor: this.resumeCursor,
      });
    }
    return super.query(filter);
  }
}

class SparseMatchedSqliteStorage extends SqliteStorage {
  queryCalls = 0;
  getByIdsCalls = 0;
  observedProjectKey: string | undefined;
  observedLegacyProjectRoots: readonly string[] | undefined;
  private boundaryPending = true;

  constructor(private readonly matchedIds: readonly string[]) {
    super(':memory:');
  }

  override async query(filter?: QueryFilter): Promise<CaptureEvent[]> {
    this.queryCalls += 1;
    this.observedProjectKey = filter?.project_key;
    this.observedLegacyProjectRoots = filter?.legacy_project_roots;
    if (this.boundaryPending) {
      this.boundaryPending = false;
      throw new StorageScanBudgetExceededError({
        order: filter?.order ?? 'desc',
        scanned_rows: 8_192,
        matched_ids: [...this.matchedIds],
        resume_cursor: {
          timestamp: '2026-05-09T08:00:00.000Z',
          id: 'sparse-resume',
        },
      });
    }
    return super.query(filter);
  }

  override async getByIds(ids: readonly string[]): Promise<CaptureEvent[]> {
    this.getByIdsCalls += 1;
    return super.getByIds(ids);
  }
}

function codexTurn(input: {
  logicalId: string;
  timestamp: string;
  occurredAt?: string;
  observationKind?: 'original' | 'inherited';
  content?: string;
  projectKey?: string;
}): Omit<CaptureEvent, 'id'> {
  const observationKind = input.observationKind ?? 'original';
  const metadata: Record<string, unknown> = {
    session_id: 'root-thread',
    logical_turn_id: input.logicalId,
    thread_id:
      observationKind === 'original'
        ? 'root-thread'
        : `fork-${input.logicalId}`,
    root_thread_id: 'root-thread',
    thread_kind: observationKind === 'original' ? 'root' : 'subagent',
    observation_kind: observationKind,
    initiator: observationKind === 'original' ? 'human' : 'agent',
    occurred_at: input.occurredAt ?? input.timestamp,
    observed_at: input.timestamp,
  };
  if (input.projectKey !== undefined) {
    metadata['repo_root'] = '/repo';
    metadata['canonical_root'] = '/repo';
    metadata['project_key'] = input.projectKey;
  }
  return {
    source: 'fs:/repo/.codex/sessions/2026/05/09/root-thread.jsonl',
    timestamp: input.timestamp,
    content:
      input.content ?? `USER: turn ${input.logicalId}\n\nASSISTANT: done`,
    metadata,
  };
}

const LARGE_TURN_CONTENT = `USER: ${'x'.repeat(4 * 1024 * 1024 - 16 * 1024)}\n\nASSISTANT: inherited`;

async function appendLargeInheritedTurns(
  storage: MemoryStorage | SqliteStorage,
  count: number,
  projectKey?: string,
): Promise<string[]> {
  const ids: string[] = [];
  for (let index = 0; index < count; index += 1) {
    ids.push(
      await storage.append(
        codexTurn({
          logicalId: `large-inherited-${index}`,
          timestamp: `2026-05-09T10:00:0${index}.000Z`,
          occurredAt: `2026-05-09T09:00:0${index}.000Z`,
          observationKind: 'inherited',
          content: LARGE_TURN_CONTENT,
          ...(projectKey !== undefined ? { projectKey } : {}),
        }),
      ),
    );
  }
  return ids;
}

describe('bounded sparse-scan MCP consumers', () => {
  it('echo_resolve_mru resumes in-call instead of surfacing the storage boundary', async () => {
    const source = 'fs:/sessions/old.jsonl';
    const storage = new SparseWindowStorage(1, {
      timestamp: '2026-05-10T00:00:00.000Z',
      id: 'resume',
    });
    await storage.append({
      source,
      timestamp: '2026-05-09T10:00:00.000Z',
      content: 'older sparse match',
    });

    const result = await echoResolveMru(storage, { sources: [source] });
    expect(result.sources[source]?.source).toBe(source);
    expect(result.warnings).toEqual([]);
    expect(storage.queryCalls).toBe(2);
  });

  it('echo_resolve_mru returns a bounded warning when every continuation is sparse', async () => {
    const storage = new SparseWindowStorage(99, {
      timestamp: '2026-05-09T10:00:00.000Z',
      id: 'resume',
    });
    const result = await echoResolveMru(storage, { sources: ['fs:/missing'] });
    expect(result.sources['fs:/missing']).toBeNull();
    expect(result.warnings.join('\n')).toMatch(/bounded storage scan exhausted/);
    expect(storage.queryCalls).toBe(4);
  });

  it('wait_for_new_turns resumes ascending from the scan cursor without restarting since', async () => {
    const source = 'fs:/session.jsonl';
    const storage = new SparseWindowStorage(1, {
      timestamp: '2026-05-09T10:00:30.000Z',
      id: 'resume',
    });
    const id = await storage.append({
      source,
      timestamp: '2026-05-09T10:01:00.000Z',
      content: 'new sparse match',
    });

    const result = await waitForNewTurns(storage, {
      sources: [source],
      since: '2026-05-09T10:00:00.000Z',
      timeout: 0,
    });
    expect(result.turn_ids).toEqual([id]);
    expect(result.warnings).toEqual([]);
    expect(storage.queryCalls).toBe(2);
  });

  it('wait_for_new_turns stops after finite windows and returns an advisory', async () => {
    const storage = new SparseWindowStorage(99, {
      timestamp: '2026-05-09T10:00:30.000Z',
      id: 'resume',
    });
    const result = await waitForNewTurns(storage, {
      sources: ['fs:/missing'],
      since: '2026-05-09T10:00:00.000Z',
      timeout: 30,
    });
    expect(result.timed_out).toBe(true);
    expect(result.warnings.join('\n')).toMatch(/bounded storage scan exhausted/);
    expect(storage.queryCalls).toBe(4);
  });

  it('cluster discovery resumes descending sparse windows in-call', async () => {
    const storage = new SparseWindowStorage(1, {
      timestamp: '2026-05-10T00:00:00.000Z',
      id: 'resume',
    });
    await storage.append({
      source: 'git:/repo',
      timestamp: '2026-05-09T10:00:00.000Z',
      content: 'commit one',
    });

    const result = await getRecentWorkContext(storage, {
      since: '2026-05-09T00:00:00.000Z',
      until: '2026-05-11T00:00:00.000Z',
    });
    expect(result.warnings.some((warning) => warning.includes('STORAGE_SCAN_BUDGET'))).toBe(false);
    // One sparse continuation + the successful on-time page + one empty
    // delayed-observation recovery page.
    expect(storage.queryCalls).toBe(3);
  });

  it('cluster discovery returns partial shape plus a finite-scan warning', async () => {
    const storage = new SparseWindowStorage(99, {
      timestamp: '2026-05-10T00:00:00.000Z',
      id: 'resume',
    });
    const result = await getRecentWorkContext(storage, {
      since: '2026-05-09T00:00:00.000Z',
      until: '2026-05-11T00:00:00.000Z',
    });
    expect(result.warnings.join('\n')).toMatch(/STORAGE_SCAN_BUDGET/);
    expect(storage.queryCalls).toBe(CLUSTER_MAX_STORAGE_SCAN_WINDOWS);
  });

  it('compares logical occurrence bounds as instants when callers use timezone offsets', async () => {
    const storage = new SparseWindowStorage(0, {
      timestamp: '2026-05-09T08:00:00.000Z',
      id: 'unused',
    });
    for (let index = 0; index < 10; index += 1) {
      await storage.append(
        codexTurn({
          logicalId: `offset-${index}`,
          timestamp: `2026-05-09T09:${String(index).padStart(2, '0')}:00.000Z`,
        }),
      );
    }

    const result = await getRecentWorkContext(storage, {
      since: '2026-05-09T01:00:00.000-07:00',
      until: '2026-05-09T03:00:00.000-07:00',
      limit: 1,
    });

    expect(result.truncation.atoms_total_in_window).toBe(10);
    expect(storage.queryCalls).toBe(1);
  });

  it('counts fail-closed unknown observations as distinct raw candidates', async () => {
    const storage = new SparseWindowStorage(0, {
      timestamp: '2026-05-09T08:00:00.000Z',
      id: 'unused',
    });
    for (let index = 0; index < 11; index += 1) {
      const timestamp = `2026-05-09T09:${String(index).padStart(2, '0')}:00.000Z`;
      const turn = codexTurn({
        logicalId: 'shared-but-untrusted',
        timestamp,
      });
      await storage.append({
        ...turn,
        metadata: {
          ...turn.metadata,
          thread_kind: 'unknown',
          observation_kind: 'unknown',
          initiator: 'unknown',
        },
      });
    }

    const result = await getRecentWorkContext(storage, {
      since: '2026-05-09T09:00:00.000Z',
      until: '2026-05-09T10:00:00.000Z',
      limit: 1,
    });

    // Unknown observations are deliberately not collapsed by
    // projectLogicalTurns, so each physical row must also charge the scan's
    // limit * STORAGE_OVERFETCH candidate target.
    expect(result.truncation.atoms_total_in_window).toBe(10);
    expect(result.warnings.join('\n')).toMatch(/storage cap hit/);
    expect(storage.queryCalls).toBe(1);
  });

  it('does not let successfully stored but unnormalizable noise satisfy the logical scan target', async () => {
    const storage = new SparseWindowStorage(0, {
      timestamp: '2026-05-09T08:00:00.000Z',
      id: 'unused',
    });
    const contextId = await storage.append(
      codexTurn({
        logicalId: 'real-context',
        timestamp: '2026-05-09T09:00:00.000Z',
      }),
    );
    for (let index = 0; index < 10; index += 1) {
      await storage.append({
        source: `coord:noise:${index}`,
        timestamp: `2026-05-09T10:${String(index).padStart(2, '0')}:00.000Z`,
        content: 'substrate row with no context normalizer',
        metadata: { surface: 'coord' },
      });
    }

    const result = await getRecentWorkContext(storage, {
      since: '2026-05-09T08:00:00.000Z',
      until: '2026-05-09T11:00:00.000Z',
      limit: 1,
    });

    expect(Object.keys(result.atoms)).toEqual([contextId]);
    expect(storage.queryCalls).toBe(3);
  });

  it('treats until as an exclusive logical-occurrence boundary', async () => {
    const storage = new MemoryStorage();
    await storage.append(
      codexTurn({
        logicalId: 'at-until',
        timestamp: '2026-05-09T09:59:59.000Z',
        occurredAt: '2026-05-09T10:00:00.000Z',
      }),
    );

    const result = await getRecentWorkContext(storage, {
      since: '2026-05-09T09:00:00.000Z',
      until: '2026-05-09T10:00:00.000Z',
    });

    expect(result.truncation.atoms_total_in_window).toBe(0);
    expect(result.clusters).toEqual([]);
  });

  it('includes a delayed MemoryStorage observation by occurrence time', async () => {
    const storage = new MemoryStorage();
    const delayedId = await storage.append(
      codexTurn({
        logicalId: 'delayed-memory',
        timestamp: '2026-05-09T12:00:00.000Z',
        occurredAt: '2026-05-09T09:30:00.000Z',
      }),
    );

    const result = await getRecentWorkContext(storage, {
      since: '2026-05-09T09:00:00.000Z',
      until: '2026-05-09T10:00:00.000Z',
    });

    expect(Object.keys(result.atoms)).toEqual([delayedId]);
    expect(result.truncation.atoms_total_in_window).toBe(1);
    expect(result.warnings).toEqual([]);
  });

  it('includes a delayed SQLite observation by occurrence time', async () => {
    const storage = new SqliteStorage(':memory:');
    try {
      const delayedId = await storage.append(
        codexTurn({
          logicalId: 'delayed-sqlite',
          timestamp: '2026-05-09T12:00:00.000Z',
          occurredAt: '2026-05-09T09:30:00.000Z',
        }),
      );

      const result = await getRecentWorkContext(storage, {
        since: '2026-05-09T09:00:00.000Z',
        until: '2026-05-09T10:00:00.000Z',
      });

      expect(Object.keys(result.atoms)).toEqual([delayedId]);
      expect(result.truncation.atoms_total_in_window).toBe(1);
      expect(result.warnings).toEqual([]);
    } finally {
      storage.close();
    }
  });

  it('does not let 4,001 newer observations starve a historical on-time target', async () => {
    const storage = new MemoryStorage();
    const targetId = await storage.append(
      codexTurn({
        logicalId: 'historical-target',
        timestamp: '2026-05-01T09:30:00.000Z',
      }),
    );
    for (let index = 0; index < 4_001; index += 1) {
      await storage.append(
        codexTurn({
          logicalId: `newer-${index}`,
          timestamp: '2026-05-03T09:30:00.000Z',
          occurredAt: '2026-05-03T09:30:00.000Z',
        }),
      );
    }

    const result = await findClusters(storage, {
      since: '2026-05-01T00:00:00.000Z',
      until: '2026-05-02T00:00:00.000Z',
    });
    const returnedIds = result.clusters.flatMap((cluster) => cluster.atom_ids);

    expect(returnedIds.filter((id) => id === targetId)).toHaveLength(1);
    expect(result.result_caps.atoms_total_in_window).toBe(1);
    expect(result.result_caps.truncated).toBe(true);
    expect(result.warnings.join('\n')).toMatch(
      new RegExp(
        `DELAYED_OBSERVATION_SCAN_BUDGET.*${CLUSTER_MAX_DELAYED_STORAGE_SCAN_WINDOWS} bounded storage windows`,
      ),
    );
    expect(result.warnings.join('\n')).not.toMatch(/STORAGE_INPUT_BUDGET/);
  });

  it('rebases admitted legacy descendant roots onto the queried project partition', async () => {
    const storage = new MemoryStorage();
    const first = codexTurn({
      logicalId: 'legacy-subdir-a',
      timestamp: '2026-05-09T09:10:00.000Z',
    });
    first.metadata!['repo_root'] = '/repo/packages/a';
    const second = codexTurn({
      logicalId: 'legacy-subdir-b',
      timestamp: '2026-05-09T09:20:00.000Z',
    });
    second.metadata!['repo_root'] = '/repo/packages/b';
    await storage.append(first);
    await storage.append(second);

    const result = await getRecentWorkContext(storage, {
      since: '2026-05-09T09:00:00.000Z',
      until: '2026-05-09T10:00:00.000Z',
      repo_path: '/repo',
    });

    expect(result.truncation.atoms_total_in_window).toBe(2);
    expect(result.clusters).toHaveLength(1);
    expect(result.clusters[0]!.atom_ids).toHaveLength(2);
    expect(
      Object.values(result.atoms)
        .map((atom) => atom.project)
        .sort((left, right) =>
          left!.observed_root!.localeCompare(right!.observed_root!),
        ),
    ).toEqual([
      {
        key: 'local:workspace:/repo',
        canonical_root: '/repo',
        observed_root: '/repo/packages/a',
      },
      {
        key: 'local:workspace:/repo',
        canonical_root: '/repo',
        observed_root: '/repo/packages/b',
      },
    ]);
  });

  it('does not rewrite project fields that are already explicit', async () => {
    const storage = new MemoryStorage();
    const explicit = codexTurn({
      logicalId: 'explicit-project',
      timestamp: '2026-05-09T09:10:00.000Z',
    });
    explicit.metadata!['repo_root'] = '/repo/packages/a';
    explicit.metadata!['project_key'] = 'local:workspace:/repo';
    explicit.metadata!['canonical_root'] = '/explicit/canonical/root';
    const explicitId = await storage.append(explicit);

    const result = await getRecentWorkContext(storage, {
      since: '2026-05-09T09:00:00.000Z',
      until: '2026-05-09T10:00:00.000Z',
      repo_path: '/repo',
    });

    expect(result.atoms[explicitId]!.project).toEqual({
      key: 'local:workspace:/repo',
      canonical_root: '/explicit/canonical/root',
      observed_root: '/repo/packages/a',
    });
  });

  it('cluster discovery caps retained raw observations during an inherited-copy flood', async () => {
    const storage = new MemoryStorage();
    for (let index = 0; index <= CLUSTER_MAX_RAW_OBSERVATIONS; index += 1) {
      await storage.append({
        source: 'fs:/repo/.codex/sessions/inherited-flood.jsonl',
        timestamp: '2026-05-09T10:00:00.000Z',
        content: 'USER: inherited prompt\n\nASSISTANT: inherited response',
        metadata: {
          session_id: 'inherited-flood',
          logical_turn_id: `inherited-${index}`,
          thread_id: 'fork-thread',
          root_thread_id: 'root-thread',
          thread_kind: 'subagent',
          observation_kind: 'inherited',
          occurred_at: '2026-05-09T09:00:00.000Z',
        },
      });
    }

    const result = await getRecentWorkContext(storage, {
      since: '2026-05-09T00:00:00.000Z',
      until: '2026-05-10T00:00:00.000Z',
      limit: 500,
    });

    expect(result.truncation.truncated).toBe(true);
    expect(result.warnings.join('\n')).toMatch(
      /STORAGE_INPUT_BUDGET.*raw observations/,
    );
  });

  it('cluster discovery caps retained raw bytes even when row count is small', async () => {
    const storage = new MemoryStorage();
    const rowsNeeded =
      Math.ceil(
        CLUSTER_MAX_RAW_STORED_BYTES / Buffer.byteLength(LARGE_TURN_CONTENT),
      ) + 1;
    await appendLargeInheritedTurns(storage, rowsNeeded);

    const result = await getRecentWorkContext(storage, {
      since: '2026-05-09T00:00:00.000Z',
      until: '2026-05-10T00:00:00.000Z',
      limit: 500,
    });

    expect(result.truncation.truncated).toBe(true);
    expect(result.warnings.join('\n')).toMatch(
      /STORAGE_INPUT_BUDGET.*retained bytes/,
    );
  });

  it('adaptively shrinks a direct SQLite query before applying the cluster byte cap', async () => {
    const storage = new SqliteStorage(':memory:');
    try {
      const rowsNeeded =
        Math.ceil(
          CLUSTER_MAX_RAW_STORED_BYTES / Buffer.byteLength(LARGE_TURN_CONTENT),
        ) + 1;
      await appendLargeInheritedTurns(storage, rowsNeeded);

      const result = await getRecentWorkContext(storage, {
        since: '2026-05-09T00:00:00.000Z',
        until: '2026-05-10T00:00:00.000Z',
        limit: 500,
      });

      expect(result.truncation.truncated).toBe(true);
      expect(result.warnings.join('\n')).toMatch(
        /STORAGE_INPUT_BUDGET.*retained bytes/,
      );
    } finally {
      storage.close();
    }
  });

  it('does not charge out-of-window logical copies to the indexed cluster lane', async () => {
    const storage = new SqliteStorage(':memory:');
    try {
      const targetId = await storage.append(
        codexTurn({
          logicalId: 'valid-in-window-target',
          timestamp: '2026-05-09T09:49:00.000Z',
        }),
      );
      for (let index = 0; index < 9; index += 1) {
        await storage.append(
          codexTurn({
            logicalId: `irrelevant-large-copy-${index}`,
            timestamp: `2026-05-09T09:5${index}:00.000Z`,
            occurredAt: `2026-05-08T09:0${index}:00.000Z`,
            observationKind: 'inherited',
            content: LARGE_TURN_CONTENT,
          }),
        );
      }

      const result = await getRecentWorkContext(storage, {
        since: '2026-05-09T09:00:00.000Z',
        until: '2026-05-09T10:00:00.000Z',
      });

      expect(Object.keys(result.atoms)).toEqual([targetId]);
      expect(result.warnings.join('\n')).not.toMatch(/STORAGE_INPUT_BUDGET/);
    } finally {
      storage.close();
    }
  });

  it('paginates byte-heavy SQLite search results without surfacing a storage error', async () => {
    const storage = new SqliteStorage(':memory:');
    try {
      const expectedIds = await appendLargeInheritedTurns(storage, 9);
      const returnedIds: string[] = [];
      let cursor: string | undefined;
      let pages = 0;
      let reachedEnd = false;

      while (pages < 10) {
        const result = await searchMemories(storage, {
          source: 'fs:/repo/.codex/sessions/2026/05/09/root-thread.jsonl',
          limit: 10,
          ...(cursor !== undefined ? { cursor } : {}),
        });
        returnedIds.push(...result.matches.map((match) => match.id));
        pages += 1;
        if (result.next_cursor === null) {
          reachedEnd = true;
          break;
        }
        cursor = result.next_cursor;
      }

      expect(reachedEnd).toBe(true);
      expect(pages).toBeGreaterThan(1);
      expect(returnedIds).toHaveLength(expectedIds.length);
      expect(new Set(returnedIds)).toEqual(new Set(expectedIds));
    } finally {
      storage.close();
    }
  });

  it('splits byte-heavy SQLite get_atoms hydration while preserving request order', async () => {
    const storage = new SqliteStorage(':memory:');
    try {
      const ids = await appendLargeInheritedTurns(storage, 9);

      const result = await getAtoms(storage, {
        atom_ids: ids,
        fields: ['metadata'],
      });

      expect(result.atoms.map((atom) => atom.id)).toEqual(ids);
      expect(result.atoms_dropped).toBe(0);
    } finally {
      storage.close();
    }
  });

  it('adaptively hydrates byte-heavy SQLite matches from a sparse project scan', async () => {
    const matchedIds: string[] = [];
    const storage = new SparseMatchedSqliteStorage(matchedIds);
    try {
      matchedIds.push(
        ...(await appendLargeInheritedTurns(
          storage,
          Math.ceil(
            CLUSTER_MAX_RAW_STORED_BYTES /
              Buffer.byteLength(LARGE_TURN_CONTENT),
          ) + 1,
          'local:workspace:/repo',
        )),
      );

      const result = await getRecentWorkContext(storage, {
        since: '2026-05-09T00:00:00.000Z',
        until: '2026-05-10T00:00:00.000Z',
        limit: 500,
        repo_path: '/repo',
      });

      expect(result.truncation.truncated).toBe(true);
      expect(result.warnings.join('\n')).toMatch(
        /STORAGE_INPUT_BUDGET.*retained bytes/,
      );
      expect(storage.observedProjectKey).toBe('local:workspace:/repo');
      expect(storage.observedLegacyProjectRoots).toEqual(['/repo']);
      expect(storage.queryCalls).toBe(1);
      expect(storage.getByIdsCalls).toBeGreaterThan(1);
    } finally {
      storage.close();
    }
  });
});
