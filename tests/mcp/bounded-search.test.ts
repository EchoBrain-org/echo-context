import { afterEach, describe, expect, it, vi } from 'vitest';
import { homedir, tmpdir } from 'node:os';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import {
  decodeCursor,
  SEARCH_SCAN_MAX_PAGES,
  SEARCH_SCAN_PAGE_ROWS,
  searchMemories,
} from '../../src/mcp/tools/search-memories.js';
import { MemoryStorage } from '../../src/storage/memory.js';
import { SqliteStorage } from '../../src/storage/sqlite.js';
import {
  STORAGE_MAX_SCANNED_ROWS,
  STORAGE_PAYLOAD_PAGE_BYTES,
  StorageScanBudgetExceededError,
} from '../../src/storage/budgets.js';

function timestampForRank(rank: number): string {
  return new Date(Date.UTC(2026, 0, 2, 0, 0, 0) - rank * 1_000).toISOString();
}

async function seedByteBoundaryPage(storage: MemoryStorage): Promise<{
  ids: string[];
  needleId: string;
}> {
  const ids: string[] = [];
  // Four individually-admissible rows fit just below the search scan's 16 MiB
  // aggregate ceiling. The following small row crosses it, forcing a stop in
  // the middle of this five-row (therefore short/final) storage page.
  const largeNoise = 'x'.repeat(STORAGE_PAYLOAD_PAGE_BYTES - 1_024);
  for (let rank = 0; rank < 4; rank += 1) {
    ids.push(
      await storage.append({
        source: 'git:/repo',
        timestamp: timestampForRank(rank),
        content: largeNoise,
      }),
    );
  }
  const needleId = await storage.append({
    source: 'git:/repo',
    timestamp: timestampForRank(4),
    content: `needle-after-byte-boundary-${'y'.repeat(8 * 1_024)}`,
  });
  ids.push(needleId);
  return { ids, needleId };
}

