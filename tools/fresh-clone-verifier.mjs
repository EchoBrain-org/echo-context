#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import { access, chmod, lstat, mkdir, mkdtemp, realpath } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const LIMITS = Object.freeze({
  aggregate: 3_700_000,
  reserve: 120_000,
  settlement: 10_000,
  version: 30_000,
  boundary: 30_000,
  install: 600_000,
  long: 900_000,
  ordinary: 300_000,
  cleanup: 30_000,
});

const FULL_SHA = /^[0-9a-f]{40}$/u;
const HASH = /^[0-9a-f]{64}$/u;
const EXPECTED_NODE_VERSION = 'v22.22.1';
const EXPECTED_NPM_VERSION = '10.9.4';
const TEMP_PARENT = '.fresh-clone-acceptance';
const MAX_OUTPUT = 128 * 1024 * 1024;

function fail(message) {
  throw new Error(`fresh-clone-verifier: ${message}`);
}

function cleanScalar(value, label, { absolute = false } = {}) {
  if (typeof value !== 'string' || value.length === 0 || /[\r\n\0]/u.test(value)) fail(`${label} is missing or contains a forbidden byte`);
  if (absolute && !value.startsWith('/')) fail(`${label} must be absolute`);
  return value;
}

export function parseInvocation(argv) {
  if (argv.length !== 13) {
    fail('usage: --node-bin <NODE> --npm-bin <NPM> --git-bin <GIT> --git-version <VERSION> --sandbox-home <HOME> --mode=source --source-sha <SHA>');
  }
  const fixed = ['--node-bin', '--npm-bin', '--git-bin', '--git-version', '--sandbox-home'];
  const values = {};
  for (let index = 0; index < fixed.length; index += 1) {
    const offset = index * 2;
    if (argv[offset] !== fixed[index]) fail(`common prefix differs at ${fixed[index]}`);
    values[fixed[index]] = cleanScalar(argv[offset + 1], fixed[index], { absolute: fixed[index] !== '--git-version' });
  }
  if (argv[10] !== '--mode=source' || argv[11] !== '--source-sha') fail('the sole accepted mode is --mode=source --source-sha <SHA>');
  const sourceSha = cleanScalar(argv[12], '--source-sha');
  if (!FULL_SHA.test(sourceSha)) fail('--source-sha must be one full lowercase Git OID');
  return Object.freeze({
    nodeBin: values['--node-bin'],
    npmBin: values['--npm-bin'],
    gitBin: values['--git-bin'],
    gitVersion: values['--git-version'],
    sandboxHome: values['--sandbox-home'],
    sourceSha,
  });
}

export function buildEnvironment(input) {
  const path = [dirname(input.nodeBin), dirname(input.npmBin), dirname(input.gitBin), '/usr/bin', '/bin'].join(':');
  return Object.freeze({
    HOME: input.sandboxHome,
    TMPDIR: join(input.sandboxHome, 'tmp'),
    PATH: path,
    LANG: 'C',
    LC_ALL: 'C',
    TZ: 'UTC',
    CI: '1',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
    NPM_CONFIG_USERCONFIG: '/dev/null',
    NPM_CONFIG_CACHE: join(input.sandboxHome, '.npm-cache'),
  });
}

function boundary(input) {
  return [
    { executable: input.gitBin, argv: ['status', '--porcelain=v1', '--untracked-files=all'], kind: 'status' },
    { executable: input.gitBin, argv: ['rev-parse', 'HEAD'], kind: 'head' },
  ];
}

