import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CHECKER = join(ROOT, 'tools/check-runtime-inventory.mjs');
const MANIFEST = join(ROOT, 'provenance/runtime-inventory.v2.json');

type Manifest = {
  schema: string;
  scripts: Array<{ name: string; command: string; executable: string; argv: string[] }>;
  executable_sources: Array<{ path: string; mode: string; blob_oid: string; content_sha256: string }>;
  npm_closure: Array<{ lock_path: string; version: string; integrity: string; dependencies: Array<{ lock_path: string }> }>;
  system_helpers: string[];
};

function checker(gitDir: string, commit: string, manifest: string, emit = false) {
  return spawnSync(process.execPath, [
    CHECKER, '--git-dir', gitDir, '--commit', commit, '--manifest', manifest, ...(emit ? ['--emit'] : []),
  ], { encoding: 'utf8', timeout: 120_000 });
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();
}

function commit(clone: string, path: string, bytes: string): string {
  writeFileSync(join(clone, path), bytes);
  execFileSync('git', ['-C', clone, 'add', '--', path]);
  execFileSync('git', ['-C', clone, '-c', 'core.hooksPath=/dev/null', 'commit', '-m', `fixture ${path}`], { stdio: 'ignore' });
  return git(clone, ['rev-parse', 'HEAD']);
}

function withClone(run: (clone: string) => void) {
  const clone = mkdtempSync(join(tmpdir(), 'echo-context-runtime-v2-'));
  try {
    execFileSync('git', ['clone', '--no-local', '--no-hardlinks', ROOT, clone], { stdio: 'ignore' });
    git(clone, ['config', 'user.name', 'runtime fixture']);
    git(clone, ['config', 'user.email', 'runtime@example.invalid']);
    run(clone);
  } finally {
    rmSync(clone, { recursive: true, force: true });
  }
}

describe('AC2 — successor runtime dependency set', () => {
  it('matches runtime-inventory.v2 at successor HEAD', () => {
    const result = checker(join(ROOT, '.git'), git(ROOT, ['rev-parse', 'HEAD']), MANIFEST);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toMatch(/runtime-inventory\.v2 OK/);
  });

  it('binds every package script, executable tool/config, helper, and full lock closure', () => {
    const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8')) as Manifest;
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { scripts: Record<string, string> };
    expect(manifest.schema).toBe('runtime-inventory.v2');
    expect(Object.fromEntries(manifest.scripts.map((row) => [row.name, row.command]))).toEqual(pkg.scripts);
    for (const path of [
      'tools/build-source-artifact.mjs', 'tools/verify-source-artifact.mjs', 'tools/release-publication-controller.mjs',
      'tools/secret-scan.sh', 'tools/fresh-clone-verifier.mjs', 'tsconfig.json', 'vitest.ci.config.ts',
    ]) expect(manifest.executable_sources.some((row) => row.path === path), path).toBe(true);
    expect(manifest.system_helpers).toEqual(['git', 'gitleaks', 'node', 'npm']);
    const closure = new Map(manifest.npm_closure.map((row) => [row.lock_path, row]));
    for (const path of ['node_modules/better-sqlite3', 'node_modules/typescript', 'node_modules/vitest', 'node_modules/tsx', 'node_modules/esbuild']) {
      expect(closure.has(path), path).toBe(true);
    }
    for (const row of manifest.npm_closure) {
      expect(row.integrity).toMatch(/^sha512-/);
      for (const edge of row.dependencies) expect(closure.has(edge.lock_path), edge.lock_path).toBe(true);
    }
  });

  it('rejects missing, extra, or changed manifest closure rows through the real checker', () => {
    const directory = mkdtempSync(join(tmpdir(), 'runtime-v2-manifest-'));
    try {
      const original = JSON.parse(readFileSync(MANIFEST, 'utf8')) as Manifest;
      const mutations = [
        { ...structuredClone(original), executable_sources: original.executable_sources.slice(1) },
        { ...structuredClone(original), system_helpers: [...original.system_helpers, 'curl'] },
        { ...structuredClone(original), scripts: original.scripts.map((row, index) => index === 0 ? { ...row, command: `${row.command} --drift` } : row) },
        { ...structuredClone(original), npm_closure: original.npm_closure.slice(0, -1) },
      ];
      for (const [index, mutation] of mutations.entries()) {
        const path = join(directory, `${index}.json`);
        writeFileSync(path, `${JSON.stringify(mutation, null, 2)}\n`);
        const result = checker(join(ROOT, '.git'), 'HEAD', path);
        expect(result.status).not.toBe(0);
        expect(result.stderr).toMatch(/differs from the committed successor closure/);
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('fails closed on shell-composed or unlisted script executables and incomplete lock rows', () => {
    withClone((clone) => {
      const pkg = JSON.parse(readFileSync(join(clone, 'package.json'), 'utf8')) as { scripts: Record<string, string> };
      pkg.scripts.fixture = 'node tools/check-runtime-inventory.mjs | sh';
      const shellCommit = commit(clone, 'package.json', `${JSON.stringify(pkg, null, 2)}\n`);
      const shellResult = checker(join(clone, '.git'), shellCommit, join(clone, 'out.json'), true);
      expect(shellResult.status).not.toBe(0);
      expect(shellResult.stderr).toMatch(/outside the closed command grammar/);

      pkg.scripts.fixture = 'python fixture.py';
      const unlistedCommit = commit(clone, 'package.json', `${JSON.stringify(pkg, null, 2)}\n`);
      const unlisted = checker(join(clone, '.git'), unlistedCommit, join(clone, 'out.json'), true);
      expect(unlisted.status).not.toBe(0);
      expect(unlisted.stderr).toMatch(/unlisted executable/);

      delete pkg.scripts.fixture;
      commit(clone, 'package.json', `${JSON.stringify(pkg, null, 2)}\n`);
      const lock = JSON.parse(readFileSync(join(clone, 'package-lock.json'), 'utf8')) as { packages: Record<string, { integrity?: string }> };
      delete lock.packages['node_modules/esbuild'].integrity;
      const lockCommit = commit(clone, 'package-lock.json', `${JSON.stringify(lock, null, 2)}\n`);
      const incomplete = checker(join(clone, '.git'), lockCommit, join(clone, 'out.json'), true);
      expect(incomplete.status).not.toBe(0);
      expect(incomplete.stderr).toMatch(/incomplete lock row: node_modules\/esbuild/);
    });
  }, 60_000);

  it('pins better-sqlite3 and forbids path, Git, and workspace lock dependencies', () => {
    const lock = JSON.parse(readFileSync(join(ROOT, 'package-lock.json'), 'utf8')) as {
      packages: Record<string, { resolved?: string; link?: boolean; version?: string; integrity?: string }>;
    };
    expect(lock.packages['node_modules/better-sqlite3']).toEqual(expect.objectContaining({ version: expect.any(String), integrity: expect.stringMatching(/^sha512-/) }));
    for (const [name, row] of Object.entries(lock.packages)) {
      if (name === '') continue;
      expect(row.link, `workspace/path link dependency forbidden: ${name}`).not.toBe(true);
      if (row.resolved) expect(row.resolved, `non-registry dependency: ${name}`).toMatch(/^https:\/\//);
    }
  });
});
