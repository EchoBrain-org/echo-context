import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
// @ts-expect-error the committed production state machine intentionally remains plain .mjs.
import { LIMITS, buildEnvironment, createProductionDeps, parseInvocation, raceUntil, runBoundedOperation, runFreshClone } from '../../tools/fresh-clone-verifier.mjs';
// @ts-expect-error the committed cleanup child intentionally remains plain .mjs.
import { runCleanup } from '../../tools/fresh-clone-cleanup.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const WRAPPER = join(ROOT, 'tools', 'fresh-clone-acceptance.sh');
const VERIFIER = join(ROOT, 'tools', 'fresh-clone-verifier.mjs');
const CLEANUP = join(ROOT, 'tools', 'fresh-clone-cleanup.mjs');
const S = '1234567890abcdef1234567890abcdef12345678';
const H = 'a'.repeat(64);
const INPUT = {
  nodeBin: '/opt/echo-node/bin/node',
  npmBin: '/opt/echo-npm/bin/npm-cli.js',
  gitBin: '/opt/echo-git/bin/git',
  gitVersion: '2.37.3',
  sandboxHome: '/tmp/echo-context-acceptance-home',
  sourceSha: S,
};
const ARGS = [
  '--node-bin', INPUT.nodeBin,
  '--npm-bin', INPUT.npmBin,
  '--git-bin', INPUT.gitBin,
  '--git-version', INPUT.gitVersion,
  '--sandbox-home', INPUT.sandboxHome,
  '--mode=source', '--source-sha', S,
];
const OWNED = join(ROOT, '.fresh-clone-acceptance', 'run-fixture');
const PREFIX = 'echo-context-0.1.0-dev.136.1-source';

type SpawnSpec = {
  executable: string;
  argv: string[];
  cwd: string;
  env: Record<string, string>;
  shell: boolean;
  detached: boolean;
  timeoutMs: number;
  settlementMs: number;
  cancellation?: CancellationFixture;
};

type CancellationFixture = {
  readonly cancelled: boolean;
  subscribe: (listener: (reason: string) => void) => () => void;
  throwIfCancelled: () => void;
  dispose: () => void;
  cancel: (reason?: string) => void;
};

type FixtureOptions = {
  spawn?: (spec: SpawnSpec, index: number) => Promise<Record<string, unknown>> | Record<string, unknown>;
  authenticate?: () => Promise<void> | void;
  createOwnedTemp?: (recordOwnedRoot: (root: string) => void) => string;
  settleActiveChild?: () => Promise<void> | void;
  authenticateHelper?: () => Promise<void> | void;
  assertGroupAbsent?: () => Promise<void> | void;
  assertPathAbsent?: () => Promise<void> | void;
  now?: () => number;
  runBounded?: (spec: Record<string, unknown>, operation: () => unknown) => Promise<unknown>;
  raceUntil?: (spec: Record<string, unknown>) => Promise<Record<string, unknown>>;
  cancelStep?: (spec: SpawnSpec, index: number, reason: string) => Promise<Record<string, unknown>> | Record<string, unknown>;
  cancellation?: CancellationFixture;
};

function cancellationFixture(): CancellationFixture {
  let cancelled = false;
  let reason = 'fixture';
  const listeners = new Set<(value: string) => void>();
  return {
    get cancelled() { return cancelled; },
    subscribe(listener) {
      if (cancelled) listener(reason);
      else listeners.add(listener);
      return () => listeners.delete(listener);
    },
    throwIfCancelled() {
      if (cancelled) throw new Error(`fixture cancellation: ${reason}`);
    },
    dispose() { listeners.clear(); },
    cancel(value = 'fixture') {
      if (cancelled) return;
      cancelled = true;
      reason = value;
      for (const listener of [...listeners]) listener(reason);
    },
  };
}

function successResult(spec: SpawnSpec, pid: number): Record<string, unknown> {
  let stdout = '';
  if (spec.executable === INPUT.npmBin && spec.argv.join('\0') === '--version') stdout = '10.9.4\n';
  if (spec.executable === INPUT.gitBin && spec.argv.join('\0') === '--version') stdout = `git version ${INPUT.gitVersion}\n`;
  if (spec.executable === INPUT.gitBin && spec.argv.join('\0') === 'rev-parse\0HEAD') stdout = `${S}\n`;
  if (spec.executable === INPUT.npmBin && spec.argv[0] === 'run' && spec.argv[1] === 'build:artifact') {
    stdout = `source archive built\nmanifest_hash=${H}\n`;
  }
  return {
    terminal: true,
    directExited: true,
    stdoutClosed: true,
    stderrClosed: true,
    status: 0,
    signal: null,
    stdout,
    stderr: '',
    outputOverflow: false,
    pgidAbsent: true,
    pid,
    lifecycleError: null,
  };
}