describe('search_memories bounded storage scan', () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it('finds a sparse match through keyset pages and gives every storage read a row limit', async () => {
    const storage = new MemoryStorage();
    for (let rank = 0; rank < 300; rank += 1) {
      await storage.append({
        source: `fs:${homedir()}/.codex/sessions/session.jsonl`,
        timestamp: timestampForRank(rank),
        content: rank === 200 ? 'the sparse needle' : `noise-${rank}`,
      });
    }
    const query = vi.spyOn(storage, 'query');

    const result = await searchMemories(storage, { query: 'needle', limit: 1 });

    expect(result.matches.map((match) => match.content)).toEqual(['the sparse needle']);
    expect(query.mock.calls.length).toBeGreaterThan(1);
    expect(query.mock.calls.length).toBeLessThanOrEqual(SEARCH_SCAN_MAX_PAGES);
    for (const [filter] of query.mock.calls) {
      expect(filter?.limit).toBe(SEARCH_SCAN_PAGE_ROWS);
    }
    expect(query.mock.calls[1]![0]?.before).toBeDefined();
  });

  it('stops at the hard page budget and returns a continuation cursor instead of loading history', async () => {
    const storage = new MemoryStorage();
    const total = SEARCH_SCAN_PAGE_ROWS * SEARCH_SCAN_MAX_PAGES + 25;
    for (let rank = 0; rank < total; rank += 1) {
      await storage.append({
        source: 'git:/repo',
        timestamp: timestampForRank(rank),
        content: `non-match-${rank}`,
      });
    }
    const query = vi.spyOn(storage, 'query');

    const first = await searchMemories(storage, { query: 'absent', limit: 10 });

    expect(first.matches).toEqual([]);
    expect(first.next_cursor).not.toBeNull();
    expect(first.warnings.join('\n')).toMatch(/scan budget reached/);
    expect(query).toHaveBeenCalledTimes(SEARCH_SCAN_MAX_PAGES);
    expect(query.mock.calls.every(([filter]) => filter?.limit === SEARCH_SCAN_PAGE_ROWS)).toBe(true);

    query.mockClear();
    const second = await searchMemories(storage, {
      query: 'absent',
      limit: 10,
      cursor: first.next_cursor!,
    });
    expect(second.matches).toEqual([]);
    expect(second.next_cursor).toBeNull();
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('continues from the last inspected row when bytes stop a short final page', async () => {
    const storage = new MemoryStorage();
    const { ids, needleId } = await seedByteBoundaryPage(storage);
    const query = vi.spyOn(storage, 'query');

    const first = await searchMemories(storage, { query: 'needle', limit: 1 });

    expect(first.matches).toEqual([]);
    expect(first.next_cursor).not.toBeNull();
    expect(decodeCursor(first.next_cursor!)).toEqual({
      timestamp: timestampForRank(3),
      id: ids[3],
    });
    expect(first.warnings.join('\n')).toMatch(/scan budget reached/);
    // Do not spin on the same partially consumed page within one request.
    expect(query).toHaveBeenCalledTimes(1);

    query.mockClear();
    const second = await searchMemories(storage, {
      query: 'needle',
      limit: 1,
      cursor: first.next_cursor!,
    });
    expect(second.matches.map((match) => match.id)).toEqual([needleId]);
    expect(second.next_cursor).toBeNull();
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('prefers the last inspected row over an older storage-scan resume cursor', async () => {
    const storage = new MemoryStorage();
    const { ids, needleId } = await seedByteBoundaryPage(storage);
    const queryImpl = storage.query.bind(storage);
    const getByIds = vi.spyOn(storage, 'getByIds');
    const query = vi.spyOn(storage, 'query').mockImplementation(async (filter) => {
      if (filter?.before === undefined) {
        throw new StorageScanBudgetExceededError({
          order: 'desc',
          scanned_rows: SEARCH_SCAN_PAGE_ROWS,
          matched_ids: ids,
          // This deeper descriptor-scan cursor is already older than every
          // hydrated row; using it here would skip the uninspected needle.
          resume_cursor: { timestamp: timestampForRank(100), id: 'resume' },
        });
      }
      return queryImpl(filter);
    });

    const first = await searchMemories(storage, { query: 'needle', limit: 1 });

    expect(first.matches).toEqual([]);
    expect(first.next_cursor).not.toBeNull();
    expect(decodeCursor(first.next_cursor!)).toEqual({
      timestamp: timestampForRank(3),
      id: ids[3],
    });
    expect(query).toHaveBeenCalledTimes(1);
    expect(getByIds).toHaveBeenCalledTimes(1);

    query.mockClear();
    const second = await searchMemories(storage, {
      query: 'needle',
      limit: 1,
      cursor: first.next_cursor!,
    });
    expect(second.matches.map((match) => match.id)).toEqual([needleId]);
    expect(second.next_cursor).toBeNull();
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('preserves an empty storage-scan page continuation', async () => {
    const storage = new MemoryStorage();
    const needleId = await storage.append({
      source: 'git:/needle/repo',
      timestamp: timestampForRank(1),
      content: 'needle beyond the descriptor window',
    });
    const queryImpl = storage.query.bind(storage);
    const resume = { timestamp: timestampForRank(0), id: 'resume' };
    const query = vi.spyOn(storage, 'query').mockImplementation(async (filter) => {
      if (filter?.before === undefined) {
        throw new StorageScanBudgetExceededError({
          order: 'desc',
          scanned_rows: STORAGE_MAX_SCANNED_ROWS,
          matched_ids: [],
          resume_cursor: resume,
        });
      }
      return queryImpl(filter);
    });

    const first = await searchMemories(storage, {
      source_prefix: 'git:/needle',
      query: 'needle',
      limit: 1,
    });
    expect(first.matches).toEqual([]);
    expect(first.next_cursor).not.toBeNull();
    expect(decodeCursor(first.next_cursor!)).toEqual(resume);
    expect(first.warnings.join('\n')).toMatch(/scan budget reached/);
    expect(query).toHaveBeenCalledTimes(1);

    query.mockClear();
    const second = await searchMemories(storage, {
      source_prefix: 'git:/needle',
      query: 'needle',
      limit: 1,
      cursor: first.next_cursor!,
    });
    expect(second.matches.map((match) => match.id)).toEqual([needleId]);
    expect(second.next_cursor).toBeNull();
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('hydrates storage-scan matches in bounded exact-fetch chunks', async () => {
    const storage = new MemoryStorage();
    const ids: string[] = [];
    for (let rank = 0; rank < 101; rank += 1) {
      ids.push(
        await storage.append({
          source: 'git:/repo',
          timestamp: timestampForRank(rank),
          content: `noise-${rank}`,
        }),
      );
    }
    const resume = { timestamp: timestampForRank(101), id: 'resume' };
    vi.spyOn(storage, 'query').mockRejectedValue(
      new StorageScanBudgetExceededError({
        order: 'desc',
        scanned_rows: STORAGE_MAX_SCANNED_ROWS,
        matched_ids: ids,
        resume_cursor: resume,
      }),
    );
    const getByIds = vi.spyOn(storage, 'getByIds');

    const result = await searchMemories(storage, { query: 'absent', limit: 1 });

    expect(result.matches).toEqual([]);
    expect(decodeCursor(result.next_cursor!)).toEqual(resume);
    expect(getByIds.mock.calls.map(([chunk]) => chunk.length)).toEqual([100, 1]);
  });

  it('keeps recency-only work to one limit-plus-one storage query', async () => {
    const storage = new MemoryStorage();
    for (let rank = 0; rank < 100; rank += 1) {
      await storage.append({
        source: `fs:${homedir()}/.codex/sessions/session.jsonl`,
        timestamp: timestampForRank(rank),
        content: `turn-${rank}`,
      });
    }
    const query = vi.spyOn(storage, 'query');

    const result = await searchMemories(storage, { source_app: 'codex', limit: 10 });

    expect(result.matches).toHaveLength(10);
    expect(result.next_cursor).not.toBeNull();
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0]![0]?.limit).toBe(11);
  });

  it('turns a sparse SQLite source scan budget into an opaque continuation', async () => {
    const root = mkdtempSync(join(tmpdir(), 'echo-context-sparse-search-'));
    roots.push(root);
    const storage = new SqliteStorage(join(root, 'context.db'));
    for (let rank = 0; rank < STORAGE_MAX_SCANNED_ROWS; rank += 1) {
      await storage.append({
        source: `fs:/noise/${rank}`,
        timestamp: timestampForRank(rank),
        content: 'noise',
      });
    }
    await storage.append({
      source: 'git:/needle/repo',
      timestamp: timestampForRank(STORAGE_MAX_SCANNED_ROWS + 1),
      content: 'needle',
    });

    const first = await searchMemories(storage, {
      source_prefix: 'git:/needle',
      limit: 1,
    });
    expect(first.matches).toEqual([]);
    expect(first.next_cursor).not.toBeNull();
    expect(first.warnings.join('\n')).toMatch(/scan budget reached/);

    const second = await searchMemories(storage, {
      source_prefix: 'git:/needle',
      limit: 1,
      cursor: first.next_cursor!,
    });
    expect(second.matches.map((match) => match.content)).toEqual(['needle']);
    storage.close();
  });
});
