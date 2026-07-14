import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

// AC2 — final-HEAD dependency provenance. Runs check-runtime-inventory against
// the target's own object store at HEAD and asserts the committed manifest
// matches the extracted closed-grammar edge set; also asserts lock hygiene
// (better-sqlite3 present; no path/git/workspace deps).
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const GIT = '/usr/local/bin/git';
const NODE = '/usr/local/bin/node';

function git(args: string[]): string {
  return execFileSync(GIT, ['-C', ROOT, ...args], { encoding: 'utf8' }).trim();
}

describe('AC2 — runtime dependency set', () => {
  it('check-runtime-inventory passes against the committed manifest at HEAD', () => {
    const head = git(['rev-parse', 'HEAD']);
    const out = execFileSync(
      NODE,
      [
        join(ROOT, 'tools', 'check-runtime-inventory.mjs'),
        '--git-dir',
        join(ROOT, '.git'),
        '--commit',
        head,
        '--manifest',
        join(ROOT, 'provenance', 'runtime-inventory.v1.json'),
      ],
      { encoding: 'utf8' },
    );
    expect(out).toMatch(/runtime-inventory OK/);
  });

  it('the manifest edge classes stay within the closed grammar', () => {
    const manifest = JSON.parse(readFileSync(join(ROOT, 'provenance', 'runtime-inventory.v1.json'), 'utf8')) as {
      entrypoints: { edges: { class: string; target: string }[] }[];
      script_clis: { class: string }[];
    };
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
    for (const e of manifest.entrypoints) for (const edge of e.edges) expect(GRAMMAR.has(edge.class)).toBe(true);
    for (const s of manifest.script_clis) expect(s.class).toBe('npm_javascript_cli');
  });

  it('the lock pins better-sqlite3 and has no path/git/workspace dependencies', () => {
    const lock = JSON.parse(readFileSync(join(ROOT, 'package-lock.json'), 'utf8')) as {
      packages: Record<string, { resolved?: string; link?: boolean; version?: string }>;
    };
    expect(lock.packages['node_modules/better-sqlite3']).toBeDefined();
    for (const [name, p] of Object.entries(lock.packages)) {
      if (name === '') continue;
      if (p.link) throw new Error(`workspace/path link dependency forbidden: ${name}`);
      if (p.resolved && !/^https:\/\//.test(p.resolved)) {
        throw new Error(`non-registry (path/git) resolved url forbidden: ${name} -> ${p.resolved}`);
      }
    }
  });
});
