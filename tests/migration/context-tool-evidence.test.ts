import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const NODE = process.execPath;
const TOOL = join(ROOT, 'tools', 'verify-context-tools.mjs');
const FIXTURE = join(ROOT, 'tests', 'fixtures', 'context-tool-parity.v1.json');
const EVIDENCE = join(ROOT, 'provenance', 'context-tool-parity.v1.json');
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

interface FixtureCase {
  id: string;
  args: Record<string, unknown>;
  timeout_budget_ms?: number;
}
interface FixtureRecord {
  cases: FixtureCase[];
  [key: string]: unknown;
}
interface ClockCall {
  requested_delay_ms: number;
  virtual_before_ms: number;
  virtual_after_ms: number;
  virtual_advance_ms: number;
}
interface ClockObservation {
  schema: string;
  mode: string;
  timer_calls: ClockCall[];
}
interface EvidenceSide {
  full_roster_descriptors: Array<{ description: string }>;
  ignored_ids: Array<{ id: string }>;
  projected_descriptor_sha256: string;
  initialize_response_sha256: string;
  tools_list_response_sha256: string;
  clock_observation: ClockObservation;
  clock_observation_sha256: string;
  per_case: Array<{ response_sha256: string }>;
  aggregate_sha256: string;
}
interface NetworkObservation {
  name: string;
  status: string;
  code: string;
}
interface NetworkProbe {
  phase: string;
  observations: NetworkObservation[];
}
interface EvidenceRecord {
  fixture_bytes_base64: string;
  harness_bytes_base64: string;
  context_tools_config_bytes_base64: string;
  fixture_sha256: string;
  harness_sha256: string;
  context_tools_config_sha256: string;
  source: EvidenceSide;
  target: EvidenceSide;
  clock_negative_control: { outcome: string } & Record<string, unknown>;
  source_install_lifecycle: {
    loopback_control: Record<string, unknown>;
    network_probes: NetworkProbe[];
    ci: Record<string, unknown>;
    rebuild: Record<string, unknown>;
  };
  timeout_contract: Record<string, unknown>;
  [key: string]: unknown;
}

