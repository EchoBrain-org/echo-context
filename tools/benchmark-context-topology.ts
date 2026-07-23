import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';
import { findClusters, type FindClustersResult } from '../src/mcp/tools/find-clusters.js';
import { getAtoms, GET_ATOMS_MAX_IDS } from '../src/mcp/tools/get-atoms.js';
import type { CaptureEvent } from '../src/storage/interface.js';
import { MemoryStorage } from '../src/storage/memory.js';

const SINCE = '2026-07-22T10:00:00.000Z';
const UNTIL = '2026-07-22T14:00:00.000Z';

interface ProjectFixture {
  name: 'echo_brain' | 'echo_context' | 'hdc';
  root: string;
  logicalTurns: number;
  inheritedCopies: number;
  threadSizes: number[];
}

const PROJECTS: readonly ProjectFixture[] = [
  {
    name: 'echo_brain',
    root: '/workspace/echo-brain',
    logicalTurns: 72,
    inheritedCopies: 282,
    threadSizes: [24, 24, 24],
  },
  {
    name: 'echo_context',
    root: '/workspace/echo-context',
    logicalTurns: 38,
    inheritedCopies: 55,
    threadSizes: [19, 19],
  },
  {
    name: 'hdc',
    root: '/workspace/hdc',
    logicalTurns: 13,
    inheritedCopies: 0,
    threadSizes: [7, 6],
  },
] as const;

export interface ForkStormFixture {
  store: MemoryStorage;
  rawObservations: number;
  expectedLogicalTurns: number;
  expectedCollapsedCopies: number;
  copyMultiplier: number;
}

export interface TopologyBenchmarkReport {
  fixture: 'fork-storm-v1';
  copy_multiplier: number;
  raw_observations: number;
  logical_turns: number;
  collapsed_observations: number;
  provider_counts: Record<string, number>;
  project_counts: Record<ProjectFixture['name'], number>;
  clusters: number;
  max_cluster_size: number;
  envelope_bytes: number;
  hydrated_ids: number;
  warnings: string[];
  latency_ms: {
    iterations: number;
    median: number;
    p95: number;
  };
}

function projectKey(root: string): string {
  return `local:workspace:${root}`;
}

function threadForTurn(project: ProjectFixture, turnIndex: number): number {
  let cursor = 0;
  for (let index = 0; index < project.threadSizes.length; index += 1) {
    cursor += project.threadSizes[index]!;
    if (turnIndex < cursor) return index;
  }
  throw new RangeError(`turn ${turnIndex} exceeds ${project.name} thread oracle`);
}

function copiesPerTurn(project: ProjectFixture): number[] {
  const out = Array.from({ length: project.logicalTurns }, () => 0);
  for (let copy = 0; copy < project.inheritedCopies; copy += 1) {
    out[copy % project.logicalTurns] += 1;
  }
  return out;
}

function observedRoot(project: ProjectFixture, turnIndex: number): string {
  if (project.name !== 'hdc') return project.root;
  if (turnIndex < 8) return project.root;
  if (turnIndex < 11) return `${project.root}/console`;
  return `${project.root}/eval`;
}

function observation(input: {
  project: ProjectFixture;
  turnIndex: number;
  threadIndex: number;
  copyIndex: number;
  occurredAt: string;
  observedAt: string;
}): Omit<CaptureEvent, 'id'> {
  const { project, turnIndex, threadIndex, copyIndex, occurredAt, observedAt } = input;
  const rootThreadId = `${project.name}:root:${threadIndex}`;
  const isOriginal = copyIndex === 0;
  const physicalThreadId = isOriginal
    ? rootThreadId
    : `${rootThreadId}:fork:${turnIndex}:${copyIndex}`;
  const repoRoot = observedRoot(project, turnIndex);
  const source =
    project.name === 'echo_context'
      ? `fs:${repoRoot}/.claude/projects/benchmark/${physicalThreadId}.jsonl`
      : `fs:${repoRoot}/.codex/sessions/2026/07/22/${physicalThreadId}.jsonl`;
  return {
    source,
    timestamp: observedAt,
    content: `USER: Continue ${project.name} turn ${turnIndex}.\n\nASSISTANT: Completed turn ${turnIndex}.`,
    metadata: {
      session_id: physicalThreadId,
      turn_index: turnIndex,
      logical_turn_id: `${project.name}:turn:${turnIndex}`,
      occurred_at: occurredAt,
      observed_at: observedAt,
      observation_kind: isOriginal ? 'original' : 'inherited',
      initiator: 'human',
      thread_id: physicalThreadId,
      root_thread_id: rootThreadId,
      ...(isOriginal
        ? { thread_kind: 'root' }
        : {
            thread_kind: 'subagent',
            parent_thread_id: rootThreadId,
            agent_path: `${rootThreadId}/agent-${copyIndex}`,
            agent_depth: 1,
          }),
      repo_root: repoRoot,
      canonical_root: project.root,
      project_key: projectKey(project.root),
      files_referenced: [`${project.root}/src/shared.ts`],
      codex: {
        model_provider: 'openai',
        model: 'benchmark-synthetic',
      },
    },
  };
}