export function sourcePlan(input, cloneRoot, ownedRoot, manifestHash = '<manifest-hash>') {
  const version = '0.1.0-dev.136.1';
  const prefix = `echo-context-${version}-source`;
  const archive = join(ownedRoot, `${prefix}.tgz`);
  const checksum = join(ownedRoot, `${prefix}.tgz.sha256`);
  const manifest = join(ownedRoot, `${prefix}.manifest.json`);
  return [
    ...boundary(input),
    { executable: input.npmBin, argv: ['ci'], kind: 'install' },
    ...boundary(input),
    { executable: input.npmBin, argv: ['run', 'typecheck'], kind: 'ordinary' },
    { executable: input.npmBin, argv: ['run', 'lint'], kind: 'ordinary' },
    { executable: input.npmBin, argv: ['run', 'test:ci'], kind: 'long' },
    { executable: input.npmBin, argv: ['run', 'verify:inventory'], kind: 'ordinary' },
    { executable: input.npmBin, argv: ['run', 'verify:authority'], kind: 'ordinary' },
    { executable: input.npmBin, argv: ['run', 'build:artifact', '--', '--source-sha', input.sourceSha, '--out', ownedRoot], kind: 'ordinary', carrier: true },
    { executable: input.npmBin, argv: ['run', 'verify:artifact', '--', '--archive', archive, '--checksum', checksum, '--manifest', manifest, '--expected-manifest-hash', manifestHash], kind: 'ordinary' },
    { executable: input.gitBin, argv: ['fsck', '--full'], kind: 'ordinary' },
    { executable: input.npmBin, argv: ['run', 'scan:secrets'], kind: 'long' },
    { executable: input.nodeBin, argv: [join(cloneRoot, 'tools/fresh-clone-cleanup.mjs'), '--owned-root', ownedRoot], kind: 'cleanup' },
    ...boundary(input),
  ].map((step, index) => Object.freeze({ ...step, ordinal: index + 1, argv: Object.freeze([...step.argv]) }));
}

function exactSingleLine(stdout, expected, label) {
  if (stdout.includes('\r') || stdout.includes('\0')) fail(`${label} contains CR or NUL`);
  if (stdout !== expected && stdout !== `${expected}\n`) fail(`${label} differs or contains extra bytes`);
}

function parseCarrier(stdout) {
  if (stdout.includes('\r') || stdout.includes('\0')) fail('manifest carrier contains CR or NUL');
  const lines = stdout.endsWith('\n') ? stdout.slice(0, -1).split('\n') : stdout.split('\n');
  const final = lines.at(-1) ?? '';
  const match = /^manifest_hash=([0-9a-f]{64})$/u.exec(final);
  if (!match) fail('build:artifact final stdout line is not the exact manifest_hash carrier');
  return match[1];
}

function classLimit(kind) {
  if (kind === 'status' || kind === 'head') return LIMITS.boundary;
  if (kind === 'install') return LIMITS.install;
  if (kind === 'long') return LIMITS.long;
  if (kind === 'cleanup') return LIMITS.cleanup;
  return LIMITS.ordinary;
}

function effectiveTimeout(kind, now, executionBoundary) {
  const remaining = executionBoundary - now;
  if (remaining <= 0) fail('aggregate prefinal execution boundary expired');
  return Math.min(classLimit(kind), remaining);
}

async function execute(step, context, executionBoundary) {
  const timeoutMs = effectiveTimeout(step.kind, context.deps.now(), executionBoundary);
  const result = await context.deps.spawnStep({
    executable: step.executable,
    argv: [...step.argv],
    cwd: context.cloneRoot,
    env: context.env,
    shell: false,
    detached: true,
    timeoutMs,
    settlementMs: LIMITS.settlement,
  });
  if (!result || result.status !== 0 || result.signal !== null || result.timedOut === true || result.outputOverflow === true || result.pgidAbsent !== true) {
    const detail = `${result?.stdout ?? ''}${result?.stderr ?? ''}`.trim();
    fail(`child ${step.ordinal ?? 'prelude'} failed or did not settle${detail ? `: ${detail}` : ''}`);
  }
  if (step.kind === 'status' && result.stdout !== '') fail('cleanliness boundary found staged, unstaged, or nonignored untracked state');
  if (step.kind === 'head') exactSingleLine(result.stdout, context.input.sourceSha, 'HEAD readback');
  return result;
}