function run(args: string[]): string {
  return execFileSync(NODE, [TOOL, ...args], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
}
function rejected(args: string[]): ReturnType<typeof spawnSync> {
  return spawnSync(NODE, [TOOL, ...args], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
}

describe('AC3 — raw-pinned source/target stdio parity evidence', () => {
  it('consumes and validates the sealed fixture as the sole case/seed/order authority', () => {
    expect(run(['--validate-only', '--fixture', FIXTURE])).toMatch(/fixture OK [0-9a-f]{64}/);
  });

  it('byte-binds fixture, scratch harness, config, descriptors, ignored IDs, cases, and aggregates', () => {
    const evidence = JSON.parse(readFileSync(EVIDENCE, 'utf8')) as EvidenceRecord;
    const fixtureBytes = Buffer.from(evidence.fixture_bytes_base64, 'base64');
    const harnessBytes = Buffer.from(evidence.harness_bytes_base64, 'base64');
    const configBytes = Buffer.from(evidence.context_tools_config_bytes_base64, 'base64');
    expect(fixtureBytes.equals(readFileSync(FIXTURE))).toBe(true);
    expect(configBytes.equals(readFileSync(join(ROOT, 'context-tools.v1.json')))).toBe(true);
    expect(sha(fixtureBytes)).toBe(evidence.fixture_sha256);
    expect(sha(harnessBytes)).toBe(evidence.harness_sha256);
    expect(sha(configBytes)).toBe(evidence.context_tools_config_sha256);
    expect(evidence.source.full_roster_descriptors).toHaveLength(15);
    expect(evidence.source.ignored_ids).toHaveLength(7);
    expect(evidence.target.full_roster_descriptors).toHaveLength(8);
    expect(evidence.target.ignored_ids).toEqual([]);
    expect(evidence.source.projected_descriptor_sha256).toBe(evidence.target.projected_descriptor_sha256);
    expect(evidence.source.initialize_response_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(evidence.target.initialize_response_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(evidence.source.tools_list_response_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(evidence.target.tools_list_response_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(evidence.source.initialize_response_sha256).not.toBe(evidence.target.initialize_response_sha256);
    expect(evidence.source.tools_list_response_sha256).not.toBe(evidence.target.tools_list_response_sha256);
    expect(evidence.source.per_case).toEqual(evidence.target.per_case);
    expect(evidence.source.aggregate_sha256).toBe(evidence.target.aggregate_sha256);
    for (const side of [evidence.source, evidence.target]) {
      expect(side.clock_observation).toEqual({
        schema: 'context-clock-observation.v1',
        mode: 'advance-exactly',
        timer_calls: [{
          requested_delay_ms: 1000,
          virtual_before_ms: Date.parse('2026-07-01T00:05:00.000Z'),
          virtual_after_ms: Date.parse('2026-07-01T00:05:01.000Z'),
          virtual_advance_ms: 1000,
        }],
      });
      expect(sha(Buffer.from(`${JSON.stringify(sortJson(side.clock_observation))}\n`))).toBe(side.clock_observation_sha256);
    }
    expect(evidence.clock_negative_control).toMatchObject({
      mode: 'immediate-no-advance',
      side: 'target',
      request_deadline_ms: 10,
      outcome: 'rejected_request_deadline',
      observation: {
        mode: 'immediate-no-advance',
        timer_calls: [{ requested_delay_ms: 1000, virtual_advance_ms: 0 }],
      },
    });
    expect(evidence.source_install_lifecycle.loopback_control).toMatchObject({
      outside_profile: 'ACCEPT',
      inside_profile: 'DENIED',
    });
    expect(evidence.source_install_lifecycle.network_probes.map((probe) => probe.phase)).toEqual([
      'before_ci',
      'after_ci',
      'after_rebuild',
    ]);
    for (const probe of evidence.source_install_lifecycle.network_probes) {
      expect(probe.observations.map((observation) => observation.name)).toEqual(['dns', 'direct_ip_tcp', 'https']);
      expect(probe.observations.every((observation) => observation.status === 'denied' && observation.code !== 'TIMEOUT')).toBe(true);
    }
    expect(evidence.source_install_lifecycle.ci).toMatchObject({ exit: 0, scripts_executed: [] });
    expect(evidence.source_install_lifecycle.rebuild).toMatchObject({
      exit: 0,
      npm_config_nodedir: '/usr/local/Cellar/node@22/22.22.1_1',
      package: { version: '12.10.0' },
    });
    expect(evidence.timeout_contract).toMatchObject({
      source_api_timeout_seconds: 1,
      timeout_budget_ms: 10,
      virtual_clock_advance_ms: 1000,
    });
  });

  it('rejects omitted/reordered/semantic fixtures and every timeout:0/missing/changed 10ms mutation', () => {
    const directory = mkdtempSync(join(tmpdir(), 'echo-context-fixture-mutations-'));
    try {
      const baseline = JSON.parse(readFileSync(FIXTURE, 'utf8')) as FixtureRecord;
      const mutations: Array<[string, (fixture: FixtureRecord) => void]> = [
        ['omitted-case', (fixture) => { fixture.cases.splice(3, 1); }],
        ['reordered-case', (fixture) => { [fixture.cases[0], fixture.cases[1]] = [fixture.cases[1], fixture.cases[0]]; }],
        ['semantic-query', (fixture) => { fixture.cases.find((item) => item.id === 'search-seeded')!.args.query = 'beta'; }],
        ['timeout-zero', (fixture) => { fixture.cases.find((item) => item.id === 'wait-timeout')!.args.timeout = 0; }],
        ['timeout-budget-missing', (fixture) => { delete fixture.cases.find((item) => item.id === 'wait-timeout')!.timeout_budget_ms; }],
        ['timeout-budget-changed', (fixture) => { fixture.cases.find((item) => item.id === 'wait-timeout')!.timeout_budget_ms = 11; }],
      ];
      for (const [name, mutate] of mutations) {
        const fixture = structuredClone(baseline);
        mutate(fixture);
        const path = join(directory, `${name}.json`);
        writeFileSync(path, `${JSON.stringify(fixture, null, 2)}\n`);
        const result = rejected(['--validate-only', '--fixture', path]);
        expect(result.status, `${name} unexpectedly bypassed fixture consumption`).not.toBe(0);
        expect(result.stderr).toMatch(/fixture/);
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('rejects descriptor, ignored-roster, case, semantic-hash, and aggregate evidence mutations via the real CLI', () => {
    const directory = mkdtempSync(join(tmpdir(), 'echo-context-evidence-mutations-'));
    try {
      const baseline = JSON.parse(readFileSync(EVIDENCE, 'utf8')) as EvidenceRecord;
      const mutations: Array<[string, (record: EvidenceRecord) => void]> = [
        ['descriptor-only', (record) => { record.source.full_roster_descriptors[0].description += ' mutated'; }],
        ['ignored-roster', (record) => { record.source.ignored_ids[0].id = 'cross_swapped'; }],
        ['omitted-result', (record) => { record.source.per_case.pop(); }],
        ['reordered-result', (record) => { [record.target.per_case[0], record.target.per_case[1]] = [record.target.per_case[1], record.target.per_case[0]]; }],
        ['semantic-result', (record) => { record.source.per_case[4].response_sha256 = '0'.repeat(64); }],
        ['aggregate', (record) => { record.target.aggregate_sha256 = 'f'.repeat(64); }],
        ['initialize-envelope', (record) => { record.source.initialize_response_sha256 = '1'.repeat(64); }],
        ['tools-list-envelope', (record) => { record.target.tools_list_response_sha256 = '2'.repeat(64); }],
        ['clock-observation', (record) => { record.source.clock_observation.timer_calls[0].virtual_advance_ms = 0; }],
        ['clock-negative-control', (record) => { record.clock_negative_control.outcome = 'accepted'; }],
        ['source-lifecycle', (record) => { record.source_install_lifecycle.network_probes[0].observations[0].code = 'TIMEOUT'; }],
      ];
      for (const [name, mutate] of mutations) {
        const record = structuredClone(baseline);
        mutate(record);
        const path = join(directory, `${name}.json`);
        writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`);
        const result = rejected([
          '--compare-records',
          '--evidence', path,
          '--observed', EVIDENCE,
        ]);
        expect(result.status, `${name} mutation unexpectedly accepted`).not.toBe(0);
        expect(result.stderr).toMatch(/differs from observed/);
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('hashes the entire JSON-RPC envelope so version, id, content, and structuredContent cannot mask each other', () => {
    const directory = mkdtempSync(join(tmpdir(), 'echo-context-full-result-'));
    try {
      const records = [
        { jsonrpc: '2.0', id: 3, result: { content: [{ type: 'text', text: '{"value":1}' }], structuredContent: { value: 1 }, isError: false } },
        { jsonrpc: '2.0', id: 4, result: { content: [{ type: 'text', text: '{"value":1}' }], structuredContent: { value: 1 }, isError: false } },
        { jsonrpc: '2.0', id: 3, result: { content: [{ type: 'text', text: '{"value":2}' }], structuredContent: { value: 1 }, isError: false } },
        { jsonrpc: '2.0', id: 3, result: { content: [{ type: 'text', text: '{"value":1}' }], structuredContent: { value: 2 }, isError: false } },
      ];
      const hashes = records.map((record, index) => {
        const path = join(directory, `${index}.json`);
        writeFileSync(path, JSON.stringify(record));
        return run(['--hash-json', path]).trim();
      });
      expect(new Set(hashes).size).toBe(4);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('rejects malformed, unknown, duplicate, unsolicited, non-JSON, and unterminated stdout through the real CLI peer', () => {
    expect(run(['--protocol-probe', 'valid'])).toMatch(/valid accepted/);
    for (const probe of ['malformed', 'malformed-id', 'unknown-id', 'duplicate-id', 'unsolicited', 'non-json', 'unterminated']) {
      const result = rejected(['--protocol-probe', probe]);
      expect(result.status, `${probe} was unexpectedly accepted`).not.toBe(0);
      expect(result.stderr).toMatch(/protocol probe/);
    }
  });
});

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(Object.keys(record).sort().map((key) => [key, sortJson(record[key])]));
  }
  return value;
}