/** Build deterministic, synthetic source observations. No real session text or
 * local paths enter the fixture. `copyMultiplier=10` multiplies inherited
 * observations while preserving the same 123 logical turns. */
export async function buildForkStormFixture(copyMultiplier = 1): Promise<ForkStormFixture> {
  if (!Number.isInteger(copyMultiplier) || copyMultiplier < 1) {
    throw new RangeError('copyMultiplier must be a positive integer');
  }
  const store = new MemoryStorage();
  let globalTurn = 0;
  let rawObservations = 0;
  let collapsedCopies = 0;

  for (const project of PROJECTS) {
    const copyCounts = copiesPerTurn(project);
    for (let turnIndex = 0; turnIndex < project.logicalTurns; turnIndex += 1) {
      const occurredMs = Date.parse(SINCE) + globalTurn * 60_000;
      const occurredAt = new Date(occurredMs).toISOString();
      const threadIndex = threadForTurn(project, turnIndex);
      const inheritedCount = copyCounts[turnIndex]! * copyMultiplier;
      for (let copyIndex = 0; copyIndex <= inheritedCount; copyIndex += 1) {
        const observedAt = new Date(occurredMs + copyIndex * 30_000).toISOString();
        const event = observation({
          project,
          turnIndex,
          threadIndex,
          copyIndex,
          occurredAt,
          observedAt,
        });
        // Use the ledger's ordinary UUID shape. Deterministic dedupe IDs are
        // longer SHA-256 strings and would make this wire-cost benchmark less
        // representative of live capture rows.
        await store.append(event);
        rawObservations += 1;
        if (copyIndex > 0) collapsedCopies += 1;
      }
      globalTurn += 1;
    }
  }

  return {
    store,
    rawObservations,
    expectedLogicalTurns: PROJECTS.reduce((sum, project) => sum + project.logicalTurns, 0),
    expectedCollapsedCopies: collapsedCopies,
    copyMultiplier,
  };
}

function percentile(samples: readonly number[], fraction: number): number {
  if (samples.length === 0) return 0;
  const sorted = [...samples].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1);
  return sorted[index]!;
}

async function hydrateAll(
  store: MemoryStorage,
  result: FindClustersResult,
): Promise<number> {
  const ids = [...new Set(result.clusters.flatMap((cluster) => cluster.atom_ids))];
  let hydrated = 0;
  for (let offset = 0; offset < ids.length; offset += GET_ATOMS_MAX_IDS) {
    const response = await getAtoms(store, {
      atom_ids: ids.slice(offset, offset + GET_ATOMS_MAX_IDS),
      fields: ['content'],
      view: 'compact',
    });
    if (response.atoms_dropped !== 0) {
      throw new Error(`get_atoms dropped ${response.atoms_dropped} benchmark IDs`);
    }
    hydrated += response.atoms.length;
  }
  return hydrated;
}

