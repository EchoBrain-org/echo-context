import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';
import {
  searchMemories,
  type SearchMemoriesParams,
  type SearchResult,
} from '../src/mcp/tools/search-memories.js';
import {
  STORAGE_DESCRIPTOR_PAGE_ROWS,
  STORAGE_MAX_SCANNED_ROWS,
  type StorageSelectPageObservation,
} from '../src/storage/budgets.js';
import { SqliteStorage } from '../src/storage/sqlite.js';

// Run this unchanged from baseline and candidate worktrees. Pre-0006 schemas
// report a null candidate-order probe; the scenario fixture/timing stays the
// same, which keeps before/after comparisons apples-to-apples.
const FIXTURE_TIMESTAMP = '2026-08-01T00:00:00.000Z';
const WARMUP_RUNS = 5;
const SAMPLE_RUNS = 30;

interface TimingSummary {
  samples: number;
  median_ms: number;
  p95_ms: number;
  min_ms: number;
  max_ms: number;
}

export interface SourcePrefixBenchmarkScenario {
  name: 'codex_app_older_hit' | 'granola_app_absent';
  params: SearchMemoriesParams;
  expected_match_count: number;
  observed_match_count: number;
  descriptor_pages: number;
  descriptor_rows: number;
  payload_pages: number;
  payload_rows: number;
  calls_to_conclusive_answer: number;
  first_call_latency: TimingSummary;
  total_latency: TimingSummary;
  warnings: string[];
}

export interface CandidateOrderProbe {
  broad_family_rows: number;
  page_limit: number;
  candidate_rows_returned: number;
  candidate_rows_visited: number;
  uses_expected_partial_index: boolean;
  temporary_order_sort: boolean;
  plan: string[];
}

export interface SourcePrefixBenchmarkReport {
  fixture: 'dense-unrelated-source-app-v2';
  warmup_runs: number;
  sample_runs: number;
  unrelated_newer_rows: number;
  total_rows: number;
  schema_version: number;
  source_family_index_available: boolean;
  scenarios: SourcePrefixBenchmarkScenario[];
  candidate_order_probe: CandidateOrderProbe | null;
}

interface ScenarioRun {
  matches: SearchResult['matches'];
  warnings: string[];
  calls: number;
  firstCallMs: number;
  totalMs: number;
  observations: StorageSelectPageObservation[];
}

function timestampForRank(rank: number): string {
  return new Date(Date.parse(FIXTURE_TIMESTAMP) + rank * 1_000).toISOString();
}

function summarize(samples: readonly number[]): TimingSummary {
  const sorted = [...samples].sort((left, right) => left - right);
  const percentile = (fraction: number): number =>
    sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)]!;
  const rounded = (value: number): number => Number(value.toFixed(6));
  return {
    samples: sorted.length,
    median_ms: rounded(percentile(0.5)),
    p95_ms: rounded(percentile(0.95)),
    min_ms: rounded(sorted[0]!),
    max_ms: rounded(sorted[sorted.length - 1]!),
  };
}

function observationTotals(observations: readonly StorageSelectPageObservation[]): {
  descriptor_pages: number;
  descriptor_rows: number;
  payload_pages: number;
  payload_rows: number;
} {
  return observations.reduce(
    (totals, observation) => {
      if (observation.phase === 'descriptor') {
        totals.descriptor_pages += 1;
        totals.descriptor_rows += observation.rows;
      } else {
        totals.payload_pages += 1;
        totals.payload_rows += observation.rows;
      }
      return totals;
    },
    {
      descriptor_pages: 0,
      descriptor_rows: 0,
      payload_pages: 0,
      payload_rows: 0,
    },
  );
}

async function seedDenseUnrelatedHistory(storage: SqliteStorage): Promise<void> {
  await storage.append(
    {
      source: `fs:${homedir()}/.codex/sessions/benchmark.jsonl`,
      timestamp: timestampForRank(0),
      content: 'old source_app benchmark hit',
    },
    { dedupeKey: 'benchmark-source-app:codex-hit' },
  );

  for (let rank = 1; rank <= STORAGE_MAX_SCANNED_ROWS; rank += 1) {
    await storage.append(
      {
        source: `fs:/benchmark/unrelated/${rank.toString().padStart(5, '0')}.jsonl`,
        timestamp: timestampForRank(rank),
        content: 'unrelated newer benchmark row',
      },
      { dedupeKey: `benchmark-source-app:unrelated:${rank}` },
    );
  }
}

async function runScenario(
  storage: SqliteStorage,
  observations: StorageSelectPageObservation[],
  params: SearchMemoriesParams,
): Promise<ScenarioRun> {
  observations.length = 0;
  let cursor: string | undefined;
  let calls = 0;
  let firstCallMs = 0;
  const matches: SearchResult['matches'] = [];
  const warnings = new Set<string>();
  const started = performance.now();

  for (;;) {
    if (calls >= 16) throw new Error('scenario did not conclude within 16 calls');
    const callStarted = performance.now();
    const result = await searchMemories(storage, {
      ...params,
      ...(cursor === undefined ? {} : { cursor }),
    });
    const callMs = performance.now() - callStarted;
    calls += 1;
    if (calls === 1) firstCallMs = callMs;
    matches.push(...result.matches);
    for (const warning of result.warnings) warnings.add(warning);
    if (result.next_cursor === null) break;
    cursor = result.next_cursor;
  }

  return {
    matches,
    warnings: [...warnings].sort(),
    calls,
    firstCallMs,
    totalMs: performance.now() - started,
    observations: [...observations],
  };
}

