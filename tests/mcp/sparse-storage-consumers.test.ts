import { describe, expect, it } from 'vitest';
import { getRecentWorkContext } from '../../src/mcp/internal/cluster-engine.js';
import { echoResolveMru } from '../../src/mcp/tools/echo-resolve-mru.js';
import { waitForNewTurns } from '../../src/mcp/tools/wait-for-new-turns.js';
import { StorageScanBudgetExceededError } from '../../src/storage/budgets.js';
import type { CaptureEvent, QueryFilter } from '../../src/storage/interface.js';
import { MemoryStorage } from '../../src/storage/memory.js';

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
    expect(storage.queryCalls).toBe(2);
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
    expect(storage.queryCalls).toBe(4);
  });
});