function fixture(options: FixtureOptions = {}) {
  const events: string[] = [];
  const spawns: SpawnSpec[] = [];
  const cancellation = options.cancellation ?? cancellationFixture();
  let active: { completion: Promise<Record<string, unknown>>; cancelAndSettle: (reason: string) => Promise<Record<string, unknown>> } | null = null;
  const deps = {
    now: options.now ?? (() => 0),
    createCancellation: () => cancellation,
    runBounded: options.runBounded ?? (async (_spec: Record<string, unknown>, operation: () => unknown) => operation()),
    raceUntil: options.raceUntil ?? ((spec: Record<string, unknown>) => raceUntil({
      completion: spec.completion as Promise<unknown>,
      deadline: Number(spec.deadline),
      now: options.now ?? (() => 0),
      cancellation: spec.cancellation,
    })),
    authenticate: async () => {
      events.push('authenticate');
      await options.authenticate?.();
    },
    startStep: (spec: SpawnSpec) => {
      events.push(`spawn:${spec.executable}:${spec.argv.join(' ')}`);
      const recorded = { ...spec, argv: [...spec.argv], env: { ...spec.env } };
      delete recorded.cancellation;
      spawns.push(recorded);
      const index = spawns.length - 1;
      const produced = options.spawn ? options.spawn(spec, index) : successResult(spec, 1000 + spawns.length);
      const completion = Promise.resolve(produced);
      let cancellationPromise: Promise<Record<string, unknown>> | null = null;
      const handle = {
        completion,
        cancelAndSettle: (reason: string) => {
          if (!cancellationPromise) {
            events.push(`cancel-step:${reason}`);
            cancellationPromise = Promise.resolve(options.cancelStep
              ? options.cancelStep(spec, index, reason)
              : successResult(spec, 10_000 + index));
            cancellationPromise.then((result) => {
              if (result.terminal === true && result.pgidAbsent === true && active === handle) active = null;
            }, () => {});
          }
          return cancellationPromise;
        },
      };
      active = handle;
      completion.then((result) => {
        if (result.terminal === true && result.pgidAbsent === true && active === handle) active = null;
      }, () => {});
      return handle;
    },
    settleActiveChild: async () => {
      events.push('settle-active-child');
      await options.settleActiveChild?.();
      if (active) return active.cancelAndSettle('cleanup-transition');
      return null;
    },
    createOwnedTemp: (parent: string, recordOwnedRoot: (root: string) => void) => {
      events.push(`create-owned-temp:${parent}`);
      if (options.createOwnedTemp) return options.createOwnedTemp(recordOwnedRoot);
      recordOwnedRoot(OWNED);
      return OWNED;
    },
    authenticateHelper: async (path: string) => {
      events.push(`authenticate-helper:${path}`);
      await options.authenticateHelper?.();
    },
    assertGroupAbsent: async (pid: number) => {
      events.push(`assert-group-absent:${pid}`);
      await options.assertGroupAbsent?.();
    },
    assertPathAbsent: async (path: string) => {
      events.push(`assert-path-absent:${path}`);
      await options.assertPathAbsent?.();
    },
  };
  return { deps, events, spawns, cancellation };
}

function shortRace(spec: Record<string, unknown>) {
  return raceUntil({
    completion: spec.completion as Promise<unknown>,
    deadline: Date.now() + 20,
    now: () => Date.now(),
    cancellation: spec.cancellation,
  });
}

function shortRead(spec: Record<string, unknown>, operation: () => unknown) {
  return runBoundedOperation({
    ...spec,
    effect: 'read_only',
    label: String(spec.label),
    deadline: Date.now() + 20,
    now: () => Date.now(),
  }, operation);
}

