#!/usr/bin/env node

import { spawn } from 'node:child_process';
import {
  accessSync, chmodSync, constants as fsConstants, lstatSync, mkdirSync, mkdtempSync, realpathSync,
} from 'node:fs';
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
  finalEnvelope: 40_000,
  terminationGrace: 5_000,
  reap: 5_000,
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
  if (kind === 'version') return LIMITS.version;
  if (kind === 'status' || kind === 'head') return LIMITS.boundary;
  if (kind === 'install') return LIMITS.install;
  if (kind === 'long') return LIMITS.long;
  if (kind === 'cleanup') return LIMITS.cleanup;
  return LIMITS.ordinary;
}

function effectiveTimeout(kind, now, executionBoundary) {
  const remaining = executionBoundary - now;
  if (remaining <= 0) fail('aggregate or reserved execution boundary expired');
  return Math.min(classLimit(kind), remaining);
}

function inertCancellation() {
  return Object.freeze({
    cancelled: false,
    subscribe: () => () => {},
    throwIfCancelled: () => {},
    dispose: () => {},
  });
}

function createSignalCancellation() {
  let cancelled = false;
  let reason = null;
  const listeners = new Set();
  const cancel = (signal) => {
    if (cancelled) return;
    cancelled = true;
    reason = signal;
    for (const listener of [...listeners]) listener(signal);
  };
  const onInterrupt = () => cancel('SIGINT');
  const onTerminate = () => cancel('SIGTERM');
  process.on('SIGINT', onInterrupt);
  process.on('SIGTERM', onTerminate);
  return {
    get cancelled() { return cancelled; },
    subscribe(listener) {
      if (cancelled) listener(reason);
      else listeners.add(listener);
      return () => listeners.delete(listener);
    },
    throwIfCancelled() {
      if (cancelled) fail(`acceptance cancelled by ${reason}`);
    },
    dispose() {
      process.removeListener('SIGINT', onInterrupt);
      process.removeListener('SIGTERM', onTerminate);
      listeners.clear();
    },
  };
}

export function runBoundedOperation(spec, operation, timers = {}) {
  if (spec.effect !== 'read_only') {
    return Promise.reject(new Error('fresh-clone-verifier: bounded Promise operations must be explicitly read_only'));
  }
  const now = spec.now ?? Date.now;
  const setTimer = timers.setTimeout ?? setTimeout;
  const clearTimer = timers.clearTimeout ?? clearTimeout;
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer;
    let unsubscribe = () => {};
    const finish = (method, value) => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimer(timer);
      unsubscribe();
      method(value);
    };
    try {
      const remaining = spec.deadline - now();
      if (!Number.isFinite(remaining) || remaining <= 0) {
        finish(reject, new Error(`fresh-clone-verifier: ${spec.label} deadline expired`));
        return;
      }
      timer = setTimer(() => finish(reject, new Error(`fresh-clone-verifier: ${spec.label} deadline expired`)), remaining);
      unsubscribe = spec.cancellation?.subscribe((signal) => finish(reject, new Error(`fresh-clone-verifier: ${spec.label} cancelled by ${signal}`))) ?? (() => {});
      Promise.resolve().then(operation).then(
        (value) => finish(resolve, value),
        (error) => finish(reject, error),
      );
    } catch (error) {
      finish(reject, error);
    }
  });
}

export function raceUntil({ completion, deadline, now = Date.now, cancellation }, timers = {}) {
  const setTimer = timers.setTimeout ?? setTimeout;
  const clearTimer = timers.clearTimeout ?? clearTimeout;
  return new Promise((resolve) => {
    let settled = false;
    let timer;
    let unsubscribe = () => {};
    const finish = (value) => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimer(timer);
      unsubscribe();
      resolve(value);
    };
    const finishCompletion = (value) => {
      if (settled) return;
      try {
        const completedAt = now();
        if (!Number.isFinite(completedAt) || completedAt > deadline) {
          finish({ kind: 'deadline' });
          return;
        }
      } catch (error) {
        finish({ kind: 'timer_error', error });
        return;
      }
      finish(value);
    };
    try {
      if (!completion || typeof completion.then !== 'function') {
        finish({ kind: 'invalid', error: new Error('completion is not a Promise') });
        return;
      }
      const remaining = deadline - now();
      if (!Number.isFinite(remaining) || remaining <= 0) {
        finish({ kind: 'deadline' });
        return;
      }
      timer = setTimer(() => finish({ kind: 'deadline' }), remaining);
      unsubscribe = cancellation?.subscribe((signal) => finish({ kind: 'cancelled', signal })) ?? (() => {});
      Promise.resolve(completion).then(
        (value) => finishCompletion({ kind: 'complete', value }),
        (error) => finishCompletion({ kind: 'error', error }),
      );
    } catch (error) {
      finish({ kind: 'timer_error', error });
    }
  });
}

