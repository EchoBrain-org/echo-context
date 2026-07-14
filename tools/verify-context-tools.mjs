#!/usr/bin/env node
// AC3: launch raw-pinned source and accepted-target MCP registrars over stdio,
// consume the sealed fixture, and compare full descriptors/results byte-wise.

import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

const NODE = '/usr/local/bin/node';
const GIT = '/usr/local/bin/git';
const NPM_CLI = '/usr/local/lib/node_modules/npm/bin/npm-cli.js';
const SANDBOX_EXEC = '/usr/bin/sandbox-exec';
const SOURCE_SHA = '2971310441b69735cbe759293abd8c4d044bf347';
const FIXED_NOW = '2026-07-01T00:05:00.000Z';
const CONTEXT_TOOLS = [
  'echo_ping',
  'echo_resolve_mru',
  'find_clusters',
  'get_atom',
  'get_atoms',
  'get_recent_work_context',
  'search_memories',
  'wait_for_new_turns',
];
const CASE_ORDER = [
  'ping-empty',
  'resolve-mru-granola',
  'find-empty',
  'find-seeded',
  'get-atom-present',
  'get-atom-missing',
  'get-atoms-mixed',
  'recent-seeded',
  'search-seeded',
  'wait-timeout',
];
const IGNORED_CLASSES = new Map([
  ['propose_decision', 'product_write'],
  ['pending_decisions', 'product_read'],
  ['get_role_state', 'task_state_read'],
  ['list_task_states', 'task_state_read'],
  ['coord_emit', 'loop_write'],
  ['coord_status', 'loop_read'],
  ['coord_invoke', 'loop_write'],
]);
const STDERR_LIMIT = 64 * 1024;

