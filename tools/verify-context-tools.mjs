#!/usr/bin/env node
// AC3: launch raw-pinned source and accepted-target MCP registrars over stdio,
// consume the sealed fixture, and compare full descriptors/results byte-wise.

import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  statSync,
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
const NODEDIR = '/usr/local/Cellar/node@22/22.22.1_1';
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
const STDOUT_LIMIT = 8 * 1024 * 1024;
const NETWORK_DENY_PROFILE = '(version 1) (allow default) (deny network*)';

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
const HARNESS = String.raw`import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';

const ROOT = process.env.ECHO_PARITY_ROOT;
const MODE = process.env.ECHO_PARITY_MODE;
const CLOCK_MODE = process.env.ECHO_PARITY_CLOCK_MODE || 'advance-exactly';
const OBSERVATION_PATH = process.env.ECHO_PARITY_OBSERVATION;
const FIXTURE = JSON.parse(Buffer.from(process.env.ECHO_PARITY_FIXTURE_B64, 'base64').toString('utf8'));
if (!ROOT || !OBSERVATION_PATH || (MODE !== 'source' && MODE !== 'target') || !['advance-exactly', 'immediate-no-advance'].includes(CLOCK_MODE)) throw new Error('invalid parity harness environment');
const rootImport = (relativePath) => import(pathToFileURL(join(ROOT, relativePath)).href);

const RealDate = Date;
const realSetTimeout = globalThis.setTimeout;
let logicalOffsetMs = 0;
const clockObservation = { schema: 'context-clock-observation.v1', mode: CLOCK_MODE, timer_calls: [] };
const persistClockObservation = () => writeFileSync(OBSERVATION_PATH, JSON.stringify(clockObservation));
class FixedDate extends RealDate {
  constructor(...args) { super(args.length === 0 ? RealDate.parse(FIXTURE.fixed_now) + logicalOffsetMs : args[0]); }
  static now() { return RealDate.parse(FIXTURE.fixed_now) + logicalOffsetMs; }
}
globalThis.Date = FixedDate;
Math.random = () => 0.5;
globalThis.setTimeout = (callback, delay = 0, ...args) => {
  if (Number(delay) >= 1000) {
    const before = FixedDate.now();
    if (CLOCK_MODE === 'immediate-no-advance') {
      if (clockObservation.timer_calls.length === 0) {
        return realSetTimeout(() => {
          clockObservation.timer_calls.push({ requested_delay_ms: Number(delay), virtual_before_ms: before, virtual_after_ms: FixedDate.now(), virtual_advance_ms: 0 });
          persistClockObservation();
          callback(...args);
        }, 0);
      }
      return realSetTimeout(callback, Number(delay), ...args);
    }
    return realSetTimeout(() => {
      logicalOffsetMs += Number(delay);
      clockObservation.timer_calls.push({ requested_delay_ms: Number(delay), virtual_before_ms: before, virtual_after_ms: FixedDate.now(), virtual_advance_ms: FixedDate.now() - before });
      persistClockObservation();
      callback(...args);
    }, 1);
  }
  return realSetTimeout(callback, delay, ...args);
};
persistClockObservation();

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
const NETWORK_PROBE = String.raw`
import dns from 'node:dns';
import https from 'node:https';
import net from 'node:net';