export async function benchmarkForkStorm(input: {
  copyMultiplier?: number;
  warmup?: number;
  iterations?: number;
  /** Wall-clock latency is meaningful in the standalone benchmark lane, not
   * while Vitest is sharing a host with the rest of the suite. */
  enforceLatency?: boolean;
} = {}): Promise<TopologyBenchmarkReport> {
  const copyMultiplier = input.copyMultiplier ?? 1;
  const warmup = input.warmup ?? 5;
  const iterations = input.iterations ?? 30;
  const fixture = await buildForkStormFixture(copyMultiplier);
  const params = { since: SINCE, until: UNTIL, view: 'rich' as const };

  for (let index = 0; index < warmup; index += 1) {
    await findClusters(fixture.store, params);
  }
  const samples: number[] = [];
  let result: FindClustersResult | undefined;
  for (let index = 0; index < iterations; index += 1) {
    const started = performance.now();
    result = await findClusters(fixture.store, params);
    samples.push(performance.now() - started);
  }
  if (result === undefined) result = await findClusters(fixture.store, params);

  const projectCounts = {} as Record<ProjectFixture['name'], number>;
  for (const project of PROJECTS) {
    const scoped = await findClusters(fixture.store, {
      ...params,
      repo_path: project.root,
    });
    projectCounts[project.name] = scoped.result_caps.atoms_total_in_window;
  }
  const hydratedIds = await hydrateAll(fixture.store, result);
  const logicalTurns = result.result_caps.atoms_total_in_window;
  const report: TopologyBenchmarkReport = {
    fixture: 'fork-storm-v1',
    copy_multiplier: copyMultiplier,
    raw_observations: fixture.rawObservations,
    logical_turns: logicalTurns,
    collapsed_observations: fixture.rawObservations - logicalTurns,
    provider_counts: result.result_caps.source_breakdown,
    project_counts: projectCounts,
    clusters: result.result_caps.clusters_total,
    max_cluster_size: Math.max(0, ...result.clusters.map((cluster) => cluster.atom_ids.length)),
    envelope_bytes: Buffer.byteLength(JSON.stringify(result), 'utf8'),
    hydrated_ids: hydratedIds,
    warnings: result.warnings,
    latency_ms: {
      iterations,
      median: Number(percentile(samples, 0.5).toFixed(3)),
      p95: Number(percentile(samples, 0.95).toFixed(3)),
    },
  };

  const expectedRaw = fixture.expectedLogicalTurns + fixture.expectedCollapsedCopies;
  const failures: string[] = [];
  if (report.raw_observations !== expectedRaw) failures.push(`raw=${report.raw_observations}`);
  if (report.logical_turns !== fixture.expectedLogicalTurns) {
    failures.push(`logical=${report.logical_turns}`);
  }
  if (report.collapsed_observations !== fixture.expectedCollapsedCopies) {
    failures.push(`collapsed=${report.collapsed_observations}`);
  }
  if (JSON.stringify(report.provider_counts) !== JSON.stringify({ codex: 85, claude_code: 38 })) {
    failures.push(`providers=${JSON.stringify(report.provider_counts)}`);
  }
  if (JSON.stringify(report.project_counts) !== JSON.stringify({
    echo_brain: 72,
    echo_context: 38,
    hdc: 13,
  })) {
    failures.push(`projects=${JSON.stringify(report.project_counts)}`);
  }
  if (report.clusters !== 7) failures.push(`clusters=${report.clusters}`);
  if (result.result_caps.clusters_returned !== 7) {
    failures.push(`clusters_returned=${result.result_caps.clusters_returned}`);
  }
  if (report.max_cluster_size !== 24) failures.push(`max_cluster=${report.max_cluster_size}`);
  if (report.envelope_bytes >= 10_000) failures.push(`envelope=${report.envelope_bytes}`);
  if (report.hydrated_ids !== fixture.expectedLogicalTurns) {
    failures.push(`hydrated=${report.hydrated_ids}`);
  }
  if (result.result_caps.truncated) failures.push('result_caps.truncated=true');
  if (report.warnings.length > 0) failures.push(`warnings=${report.warnings.join(' | ')}`);
  const latencyCeiling = copyMultiplier === 1 ? 100 : 250;
  if (input.enforceLatency !== false && report.latency_ms.p95 >= latencyCeiling) {
    failures.push(`p95=${report.latency_ms.p95}ms`);
  }
  if (failures.length > 0) {
    throw new Error(`fork-storm benchmark failed: ${failures.join(', ')}`);
  }
  return report;
}

async function main(): Promise<void> {
  const baseline = await benchmarkForkStorm();
  const inheritedStress = await benchmarkForkStorm({ copyMultiplier: 10 });
  process.stdout.write(`${JSON.stringify({ baseline, inherited_copy_stress: inheritedStress }, null, 2)}\n`);
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && import.meta.url === pathToFileURL(invokedPath).href) {
  await main();
}