export function canonicalBytes(value) {
  const sort = (item) =>
    Array.isArray(item)
      ? item.map(sort)
      : item && typeof item === 'object'
        ? Object.fromEntries(Object.keys(item).sort().map((key) => [key, sort(item[key])]))
        : item;
  return Buffer.from(`${JSON.stringify(sort(value))}\n`, 'utf8');
}
export function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}
function fail(message) {
  throw new Error(`verify-context-tools: ${message}`);
}
function argument(name, required = false) {
  const index = process.argv.indexOf(name);
  if (index >= 0 && index + 1 < process.argv.length) return process.argv[index + 1];
  if (required) fail(`${name} is required`);
  return undefined;
}
function exactObject(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object`);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) fail(`${label} keys ${actual.join(',')} != ${expected.join(',')}`);
}
function uuid(index) {
  return `00000000-0000-4000-8000-00000000000${index}`;
}

export function validateFixture(fixture) {
  exactObject(
    fixture,
    ['schema', 'tools', 'fixed_now', 'repo_path', 'seed', 'cases'],
    'fixture',
  );
  if (fixture.schema !== 'context-tool-parity.v1') fail('fixture schema mismatch');
  if (JSON.stringify(fixture.tools) !== JSON.stringify(CONTEXT_TOOLS)) fail('fixture tool roster/order drift');
  if (fixture.fixed_now !== FIXED_NOW || fixture.repo_path !== '/fixture/repo') fail('fixture clock/repo drift');
  const expectedSeed = [
    { id: uuid(1), source: 'claude_code:/fixture/repo', timestamp: '2026-07-01T00:00:00.000Z', content: 'alpha work on the fixture repo', metadata: { repo_root: '/fixture/repo', session_id: 's1' } },
    { id: uuid(2), source: 'codex:/fixture/repo', timestamp: '2026-07-01T00:01:00.000Z', content: 'alpha follow-up in codex', metadata: { repo_root: '/fixture/repo', session_id: 's2' } },
    { id: uuid(3), source: 'api:granola', timestamp: '2026-07-01T00:02:00.000Z', content: 'alpha meeting note', metadata: {} },
  ];
  if (canonicalBytes(fixture.seed).compare(canonicalBytes(expectedSeed)) !== 0) fail('fixture seed bytes drift');
  if (!Array.isArray(fixture.cases) || JSON.stringify(fixture.cases.map((item) => item.id)) !== JSON.stringify(CASE_ORDER)) {
    fail('fixture case omission/order drift');
  }
  const expectedCases = [
    { id: 'ping-empty', tool: 'echo_ping', args: { message: '' } },
    { id: 'resolve-mru-granola', tool: 'echo_resolve_mru', args: { sources: ['granola'] } },
    { id: 'find-empty', tool: 'find_clusters', args: { since: '2020-01-01T00:00:00', until: '2020-01-02T00:00:00' } },
    { id: 'find-seeded', tool: 'find_clusters', args: { since: '2026-07-01T00:00:00', until: '2026-07-01T00:05:00' } },
    { id: 'get-atom-present', tool: 'get_atom', args: { id: uuid(1) } },
    { id: 'get-atom-missing', tool: 'get_atom', args: { id: uuid(9) } },
    { id: 'get-atoms-mixed', tool: 'get_atoms', args: { atom_ids: [uuid(1), uuid(9), uuid(2)], format: 'minimal' } },
    { id: 'recent-seeded', tool: 'get_recent_work_context', args: { limit: 10, format: 'minimal' } },
    { id: 'search-seeded', tool: 'search_memories', args: { query: 'alpha', limit: 10 } },
    {
      id: 'wait-timeout',
      tool: 'wait_for_new_turns',
      args: { source_prefix: 'nope:', since: FIXED_NOW, timeout: 1 },
      timeout_budget_ms: 10,
      virtual_clock_advance_ms: 1000,
    },
  ];
  if (canonicalBytes(fixture.cases).compare(canonicalBytes(expectedCases)) !== 0) {
    fail('fixture case bytes drift (timeout must remain schema-valid 1s + literal 10ms harness budget)');
  }
  return fixture;
}

// This exact scratch bootstrap is emitted unchanged for source and target and
// hash-bound in provenance. The pinned server.ts is HTTP-only; the bootstrap
// uses the actual registrar modules with the SDK's real stdio transport.
const HARNESS = String.raw`import { pathToFileURL } from 'node:url';
import { join } from 'node:path';

const ROOT = process.env.ECHO_PARITY_ROOT;
const MODE = process.env.ECHO_PARITY_MODE;
const FIXTURE = JSON.parse(Buffer.from(process.env.ECHO_PARITY_FIXTURE_B64, 'base64').toString('utf8'));
if (!ROOT || (MODE !== 'source' && MODE !== 'target')) throw new Error('invalid parity harness environment');
const rootImport = (relativePath) => import(pathToFileURL(join(ROOT, relativePath)).href);

const RealDate = Date;
const realSetTimeout = globalThis.setTimeout;
let logicalOffsetMs = 0;
class FixedDate extends RealDate {
  constructor(...args) { super(args.length === 0 ? RealDate.parse(FIXTURE.fixed_now) + logicalOffsetMs : args[0]); }
  static now() { return RealDate.parse(FIXTURE.fixed_now) + logicalOffsetMs; }
}
globalThis.Date = FixedDate;
Math.random = () => 0.5;
globalThis.setTimeout = (callback, delay = 0, ...args) => {
  if (Number(delay) >= 1000) {
    return realSetTimeout(() => { logicalOffsetMs += Number(delay); callback(...args); }, 1);
  }
  return realSetTimeout(callback, delay, ...args);
};

const { McpServer } = await rootImport('node_modules/@modelcontextprotocol/sdk/dist/esm/server/mcp.js');
const { StdioServerTransport } = await rootImport('node_modules/@modelcontextprotocol/sdk/dist/esm/server/stdio.js');
const { MemoryStorage } = await rootImport('src/storage/memory.ts');
const store = new MemoryStorage();
store.events = FIXTURE.seed.map((event, index) => ({ ...event, _seq: index + 1 }));
store.seqCounter = FIXTURE.seed.length;
const server = new McpServer({ name: MODE === 'source' ? 'echo-source-parity' : 'echo-target-parity', version: '0.0.0' });

const registrars = {
  echoPing: (await rootImport('src/mcp/tools/echo-ping.ts')).registerEchoPing,
  resolveMru: (await rootImport('src/mcp/tools/echo-resolve-mru.ts')).registerEchoResolveMru,
  findClusters: (await rootImport('src/mcp/tools/find-clusters.ts')).registerFindClusters,
  getAtom: (await rootImport('src/mcp/tools/get-atom.ts')).registerGetAtom,
  getAtoms: (await rootImport('src/mcp/tools/get-atoms.ts')).registerGetAtoms,
  recent: (await rootImport('src/mcp/tools/recent-work-context.ts')).registerRecentWorkContext,
  search: (await rootImport('src/mcp/tools/search-memories.ts')).registerSearchMemories,
  wait: (await rootImport('src/mcp/tools/wait-for-new-turns.ts')).registerWaitForNewTurns,
};
registrars.echoPing(server);
if (MODE === 'source') (await rootImport('src/surfaces/ceo-slack-responder/propose-decision-tool.ts')).registerProposeDecision(server);
registrars.search(server, store);
registrars.recent(server, store);
registrars.findClusters(server, store);
if (MODE === 'source') (await rootImport('src/mcp/tools/pending-decisions.ts')).registerPendingDecisions(server);
registrars.getAtoms(server, store);
registrars.wait(server, store);
registrars.getAtom(server, store);
registrars.resolveMru(server, store);
if (MODE === 'source') {
  (await rootImport('src/mcp/tools/get-role-state.ts')).registerGetRoleState(server, ROOT);
  (await rootImport('src/mcp/tools/list-task-states.ts')).registerListTaskStates(server, ROOT);
  const coordRoles = { schema_version: 1, roles: [] };
  const deadlines = { currentSnapshot: () => ({ open: [] }), lastFullReplayWatermark: 0 };
  (await rootImport('src/mcp/tools/coord-emit.ts')).registerCoordEmit(server, { storage: store, coordRoles, xEchoRoleHeader: null, deadlines });
  (await rootImport('src/mcp/tools/coord-status.ts')).registerCoordStatus(server, { storage: store, coordRoles, deadlines, serverStartedAt: new Date() });
  (await rootImport('src/mcp/tools/coord-invoke.ts')).registerCoordInvoke(server, { storage: store, coordRoles, deadlines });
}
const transport = new StdioServerTransport();
await server.connect(transport);
process.stdin.once('end', async () => {
  try { await transport.close(); } finally { process.exit(0); }
});
`;

function configFreeGit(gitDir, args, encoding = null) {
  return execFileSync(GIT, ['--git-dir', gitDir, ...args], {
    encoding,
    env: {
      PATH: '/usr/local/bin:/usr/bin:/bin',
      HOME: '/nonexistent',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_SYSTEM: '/dev/null',
      GIT_ATTR_NOSYSTEM: '1',
      GIT_NO_REPLACE_OBJECTS: '1',
      GIT_OPTIONAL_LOCKS: '0',
    },
    maxBuffer: 512 * 1024 * 1024,
  });
}
function materializePinnedSource(gitDir, sha, destination) {
  const commitType = configFreeGit(gitDir, ['cat-file', '-t', sha], 'utf8').trim();
  if (commitType !== 'commit') fail(`source pin is ${commitType}, not commit`);
  const raw = configFreeGit(gitDir, [
    'ls-tree',
    '-r',
    '-z',
    sha,
    '--',
    'package.json',
    'package-lock.json',
    'tsconfig.json',
    'src',
  ]);
  for (const record of raw.toString('utf8').split('\0').filter(Boolean)) {
    const match = record.match(/^(100644|100755) blob ([0-9a-f]{40})\t(.+)$/);
    if (!match) fail(`source materialization rejects non-regular tree row: ${record.slice(0, 160)}`);
    const [, mode, oid, file] = match;
    if (file.includes('\n') || file.includes('\0') || file.startsWith('/') || file.split('/').includes('..')) fail(`unsafe source path: ${file}`);
    const output = join(destination, file);
    mkdirSync(dirname(output), { recursive: true });
    writeFileSync(output, configFreeGit(gitDir, ['cat-file', 'blob', oid]));
    chmodSync(output, mode === '100755' ? 0o755 : 0o644);
  }
  for (const required of ['package.json', 'package-lock.json', 'src/storage/memory.ts']) {
    if (!existsSync(join(destination, required))) fail(`raw source export missing ${required}`);
  }
}
function scratchEnvironment(root, additions = {}) {
  const dirs = {
    HOME: join(root, '.home'),
    TMPDIR: join(root, '.tmp'),
    XDG_CACHE_HOME: join(root, '.xdg-cache'),
    XDG_CONFIG_HOME: join(root, '.xdg-config'),
    XDG_DATA_HOME: join(root, '.xdg-data'),
  };
  for (const directory of Object.values(dirs)) mkdirSync(directory, { recursive: true });
  return {
    PATH: '/usr/local/bin:/usr/bin:/bin',
    ...dirs,
    LANG: 'C',
    LC_ALL: 'C',
    TZ: 'UTC',
    ...additions,
  };
}
function installPinnedSource(root, npmCache) {
  if (!isAbsolute(npmCache) || !existsSync(npmCache)) fail('--npm-cache must be an existing absolute cache path');
  const profile = '(version 1) (allow default) (deny network*)';
  const result = spawnSync(
    SANDBOX_EXEC,
    [
      '-p',
      profile,
      NODE,
      NPM_CLI,
      'ci',
      '--offline',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
    ],
    {
      cwd: root,
      env: scratchEnvironment(root, { npm_config_cache: npmCache }),
      encoding: 'utf8',
      timeout: 120_000,
      maxBuffer: 8 * 1024 * 1024,
    },
  );
  if (result.error || result.signal || result.status !== 0) {
    fail(`pinned source npm ci failed: status=${result.status} signal=${result.signal} ${result.error?.message ?? ''}\n${result.stderr?.slice(-8192) ?? ''}`);
  }
}
function assertTargetRoot(root) {
  const packagePath = join(root, 'package.json');
  if (!existsSync(packagePath) || !existsSync(join(root, 'node_modules', 'tsx'))) fail('target root needs its exact package plus installed locked dependencies');
  const resolved = realpathSync(root);
  if (relative(resolved, packagePath).startsWith(`..${sep}`)) fail('target root containment failure');
}
function timeoutPromise(ms, label) {
  let timer;
  const promise = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} exceeded ${ms}ms`)), ms);
  });
  return { promise, cancel: () => clearTimeout(timer) };
}

