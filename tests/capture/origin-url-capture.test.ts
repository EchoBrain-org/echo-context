import { execFile } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { _resetGitStateCache, probeGitState } from '../../src/capture/git-state.js';
import { captureStdout } from '../fixtures/stdout.js';

const execFileP = promisify(execFile);

async function makeRepo(): Promise<string> {
  const raw = mkdtempSync(join(tmpdir(), 'echo-origin-url-test-'));
  const dir = realpathSync(raw);
  await execFileP('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  await execFileP('git', ['config', 'user.email', 'test@example.com'], {
    cwd: dir,
  });
  await execFileP('git', ['config', 'user.name', 'Test'], { cwd: dir });
  await execFileP('git', ['config', 'commit.gpgsign', 'false'], { cwd: dir });
  return dir;
}

async function commitFile(
  dir: string,
  file: string,
  contents: string,
  message: string,
): Promise<string> {
  writeFileSync(join(dir, file), contents);
  await execFileP('git', ['add', '.'], { cwd: dir });
  await execFileP('git', ['commit', '-q', '-m', message], { cwd: dir });
  const { stdout } = await execFileP('git', ['rev-parse', 'HEAD'], {
    cwd: dir,
  });
  return stdout.trim();
}

async function setOrigin(repo: string, url: string): Promise<void> {
  await execFileP('git', ['remote', 'remove', 'origin'], { cwd: repo }).catch(() => undefined);
  await execFileP('git', ['remote', 'add', 'origin', url], { cwd: repo });
}

describe('origin URL capture', () => {
  let cleanups: Array<() => void> = [];
  let stdout: string[] = [];
  let restoreStdout: () => void;

  beforeEach(() => {
    _resetGitStateCache();
    cleanups = [];
    const captured = captureStdout();
    stdout = captured.writes;
    restoreStdout = captured.restore;
  });

  afterEach(() => {
    for (const c of cleanups) c();
    cleanups = [];
    restoreStdout();
  });

  it('probeGitState captures origin_url and strips URL credentials', async () => {
    const repo = await makeRepo();
    cleanups.push(() => rmSync(repo, { recursive: true, force: true }));
    await setOrigin(repo, 'https://user:token@GitHub.com/Example/Demo.git');
    await commitFile(repo, 'a.txt', '1', 'first');

    const state = await probeGitState(repo, new Date().toISOString());

    expect(state?.origin_url).toBe('https://GitHub.com/Example/Demo.git');
    expect(state?.origin_url).not.toContain('user:token@');
    expect(state?.head_sha).toMatch(/^[0-9a-f]{40}$/);
  });

  it('probeGitState leaves origin_url undefined for a remote-less repo without logging', async () => {
    const repo = await makeRepo();
    cleanups.push(() => rmSync(repo, { recursive: true, force: true }));
    await commitFile(repo, 'a.txt', '1', 'first');

    const state = await probeGitState(repo, new Date().toISOString());

    expect(state?.origin_url).toBeUndefined();
    expect(stdout.join('')).not.toContain('git_command_failed');
  });
});
