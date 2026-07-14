import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

// AC6/AC7 — no reflog-only, dangling, unreachable, or extra target object. The
// accepted target has a sole branch, no tags/other refs/reflogs, an exact match
// between the unique object set and what is reachable from the branch, and a
// clean `git fsck`.
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const GIT = '/usr/local/bin/git';
const BRANCH = 'migration/2026-07-13-135';
const ENV = { ...process.env, GIT_OPTIONAL_LOCKS: '0' };
const git = (args: string[]) => execFileSync(GIT, ['-C', ROOT, ...args], { encoding: 'utf8', env: ENV, maxBuffer: 128 * 1024 * 1024 }).trim();

describe('AC6/AC7 — object closure', () => {
  it('has exactly the sole migration branch and no other refs/tags', () => {
    const branches = git(['for-each-ref', '--format=%(refname)', 'refs/heads/']).split('\n').filter(Boolean);
    expect(branches).toEqual([`refs/heads/${BRANCH}`]);
    const tags = git(['for-each-ref', '--format=%(refname)', 'refs/tags/']).split('\n').filter(Boolean);
    expect(tags).toEqual([]);
    const remotes = git(['for-each-ref', '--format=%(refname)', 'refs/remotes/']).split('\n').filter(Boolean);
    expect(remotes).toEqual([]);
  });

  it('fsck --full --no-reflogs --unreachable reports nothing', () => {
    const out = git(['fsck', '--full', '--no-reflogs', '--unreachable']);
    expect(out).toBe('');
  });

  it('the object set equals what is reachable from the sole branch', () => {
    const all = git(['cat-file', '--batch-all-objects', '--batch-check=%(objectname)'])
      .split('\n').filter(Boolean).sort();
    const reachable = git(['rev-list', '--objects', '--no-object-names', `refs/heads/${BRANCH}`])
      .split('\n').filter(Boolean).sort();
    expect(all).toEqual(reachable);
  });

  it('every tracked file is in the target-only ∪ source-extraction allowlist (exact-HEAD safety)', async () => {
    const { readFileSync } = await import('node:fs');
    const tracked = git(['ls-files']).split('\n').filter(Boolean);
    const policy = JSON.parse(readFileSync(join(ROOT, 'provenance/target-only-policy.v1.json'), 'utf8')) as { target_only_paths: string[] };
    const extraction = JSON.parse(readFileSync(join(ROOT, 'provenance/source-extraction.v1.json'), 'utf8')) as { rows: { path: string }[] };
    const allowed = new Set([...policy.target_only_paths, ...extraction.rows.map((r) => r.path)]);
    const unexpected = tracked.filter((f) => !allowed.has(f));
    // No tracked file may fall outside the allowlist. (Completeness — that every
    // allowlisted target-only path EXISTS — closes with AC8's three files; until
    // then this one-directional check guards against stray tracked files.)
    expect(unexpected).toEqual([]);
  });
});