function attachCleanupFailure(primary, cleanup) {
  const error = primary instanceof Error ? primary : new Error(String(primary));
  Object.defineProperty(error, 'cleanupFailure', { value: cleanup instanceof Error ? cleanup.message : String(cleanup), enumerable: true });
  return error;
}

export async function runFreshClone(argv, injected) {
  const input = parseInvocation(argv);
  const verifierPath = fileURLToPath(import.meta.url);
  const cloneRoot = dirname(dirname(verifierPath));
  const deps = injected ?? createProductionDeps();
  const started = deps.now();
  const aggregateEnd = started + LIMITS.aggregate;
  const prefinalCutoff = aggregateEnd - LIMITS.reserve;
  const prefinalExecutionBoundary = prefinalCutoff - LIMITS.settlement;

  // This is the first injected/operational action. It performs identity reads
  // only; parsing above is pure and cannot mutate, spawn, or access a network.
  await deps.authenticate({ input, verifierPath, cloneRoot, expectedNodeVersion: EXPECTED_NODE_VERSION });
  if (deps.now() > prefinalCutoff) fail('identity checks exhausted the prefinal deadline');
  const context = { input, deps, cloneRoot, env: buildEnvironment(input) };

  const npmVersion = await deps.spawnStep({
    executable: input.npmBin,
    argv: ['--version'],
    cwd: cloneRoot,
    env: context.env,
    shell: false,
    detached: true,
    timeoutMs: effectiveTimeout('status', deps.now(), prefinalExecutionBoundary),
    settlementMs: LIMITS.settlement,
  });
  if (npmVersion.status !== 0 || npmVersion.signal !== null || npmVersion.timedOut === true || npmVersion.outputOverflow === true || npmVersion.pgidAbsent !== true) fail('npm version prelude failed or did not settle');
  exactSingleLine(npmVersion.stdout, EXPECTED_NPM_VERSION, 'npm version');

  const gitVersion = await deps.spawnStep({
    executable: input.gitBin,
    argv: ['--version'],
    cwd: cloneRoot,
    env: context.env,
    shell: false,
    detached: true,
    timeoutMs: effectiveTimeout('status', deps.now(), prefinalExecutionBoundary),
    settlementMs: LIMITS.settlement,
  });
  if (gitVersion.status !== 0 || gitVersion.signal !== null || gitVersion.timedOut === true || gitVersion.outputOverflow === true || gitVersion.pgidAbsent !== true) fail('git version prelude failed or did not settle');
  exactSingleLine(gitVersion.stdout, `git version ${input.gitVersion}`, 'git version');

  const placeholder = join(cloneRoot, TEMP_PARENT, 'run-PENDING');
  let plan = sourcePlan(input, cloneRoot, placeholder);
  let ownedRoot;
  let cleanupState = 'not_started';
  let cleanupPid = null;

  const transitionCleanup = async () => {
    if (!ownedRoot || cleanupState !== 'not_started') return;
    cleanupState = 'running'; // first synchronous, non-fallible state action
    try {
      await deps.settleActiveChild();
      const helper = join(cloneRoot, 'tools/fresh-clone-cleanup.mjs');
      await deps.authenticateHelper(helper);
      const cleanupStep = sourcePlan(input, cloneRoot, ownedRoot).at(14);
      const reserveBoundary = Math.min(aggregateEnd, deps.now() + 40_000);
      const result = await execute(cleanupStep, context, reserveBoundary);
      if (!Number.isInteger(result.pid) || result.pid <= 0) fail('cleanup child did not return a direct process-group identity');
      cleanupPid = result.pid;
      await deps.assertGroupAbsent(cleanupPid);
      await deps.assertPathAbsent(ownedRoot);
      if (deps.now() > reserveBoundary) fail('cleanup and absence readback exceeded its reserved envelope');
      cleanupState = 'completed';
    } catch (error) {
      cleanupState = 'failed';
      throw error;
    }
  };

  try {
    for (let index = 0; index < 10; index += 1) await execute(plan[index], context, prefinalExecutionBoundary);
    ownedRoot = await deps.createOwnedTemp(join(cloneRoot, TEMP_PARENT));
    if (deps.now() > prefinalCutoff) fail('temporary-root creation crossed the reserved final window');
    plan = sourcePlan(input, cloneRoot, ownedRoot);
    const build = await execute(plan[10], context, prefinalExecutionBoundary);
    const manifestHash = parseCarrier(build.stdout);
    if (!HASH.test(manifestHash)) fail('manifest carrier is malformed');
    plan = sourcePlan(input, cloneRoot, ownedRoot, manifestHash);
    for (let index = 11; index <= 13; index += 1) await execute(plan[index], context, prefinalExecutionBoundary);
    if (deps.now() > prefinalCutoff) fail('prefinal settlement crossed the reserved final window');
    await transitionCleanup();
    if (cleanupState !== 'completed') fail('cleanup did not reach completed');
    await execute(plan[15], context, Math.min(aggregateEnd, deps.now() + 40_000));
    await execute(plan[16], context, Math.min(aggregateEnd, deps.now() + 40_000));
    if (deps.now() > aggregateEnd) fail('aggregate 3700-second deadline expired');
    return Object.freeze({ sourceSha: input.sourceSha, manifestHash, cleanupState, steps: 17 });
  } catch (primary) {
    if (ownedRoot && cleanupState === 'not_started') {
      try {
        await transitionCleanup();
      } catch (cleanup) {
        throw attachCleanupFailure(primary, cleanup);
      }
    }
    throw primary;
  } finally {
    if (ownedRoot && cleanupState === 'not_started') {
      // The transition itself owns retry prevention. A running/completed/failed
      // state can never re-enter this branch.
      await transitionCleanup();
    }
  }
}

