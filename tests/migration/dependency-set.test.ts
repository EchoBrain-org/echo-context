import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// AC2 — final-HEAD dependency provenance. Every assertion invokes the real
// object-only checker. Adversarial commits are made in no-local temporary
// clones so neither the mutable checkout nor a test-only parser can decide the
// result.
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const GIT = '/usr/local/bin/git';
const NODE = '/usr/local/bin/node';
const MANIFEST = join(ROOT, 'provenance', 'runtime-inventory.v1.json');
const CHECKER = join(ROOT, 'tools', 'check-runtime-inventory.mjs');
const GRAMMAR = new Set([
  'repository_static_import',
  'repository_dynamic_literal_import',
  'repository_commonjs_literal_require',
  'repository_literal_read',
  'repository_literal_process_launch',
  'node_builtin',
  'npm_package',
  'npm_javascript_cli',
  'native_or_system_helper',
]);

type Edge = {
  from: string;
  class: string;
  target: string;
  version?: string;
  integrity?: string;
  sha256?: string;
};
type Manifest = {
  entrypoint_sources: { file: string; reasons: string[] }[];
  entrypoints: { entrypoint: string; modules: string[]; edges: Edge[] }[];
  script_clis: { script: string; class: string; target: string }[];
};

function git(cwd: string, args: string[]): string {
  return execFileSync(GIT, ['-C', cwd, ...args], { encoding: 'utf8' }).trim();
}

function runChecker(gitDir: string, commit: string, manifest: string, emit = false) {
  return spawnSync(
    NODE,
    [CHECKER, '--git-dir', gitDir, '--commit', commit, '--manifest', manifest, ...(emit ? ['--emit'] : [])],
    { encoding: 'utf8', timeout: 120_000, maxBuffer: 32 * 1024 * 1024 },
  );
}

function expectRejected(result: ReturnType<typeof runChecker>, pattern: RegExp) {
  if (result.error) throw result.error;
  expect(result.signal).toBeNull();
  expect(result.status).not.toBe(0);
  expect(`${result.stdout}${result.stderr}`).toMatch(pattern);
}

function writeJson(path: string, value: unknown) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function withNoLocalClone(run: (clone: string) => void) {
  const clone = mkdtempSync(join(tmpdir(), 'echo-context-ac2-'));
  try {
    execFileSync(GIT, ['clone', '--no-local', '--no-hardlinks', '--no-checkout', ROOT, clone], { stdio: 'ignore' });
    execFileSync(GIT, ['-C', clone, '-c', 'core.hooksPath=/dev/null', 'checkout', '--detach', git(ROOT, ['rev-parse', 'HEAD'])], {
      stdio: 'ignore',
    });
    execFileSync(GIT, ['-C', clone, 'remote', 'remove', 'origin']);
    git(clone, ['config', 'user.name', 'AC2 fixture']);
    git(clone, ['config', 'user.email', 'ac2-fixture@example.invalid']);
    run(clone);
  } finally {
    rmSync(clone, { recursive: true, force: true });
  }
}

function commitFixture(clone: string, relativePath: string, source: string): string {
  const absolute = join(clone, relativePath);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, source, 'utf8');
  execFileSync(GIT, ['-C', clone, 'add', '--', relativePath]);
  execFileSync(GIT, ['-C', clone, '-c', 'core.hooksPath=/dev/null', 'commit', '-m', `AC2 fixture ${relativePath}`], {
    stdio: 'ignore',
  });
  return git(clone, ['rev-parse', 'HEAD']);
}

