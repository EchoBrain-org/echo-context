import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
// @ts-expect-error the committed production state machine intentionally remains plain .mjs.
import { LIMITS, buildEnvironment, parseInvocation, runFreshClone } from '../../tools/fresh-clone-verifier.mjs';
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
};

type FixtureOptions = {
  spawn?: (spec: SpawnSpec, index: number) => Promise<Record<string, unknown>> | Record<string, unknown>;
  authenticate?: () => Promise<void> | void;
  createOwnedTemp?: () => Promise<string> | string;
  settleActiveChild?: () => Promise<void> | void;
  authenticateHelper?: () => Promise<void> | void;
  assertGroupAbsent?: () => Promise<void> | void;
  assertPathAbsent?: () => Promise<void> | void;
  now?: () => number;
};

function successResult(spec: SpawnSpec, pid: number): Record<string, unknown> {
  let stdout = '';
  if (spec.executable === INPUT.npmBin && spec.argv.join('\0') === '--version') stdout = '10.9.4\n';
  if (spec.executable === INPUT.gitBin && spec.argv.join('\0') === '--version') stdout = `git version ${INPUT.gitVersion}\n`;
  if (spec.executable === INPUT.gitBin && spec.argv.join('\0') === 'rev-parse\0HEAD') stdout = `${S}\n`;
  if (spec.executable === INPUT.npmBin && spec.argv[0] === 'run' && spec.argv[1] === 'build:artifact') {
    stdout = `source archive built\nmanifest_hash=${H}\n`;
  }
  return { status: 0, signal: null, stdout, stderr: '', timedOut: false, outputOverflow: false, pgidAbsent: true, pid };
}

function fixture(options: FixtureOptions = {}) {
  const events: string[] = [];
  const spawns: SpawnSpec[] = [];
  const deps = {
    now: options.now ?? (() => 0),
    authenticate: async () => {
      events.push('authenticate');
      await options.authenticate?.();
    },
    spawnStep: async (spec: SpawnSpec) => {
      events.push(`spawn:${spec.executable}:${spec.argv.join(' ')}`);
      spawns.push(structuredClone(spec));
      return options.spawn ? options.spawn(spec, spawns.length - 1) : successResult(spec, 1000 + spawns.length);
    },
    settleActiveChild: async () => {
      events.push('settle-active-child');
      await options.settleActiveChild?.();
    },
    createOwnedTemp: async (parent: string) => {
      events.push(`create-owned-temp:${parent}`);
      return options.createOwnedTemp ? options.createOwnedTemp() : OWNED;
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
  return { deps, events, spawns };
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
    await expect(runFreshClone(ARGS, deps)).rejects.toThrow(/identity checks exhausted/);
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
    await expect(runFreshClone(ARGS, deps)).rejects.toThrow(/did not settle/);
    expect(spawns.some((spec) => spec.argv.join(' ') === 'run lint')).toBe(false);
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