function processGroupExists(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    if (error?.code === 'ESRCH') return false;
    throw error;
  }
}

function signalGroup(pid, signal) {
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if (error?.code !== 'ESRCH') throw error;
  }
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function spawnManaged(spec, state) {
  if (spec.shell !== false || spec.detached !== true) fail('production child must use shell:false and its own process group');
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(spec.executable, spec.argv, {
        cwd: spec.cwd,
        env: { ...spec.env },
        shell: false,
        detached: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (error) {
      reject(error);
      return;
    }
    state.active = child;
    const stdout = [];
    const stderr = [];
    let outputBytes = 0;
    let outputOverflow = false;
    let settled = false;
    let timedOut = false;
    let timer;
    const capture = (target) => (chunk) => {
      outputBytes += chunk.length;
      if (outputBytes > MAX_OUTPUT) {
        outputOverflow = true;
        child.stdin.end();
        signalGroup(child.pid, 'SIGTERM');
        return;
      }
      target.push(Buffer.from(chunk));
    };
    child.stdout.on('data', capture(stdout));
    child.stderr.on('data', capture(stderr));
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      state.active = null;
      reject(error);
    });
    timer = setTimeout(async () => {
      if (settled) return;
      timedOut = true;
      child.stdin.end();
      signalGroup(child.pid, 'SIGTERM');
      await wait(5_000);
      if (processGroupExists(child.pid)) signalGroup(child.pid, 'SIGKILL');
      await wait(5_000);
      if (!settled) {
        settled = true;
        state.active = null;
        reject(new Error(`child deadline expired and settlement did not finish: ${spec.executable}`));
      }
    }, spec.timeoutMs);
    child.on('close', async (status, signal) => {
      if (settled) return;
      clearTimeout(timer);
      if (processGroupExists(child.pid)) {
        signalGroup(child.pid, 'SIGTERM');
        await wait(5_000);
        if (processGroupExists(child.pid)) signalGroup(child.pid, 'SIGKILL');
        await wait(5_000);
      }
      const pgidAbsent = !processGroupExists(child.pid);
      settled = true;
      state.active = null;
      resolve({
        status,
        signal,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
        timedOut,
        outputOverflow,
        pgidAbsent,
        pid: child.pid,
      });
    });
  });
}