async function boundedRead(context, label, deadline, operation) {
  context.cancellation.throwIfCancelled();
  const value = await context.deps.runBounded({ effect: 'read_only', label, deadline, cancellation: context.cancellation }, operation);
  if (context.deps.now() > deadline) fail(`${label} crossed its deadline`);
  context.cancellation.throwIfCancelled();
  return value;
}

function isTerminalRecord(value) {
  return value?.terminal === true && value.directExited === true && value.stdoutClosed === true && value.stderrClosed === true && value.pgidAbsent === true;
}

async function runCancellable(context, label, executionEnd, terminalEnd, start) {
  context.cancellation.throwIfCancelled();
  let handle;
  try {
    handle = start();
  } catch (error) {
    throw error;
  }
  if (!handle || typeof handle !== 'object' || !handle.completion || typeof handle.completion.then !== 'function' || typeof handle.cancelAndSettle !== 'function') {
    fail(`${label} adapter did not synchronously return a cancellable single-flight handle`);
  }

  const first = await context.deps.raceUntil({ completion: handle.completion, deadline: executionEnd, cancellation: context.cancellation });
  if (first.kind === 'complete' && isTerminalRecord(first.value)) return first.value;

  const reason = first.kind === 'complete' ? 'nonterminal-completion' : first.kind;
  let settlement;
  try {
    settlement = handle.cancelAndSettle(reason);
  } catch (error) {
    settlement = Promise.reject(error);
  }
  const cancellationEnd = Math.min(terminalEnd, context.deps.now() + LIMITS.settlement);
  const terminal = await context.deps.raceUntil({ completion: settlement, deadline: cancellationEnd, cancellation: null });
  if (terminal.kind !== 'complete' || !isTerminalRecord(terminal.value)) {
    fail(`${label} cancellation failed to prove direct exit, stream closure, and PGID absence`);
  }
  if (first.kind === 'error' || first.kind === 'timer_error' || first.kind === 'invalid') throw first.error;
  if (first.kind === 'cancelled') fail(`${label} cancelled by ${first.signal}`);
  fail(`${label} execution deadline expired or returned a nonterminal record`);
}

function validateResult(result, label) {
  if (!isTerminalRecord(result) || result.status !== 0 || result.signal !== null || result.outputOverflow === true || result.lifecycleError) {
    const detail = `${result?.stdout ?? ''}${result?.stderr ?? ''}`.trim();
    fail(`${label} failed or did not settle${detail ? `: ${detail}` : ''}`);
  }
}