const denied = async (name, start) => new Promise((resolveProbe, rejectProbe) => {
  let settled = false;
  let resource;
  const cleanup = () => { if (resource && typeof resource.destroy === 'function') resource.destroy(); };
  const finish = (value) => { if (!settled) { settled = true; clearTimeout(timer); cleanup(); resolveProbe(value); } };
  const reject = (error) => { if (!settled) { settled = true; clearTimeout(timer); cleanup(); rejectProbe(error); } };
  const timer = setTimeout(() => reject(new Error(name + ' timed out without an explicit denial')), 1000);
  try {
    resource = start(
      () => reject(new Error(name + ' unexpectedly reached the network')),
      (error) => {
        const code = String(error && (error.code || error.name) || '');
        if (!code) reject(new Error(name + ' failed without an explicit error code'));
        else finish({ name, status: 'denied', code });
      },
    );
  } catch (error) {
    const code = String(error && (error.code || error.name) || '');
    if (!code) reject(new Error(name + ' threw without an explicit error code'));
    else finish({ name, status: 'denied', code });
  }
});
const observations = await Promise.all([
  denied('dns', (success, failure) => dns.lookup('registry.npmjs.org', (error) => error ? failure(error) : success())),
  denied('direct_ip_tcp', (success, failure) => {
    const socket = net.connect({ host: '1.1.1.1', port: 443 });
    socket.once('connect', () => { socket.destroy(); success(); });
    socket.once('error', failure);
    return socket;
  }),
  denied('https', (success, failure) => {
    const request = https.get('https://registry.npmjs.org/', () => { request.destroy(); success(); });
    request.once('error', failure);
    return request;
  }),
]);
process.stdout.write(JSON.stringify(observations));
`;

const LOOPBACK_SERVER = String.raw`
const net = require('node:net');
const server = net.createServer((socket) => { socket.end('ok'); });
server.listen(0, '127.0.0.1', () => process.stdout.write(String(server.address().port) + '\n'));
`;
const LOOPBACK_CLIENT = String.raw`
const net = require('node:net');
const port = Number(process.argv[1]);
const socket = net.connect({ host: '127.0.0.1', port });
let settled = false;
const finish = (record, status = 0) => {
  if (settled) return;
  settled = true;
  clearTimeout(timer);
  socket.destroy();
  process.stdout.write(JSON.stringify(record));
  process.exit(status);
};
const timer = setTimeout(() => finish({ status: 'timeout' }, 2), 1000);
socket.once('connect', () => finish({ status: 'accepted' }));
socket.once('error', (error) => finish({ status: 'denied', code: String(error.code || error.name || '') }, error.code || error.name ? 0 : 2));
`;

function runSandboxed(root, env, argv, label, timeout = 120_000) {
  const result = spawnSync(SANDBOX_EXEC, ['-p', NETWORK_DENY_PROFILE, NODE, ...argv], {
    cwd: root,
    env,
    encoding: 'utf8',
    timeout,
    maxBuffer: 8 * 1024 * 1024,
  });
  if (result.error || result.signal || result.status !== 0) {
    fail(`${label} failed: status=${result.status} signal=${result.signal} ${result.error?.message ?? ''}\n${result.stderr?.slice(-8192) ?? ''}`);
  }
  return result;
}
function runNetworkDenialProbe(root, env, phase) {
  const result = runSandboxed(root, env, ['--input-type=module', '-e', NETWORK_PROBE], `network-denial probe ${phase}`, 10_000);
  let observations;
  try { observations = JSON.parse(result.stdout); } catch { fail(`network-denial probe ${phase} emitted invalid JSON`); }
  if (!Array.isArray(observations) || observations.length !== 3 || observations.some((entry) => entry.status !== 'denied')) {
    fail(`network-denial probe ${phase} was not fail-closed`);
  }
  return { phase, observations };
}
function readFirstLine(stream, timeoutMs, label) {
  return new Promise((resolveLine, rejectLine) => {
    let buffer = '';
    const timer = setTimeout(() => { cleanup(); rejectLine(new Error(`${label} timed out`)); }, timeoutMs);
    const onData = (chunk) => {
      buffer += chunk.toString('utf8');
      const newline = buffer.indexOf('\n');
      if (newline >= 0) { cleanup(); resolveLine(buffer.slice(0, newline)); }
    };
    const onEnd = () => { cleanup(); rejectLine(new Error(`${label} ended before a line`)); };
    const cleanup = () => { clearTimeout(timer); stream.off('data', onData); stream.off('end', onEnd); };
    stream.on('data', onData);
    stream.once('end', onEnd);
  });
}
async function verifyLoopbackControl(root, env) {
  const server = spawn(NODE, ['-e', LOOPBACK_SERVER], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  server.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
  try {
    const portText = await readFirstLine(server.stdout, 2_000, 'loopback control server');
    if (!/^\d+$/.test(portText)) fail(`loopback control emitted invalid port: ${portText}`);
    const outside = spawnSync(NODE, ['-e', LOOPBACK_CLIENT, portText], { cwd: root, env, encoding: 'utf8', timeout: 5_000 });
    if (outside.error || outside.signal || outside.status !== 0) fail(`outside-profile loopback control failed: ${outside.stderr}`);
    const outsideRecord = JSON.parse(outside.stdout);
    if (outsideRecord.status !== 'accepted') fail('outside-profile loopback control did not ACCEPT');
    const inside = runSandboxed(root, env, ['-e', LOOPBACK_CLIENT, portText], 'inside-profile loopback control', 5_000);
    const insideRecord = JSON.parse(inside.stdout);
    if (insideRecord.status !== 'denied' || !insideRecord.code) fail('inside-profile loopback control was not explicitly denied');
    return { outside_profile: 'ACCEPT', inside_profile: 'DENIED', inside_error_code: insideRecord.code };
  } finally {
    if (server.exitCode === null && server.signalCode === null) server.kill('SIGKILL');
    if (server.exitCode === null && server.signalCode === null) {
      const reaped = await Promise.race([
        new Promise((resolveExit) => server.once('exit', () => resolveExit(true))),
        new Promise((resolveTimeout) => setTimeout(() => resolveTimeout(false), 2_000)),
      ]);
      if (!reaped) fail('loopback control server survived SIGKILL/reap deadline');
    }
    if (stderr && !server.pid) fail(`loopback control server failed: ${stderr.slice(-4096)}`);
  }
}
async function installPinnedSource(root, npmCache) {
  if (!isAbsolute(npmCache) || !existsSync(npmCache)) fail('--npm-cache must be an existing absolute cache path');
  if (!existsSync(NODEDIR)) fail(`pinned npm_config_nodedir is missing: ${NODEDIR}`);
  const env = scratchEnvironment(root, { npm_config_cache: npmCache, npm_config_nodedir: NODEDIR });
  const loopback_control = await verifyLoopbackControl(root, env);
  const network_probes = [runNetworkDenialProbe(root, env, 'before_ci')];
  runSandboxed(
    root,
    env,
    [NPM_CLI, 'ci', '--offline', '--ignore-scripts', '--no-audit', '--no-fund'],
    'pinned source npm ci',
  );
  network_probes.push(runNetworkDenialProbe(root, env, 'after_ci'));
  runSandboxed(
    root,
    env,
    [NPM_CLI, 'rebuild', 'better-sqlite3', '--offline', '--foreground-scripts', '--build-from-source'],
    'pinned source better-sqlite3 rebuild',
  );
  network_probes.push(runNetworkDenialProbe(root, env, 'after_rebuild'));
  const nativePath = join(root, 'node_modules/better-sqlite3/build/Release/better_sqlite3.node');
  if (!existsSync(nativePath)) fail('pinned source rebuild did not produce better_sqlite3.node');
  runSandboxed(
    root,
    env,
    ['-e', "const Database=require('better-sqlite3');const db=new Database(':memory:');db.exec('create table t(v integer);insert into t values(7)');if(db.prepare('select v from t').get().v!==7)process.exit(2);db.close()"],
    'pinned source better-sqlite3 smoke',
    10_000,
  );
  const lock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8'));
  const locked = lock.packages?.['node_modules/better-sqlite3'];
  if (!locked?.version || !locked?.integrity) fail('pinned source lock lacks better-sqlite3 metadata');
  return {
    network_profile: NETWORK_DENY_PROFILE,
    loopback_control,
    network_probes,
    ci: { command: 'npm ci --offline --ignore-scripts --no-audit --no-fund', exit: 0, scripts_executed: [] },
    rebuild: {
      command: 'npm rebuild better-sqlite3 --offline --foreground-scripts --build-from-source',
      exit: 0,
      npm_config_nodedir: NODEDIR,
      package: { version: locked.version, integrity: locked.integrity },
      native_artifact: { path: 'node_modules/better-sqlite3/build/Release/better_sqlite3.node', size_bytes: statSync(nativePath).size, sha256: sha256(readFileSync(nativePath)) },
    },
    smoke: 'better-sqlite3 in-memory open/create/insert/select/close under deny-network',
  };
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
  constructor(label, args, options) {
    this.label = label;
    this.nextId = 1;
    this.pending = new Map();
    this.seenResponseIds = new Set();
    this.stderr = '';
    this.stdoutBuffer = Buffer.alloc(0);
    this.child = spawn(NODE, args, { ...options, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
    this.child.stdin.on('error', (error) => {
      if (this.protocolError && ['EPIPE', 'ERR_STREAM_DESTROYED'].includes(error.code)) return;
      this.rejectAll(error);
    });
    this.child.stderr.on('data', (chunk) => {
      this.stderr += chunk.toString('utf8');
      if (Buffer.byteLength(this.stderr) > STDERR_LIMIT) {
        this.rejectAll(new Error(`${label} stderr exceeded ${STDERR_LIMIT} bytes`));
        try { process.kill(-this.child.pid, 'SIGKILL'); } catch {}
      }
    });
    this.child.stdout.on('data', (chunk) => {
      this.stdoutBuffer = Buffer.concat([this.stdoutBuffer, chunk]);
      if (this.stdoutBuffer.length > STDOUT_LIMIT) {
        this.protocolFailure(new Error(`${label} stdout exceeded ${STDOUT_LIMIT} bytes`));
        return;
      }
      for (;;) {
        const newline = this.stdoutBuffer.indexOf(0x0a);
        if (newline < 0) break;
        const lineBytes = this.stdoutBuffer.subarray(0, newline);
        this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
        if (lineBytes.length === 0) {
          this.protocolFailure(new Error(`${label} emitted an unsolicited blank stdout line`));
          continue;
        }
        let line;
        try { line = new TextDecoder('utf-8', { fatal: true }).decode(lineBytes); } catch { this.protocolFailure(new Error(`${label} emitted non-UTF-8 stdout`)); continue; }
        let message;
        try { message = JSON.parse(line); } catch { this.protocolFailure(new Error(`${label} emitted non-JSON stdout: ${line.slice(0, 500)}`)); continue; }
        if (!message || typeof message !== 'object' || Array.isArray(message)) {
          this.protocolFailure(new Error(`${label} emitted a non-object JSON-RPC message`));
          continue;
        }
        const keys = Object.keys(message).sort();
        if (JSON.stringify(keys) !== JSON.stringify(['id', 'jsonrpc', 'result'])) {
          this.protocolFailure(new Error(`${label} emitted malformed/unsolicited JSON-RPC envelope keys: ${keys.join(',')}`));
          continue;
        }
        if (message.jsonrpc !== '2.0' || !Number.isSafeInteger(message.id) || message.id < 1) {
          this.protocolFailure(new Error(`${label} emitted malformed JSON-RPC version/id`));
          continue;
        }
        if (this.seenResponseIds.has(message.id)) {
          this.protocolFailure(new Error(`${label} emitted duplicate response id ${message.id}`));
          continue;
        }
        if (!this.pending.has(message.id)) {
          this.protocolFailure(new Error(`${label} emitted unknown response id ${message.id}`));
          continue;
        }
        this.seenResponseIds.add(message.id);
        const pending = this.pending.get(message.id);
        this.pending.delete(message.id);
        pending.resolve(message);
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
  protocolFailure(error) {
    if (!this.protocolError) this.protocolError = error;
    this.rejectAll(this.protocolError);
    if (this.child.pid) {
      try { process.kill(-this.child.pid, 'SIGTERM'); } catch (killError) { if (killError.code !== 'ESRCH') throw killError; }
    }
  }
  notify(method, params = {}) {
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
  }
  async request(method, params, deadlineMs) {
    const id = this.nextId++;
    const response = new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    const deadline = timeoutPromise(deadlineMs, `${this.label} ${method}`);
    try {
      return await Promise.race([response, deadline.promise]);
    } finally {
      deadline.cancel();
      this.pending.delete(id);
    }
  }
  async initialize() {
    const envelope = await this.request(
      'initialize',
      { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'echo-context-parity', version: '1' } },
      10_000,
    );
    this.notify('notifications/initialized');
    return envelope;
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
    if (this.protocolError) throw this.protocolError;
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
function readClockObservation(path, mode, clockMode = 'advance-exactly') {
  if (!existsSync(path)) fail(`${mode} harness did not emit a clock observation`);
  const observation = JSON.parse(readFileSync(path, 'utf8'));
  exactObject(observation, ['schema', 'mode', 'timer_calls'], `${mode} clock observation`);
  if (observation.schema !== 'context-clock-observation.v1' || observation.mode !== clockMode) fail(`${mode} clock observation identity drift`);
  if (!Array.isArray(observation.timer_calls)) fail(`${mode} timer_calls must be an array`);
  return observation;
}
function validateExactClockObservation(observation, mode) {
  if (observation.timer_calls.length !== 1) fail(`${mode} must observe exactly one long-poll timer`);
  const call = observation.timer_calls[0];
  exactObject(call, ['requested_delay_ms', 'virtual_before_ms', 'virtual_after_ms', 'virtual_advance_ms'], `${mode} timer call`);
  const fixed = Date.parse(FIXED_NOW);
  if (call.requested_delay_ms !== 1000 || call.virtual_before_ms !== fixed || call.virtual_after_ms !== fixed + 1000 || call.virtual_advance_ms !== 1000) {
    fail(`${mode} did not observe an exact 1000ms virtual long-poll advance`);
  }
}
async function exercise(peer, fixture, mode, observationPath) {
  const initializeEnvelope = await peer.initialize();
  const listEnvelope = await peer.request('tools/list', {}, 5_000);
  const projection = rosterProjection(listEnvelope.result.tools, mode);
  const perCase = [];
  for (const item of fixture.cases) {
    const deadline = item.id === 'wait-timeout' ? item.timeout_budget_ms : 5_000;
    const started = process.hrtime.bigint();
    const envelope = await peer.request('tools/call', { name: item.tool, arguments: item.args }, deadline);
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1_000_000;
    if (item.id === 'wait-timeout' && elapsedMs > item.timeout_budget_ms) {
      fail(`${mode} wait case took ${elapsedMs.toFixed(3)}ms > fixture budget ${item.timeout_budget_ms}ms`);
    }
    perCase.push({ case_id: item.id, response_sha256: sha256(canonicalBytes(envelope)) });
  }
  const clockObservation = readClockObservation(observationPath, mode);
  validateExactClockObservation(clockObservation, mode);
  const initializeResponseSha = sha256(canonicalBytes(initializeEnvelope));
  const toolsListResponseSha = sha256(canonicalBytes(listEnvelope));
  const aggregate = Buffer.from(perCase.map((row) => `${row.case_id}\0${row.response_sha256}\n`).join(''), 'utf8');
  return {
    ...projection,
    initialize_response_sha256: initializeResponseSha,
    tools_list_response_sha256: toolsListResponseSha,
    clock_observation: clockObservation,
    clock_observation_sha256: sha256(canonicalBytes(clockObservation)),
    per_case: perCase,
    aggregate_sha256: sha256(aggregate),
  };
}
async function exerciseImmediateClockNegativeControl(peer, fixture, observationPath) {
  await peer.initialize();
  const item = fixture.cases.find((candidate) => candidate.id === 'wait-timeout');
  let deadlineRejected = false;
  try {
    await peer.request('tools/call', { name: item.tool, arguments: item.args }, item.timeout_budget_ms);
  } catch (error) {
    if (!String(error?.message ?? error).includes('exceeded 10ms')) throw error;
    deadlineRejected = true;
  }
  if (!deadlineRejected) fail('immediate-no-advance clock negative control returned instead of failing its 10ms deadline');
  const observation = readClockObservation(observationPath, 'target negative control', 'immediate-no-advance');
  if (observation.timer_calls.length !== 1) fail('immediate clock negative control did not observe exactly one fake timer');
  const call = observation.timer_calls[0];
  const fixed = Date.parse(FIXED_NOW);
  if (call.requested_delay_ms !== 1000 || call.virtual_before_ms !== fixed || call.virtual_after_ms !== fixed || call.virtual_advance_ms !== 0) {
    fail('immediate clock negative control did not prove zero virtual advance');
  }
  if (peer.child.pid) {
    try { process.kill(-peer.child.pid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
  }
  return {
    mode: 'immediate-no-advance',
    side: 'target',
    request_deadline_ms: item.timeout_budget_ms,
    outcome: 'rejected_request_deadline',
    observation,
    observation_sha256: sha256(canonicalBytes(observation)),
  };
}
function buildEvidence(fixtureBytes, configBytes, sourceInstallLifecycle, negativeControl, source, target) {
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
    source_install_lifecycle: sourceInstallLifecycle,
    clock_negative_control: negativeControl,
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

async function runProtocolProbe(probeCase) {
  const cases = new Set(['valid', 'malformed', 'malformed-id', 'unknown-id', 'duplicate-id', 'unsolicited', 'unterminated', 'non-json']);
  if (!cases.has(probeCase)) fail(`unknown --protocol-probe case: ${probeCase}`);
  const scratch = mkdtempSync(join(tmpdir(), 'echo-context-protocol-probe-'));
  const childPath = join(scratch, 'child.mjs');
  const childSource = String.raw`
