import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, normalize } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  _canonicalizePathForTest,
  canonicalizePath,
  gitToplevel,
  resolveCanonicalRoot,
} from '../../src/capture/workspace-root.js';

const execFileP = promisify(execFile);

const PROJECT_ANCHORS = [
  '.git',
  'package.json',
  'go.mod',
  'Cargo.toml',
  'pyproject.toml',
  'pnpm-workspace.yaml',
] as const;

describe('workspace root resolution', () => {
  let cleanupDirs: string[];
  let originalHome: string | undefined;

  beforeEach(() => {
    cleanupDirs = [];
    originalHome = process.env['HOME'];
  });

  afterEach(() => {
    if (originalHome === undefined) delete process.env['HOME'];
    else process.env['HOME'] = originalHome;
    for (const dir of cleanupDirs) rmSync(dir, { recursive: true, force: true });
  });

  function tempDir(prefix: string): string {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
    cleanupDirs.push(dir);
    return dir;
  }

  async function makeRepo(): Promise<string> {
    const repo = tempDir('echo-workspace-git-');
    await execFileP('git', ['init', '-q', '-b', 'main'], { cwd: repo });
    return repo;
  }

  function writeAnchor(root: string, anchor: (typeof PROJECT_ANCHORS)[number]): void {
    if (anchor === '.git') {
      mkdirSync(join(root, anchor), { recursive: true });
      return;
    }
    writeFileSync(join(root, anchor), '{}\n');
  }

  it('gitToplevel returns the git root for a repo subdir and null on git failure', async () => {
    const repo = await makeRepo();
    const subdir = join(repo, 'src', 'lib');
    mkdirSync(subdir, { recursive: true });

    expect(await gitToplevel(subdir)).toBe(repo);
    expect(await gitToplevel(join(repo, 'missing'))).toBeNull();
    expect(await gitToplevel(tempDir('echo-workspace-non-git-'))).toBeNull();
  });

  it('resolveCanonicalRoot prefers git toplevel over the reported subdir', async () => {
    const repo = await makeRepo();
    const subdir = join(repo, 'packages', 'app');
    mkdirSync(subdir, { recursive: true });
    writeFileSync(join(repo, 'package.json'), '{}\n');

    expect(await resolveCanonicalRoot(subdir)).toBe(await canonicalizePath(repo));
  });

  it('walks up to the nearest root for every exact project anchor', async () => {
    for (const anchor of PROJECT_ANCHORS) {
      const root = tempDir(`echo-workspace-anchor-${anchor.replace(/[^a-z]/gi, '')}-`);
      const subdir = join(root, 'a', 'b');
      mkdirSync(subdir, { recursive: true });
      writeAnchor(root, anchor);

      expect(await resolveCanonicalRoot(subdir)).toBe(await canonicalizePath(root));
    }
  });

  it('falls back to the reported directory when no anchor is found', async () => {
    const dir = tempDir('echo-workspace-no-anchor-');

    expect(await resolveCanonicalRoot(dir)).toBe(await canonicalizePath(dir));
  });

  it('does not return HOME as a discovered anchor root', async () => {
    const home = tempDir('echo-workspace-home-');
    process.env['HOME'] = home;
    writeFileSync(join(home, 'package.json'), '{}\n');
    const start = join(home, 'unanchored', 'child');
    mkdirSync(start, { recursive: true });

    expect(await resolveCanonicalRoot(start)).toBe(await canonicalizePath(start));
  });

  it('does not return ambient roots as discovered roots', async () => {
    const starts = [
      `/echo-workspace-root-${process.pid}-${Date.now()}`,
      `/tmp/echo-workspace-root-${process.pid}-${Date.now()}`,
      `/private/tmp/echo-workspace-root-${process.pid}-${Date.now()}`,
    ];

    for (const start of starts) {
      const resolved = await resolveCanonicalRoot(start);
      expect(resolved).toBe(await canonicalizePath(start));
      expect(['/tmp', '/private/tmp', '/']).not.toContain(resolved);
    }
  });

  it('walks up normally for anchored external workspaces outside HOME', async () => {
    process.env['HOME'] = tempDir('echo-workspace-other-home-');
    const root = tempDir('echo-workspace-external-');
    writeFileSync(join(root, 'package.json'), '{}\n');
    const subdir = join(root, 'src', 'feature');
    mkdirSync(subdir, { recursive: true });

    expect(await resolveCanonicalRoot(subdir)).toBe(await canonicalizePath(root));
  });

  it('walks up normally when HOME is missing', async () => {
    delete process.env['HOME'];
    const root = tempDir('echo-workspace-missing-home-');
    writeFileSync(join(root, 'pyproject.toml'), '[project]\n');
    const subdir = join(root, 'pkg', 'mod');
    mkdirSync(subdir, { recursive: true });

    expect(await resolveCanonicalRoot(subdir)).toBe(await canonicalizePath(root));
  });

  it('canonicalizes symlinked roots', async () => {
    const realRoot = tempDir('echo-workspace-real-');
    writeFileSync(join(realRoot, 'package.json'), '{}\n');
    const linkRoot = join(tempDir('echo-workspace-link-parent-'), 'link-root');
    symlinkSync(realRoot, linkRoot, 'dir');
    const start = join(linkRoot, 'src');
    mkdirSync(start, { recursive: true });

    expect(await resolveCanonicalRoot(start)).toBe(await canonicalizePath(realRoot));
  });

  it('canonicalizes non-existent paths by realpathing the longest existing prefix', async () => {
    const realRoot = tempDir('echo-workspace-nonexistent-real-');
    const linkRoot = join(tempDir('echo-workspace-nonexistent-link-'), 'project');
    symlinkSync(realRoot, linkRoot, 'dir');

    const missing = join(linkRoot, 'missing', '..', 'future', 'file.ts');
    const expected = normalize(join(realRoot, 'future', 'file.ts'));
    expect(await _canonicalizePathForTest(missing, { caseInsensitiveFilesystem: false })).toBe(
      expected,
    );
  });

  it('degrades without throwing when the reported path is deleted', async () => {
    const dir = tempDir('echo-workspace-deleted-');
    const reported = join(dir, 'gone');
    rmSync(dir, { recursive: true, force: true });

    await expect(resolveCanonicalRoot(reported)).resolves.toBe(await canonicalizePath(reported));
  });

  it('case-folds only through the injected test seam', async () => {
    const root = tempDir('echo-workspace-CaseFold-');
    const mixed = join(root, 'MixedCase');
    mkdirSync(mixed);
    const preserved = await _canonicalizePathForTest(mixed, {
      caseInsensitiveFilesystem: false,
    });
    const folded = await _canonicalizePathForTest(mixed, {
      caseInsensitiveFilesystem: true,
    });

    expect(preserved).toBe(realpathSync(mixed));
    expect(folded).toBe(preserved.toLowerCase());
  });
});