function createProductionDeps() {
  const state = { active: null };
  return {
    now: () => Date.now(),
    authenticate: async ({ input, verifierPath, cloneRoot, expectedNodeVersion }) => {
      const executableChecks = [input.nodeBin, input.npmBin, input.gitBin];
      if (await realpath(process.execPath) !== input.nodeBin || process.version !== expectedNodeVersion) {
        fail('running Node identity/version differs from the authenticated NODE');
      }
      for (const path of executableChecks) {
        const info = await lstat(path);
        if (!info.isFile() || info.isSymbolicLink() || await realpath(path) !== path) fail(`tool is not a canonical regular nonsymlink file: ${path}`);
        await access(path, fsConstants.X_OK);
      }
      if (await realpath(verifierPath) !== verifierPath || verifierPath !== join(cloneRoot, 'tools/fresh-clone-verifier.mjs')) {
        fail('running verifier is not the authenticated absolute sibling');
      }
      if (await realpath(process.cwd()) !== cloneRoot || process.cwd() !== cloneRoot) fail('physical cwd differs from authenticated clone root');
      for (const path of [input.sandboxHome, join(input.sandboxHome, 'tmp')]) {
        const info = await lstat(path);
        const mode = info.mode & 0o777;
        if (!info.isDirectory() || info.isSymbolicLink() || await realpath(path) !== path || info.uid !== process.getuid() || mode !== 0o700) {
          fail(`sandbox directory is not caller-owned canonical mode-0700: ${path}`);
        }
      }
    },
    spawnStep: (spec) => spawnManaged(spec, state),
    settleActiveChild: async () => {
      if (!state.active) return;
      state.active.stdin.end();
      signalGroup(state.active.pid, 'SIGTERM');
      await wait(5_000);
      if (processGroupExists(state.active.pid)) signalGroup(state.active.pid, 'SIGKILL');
      await wait(5_000);
      if (processGroupExists(state.active.pid)) fail('active child group survived cleanup settlement');
    },
    createOwnedTemp: async (parent) => {
      const created = await mkdir(parent, { recursive: true, mode: 0o700 });
      const parentInfo = await lstat(parent);
      if (!parentInfo.isDirectory() || parentInfo.isSymbolicLink() || await realpath(parent) !== parent || parentInfo.uid !== process.getuid()) {
        fail('acceptance-temp parent is not a caller-owned canonical directory');
      }
      if (created !== undefined) await chmod(parent, 0o700);
      else if ((parentInfo.mode & 0o777) !== 0o700) fail('existing acceptance-temp parent must have mode 0700');
      const root = await mkdtemp(join(parent, 'run-'));
      await chmod(root, 0o700);
      if (await realpath(root) !== root) fail('owned temporary root is not canonical');
      return root;
    },
    authenticateHelper: async (path) => {
      const info = await lstat(path);
      if (!info.isFile() || info.isSymbolicLink() || await realpath(path) !== path) fail('cleanup helper is not an authenticated regular nonsymlink sibling');
    },
    assertPathAbsent: async (path) => {
      try {
        await lstat(path);
      } catch (error) {
        if (error?.code === 'ENOENT') return;
        throw error;
      }
      fail(`owned temporary root survived cleanup: ${path}`);
    },
    assertGroupAbsent: async (pid) => {
      if (processGroupExists(pid)) fail(`cleanup process group ${pid} survived reap`);
    },
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runFreshClone(process.argv.slice(2)).then(
    () => process.stdout.write('fresh-clone acceptance OK\n'),
    (error) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    },
  );
}