describe('AC2 — runtime dependency set', () => {
  it('matches the recursively computed manifest at final HEAD', () => {
    const result = runChecker(join(ROOT, '.git'), git(ROOT, ['rev-parse', 'HEAD']), MANIFEST);
    if (result.error) throw result.error;
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toMatch(/runtime-inventory OK/);
  });

  it('binds the real launcher, storage, migration, SQL, npm CLI, and native closure', () => {
    const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8')) as Manifest;
    const context = manifest.entrypoints.find((entry) => entry.entrypoint === 'tools/verify-context-tools.mjs');
    const service = manifest.entrypoints.find((entry) => entry.entrypoint === 'tools/verify-service-parity.mjs');
    expect(context).toBeDefined();
    expect(service).toBeDefined();

    for (const required of [
      'src/mcp/tools/search-memories.ts',
      'src/mcp/tools/wait-for-new-turns.ts',
      'src/storage/memory.ts',
    ]) {
      expect(context?.modules).toContain(required);
    }
    expect(service?.modules).toContain('src/storage/sqlite.ts');
    expect(service?.modules).toContain('src/storage/migrate.ts');

    const edges = manifest.entrypoints.flatMap((entry) => entry.edges);
    expect(edges).toContainEqual(
      expect.objectContaining({ class: 'repository_literal_read', target: 'src/storage/migrations/0001_initial.sql' }),
    );
    expect(edges).toContainEqual(expect.objectContaining({ class: 'npm_package', target: 'tsx' }));
    expect(edges).toContainEqual(expect.objectContaining({ class: 'npm_javascript_cli', target: 'vite-node' }));
    expect(edges).toContainEqual(expect.objectContaining({ class: 'npm_package', target: 'better-sqlite3' }));
    expect(edges).toContainEqual(
      expect.objectContaining({
        class: 'native_or_system_helper',
        target: 'node_modules/better-sqlite3/build/Release/better_sqlite3.node',
        sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      }),
    );
    for (const entry of manifest.entrypoints) {
      expect(new Set(entry.modules).size).toBe(entry.modules.length);
      for (const edge of entry.edges) {
        expect(GRAMMAR.has(edge.class)).toBe(true);
        expect(entry.modules).toContain(edge.from);
      }
    }
    for (const edge of manifest.script_clis) expect(GRAMMAR.has(edge.class)).toBe(true);
  });

  it('rejects an omitted entrypoint, every omitted edge class, and an unknown class through the real CLI', () => {
    withNoLocalClone((clone) => {
      writeFileSync(join(clone, 'tools', 'ac2-fixture-child.cjs'), 'module.exports = { ok: true };\n', 'utf8');
      const commit = commitFixture(
        clone,
        'tools/ac2-fixture-entry.mjs',
        `#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const child = fileURLToPath(new URL('./ac2-fixture-child.cjs', import.meta.url));
require('./ac2-fixture-child.cjs');
spawnSync('/usr/local/bin/node', [child]);
`,
      );
      execFileSync(GIT, ['-C', clone, 'add', '--', 'tools/ac2-fixture-child.cjs']);
      execFileSync(GIT, ['-C', clone, '-c', 'core.hooksPath=/dev/null', 'commit', '--amend', '--no-edit'], { stdio: 'ignore' });
      const amended = git(clone, ['rev-parse', 'HEAD']);
      expect(amended).not.toBe(commit);

      const emittedPath = join(clone, 'runtime-inventory.fixture.json');
      const emitted = runChecker(join(clone, '.git'), amended, emittedPath, true);
      if (emitted.error) throw emitted.error;
      expect(emitted.status, emitted.stderr).toBe(0);
      const complete = JSON.parse(readFileSync(emittedPath, 'utf8')) as Manifest;
      const presentClasses = new Set(complete.entrypoints.flatMap((entry) => entry.edges.map((edge) => edge.class)));
      expect(presentClasses).toEqual(GRAMMAR);

      const withoutEntrypoint = structuredClone(complete);
      withoutEntrypoint.entrypoints.splice(0, 1);
      withoutEntrypoint.entrypoint_sources.splice(0, 1);
      const omittedEntrypointPath = join(clone, 'omitted-entrypoint.json');
      writeJson(omittedEntrypointPath, withoutEntrypoint);
      expectRejected(runChecker(join(clone, '.git'), amended, omittedEntrypointPath), /manifest differs/);

      for (const klass of GRAMMAR) {
        const mutation = structuredClone(complete);
        const owner = mutation.entrypoints.find((entry) => entry.edges.some((edge) => edge.class === klass));
        if (!owner) throw new Error(`fixture did not produce edge class ${klass}`);
        owner.edges.splice(
          owner.edges.findIndex((edge) => edge.class === klass),
          1,
        );
        const mutationPath = join(clone, `omitted-${klass}.json`);
        writeJson(mutationPath, mutation);
        expectRejected(runChecker(join(clone, '.git'), amended, mutationPath), /manifest differs/);
      }

      const unknown = structuredClone(complete);
      unknown.entrypoints[0].edges[0].class = 'unknown_edge_class';
      const unknownPath = join(clone, 'unknown-class.json');
      writeJson(unknownPath, unknown);
      expectRejected(runChecker(join(clone, '.git'), amended, unknownPath), /manifest differs/);
    });
  }, 120_000);

  it('fails closed on computed imports, module-root reads, and process launches in committed objects', () => {
    withNoLocalClone((clone) => {
      const cases = [
        {
          label: 'dynamic import',
          pattern: /computed dynamic import/,
          source: `#!/usr/bin/env node
const suffix = process.env.AC2_SUFFIX;
await import(\`./\${suffix}.mjs\`);
`,
        },
        {
          label: 'repository read',
          pattern: /computed repository-capable read/,
          source: `#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const MODULE_ROOT = dirname(fileURLToPath(import.meta.url));
readFileSync(join(MODULE_ROOT, process.env.AC2_FILE));
`,
        },
        {
          label: 'process launch',
          pattern: /computed or unpinned process launch/,
          source: `#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
const command = process.env.AC2_COMMAND;
spawnSync(command, []);
`,
        },
      ];
      for (const fixture of cases) {
        const commit = commitFixture(clone, 'tools/ac2-computed-fixture.mjs', fixture.source);
        const result = runChecker(join(clone, '.git'), commit, MANIFEST);
        expectRejected(result, fixture.pattern);
      }
    });
  }, 120_000);

  it('pins better-sqlite3 and forbids path, Git, and workspace lock dependencies', () => {
    const lock = JSON.parse(readFileSync(join(ROOT, 'package-lock.json'), 'utf8')) as {
      packages: Record<string, { resolved?: string; link?: boolean; version?: string; integrity?: string }>;
    };
    expect(lock.packages['node_modules/better-sqlite3']).toEqual(
      expect.objectContaining({ version: expect.any(String), integrity: expect.stringMatching(/^sha512-/) }),
    );
    for (const [name, row] of Object.entries(lock.packages)) {
      if (name === '') continue;
      if (row.link) throw new Error(`workspace/path link dependency forbidden: ${name}`);
      if (row.resolved && !/^https:\/\//.test(row.resolved)) {
        throw new Error(`non-registry (path/git) resolved URL forbidden: ${name} -> ${row.resolved}`);
      }
    }
  });
});