class StdioPeer {
  constructor(label, command, args, options) {
    this.label = label;
    this.nextId = 1;
    this.pending = new Map();
    this.stderr = '';
    this.stdoutBuffer = '';
    this.child = spawn(command, args, { ...options, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
    this.child.stderr.on('data', (chunk) => {
      this.stderr += chunk.toString('utf8');
      if (Buffer.byteLength(this.stderr) > STDERR_LIMIT) {
        this.rejectAll(new Error(`${label} stderr exceeded ${STDERR_LIMIT} bytes`));
        try { process.kill(-this.child.pid, 'SIGKILL'); } catch {}
      }
    });
    this.child.stdout.on('data', (chunk) => {
      this.stdoutBuffer += chunk.toString('utf8');
      for (;;) {
        const newline = this.stdoutBuffer.indexOf('\n');
        if (newline < 0) break;
        const line = this.stdoutBuffer.slice(0, newline);
        this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
        if (line.length === 0) continue;
        let message;
        try { message = JSON.parse(line); } catch { this.rejectAll(new Error(`${label} emitted non-JSON stdout: ${line.slice(0, 500)}`)); continue; }
        if (message.id !== undefined && this.pending.has(message.id)) {
          const pending = this.pending.get(message.id);
          this.pending.delete(message.id);
          if (message.error) pending.reject(new Error(`${label} RPC ${message.id}: ${JSON.stringify(message.error)}`));
          else pending.resolve(message.result);
        }
      }
    });
    this.child.once('error', (error) => this.rejectAll(error));
    this.child.once('exit', (code, signal) => {
      this.exit = { code, signal };
      this.rejectAll(new Error(`${label} exited: code=${code} signal=${signal}; stderr=${this.stderr.slice(-4096)}`));
    });
  }
  rejectAll(error) {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }
  notify(method, params = {}) {
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
  }
  async request(method, params, deadlineMs) {
    const id = this.nextId++;
    const response = new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    const deadline = timeoutPromise(deadlineMs, `${this.label} ${method}`);
    try { return await Promise.race([response, deadline.promise]); } finally { deadline.cancel(); }
  }
  async initialize() {
    await this.request(
      'initialize',
      { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'echo-context-parity', version: '1' } },
      10_000,
    );
    this.notify('notifications/initialized');
  }
  async close() {
    const pid = this.child.pid;
    if (!pid) fail(`${this.label} has no pid`);
    this.child.stdin.end();
    let outcome = await this.waitExit(5_000);
    if (outcome.timedOut) {
      try { process.kill(-pid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
      outcome = await this.waitExit(5_000);
    }
    if (outcome.timedOut) {
      try { process.kill(-pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
      outcome = await this.waitExit(5_000);
    }
    if (outcome.timedOut) fail(`${this.label} process group survived KILL deadline`);
    await new Promise((resolveWait) => setTimeout(resolveWait, 20));
    try {
      process.kill(-pid, 0);
      fail(`${this.label} descendant/process group survived shutdown`);
    } catch (error) {
      if (error.message?.startsWith('verify-context-tools:')) throw error;
      if (error.code !== 'ESRCH') throw error;
    }
    if (this.stdoutBuffer.length !== 0) fail(`${this.label} left unterminated stdout bytes`);
  }
  waitExit(ms) {
    if (this.exit) return Promise.resolve({ ...this.exit, timedOut: false });
    return new Promise((resolveExit) => {
      let settled = false;
      const timer = setTimeout(() => { if (!settled) { settled = true; resolveExit({ timedOut: true }); } }, ms);
      this.child.once('exit', (code, signal) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolveExit({ code, signal, timedOut: false });
      });
    });
  }
}

function rosterProjection(tools, mode) {
  if (!Array.isArray(tools)) fail(`${mode} tools/list did not return tools[]`);
  const names = tools.map((tool) => tool.name);
  if (names.some((name) => typeof name !== 'string')) fail(`${mode} roster contains nameless descriptor`);
  if (new Set(names).size !== names.length) fail(`${mode} roster contains duplicate IDs`);
  for (const name of CONTEXT_TOOLS) if (names.filter((candidate) => candidate === name).length !== 1) fail(`${mode} requires context ID ${name} exactly once`);
  const projected = CONTEXT_TOOLS.map((name) => tools.find((tool) => tool.name === name));
  const ignoredNames = names.filter((name) => !CONTEXT_TOOLS.includes(name)).sort();
  if (mode === 'target' && ignoredNames.length !== 0) fail(`target exposes non-context tools: ${ignoredNames.join(',')}`);
  if (mode === 'source' && JSON.stringify(ignoredNames) !== JSON.stringify([...IGNORED_CLASSES.keys()].sort())) {
    fail(`source ignored roster drift: ${ignoredNames.join(',')}`);
  }
  const ignored = ignoredNames.map((id) => ({ id, classification: IGNORED_CLASSES.get(id) }));
  return {
    full_roster_descriptors: tools,
    full_roster_sha256: sha256(canonicalBytes(tools)),
    projected_descriptor_sha256: sha256(canonicalBytes(projected)),
    ignored_ids: ignored,
  };
}
async function exercise(peer, fixture, mode) {
  await peer.initialize();
  const list = await peer.request('tools/list', {}, 5_000);
  const projection = rosterProjection(list.tools, mode);
  const perCase = [];
  for (const item of fixture.cases) {
    const deadline = item.id === 'wait-timeout' ? item.timeout_budget_ms : 5_000;
    const started = process.hrtime.bigint();
    const result = await peer.request('tools/call', { name: item.tool, arguments: item.args }, deadline);
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1_000_000;
    if (item.id === 'wait-timeout' && elapsedMs > item.timeout_budget_ms) {
      fail(`${mode} wait case took ${elapsedMs.toFixed(3)}ms > fixture budget ${item.timeout_budget_ms}ms`);
    }
    perCase.push({ case_id: item.id, response_sha256: sha256(canonicalBytes(result)) });
  }
  const aggregate = Buffer.from(perCase.map((row) => `${row.case_id}\0${row.response_sha256}\n`).join(''), 'utf8');
  return { ...projection, per_case: perCase, aggregate_sha256: sha256(aggregate) };
}
function buildEvidence(fixtureBytes, configBytes, source, target) {
  const fixture = JSON.parse(fixtureBytes.toString('utf8'));
  return {
    schema: 'context-tool-parity.v1',
    source_commit: SOURCE_SHA,
    fixture_sha256: sha256(fixtureBytes),
    fixture_bytes_base64: fixtureBytes.toString('base64'),
    harness_sha256: sha256(Buffer.from(HARNESS, 'utf8')),
    harness_bytes_base64: Buffer.from(HARNESS, 'utf8').toString('base64'),
    context_tools_config_sha256: sha256(configBytes),
    context_tools_config_bytes_base64: configBytes.toString('base64'),
    case_order: fixture.cases.map((item) => item.id),
    timeout_contract: {
      source_api_timeout_seconds: 1,
      timeout_budget_ms: 10,
      virtual_clock_advance_ms: 1000,
      note: 'Pinned source schema accepts integer seconds only. The fixture sends timeout:1 and the identical hash-bound harness advances one logical second within the literal 10ms wall budget; timeout:0 is forbidden.',
    },
    source,
    target,
  };
}

async function runParity() {
  const sourceGitDir = argument('--source-git-dir', true);
  const sourceSha = argument('--source-sha', true);
  const targetRoot = resolve(argument('--target-root', true));
  const fixturePath = resolve(argument('--fixture', true));
  const evidencePath = resolve(argument('--evidence', true));
  const npmCache = resolve(argument('--npm-cache', true));
  if (sourceSha !== SOURCE_SHA) fail(`source SHA must be ${SOURCE_SHA}`);
  assertTargetRoot(targetRoot);
  const fixtureBytes = readFileSync(fixturePath);
  const fixture = validateFixture(JSON.parse(fixtureBytes.toString('utf8')));
  const configBytes = readFileSync(join(targetRoot, 'context-tools.v1.json'));
  const config = JSON.parse(configBytes.toString('utf8'));
  if (config.count !== 8 || JSON.stringify(config.tools) !== JSON.stringify(CONTEXT_TOOLS)) fail('context-tools.v1.json drift');
  const scratch = mkdtempSync(join(tmpdir(), 'echo-context-stdio-parity-'));
  const sourceRoot = join(scratch, 'source');
  const harnessPath = join(scratch, 'stdio-harness.mjs');
  mkdirSync(sourceRoot, { recursive: true });
  writeFileSync(harnessPath, HARNESS);
  let sourcePeer;
  let targetPeer;
  const overall = timeoutPromise(60_000, 'overall context parity suite');
  try {
    materializePinnedSource(sourceGitDir, sourceSha, sourceRoot);
    installPinnedSource(sourceRoot, npmCache);
    const commonFixture = canonicalBytes(fixture).toString('base64');
    const sourceEnv = scratchEnvironment(sourceRoot, {
      ECHO_PARITY_ROOT: sourceRoot,
      ECHO_PARITY_MODE: 'source',
      ECHO_PARITY_FIXTURE_B64: commonFixture,
    });
    const targetEnv = scratchEnvironment(join(scratch, 'target-env'), {
      ECHO_PARITY_ROOT: targetRoot,
      ECHO_PARITY_MODE: 'target',
      ECHO_PARITY_FIXTURE_B64: commonFixture,
    });
    const sourceViteNode = join(sourceRoot, 'node_modules/vite-node/vite-node.mjs');
    if (!existsSync(sourceViteNode)) fail('pinned source install lacks vite-node CLI');
    sourcePeer = new StdioPeer('source', NODE, [sourceViteNode, '--script', harnessPath], { cwd: sourceRoot, env: sourceEnv });
    targetPeer = new StdioPeer('target', NODE, ['--import', 'tsx', harnessPath], { cwd: targetRoot, env: targetEnv });
    const work = (async () => {
      const [source, target] = await Promise.all([
        exercise(sourcePeer, fixture, 'source'),
        exercise(targetPeer, fixture, 'target'),
      ]);
      if (source.projected_descriptor_sha256 !== target.projected_descriptor_sha256) fail('projected descriptor bytes differ source vs target');
      if (canonicalBytes(source.per_case).compare(canonicalBytes(target.per_case)) !== 0) fail('per-case full-response hashes differ source vs target');
      if (source.aggregate_sha256 !== target.aggregate_sha256) fail('aggregate differs source vs target');
      return buildEvidence(fixtureBytes, configBytes, source, target);
    })();
    const observed = await Promise.race([work, overall.promise]);
    if (process.argv.includes('--emit')) writeFileSync(evidencePath, `${JSON.stringify(observed, null, 2)}\n`);
    else {
      const declared = JSON.parse(readFileSync(evidencePath, 'utf8'));
      if (canonicalBytes(declared).compare(canonicalBytes(observed)) !== 0) fail('committed context parity evidence differs from actual source/target stdio observation');
    }
    process.stdout.write(`context-tool parity OK: source=${observed.source.full_roster_descriptors.length} tools (${observed.source.ignored_ids.length} ignored), target=8, cases=10, aggregate=${observed.target.aggregate_sha256}\n`);
  } finally {
    overall.cancel();
    const closeErrors = [];
    for (const peer of [sourcePeer, targetPeer]) {
      if (!peer) continue;
      try { await peer.close(); } catch (error) { closeErrors.push(error); }
    }
    rmSync(scratch, { recursive: true, force: true });
    if (closeErrors.length > 0) throw closeErrors[0];
  }
}

async function main() {
  if (process.argv.includes('--validate-only')) {
    const bytes = readFileSync(argument('--fixture', true));
    validateFixture(JSON.parse(bytes.toString('utf8')));
    process.stdout.write(`fixture OK ${sha256(bytes)}\n`);
    return;
  }
  if (process.argv.includes('--hash-json')) {
    const value = JSON.parse(readFileSync(argument('--hash-json', true), 'utf8'));
    process.stdout.write(`${sha256(canonicalBytes(value))}\n`);
    return;
  }
  if (process.argv.includes('--compare-records')) {
    const candidate = JSON.parse(readFileSync(argument('--evidence', true), 'utf8'));
    const observed = JSON.parse(readFileSync(argument('--observed', true), 'utf8'));
    if (canonicalBytes(candidate).compare(canonicalBytes(observed)) !== 0) fail('evidence record differs from observed record');
    process.stdout.write('context-tool evidence record OK\n');
    return;
  }
  await runParity();
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
