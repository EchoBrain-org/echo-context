import { execFileSync } from 'node:child_process';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

function packageSourceClosure(): string[] {
  const tsc = join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc');
  const output = execFileSync(
    process.execPath,
    [tsc, '--noEmit', '--listFiles', '--project', join(ROOT, 'tsconfig.build.json')],
    { cwd: ROOT, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 },
  );
  return output
    .split(/\r?\n/u)
    .filter((path) => path.startsWith(join(ROOT, 'src')))
    .map((path) => relative(ROOT, path).split('\\').join('/'))
    .sort();
}

describe('lean package TypeScript closure', () => {
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
        path.startsWith('src/capture/surfaces/') ||
        path.startsWith('src/enrich/') ||
        path === 'src/capture/granola-source-policy.ts' ||
        path === 'src/mcp/parse-anchors.ts' ||
        path === 'src/mcp/util/role-state-git.ts' ||
        path === 'src/trace/signal-window.ts' ||
        /(?:^|\/)(?:backlog|coord(?:ination)?|product|project-config|slack)(?:\/|[-_.])/u.test(
          path,
        ) ||
        /(?:watcher|poller|worker-loop|enrich(?:ment)?-(?:loop|worker))\.ts$/u.test(path)
      );
    });

    expect(forbidden).toEqual([]);
  });
});