async function measureScenario(input: {
  name: SourcePrefixBenchmarkScenario['name'];
  params: SearchMemoriesParams;
  expectedMatchCount: number;
  storage: SqliteStorage;
  observations: StorageSelectPageObservation[];
}): Promise<SourcePrefixBenchmarkScenario> {
  const { name, params, expectedMatchCount, storage, observations } = input;
  for (let run = 0; run < WARMUP_RUNS; run += 1) {
    await runScenario(storage, observations, params);
  }

  const runs: ScenarioRun[] = [];
  for (let run = 0; run < SAMPLE_RUNS; run += 1) {
    runs.push(await runScenario(storage, observations, params));
  }
  for (const run of runs) {
    if (run.matches.length !== expectedMatchCount) {
      throw new Error(
        `${name} expected ${expectedMatchCount} matches but received ${run.matches.length}`,
      );
    }
  }

  const representative = runs[0]!;
  return {
    name,
    params,
    expected_match_count: expectedMatchCount,
    observed_match_count: representative.matches.length,
    ...observationTotals(representative.observations),
    calls_to_conclusive_answer: representative.calls,
    first_call_latency: summarize(runs.map((run) => run.firstCallMs)),
    total_latency: summarize(runs.map((run) => run.totalMs)),
    warnings: representative.warnings,
  };
}

function probeCandidateOrder(root: string): CandidateOrderProbe | null {
  const dbPath = join(root, 'candidate-order.db');
  new SqliteStorage(dbPath).close();
  const db = new Database(dbPath);
  try {
    const columns = db.pragma('table_xinfo(events)') as Array<{ name: string }>;
    if (!columns.some((column) => column.name === 'source_family_mask')) return null;

    const broadFamilyRows = STORAGE_DESCRIPTOR_PAGE_ROWS * 4;
    const insert = db.prepare(
      `INSERT INTO events (id, source, timestamp, content)
       VALUES (?, ?, ?, 'broad source family')`,
    );
    db.transaction(() => {
      for (let rank = 0; rank < broadFamilyRows; rank += 1) {
        insert.run(
          `probe-${rank.toString().padStart(5, '0')}`,
          `fs:/probe/.codex/sessions/${rank}.jsonl`,
          timestampForRank(rank),
        );
      }
    })();

    let visits = 0;
    db.function('echo_probe', (source: unknown) => {
      void source;
      visits += 1;
      return 1;
    });
    const sql = `SELECT rowid, id, source, timestamp
                   FROM events
                  WHERE (source_family_mask & 4) != 0
                    AND echo_probe(source) = 1
                  ORDER BY timestamp DESC, id DESC
                  LIMIT ${STORAGE_DESCRIPTOR_PAGE_ROWS}`;
    const plan = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as Array<{
      detail: string;
    }>;
    const rows = db.prepare(sql).all();
    const details = plan.map((row) => row.detail);
    const probe: CandidateOrderProbe = {
      broad_family_rows: broadFamilyRows,
      page_limit: STORAGE_DESCRIPTOR_PAGE_ROWS,
      candidate_rows_returned: rows.length,
      candidate_rows_visited: visits,
      uses_expected_partial_index: details.some((detail) =>
        detail.includes('idx_events_source_family_codex_timestamp_id'),
      ),
      temporary_order_sort: details.some((detail) => detail.includes('TEMP B-TREE FOR ORDER BY')),
      plan: details,
    };
    if (
      probe.candidate_rows_visited > probe.page_limit ||
      !probe.uses_expected_partial_index ||
      probe.temporary_order_sort
    ) {
      throw new Error(`source-family candidate order is unbounded: ${JSON.stringify(probe)}`);
    }
    return probe;
  } finally {
    db.close();
  }
}

export async function benchmarkSourcePrefix(): Promise<SourcePrefixBenchmarkReport> {
  const root = mkdtempSync(join(tmpdir(), 'echo-source-prefix-benchmark-'));
  const observations: StorageSelectPageObservation[] = [];
  let storage: SqliteStorage | undefined;
  try {
    const dbPath = join(root, 'context.db');
    storage = new SqliteStorage(dbPath, {
      onSelectPage: (observation) => observations.push(observation),
    });
    await seedDenseUnrelatedHistory(storage);

    const scenarios = [
      await measureScenario({
        name: 'codex_app_older_hit',
        params: { source_app: 'codex', limit: 1 },
        expectedMatchCount: 1,
        storage,
        observations,
      }),
      await measureScenario({
        name: 'granola_app_absent',
        params: { source_app: 'granola', limit: 1 },
        expectedMatchCount: 0,
        storage,
        observations,
      }),
    ];
    storage.close();
    storage = undefined;

    const inspect = new Database(dbPath, { readonly: true });
    const schemaVersion = inspect.pragma('user_version', {
      simple: true,
    }) as number;
    const columns = inspect.pragma('table_xinfo(events)') as Array<{
      name: string;
    }>;
    const sourceFamilyIndexAvailable = columns.some(
      (column) => column.name === 'source_family_mask',
    );
    inspect.close();

    return {
      fixture: 'dense-unrelated-source-app-v2',
      warmup_runs: WARMUP_RUNS,
      sample_runs: SAMPLE_RUNS,
      unrelated_newer_rows: STORAGE_MAX_SCANNED_ROWS,
      total_rows: STORAGE_MAX_SCANNED_ROWS + 1,
      schema_version: schemaVersion,
      source_family_index_available: sourceFamilyIndexAvailable,
      scenarios,
      candidate_order_probe: probeCandidateOrder(root),
    };
  } finally {
    storage?.close();
    rmSync(root, { recursive: true, force: true });
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const report = await benchmarkSourcePrefix();
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}