let buffer = '';
process.stdin.on('data', (chunk) => {
  buffer += chunk.toString('utf8');
  const newline = buffer.indexOf('\n');
  if (newline < 0) return;
  const request = JSON.parse(buffer.slice(0, newline));
  const id = request.id;
  const valid = JSON.stringify({ jsonrpc: '2.0', id, result: { ok: true } });
  switch (process.env.PROBE_CASE) {
    case 'valid': process.stdout.write(valid + '\n'); break;
    case 'malformed': process.stdout.write(JSON.stringify({ jsonrpc: '1.0', id, result: {} }) + '\n'); break;
    case 'malformed-id': process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: String(id), result: {} }) + '\n'); break;
    case 'unknown-id': process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: id + 99, result: {} }) + '\n'); break;
    case 'duplicate-id': process.stdout.write(valid + '\n' + valid + '\n'); break;
    case 'unsolicited': process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/progress', params: {} }) + '\n'); break;
    case 'unterminated': process.stdout.write(valid); break;
    case 'non-json': process.stdout.write('not-json\n'); break;
  }
});
`;
  writeFileSync(childPath, childSource);
  const peer = new StdioPeer(`protocol probe ${probeCase}`, [childPath], {
    cwd: scratch,
    env: scratchEnvironment(scratch, { PROBE_CASE: probeCase }),
  });
  let requestError;
  let closeError;
  try {
    try {
      await peer.request('probe', {}, 250);
      await new Promise((resolveWait) => setTimeout(resolveWait, 20));
    } catch (error) {
      requestError = error;
    }
  } finally {
    try { await peer.close(); } catch (error) { closeError = error; }
    rmSync(scratch, { recursive: true, force: true });
  }
  const error = closeError ?? requestError;
  if (probeCase === 'valid') {
    if (error) throw error;
    process.stdout.write('protocol probe valid accepted\n');
    return;
  }
  if (!error) fail(`protocol probe ${probeCase} was unexpectedly accepted`);
  throw error;
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
  let negativePeer;
  const overall = timeoutPromise(60_000, 'overall context parity suite');
  try {
    materializePinnedSource(sourceGitDir, sourceSha, sourceRoot);
    const sourceInstallLifecycle = await installPinnedSource(sourceRoot, npmCache);
    const commonFixture = canonicalBytes(fixture).toString('base64');
    const sourceObservationPath = join(scratch, 'source-clock-observation.json');
    const targetObservationPath = join(scratch, 'target-clock-observation.json');
    const negativeObservationPath = join(scratch, 'negative-clock-observation.json');
    const sourceEnv = scratchEnvironment(sourceRoot, {
      ECHO_PARITY_ROOT: sourceRoot,
      ECHO_PARITY_MODE: 'source',
      ECHO_PARITY_FIXTURE_B64: commonFixture,
      ECHO_PARITY_CLOCK_MODE: 'advance-exactly',
      ECHO_PARITY_OBSERVATION: sourceObservationPath,
    });
    const targetEnv = scratchEnvironment(join(scratch, 'target-env'), {
      ECHO_PARITY_ROOT: targetRoot,
      ECHO_PARITY_MODE: 'target',
      ECHO_PARITY_FIXTURE_B64: commonFixture,
      ECHO_PARITY_CLOCK_MODE: 'advance-exactly',
      ECHO_PARITY_OBSERVATION: targetObservationPath,
    });
    const sourceViteNode = join(sourceRoot, 'node_modules/vite-node/vite-node.mjs');
    if (!existsSync(sourceViteNode)) fail('pinned source install lacks vite-node CLI');
    sourcePeer = new StdioPeer('source', [sourceViteNode, '--script', harnessPath], { cwd: sourceRoot, env: sourceEnv });
    targetPeer = new StdioPeer('target', ['--import', 'tsx', harnessPath], { cwd: targetRoot, env: targetEnv });
    const work = (async () => {
      const [source, target] = await Promise.all([
        exercise(sourcePeer, fixture, 'source', sourceObservationPath),
        exercise(targetPeer, fixture, 'target', targetObservationPath),
      ]);
      if (source.projected_descriptor_sha256 !== target.projected_descriptor_sha256) fail('projected descriptor bytes differ source vs target');
      if (source.clock_observation_sha256 !== target.clock_observation_sha256) fail('clock observations differ source vs target');
      if (canonicalBytes(source.per_case).compare(canonicalBytes(target.per_case)) !== 0) fail('per-case full-response hashes differ source vs target');
      if (source.aggregate_sha256 !== target.aggregate_sha256) fail('aggregate differs source vs target');
      const negativeEnv = scratchEnvironment(join(scratch, 'negative-env'), {
        ECHO_PARITY_ROOT: targetRoot,
        ECHO_PARITY_MODE: 'target',
        ECHO_PARITY_FIXTURE_B64: commonFixture,
        ECHO_PARITY_CLOCK_MODE: 'immediate-no-advance',
        ECHO_PARITY_OBSERVATION: negativeObservationPath,
      });
      negativePeer = new StdioPeer('target immediate-clock negative control', ['--import', 'tsx', harnessPath], { cwd: targetRoot, env: negativeEnv });
      const negativeControl = await exerciseImmediateClockNegativeControl(negativePeer, fixture, negativeObservationPath);
      return buildEvidence(fixtureBytes, configBytes, sourceInstallLifecycle, negativeControl, source, target);
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
    for (const peer of [sourcePeer, targetPeer, negativePeer]) {
      if (!peer) continue;
      try { await peer.close(); } catch (error) { closeErrors.push(error); }
    }
    rmSync(scratch, { recursive: true, force: true });
    if (closeErrors.length > 0) throw closeErrors[0];
  }
}

async function main() {
  if (process.argv.includes('--protocol-probe')) {
    await runProtocolProbe(argument('--protocol-probe', true));
    return;
  }
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
