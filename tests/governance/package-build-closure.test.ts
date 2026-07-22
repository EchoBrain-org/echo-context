import { execFileSync } from 'node:child_process';
import { dirname, join, relative } from 'node:path';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const RETIRED_SOURCE_PATHS = [
  'src/capture/granola-source-policy.ts',
  'src/capture/surfaces/fs-watcher.ts',
  'src/capture/surfaces/git-watcher.ts',
  'src/capture/surfaces/granola-poller.ts',
  'src/echo-home/paths.ts',
  'src/enrich/granola-signals.ts',
  'src/mcp/parse-anchors.ts',
  'src/mcp/util/role-state-git.ts',
  'src/trace/signal-window.ts',
  'src/util/subject.ts',
  'src/util/subprocess.ts',
];

function sourceTreeTypeScript(directory = join(ROOT, 'src')): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...sourceTreeTypeScript(path));
    if (entry.isFile() && entry.name.endsWith('.ts')) {
      files.push(relative(ROOT, path).split('\\').join('/'));
    }
  }
  return files.sort();
}

let cachedPackageSourceClosure: string[] | undefined;
function packageSourceClosure(): string[] {
  if (cachedPackageSourceClosure !== undefined) return cachedPackageSourceClosure;
  const tsc = join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc');
  const output = execFileSync(
    process.execPath,
    [tsc, '--noEmit', '--listFiles', '--project', join(ROOT, 'tsconfig.build.json')],
    { cwd: ROOT, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 },
  );
  cachedPackageSourceClosure = output
    .split(/\r?\n/u)
    .filter((path) => path.startsWith(join(ROOT, 'src')))
    .map((path) => relative(ROOT, path).split('\\').join('/'))
    .sort();
  return cachedPackageSourceClosure;
}

describe('lean package TypeScript closure', () => {
  it('contains every current TypeScript source file', () => {
    expect(packageSourceClosure()).toEqual(sourceTreeTypeScript());
  });

  it('keeps retired incubation prototypes out of the current source tree', () => {
    expect(RETIRED_SOURCE_PATHS.filter((path) => existsSync(join(ROOT, path)))).toEqual([]);
  });

  it('contains context capture/retrieval but no product-owned runtime surface', () => {
    const closure = packageSourceClosure();
    expect(closure).toContain('src/cli.ts');
    expect(closure).toContain('src/echo-home/state-paths.ts');
    expect(closure).toContain('src/mcp/util/granola-signal-runs.ts');
    expect(closure).toContain('src/normalize/adapters/git.ts');
    expect(closure).toContain('src/normalize/adapters/granola.ts');

    const forbidden = closure.filter((path) => {
      if (
        path.startsWith('src/echo-home/') &&
        path !== 'src/echo-home/state-paths.ts' &&
        path !== 'src/echo-home/adapters/atomic-write.ts'
      ) {
        return true;
      }
      return (
        path.startsWith('src/enrich/') ||
        path === 'src/capture/granola-source-policy.ts' ||
        path === 'src/mcp/parse-anchors.ts' ||
        path === 'src/mcp/util/role-state-git.ts' ||
        path === 'src/trace/signal-window.ts' ||
        /(?:^|\/)(?:backlog|coord(?:ination)?|product|project-config|slack)(?:\/|[-_.])/u.test(
          path,
        )
      );
    });

    expect(forbidden).toEqual([]);
  });

  it('binds every concrete capture entrypoint exactly once in the adapter registry', () => {
    const extractorEntries = readdirSync(
      join(ROOT, 'src', 'capture', 'extractors'),
      { withFileTypes: true },
    )
      .filter(
        (entry) =>
          entry.isFile() &&
          entry.name.endsWith('.ts') &&
          !entry.name.startsWith('_'),
      )
      .map((entry) => entry.name)
      .sort();
    const registry = readFileSync(
      join(ROOT, 'src', 'context-adapters', 'registry.ts'),
      'utf8',
    );
    const bindings = Array.from(
      registry.matchAll(
        /import\(\s*['"]\.\.\/capture\/extractors\/([^'"]+)\.js['"]\s*\)/gu,
      ),
      (match) => `${match[1] as string}.ts`,
    ).sort();

    expect(new Set(bindings).size).toBe(bindings.length);
    expect(bindings).toEqual(extractorEntries);
  });

  it('orders artifact-manifest paths with the runtime verifier ordinal contract', () => {
    const builder = readFileSync(join(ROOT, 'tools', 'build-package.mjs'), 'utf8');
    expect(builder).toContain(
      '.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))',
    );
    expect(builder).not.toContain('a.path.localeCompare(b.path)');

    const mixedCasePaths = [
      'context-tools.v2.json',
      'dist/version.js.map',
      'LICENSE',
      'package.json',
      'README.md',
    ];
    expect(
      mixedCasePaths.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
    ).toEqual([
      'LICENSE',
      'README.md',
      'context-tools.v2.json',
      'dist/version.js.map',
      'package.json',
    ]);
  });
});