function independentOracle(): Array<[string, string[]]> {
  const archive = join(OWNED, `${PREFIX}.tgz`);
  const checksum = join(OWNED, `${PREFIX}.tgz.sha256`);
  const manifest = join(OWNED, `${PREFIX}.manifest.json`);
  return [
    [INPUT.npmBin, ['--version']],
    [INPUT.gitBin, ['--version']],
    [INPUT.gitBin, ['status', '--porcelain=v1', '--untracked-files=all']],
    [INPUT.gitBin, ['rev-parse', 'HEAD']],
    [INPUT.npmBin, ['ci']],
    [INPUT.gitBin, ['status', '--porcelain=v1', '--untracked-files=all']],
    [INPUT.gitBin, ['rev-parse', 'HEAD']],
    [INPUT.npmBin, ['run', 'typecheck']],
    [INPUT.npmBin, ['run', 'lint']],
    [INPUT.npmBin, ['run', 'test:ci']],
    [INPUT.npmBin, ['run', 'verify:inventory']],
    [INPUT.npmBin, ['run', 'verify:authority']],
    [INPUT.npmBin, ['run', 'build:artifact', '--', '--source-sha', S, '--out', OWNED]],
    [INPUT.npmBin, ['run', 'verify:artifact', '--', '--archive', archive, '--checksum', checksum, '--manifest', manifest, '--expected-manifest-hash', H]],
    [INPUT.gitBin, ['fsck', '--full']],
    [INPUT.npmBin, ['run', 'scan:secrets']],
    [INPUT.nodeBin, [CLEANUP, '--owned-root', OWNED]],
    [INPUT.gitBin, ['status', '--porcelain=v1', '--untracked-files=all']],
    [INPUT.gitBin, ['rev-parse', 'HEAD']],
  ];
}

afterEach(() => {
  delete process.env.ECHO_ACCEPTANCE_POISON;
});