async function execute(step, context, envelopeEnd) {
  context.cancellation.throwIfCancelled();
  const now = context.deps.now();
  const executionEnd = Math.min(now + classLimit(step.kind), envelopeEnd - LIMITS.settlement);
  if (executionEnd <= now) fail('aggregate or reserved execution boundary expired');
  const terminalEnd = Math.min(envelopeEnd, executionEnd + LIMITS.settlement);
  const result = await runCancellable(context, `child ${step.ordinal ?? 'prelude'}`, executionEnd, terminalEnd, () => context.deps.startStep({
    executable: step.executable,
    argv: [...step.argv],
    cwd: context.cloneRoot,
    env: context.env,
    shell: false,
    detached: true,
    timeoutMs: executionEnd - now,
    settlementMs: LIMITS.settlement,
    cancellation: context.cancellation,
  }));
  validateResult(result, `child ${step.ordinal ?? 'prelude'}`);
  context.cancellation.throwIfCancelled();
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
  const deps = injected ?? createProductionDeps();
  // The aggregate clock is deliberately the first evaluated operational read;
  // even argument parsing and clone-root derivation consume this one budget.
  const started = deps.now();
  const aggregateEnd = started + LIMITS.aggregate;
  const prefinalCutoff = aggregateEnd - LIMITS.reserve;
  const input = parseInvocation(argv);
  const verifierPath = fileURLToPath(import.meta.url);
  const cloneRoot = dirname(dirname(verifierPath));
  const cancellation = deps.createCancellation?.() ?? inertCancellation();
  const context = { input, deps, cloneRoot, env: buildEnvironment(input), cancellation };
  const cleanupContext = { ...context, cancellation: inertCancellation() };
  const cleanup = { state: 'unallocated', root: null, pid: null };

  const settleActiveBy = async (deadline) => {
    let completion;
    try {
      completion = Promise.resolve(deps.settleActiveChild());
    } catch (error) {
      throw error;
    }
    const outcome = await deps.raceUntil({ completion, deadline, cancellation: null });
    if (outcome.kind === 'complete') {
      if (outcome.value === null || outcome.value === undefined || isTerminalRecord(outcome.value)) return;
      fail('active-child settlement returned a nonterminal record');
    }
    if (outcome.kind === 'error' || outcome.kind === 'timer_error' || outcome.kind === 'invalid') throw outcome.error;
    fail('active-child settlement exceeded the cleanup envelope');
  };

  const recordOwnedRoot = (root) => {
    if (cleanup.state !== 'unallocated') fail('owned temporary root was assigned more than once');
    // Assignment precedes validation so every post-mkdtemp failure retains the
    // only cleanup authority and cannot strand an unrecorded partial T.
    cleanup.root = root;
    cleanup.state = 'not_started';
    cleanScalar(root, 'owned temporary root', { absolute: true });
  };

  const transitionCleanup = async () => {
    if (cleanup.state === 'unallocated' || cleanup.state !== 'not_started') return;
    cleanup.state = 'running';
    const reserveBoundary = Math.min(aggregateEnd, deps.now() + LIMITS.finalEnvelope);
    try {
      await settleActiveBy(reserveBoundary);
      const helper = join(cloneRoot, 'tools/fresh-clone-cleanup.mjs');
      await boundedRead(cleanupContext, 'cleanup-helper authentication', reserveBoundary, () => deps.authenticateHelper(helper));
      const cleanupStep = sourcePlan(input, cloneRoot, cleanup.root).at(14);
      const result = await execute(cleanupStep, cleanupContext, reserveBoundary);
      if (!Number.isInteger(result.pid) || result.pid <= 0) fail('cleanup child did not return a direct process-group identity');
      cleanup.pid = result.pid;
      await boundedRead(cleanupContext, 'cleanup process-group absence', reserveBoundary, () => deps.assertGroupAbsent(cleanup.pid));
      await boundedRead(cleanupContext, 'owned-root ENOENT readback', reserveBoundary, () => deps.assertPathAbsent(cleanup.root));
      cleanup.state = 'completed';
    } catch (error) {
      cleanup.state = 'failed';
      throw error;
    }
  };

  try {
    await boundedRead(context, 'identity authentication', prefinalCutoff, () => deps.authenticate({ input, verifierPath, cloneRoot, expectedNodeVersion: EXPECTED_NODE_VERSION }));

    const npmVersion = await execute({ executable: input.npmBin, argv: ['--version'], kind: 'version' }, context, prefinalCutoff);
    exactSingleLine(npmVersion.stdout, EXPECTED_NPM_VERSION, 'npm version');
    const gitVersion = await execute({ executable: input.gitBin, argv: ['--version'], kind: 'version' }, context, prefinalCutoff);
    exactSingleLine(gitVersion.stdout, `git version ${input.gitVersion}`, 'git version');

    const placeholder = join(cloneRoot, TEMP_PARENT, 'run-PENDING');
    let plan = sourcePlan(input, cloneRoot, placeholder);
    for (let index = 0; index < 10; index += 1) await execute(plan[index], context, prefinalCutoff);

    cancellation.throwIfCancelled();
    if (deps.now() > prefinalCutoff) fail('temporary-root creation crossed the reserved final window');
    const createdRoot = deps.createOwnedTemp(join(cloneRoot, TEMP_PARENT), recordOwnedRoot);
    if (createdRoot && typeof createdRoot.then === 'function') fail('owned temporary-root adapter must be synchronous and non-thenable');
    if (cleanup.state === 'unallocated') recordOwnedRoot(createdRoot);
    else if (createdRoot !== cleanup.root) fail('owned temporary-root result differs from its immediate record');
    if (deps.now() > prefinalCutoff) fail('temporary-root creation crossed the reserved final window');
    cancellation.throwIfCancelled();

    plan = sourcePlan(input, cloneRoot, cleanup.root);
    const build = await execute(plan[10], context, prefinalCutoff);
    const manifestHash = parseCarrier(build.stdout);
    if (!HASH.test(manifestHash)) fail('manifest carrier is malformed');
    plan = sourcePlan(input, cloneRoot, cleanup.root, manifestHash);
    for (let index = 11; index <= 13; index += 1) await execute(plan[index], context, prefinalCutoff);
    if (deps.now() > prefinalCutoff) fail('prefinal settlement crossed the reserved final window');

    await transitionCleanup();
    if (cleanup.state !== 'completed') fail('cleanup did not reach completed');
    const finalStatusBoundary = Math.min(aggregateEnd, deps.now() + LIMITS.finalEnvelope);
    await execute(plan[15], context, finalStatusBoundary);
    const finalHeadBoundary = Math.min(aggregateEnd, deps.now() + LIMITS.finalEnvelope);
    await execute(plan[16], context, finalHeadBoundary);
    if (deps.now() > aggregateEnd) fail('aggregate 3700-second deadline expired');
    return Object.freeze({ sourceSha: input.sourceSha, manifestHash, cleanupState: cleanup.state, steps: 17 });
  } catch (primary) {
    if (cleanup.state === 'not_started') {
      try {
        await transitionCleanup();
      } catch (cleanupFailure) {
        throw attachCleanupFailure(primary, cleanupFailure);
      }
    }
    throw primary;
  } finally {
    cancellation.dispose?.();
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
  if (!Number.isInteger(pid) || pid <= 0) return;
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if (error?.code !== 'ESRCH') throw error;
  }
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function notify(record) {
  for (const resolve of [...record.waiters]) resolve();
  record.waiters.clear();
}

function processRecordTerminal(record, runtime) {
  return record.directExited && record.stdoutClosed && record.stderrClosed && !runtime.groupExists(record.pid);
}

async function waitForTerminal(record, timeoutMs, runtime) {
  const deadline = runtime.now() + timeoutMs;
  while (!processRecordTerminal(record, runtime)) {
    const remaining = deadline - runtime.now();
    if (remaining <= 0) return false;
    await Promise.race([
      new Promise((resolve) => record.waiters.add(resolve)),
      runtime.pollDelay(Math.min(25, remaining)),
    ]);
  }
  return true;
}

function closeStdin(record) {
  if (record.stdinClosed) return;
  record.stdinClosed = true;
  try {
    record.child.stdin.end();
  } catch (error) {
    record.closeError = error;
  }
}

async function terminateRecord(record, runtime) {
  if (record.termination) return record.termination;
  record.termination = (async () => {
    const errors = [];
    closeStdin(record);
    try {
      runtime.signalGroup(record.pid, 'SIGTERM');
    } catch (error) {
      errors.push(error);
    }
    try {
      await runtime.delay(LIMITS.terminationGrace);
    } catch (error) {
      errors.push(error);
    }
    try {
      if (runtime.groupExists(record.pid)) runtime.signalGroup(record.pid, 'SIGKILL');
    } catch (error) {
      errors.push(error);
    }
    try {
      if (!await waitForTerminal(record, LIMITS.reap, runtime)) errors.push(new Error('direct child, streams, or process group survived settlement'));
    } catch (error) {
      errors.push(error);
    }
    if (record.closeError) errors.push(record.closeError);
    if (errors.length > 0) throw new AggregateError(errors, 'child termination ceremony failed');
  })();
  return record.termination;
}

function startManaged(spec, state, runtime) {
  if (spec.shell !== false || spec.detached !== true) fail('production child must use shell:false and its own process group');
  let child;
  try {
    child = runtime.spawn(spec.executable, spec.argv, {
      cwd: spec.cwd,
      env: { ...spec.env },
      shell: false,
      detached: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (error) {
    throw error;
  }

  const record = {
    child,
    pid: child.pid,
    directExited: false,
    stdoutClosed: false,
    stderrClosed: false,
    stdinClosed: false,
    status: null,
    signal: null,
    stdout: [],
    stderr: [],
    outputBytes: 0,
    outputOverflow: false,
    timedOut: false,
    cancelled: false,
    spawnError: null,
    streamError: null,
    closeError: null,
    termination: null,
    waiters: new Set(),
  };
  let resolveCompletion;
  const completion = new Promise((resolve) => { resolveCompletion = resolve; });
  let pollTimer;
  const result = () => ({
    terminal: processRecordTerminal(record, runtime),
    directExited: record.directExited,
    stdoutClosed: record.stdoutClosed,
    stderrClosed: record.stderrClosed,
    status: record.status,
    signal: record.signal,
    stdout: Buffer.concat(record.stdout).toString('utf8'),
    stderr: Buffer.concat(record.stderr).toString('utf8'),
    outputOverflow: record.outputOverflow,
    pgidAbsent: !runtime.groupExists(record.pid),
    pid: record.pid,
    lifecycleError: record.spawnError ?? record.streamError ?? record.closeError ?? null,
  });
  const completeIfTerminal = () => {
    notify(record);
    if (record.completed || !processRecordTerminal(record, runtime)) return false;
    record.completed = true;
    if (pollTimer !== undefined) runtime.clearTimer(pollTimer);
    if (state.active === handle) state.active = null;
    resolveCompletion(result());
    return true;
  };
  const pollForNaturalGroupExit = () => {
    if (completeIfTerminal() || record.completed || !record.directExited || !record.stdoutClosed || !record.stderrClosed) return;
    try {
      pollTimer = runtime.setTimer(pollForNaturalGroupExit, 25);
    } catch (error) {
      record.streamError = record.streamError ?? error;
    }
  };
  const changed = () => {
    notify(record);
    pollForNaturalGroupExit();
  };
  const capture = (target) => (chunk) => {
    record.outputBytes += chunk.length;
    if (record.outputBytes > MAX_OUTPUT) {
      if (!record.outputOverflow) {
        record.outputOverflow = true;
        queueMicrotask(() => { void handle.cancelAndSettle('output-overflow').catch(() => {}); });
      }
      return;
    }
    target.push(Buffer.from(chunk));
  };
  child.stdout.on('data', capture(record.stdout));
  child.stderr.on('data', capture(record.stderr));
  child.stdout.once('error', (error) => { record.streamError = error; changed(); });
  child.stderr.once('error', (error) => { record.streamError = error; changed(); });
  child.stdout.once('close', () => { record.stdoutClosed = true; changed(); });
  child.stderr.once('close', () => { record.stderrClosed = true; changed(); });
  child.stdin.once('error', (error) => { record.closeError = error; notify(record); });
  child.once('error', (error) => {
    record.spawnError = error;
    if (!Number.isInteger(record.pid)) record.directExited = true;
    changed();
  });
  child.once('exit', (status, signal) => {
    record.status = status;
    record.signal = signal;
    record.directExited = true;
    changed();
  });

  const handle = {
    completion,
    cancelAndSettle(reason) {
      if (record.cancellation) return record.cancellation;
      record.cancellationReason = reason;
      record.cancellation = (async () => {
        let settlementError;
        try {
          await terminateRecord(record, runtime);
        } catch (error) {
          settlementError = error;
        }
        const terminal = processRecordTerminal(record, runtime);
        if (!terminal) throw settlementError ?? new Error('child remained nonterminal after cancellation ceremony');
        if (settlementError) record.streamError = record.streamError ?? settlementError;
        completeIfTerminal();
        return result();
      })();
      return record.cancellation;
    },
  };
  state.active = handle;
  completeIfTerminal();
  return handle;
}

export function createProductionDeps(overrides = {}) {
  const state = { active: null };
  const fs = {
    accessSync, chmodSync, lstatSync, mkdirSync, mkdtempSync, realpathSync,
    ...(overrides.fs ?? {}),
  };
  const runtime = {
    spawn: overrides.spawn ?? spawn,
    now: overrides.now ?? (() => Date.now()),
    setTimer: overrides.setTimer ?? setTimeout,
    clearTimer: overrides.clearTimer ?? clearTimeout,
    delay: overrides.delay ?? wait,
    pollDelay: overrides.pollDelay ?? wait,
    groupExists: overrides.groupExists ?? processGroupExists,
    signalGroup: overrides.signalGroup ?? signalGroup,
  };
  const deps = {
    now: runtime.now,
    createCancellation: overrides.createCancellation ?? createSignalCancellation,
    runBounded: (spec, operation) => runBoundedOperation({ ...spec, now: runtime.now }, operation, runtime),
    raceUntil: (spec) => raceUntil({ ...spec, now: runtime.now }, runtime),
    authenticate: ({ input, verifierPath, cloneRoot, expectedNodeVersion }) => {
      const executableChecks = [input.nodeBin, input.npmBin, input.gitBin];
      if (fs.realpathSync(process.execPath) !== input.nodeBin || process.version !== expectedNodeVersion) {
        fail('running Node identity/version differs from the authenticated NODE');
      }
      for (const path of executableChecks) {
        const info = fs.lstatSync(path);
        if (!info.isFile() || info.isSymbolicLink() || fs.realpathSync(path) !== path) fail(`tool is not a canonical regular nonsymlink file: ${path}`);
        fs.accessSync(path, fsConstants.X_OK);
      }
      if (fs.realpathSync(verifierPath) !== verifierPath || verifierPath !== join(cloneRoot, 'tools/fresh-clone-verifier.mjs')) {
        fail('running verifier is not the authenticated absolute sibling');
      }
      if (fs.realpathSync(process.cwd()) !== cloneRoot || process.cwd() !== cloneRoot) fail('physical cwd differs from authenticated clone root');
      for (const path of [input.sandboxHome, join(input.sandboxHome, 'tmp')]) {
        const info = fs.lstatSync(path);
        const mode = info.mode & 0o777;
        if (!info.isDirectory() || info.isSymbolicLink() || fs.realpathSync(path) !== path || info.uid !== process.getuid() || mode !== 0o700) {
          fail(`sandbox directory is not caller-owned canonical mode-0700: ${path}`);
        }
      }
    },
    startStep: (spec) => startManaged(spec, state, runtime),
    settleActiveChild: () => {
      const handle = state.active;
      if (!handle) return null;
      return handle.cancelAndSettle('cleanup-transition');
    },
    createOwnedTemp: (parent, recordOwnedRoot) => {
      const created = fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
      const parentInfo = fs.lstatSync(parent);
      if (!parentInfo.isDirectory() || parentInfo.isSymbolicLink() || fs.realpathSync(parent) !== parent || parentInfo.uid !== process.getuid()) {
        fail('acceptance-temp parent is not a caller-owned canonical directory');
      }
      if (created !== undefined) fs.chmodSync(parent, 0o700);
      else if ((parentInfo.mode & 0o777) !== 0o700) fail('existing acceptance-temp parent must have mode 0700');
      const root = fs.mkdtempSync(join(parent, 'run-'));
      recordOwnedRoot(root);
      fs.chmodSync(root, 0o700);
      if (fs.realpathSync(root) !== root) fail('owned temporary root is not canonical');
      return root;
    },
    authenticateHelper: (path) => {
      const info = fs.lstatSync(path);
      if (!info.isFile() || info.isSymbolicLink() || fs.realpathSync(path) !== path) fail('cleanup helper is not an authenticated regular nonsymlink sibling');
    },
    assertPathAbsent: (path) => {
      try {
        fs.lstatSync(path);
      } catch (error) {
        if (error?.code === 'ENOENT') return;
        throw error;
      }
      fail(`owned temporary root survived cleanup: ${path}`);
    },
    assertGroupAbsent: (pid) => {
      if (runtime.groupExists(pid)) fail(`cleanup process group ${pid} survived reap`);
    },
  };
  return deps;
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