describe('AC3 — source-only fresh-clone production state machine', () => {
  it('runs the exact literal child oracle with a scrubbed environment and fixed limits', async () => {
    process.env.ECHO_ACCEPTANCE_POISON = 'must-not-cross';
    const { deps, events, spawns } = fixture();
    await expect(runFreshClone(ARGS, deps)).resolves.toEqual({ sourceSha: S, manifestHash: H, cleanupState: 'completed', steps: 17 });

    expect(events[0]).toBe('authenticate');
    expect(spawns.map((spec) => [spec.executable, spec.argv])).toEqual(independentOracle());
    expect(spawns.every((spec) => spec.cwd === ROOT && spec.shell === false && spec.detached === true && spec.settlementMs === 10_000)).toBe(true);
    const expectedEnv = buildEnvironment(parseInvocation(ARGS));
    expect(spawns.every((spec) => JSON.stringify(spec.env) === JSON.stringify(expectedEnv))).toBe(true);
    expect(spawns.some((spec) => Object.hasOwn(spec.env, 'ECHO_ACCEPTANCE_POISON'))).toBe(false);
    expect(spawns.filter((spec) => spec.argv[0] === 'status')).toHaveLength(3);
    expect(spawns.filter((spec) => spec.argv[0] === 'rev-parse')).toHaveLength(3);
    expect(spawns.filter((spec) => spec.argv[1] === 'build:artifact')).toHaveLength(1);
    expect(spawns.filter((spec) => spec.argv[1] === 'verify:artifact')).toHaveLength(1);
    expect(spawns.find((spec) => spec.argv.join(' ') === 'ci')?.timeoutMs).toBe(600_000);
    expect(spawns.find((spec) => spec.argv.join(' ') === 'run test:ci')?.timeoutMs).toBe(900_000);
    expect(spawns.find((spec) => spec.argv.join(' ') === 'run scan:secrets')?.timeoutMs).toBe(900_000);
    expect(spawns.find((spec) => spec.executable === INPUT.nodeBin)?.timeoutMs).toBe(30_000);
    expect(LIMITS).toMatchObject({ aggregate: 3_700_000, reserve: 120_000, settlement: 10_000, cleanup: 30_000 });
  });

  it('accepts only the exact fixed prefix and source mode', () => {
    expect(parseInvocation(ARGS)).toEqual(INPUT);
    expect(() => parseInvocation([...ARGS.slice(0, 10), '--mode=release', '--source-sha', S])).toThrow(/sole accepted mode/);
    expect(() => parseInvocation([...ARGS, '--source-sha', S])).toThrow(/usage/);
    expect(() => parseInvocation([...ARGS.slice(0, 12), 'ABC'])).toThrow(/full lowercase Git OID/);
  });

  it('authenticates before every child and fails closed when identity consumes the prefinal window', async () => {
    let clock = 0;
    const { deps, spawns } = fixture({
      now: () => clock,
      authenticate: () => { clock = LIMITS.aggregate - LIMITS.reserve + 1; },
    });
    await expect(runFreshClone(ARGS, deps)).rejects.toThrow(/identity authentication crossed its deadline/);
    expect(spawns).toEqual([]);
  });

  it('rejects carrier tampering and performs exactly one terminal cleanup attempt', async () => {
    const { deps, events, spawns } = fixture({
      spawn: (spec, index) => {
        const result = successResult(spec, 2000 + index);
        if (spec.argv[1] === 'build:artifact') result.stdout = `manifest_hash=${H}\nextra\n`;
        return result;
      },
    });
    await expect(runFreshClone(ARGS, deps)).rejects.toThrow(/manifest_hash carrier/);
    expect(spawns.filter((spec) => spec.executable === INPUT.nodeBin)).toHaveLength(1);
    expect(events.filter((event) => event === 'settle-active-child')).toHaveLength(1);
  });

  it('marks a pre-helper cleanup failure terminal and preserves the primary error', async () => {
    const { deps, events, spawns } = fixture({
      spawn: (spec, index) => {
        if (spec.argv[1] === 'build:artifact') throw new Error('primary-build-failure');
        return successResult(spec, 3000 + index);
      },
      settleActiveChild: () => { throw new Error('cleanup-settlement-failure'); },
    });
    let thrown: (Error & { cleanupFailure?: string }) | undefined;
    try {
      await runFreshClone(ARGS, deps);
    } catch (error) {
      thrown = error as Error & { cleanupFailure?: string };
    }
    expect(thrown?.message).toContain('primary-build-failure');
    expect(thrown?.cleanupFailure).toContain('cleanup-settlement-failure');
    expect(events.filter((event) => event === 'settle-active-child')).toHaveLength(1);
    expect(events.some((event) => event.startsWith('authenticate-helper:'))).toBe(false);
    expect(spawns.filter((spec) => spec.executable === INPUT.nodeBin)).toHaveLength(0);
  });

  it('does not respawn cleanup after helper, PGID, absence, or final-boundary failure', async () => {
    for (const failure of ['helper', 'pgid', 'absence', 'final'] as const) {
      let finalStatus = 0;
      const { deps, spawns } = fixture({
        authenticateHelper: failure === 'helper' ? () => { throw new Error('helper-failed'); } : undefined,
        assertGroupAbsent: failure === 'pgid' ? () => { throw new Error('pgid-survived'); } : undefined,
        assertPathAbsent: failure === 'absence' ? () => { throw new Error('root-survived'); } : undefined,
        spawn: (spec, index) => {
          if (spec.argv[0] === 'status') {
            finalStatus += 1;
            if (failure === 'final' && finalStatus === 3) return { ...successResult(spec, 4000 + index), status: 1 };
          }
          return successResult(spec, 4000 + index);
        },
      });
      await expect(runFreshClone(ARGS, deps)).rejects.toThrow();
      const cleanupSpawns = spawns.filter((spec) => spec.executable === INPUT.nodeBin);
      expect(cleanupSpawns).toHaveLength(failure === 'helper' ? 0 : 1);
    }
  });

  it('rejects an unsettled process group before advancing', async () => {
    const { deps, spawns } = fixture({
      spawn: (spec, index) => {
        const result = successResult(spec, 5000 + index);
        if (spec.argv.join(' ') === 'run typecheck') result.pgidAbsent = false;
        return result;
      },
    });
    await expect(runFreshClone(ARGS, deps)).rejects.toThrow(/nonterminal record/);
    expect(spawns.some((spec) => spec.argv.join(' ') === 'run lint')).toBe(false);
  });

  it.each(['after-mkdtemp', 'after-chmod', 'after-realpath'])('records a partial T %s and performs exactly one cleanup plus ENOENT readback', async (stage) => {
    let absenceReads = 0;
    const parent = dirname(OWNED);
    const production = createProductionDeps({
      fs: {
        mkdirSync: () => undefined,
        lstatSync: () => ({
          isDirectory: () => true,
          isSymbolicLink: () => false,
          mode: 0o700,
          uid: process.getuid?.() ?? 0,
        }),
        realpathSync: (path: string) => {
          if (path === parent) return parent;
          if (stage === 'after-chmod') throw new Error('injected-after-chmod');
          if (stage === 'after-realpath') return `${path}-drift`;
          return path;
        },
        mkdtempSync: () => OWNED,
        chmodSync: (path: string) => {
          if (path === OWNED && stage === 'after-mkdtemp') throw new Error('injected-after-mkdtemp');
        },
      },
    });
    const { deps, events, spawns } = fixture({
      createOwnedTemp: (recordOwnedRoot) => production.createOwnedTemp(parent, recordOwnedRoot),
      assertPathAbsent: () => { absenceReads += 1; },
    });
    await expect(runFreshClone(ARGS, deps)).rejects.toThrow(stage === 'after-realpath' ? /not canonical/ : `injected-${stage}`);
    expect(spawns.filter((spec) => spec.executable === INPUT.nodeBin)).toHaveLength(1);
    expect(events.filter((event) => event === 'settle-active-child')).toHaveLength(1);
    expect(absenceReads).toBe(1);
  });

  it('blocks helper authentication and cleanup when a post-T child group permanently survives', async () => {
    const { deps, events, spawns } = fixture({
      spawn: (spec, index) => {
        const result = successResult(spec, 6000 + index);
        if (spec.argv[1] === 'build:artifact') result.pgidAbsent = false;
        return result;
      },
      cancelStep: () => { throw new Error('permanent-process-group-survivor'); },
      settleActiveChild: () => { throw new Error('permanent-process-group-survivor'); },
    });
    let thrown: (Error & { cleanupFailure?: string }) | undefined;
    try {
      await runFreshClone(ARGS, deps);
    } catch (error) {
      thrown = error as Error & { cleanupFailure?: string };
    }
    expect(thrown?.message).toContain('cancellation failed to prove');
    expect(thrown?.cleanupFailure).toContain('permanent-process-group-survivor');
    expect(events.filter((event) => event === 'settle-active-child')).toHaveLength(1);
    expect(events.some((event) => event.startsWith('authenticate-helper:'))).toBe(false);
    expect(spawns.filter((spec) => spec.executable === INPUT.nodeBin)).toHaveLength(0);
  });

  it('injects cancellation after T, settles before the sole cleanup child, and never advances the interrupted trace', async () => {
    const cancellation = cancellationFixture();
    const { deps, events, spawns } = fixture({
      cancellation,
      spawn: (spec, index) => {
        if (spec.argv.join(' ') === 'run scan:secrets') cancellation.cancel('injected-cancel');
        return successResult(spec, 7000 + index);
      },
    });
    await expect(runFreshClone(ARGS, deps)).rejects.toThrow(/cancel/);
    const settle = events.indexOf('settle-active-child');
    const helper = events.findIndex((event) => event.startsWith('authenticate-helper:'));
    expect(settle).toBeGreaterThan(-1);
    expect(helper).toBeGreaterThan(settle);
    expect(spawns.filter((spec) => spec.executable === INPUT.nodeBin)).toHaveLength(1);
    expect(spawns.filter((spec) => spec.argv[0] === 'status')).toHaveLength(2);
  });

  it('makes a cleanup-child timeout terminal and does not run a final boundary', async () => {
    const { deps, spawns } = fixture({
      spawn: (spec, index) => spec.executable === INPUT.nodeBin
        ? { ...successResult(spec, 8000 + index), lifecycleError: new Error('cleanup-timeout') }
        : successResult(spec, 8000 + index),
    });
    await expect(runFreshClone(ARGS, deps)).rejects.toThrow(/failed or did not settle/);
    expect(spawns.filter((spec) => spec.executable === INPUT.nodeBin)).toHaveLength(1);
    expect(spawns.filter((spec) => spec.argv[0] === 'status')).toHaveLength(2);
  });

  it('gives final status and final HEAD separate consecutive 40-second envelopes', async () => {
    let clock = 0;
    let statuses = 0;
    const { deps, spawns } = fixture({
      now: () => clock,
      spawn: (spec, index) => {
        if (spec.argv[0] === 'status') {
          statuses += 1;
          if (statuses === 3) return Promise.resolve().then(() => {
            clock = LIMITS.finalEnvelope - LIMITS.settlement + 1;
            return successResult(spec, 9000 + index);
          });
        }
        return successResult(spec, 9000 + index);
      },
    });
    await expect(runFreshClone(ARGS, deps)).resolves.toMatchObject({ cleanupState: 'completed' });
    expect(spawns.filter((spec) => spec.argv[0] === 'status')).toHaveLength(3);
    expect(spawns.filter((spec) => spec.argv.join(' ') === 'rev-parse HEAD')).toHaveLength(3);
  });

  it('bounds a never-resolving injected filesystem authentication promise', async () => {
    const { deps, spawns } = fixture({
      now: () => Date.now(),
      authenticate: () => new Promise<void>(() => {}),
      runBounded: (spec, operation) => runBoundedOperation({
        ...spec,
        label: String(spec.label),
        deadline: Math.min(Number(spec.deadline), Date.now() + 20),
        now: () => Date.now(),
      }, operation),
    });
    await expect(runFreshClone(ARGS, deps)).rejects.toThrow(/deadline expired/);
    expect(spawns).toEqual([]);
  });

  it.each(['active settlement', 'helper authentication', 'cleanup child', 'path absence'])('bounds never-settling cleanup surface: %s', async (surface) => {
    const never = () => new Promise<void>(() => {});
    const { deps, events, spawns } = fixture({
      raceUntil: shortRace,
      runBounded: shortRead,
      settleActiveChild: surface === 'active settlement' ? never : undefined,
      authenticateHelper: surface === 'helper authentication' ? never : undefined,
      assertPathAbsent: surface === 'path absence' ? never : undefined,
      spawn: (spec, index) => surface === 'cleanup child' && spec.executable === INPUT.nodeBin
        ? new Promise<Record<string, unknown>>(() => {})
        : successResult(spec, 11_000 + index),
    });
    await expect(runFreshClone(ARGS, deps)).rejects.toThrow(/deadline|envelope|execution/);
    const cleanupSpawns = spawns.filter((spec) => spec.executable === INPUT.nodeBin);
    expect(cleanupSpawns).toHaveLength(surface === 'active settlement' || surface === 'helper authentication' ? 0 : 1);
    expect(spawns.filter((spec) => spec.argv[0] === 'status')).toHaveLength(2);
    if (surface === 'active settlement') expect(events.some((event) => event.startsWith('authenticate-helper:'))).toBe(false);
  });

  it('bounds a never-resolving final HEAD and performs no later child', async () => {
    let heads = 0;
    const { deps, spawns } = fixture({
      raceUntil: shortRace,
      spawn: (spec, index) => {
        if (spec.argv.join(' ') === 'rev-parse HEAD') {
          heads += 1;
          if (heads === 3) return new Promise<Record<string, unknown>>(() => {});
        }
        return successResult(spec, 12_000 + index);
      },
    });
    await expect(runFreshClone(ARGS, deps)).rejects.toThrow(/execution deadline/);
    expect(spawns.at(-1)?.argv).toEqual(['rev-parse', 'HEAD']);
    expect(heads).toBe(3);
  });

  it('caps all consecutive final envelopes at the original aggregate deadline', async () => {
    let clock = 0;
    let statuses = 0;
    const { deps, spawns } = fixture({
      now: () => clock,
      spawn: (spec, index) => {
        if (spec.argv[0] === 'status') {
          statuses += 1;
          if (statuses === 3) return Promise.resolve().then(() => {
            clock = LIMITS.aggregate - 5_000;
            return successResult(spec, 13_000 + index);
          });
        }
        return successResult(spec, 13_000 + index);
      },
    });
    await expect(runFreshClone(ARGS, deps)).rejects.toThrow(/execution boundary expired/);
    expect(spawns.filter((spec) => spec.argv.join(' ') === 'rev-parse HEAD')).toHaveLength(2);
    expect(clock).toBeLessThanOrEqual(LIMITS.aggregate);
  });

  it('rejects an unclassified Promise seam before it can start or mutate later', async () => {
    let started = false;
    let mutated = false;
    await expect(runBoundedOperation({ label: 'late', deadline: Date.now() + 5, now: () => Date.now() }, () => {
      started = true;
      return new Promise((resolve) => setTimeout(() => { mutated = true; resolve(undefined); }, 30));
    })).rejects.toThrow(/explicitly read_only/);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(started).toBe(false);
    expect(mutated).toBe(false);
  });

  it('starts the aggregate clock before parsing even a rejected invocation', async () => {
    let clockReads = 0;
    const { deps } = fixture({ now: () => { clockReads += 1; return 0; } });
    await expect(runFreshClone(['--invalid'], deps)).rejects.toThrow(/usage/);
    expect(clockReads).toBe(1);
  });

  it('runs cancellation through TERM, exact grace, conditional KILL, and terminal stream/PGID settlement', async () => {
    const signals: string[] = [];
    const delays: number[] = [];
    const cancellation = cancellationFixture();
    const readinessDirectory = realpathSync(mkdtempSync(join(tmpdir(), 'echo-context-term-ready-')));
    const readinessFile = join(readinessDirectory, 'ready');
    const deps = createProductionDeps({
      delay: async (milliseconds: number) => { delays.push(milliseconds); },
      pollDelay: (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, Math.min(milliseconds, 5))),
      signalGroup: (pid: number, signal: NodeJS.Signals) => {
        signals.push(signal);
        try {
          process.kill(-pid, signal);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
        }
      },
    });
    const child = deps.startStep({
      executable: process.execPath,
      argv: ['--eval', `const {writeFileSync}=require('node:fs'); process.on('SIGTERM',()=>{}); writeFileSync(${JSON.stringify(readinessFile)},'ready'); setInterval(()=>{},1000)`],
      cwd: ROOT,
      env: { ...process.env },
      shell: false,
      detached: true,
      timeoutMs: 30_000,
      settlementMs: LIMITS.settlement,
      cancellation,
    });
    try {
      const readinessDeadline = Date.now() + 5_000;
      while (!existsSync(readinessFile) && Date.now() < readinessDeadline) await new Promise((resolve) => setTimeout(resolve, 10));
      expect(existsSync(readinessFile)).toBe(true);
      cancellation.cancel('fixture-cancel');
      await expect(child.cancelAndSettle('fixture-cancel')).resolves.toMatchObject({ terminal: true, pgidAbsent: true });
      await expect(child.completion).resolves.toMatchObject({ terminal: true, pgidAbsent: true });
      expect(deps.settleActiveChild()).toBeNull();
      expect(signals).toEqual(['SIGTERM', 'SIGKILL']);
      expect(delays).toEqual([LIMITS.terminationGrace]);
    } finally {
      await child.cancelAndSettle('fixture-finally').catch(() => {});
      rmSync(readinessDirectory, { recursive: true, force: true });
    }
  });
});

describe('AC3 — wrapper and cleanup boundaries', () => {
  it('keeps module evaluation side-effect-free in a fresh process', () => {
    const directory = mkdtempSync(join(tmpdir(), 'echo-context-import-'));
    const sentinel = join(directory, 'sentinel');
    writeFileSync(sentinel, 'unchanged');
    try {
      const script = `await import(${JSON.stringify(pathToFileURL(VERIFIER).href)}); await import(${JSON.stringify(pathToFileURL(CLEANUP).href)});`;
      const result = spawnSync(process.execPath, ['--input-type=module', '--eval', script], {
        cwd: directory,
        encoding: 'utf8',
        env: { ...process.env, ECHO_IMPORT_SENTINEL: sentinel },
      });
      expect(result.status).toBe(0);
      expect(result.stdout).toBe('');
      expect(result.stderr).toBe('');
      expect(readFileSync(sentinel, 'utf8')).toBe('unchanged');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('uses one env-scrubbed exec and rejects relative, wrong-cwd, and symlink entrypoints before Node', () => {
    const source = readFileSync(WRAPPER, 'utf8');
    expect(source.match(/\bexec\b/gu)).toHaveLength(1);
    expect(source).toContain('exec /usr/bin/env -i');
    for (const name of ['HOME', 'TMPDIR', 'PATH', 'LANG', 'LC_ALL', 'TZ', 'CI', 'GIT_CONFIG_NOSYSTEM', 'GIT_CONFIG_GLOBAL', 'GIT_TERMINAL_PROMPT', 'NPM_CONFIG_USERCONFIG', 'NPM_CONFIG_CACHE']) {
      expect(source).toContain(`${name}=`);
    }
    expect(source).not.toMatch(/\beval\b/u);

    const relative = spawnSync('tools/fresh-clone-acceptance.sh', [], { cwd: ROOT, encoding: 'utf8' });
    expect(relative.status).toBe(2);
    expect(relative.stderr).toContain('canonical absolute path');

    const directory = mkdtempSync(join(tmpdir(), 'echo-context-wrapper-'));
    try {
      const wrongCwd = spawnSync(WRAPPER, [], { cwd: directory, encoding: 'utf8' });
      expect(wrongCwd.status).toBe(2);
      expect(wrongCwd.stderr).toContain('physical cwd');
      const link = join(directory, 'acceptance-link');
      symlinkSync(WRAPPER, link);
      const symlinked = spawnSync(link, [], { cwd: ROOT, encoding: 'utf8' });
      expect(symlinked.status).toBe(2);
      expect(symlinked.stderr).toContain('nonsymlink');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('successfully crosses the scrubbed shell-to-Node boundary with verbatim argv', () => {
    const clone = realpathSync(mkdtempSync(join(tmpdir(), 'echo-context-wrapper-success-')));
    const tools = join(clone, 'tools');
    const home = join(clone, 'home');
    const homeTmp = join(home, 'tmp');
    const fakeNpm = join(clone, 'npm-cli.js');
    const fakeGit = join(clone, 'git');
    mkdirSync(tools);
    mkdirSync(home, { mode: 0o700 });
    mkdirSync(homeTmp, { mode: 0o700 });
    chmodSync(home, 0o700);
    chmodSync(homeTmp, 0o700);
    copyFileSync(WRAPPER, join(tools, 'fresh-clone-acceptance.sh'));
    chmodSync(join(tools, 'fresh-clone-acceptance.sh'), 0o755);
    writeFileSync(fakeNpm, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    writeFileSync(fakeGit, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    writeFileSync(join(tools, 'fresh-clone-verifier.mjs'), "import { writeFileSync } from 'node:fs'; writeFileSync(`${process.env.HOME}/observed.json`, JSON.stringify({ argv: process.argv.slice(2), env: process.env }));\n");
    const node = realpathSync(process.execPath);
    const argv = ['--node-bin', node, '--npm-bin', fakeNpm, '--git-bin', fakeGit, '--git-version', 'fixture', '--sandbox-home', home, '--mode=source', '--source-sha', S];
    try {
      const result = spawnSync(join(tools, 'fresh-clone-acceptance.sh'), argv, {
        cwd: clone,
        encoding: 'utf8',
        env: { ...process.env, ECHO_ACCEPTANCE_POISON: 'must-not-cross' },
      });
      expect(result.status).toBe(0);
      const observed = JSON.parse(readFileSync(join(home, 'observed.json'), 'utf8')) as { argv: string[]; env: Record<string, string> };
      expect(observed.argv).toEqual(argv);
      expect(observed.env.HOME).toBe(home);
      expect(observed.env.TMPDIR).toBe(homeTmp);
      expect(observed.env.ECHO_ACCEPTANCE_POISON).toBeUndefined();
      expect(observed.env.GIT_CONFIG_GLOBAL).toBe('/dev/null');
    } finally {
      rmSync(clone, { recursive: true, force: true });
    }
  });

  it('settles a timer-construction error instead of starting the asynchronous dependency', async () => {
    let started = false;
    await expect(runBoundedOperation({ effect: 'read_only', label: 'timer-fixture', deadline: Date.now() + 100, now: () => Date.now() }, async () => {
      started = true;
    }, {
      setTimeout: () => { throw new Error('timer-construction-failed'); },
      clearTimeout: () => {},
    })).rejects.toThrow(/timer-construction-failed/);
    expect(started).toBe(false);
  });

  it('removes only the authenticated owned run root and preserves a sibling sentinel', async () => {
    const parent = join(ROOT, '.fresh-clone-acceptance');
    mkdirSync(parent, { recursive: true, mode: 0o700 });
    chmodSync(parent, 0o700);
    const owned = mkdtempSync(join(parent, 'run-cleanup-test-'));
    const sentinel = join(parent, `sentinel-${process.pid}`);
    writeFileSync(join(owned, 'artifact'), 'fixture');
    writeFileSync(sentinel, 'preserve');
    try {
      await expect(runCleanup(['--owned-root', owned])).resolves.toBeUndefined();
      expect(existsSync(owned)).toBe(false);
      expect(readFileSync(sentinel, 'utf8')).toBe('preserve');
      await expect(runCleanup(['--owned-root', ROOT])).rejects.toThrow(/outside/);
      expect(existsSync(ROOT)).toBe(true);
    } finally {
      rmSync(owned, { recursive: true, force: true });
      rmSync(sentinel, { force: true });
    }
  });
});
