import { execFile } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { gate } from '../../../src/capture/gate.js';
import { CAPTURED_SOURCES, isAllowedRepo } from '../../../src/capture/sources.js';
import {
  startGitWatcher,
  type GitWatcherHandle,
} from '../../../src/capture/surfaces/git-watcher.js';
import type { CaptureEvent, EventId } from '../../../src/storage/interface.js';
import { MemoryStorage } from '../../../src/storage/memory.js';
import { waitFor } from '../../fixtures/jsonl.js';
import { captureStdout } from '../../fixtures/stdout.js';

/** Storage whose append always rejects — exercises the watcher's error
 *  containment (Bug C: track()'s .finally-only chain re-rejected unhandled). */
class RejectingStorage extends MemoryStorage {
  override async append(): Promise<EventId> {
    throw new Error('synthetic storage failure');
  }
}

const execFileP = promisify(execFile);

async function makeRepo(): Promise<string> {
  const raw = mkdtempSync(join(tmpdir(), 'echo-git-test-'));
  const dir = realpathSync(raw); // resolve symlinks (macOS /var → /private/var)
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
  const { stdout } = await execFileP('git', ['rev-parse', 'HEAD'], { cwd: dir });
  return stdout.trim();
}

async function waitForCount(
  storage: MemoryStorage,
  target: number,
  timeoutMs = 8000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const n = await storage.count();
    if (n >= target) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  const got = await storage.count();
  throw new Error(`storage count never reached ${target}; current=${got}`);
}

function pushAllowedRepo(repo: string): () => void {
  const repos = CAPTURED_SOURCES.git_repos as unknown as string[];
  repos.push(repo);
  return () => {
    const idx = repos.lastIndexOf(repo);
    if (idx !== -1) repos.splice(idx, 1);
  };
}

describe('startGitWatcher', () => {
  let restoreStdout: () => void;
  let cleanups: Array<() => void> = [];
  let handles: GitWatcherHandle[] = [];

  beforeEach(() => {
    ({ restore: restoreStdout } = captureStdout());
    cleanups = [];
    handles = [];
  });

  afterEach(async () => {
    for (const h of handles) {
      await h.stop();
    }
    handles = [];
    for (const c of cleanups) c();
    cleanups = [];
    restoreStdout();
  });

  it('captures all commits as backfill on first boot of an empty store', async () => {
    const repo = await makeRepo();
    cleanups.push(pushAllowedRepo(repo));
    cleanups.push(() => rmSync(repo, { recursive: true, force: true }));

    const sha1 = await commitFile(repo, 'a.txt', '1', 'first');
    const sha2 = await commitFile(repo, 'a.txt', '2', 'second');
    const sha3 = await commitFile(repo, 'a.txt', '3', 'third');

    const storage = new MemoryStorage();
    const h = await startGitWatcher([repo], storage, { enableFsWatch: false });
    handles.push(h);

    await waitForCount(storage, 3);
    const events = await storage.query({ source: `git:${repo}`, order: 'asc' });
    expect(events).toHaveLength(3);

    const shas = new Set(
      events.map((e) => (e.metadata as Record<string, unknown>)['sha']),
    );
    // Item 025: deterministic id-ASC tie-break — same-second commits land in
    // arbitrary id-ASC order. Compare as a set.
    expect(shas).toEqual(new Set([sha1, sha2, sha3]));

    const first = events.find((e) =>
      e.content.startsWith(`COMMIT ${sha1.slice(0, 7)}: first`),
    )!;
    expect(first).toBeDefined();
    expect(first.content).toContain('--- DIFF ---');
    expect(first.source).toBe(`git:${repo}`);
    const meta = first.metadata as Record<string, unknown>;
    expect(meta['author']).toBe('Test');
    expect(typeof meta['files_changed']).toBe('number');
  });

  it('populates metadata.repo_root and metadata.files_referenced for each commit', async () => {
    const repo = await makeRepo();
    cleanups.push(pushAllowedRepo(repo));
    cleanups.push(() => rmSync(repo, { recursive: true, force: true }));

    // First commit: one file
    writeFileSync(join(repo, 'a.txt'), 'hello\n');
    await execFileP('git', ['add', '.'], { cwd: repo });
    await execFileP('git', ['commit', '-q', '-m', 'first'], { cwd: repo });

    // Second commit: two files (one new, one modified)
    writeFileSync(join(repo, 'a.txt'), 'hello again\n');
    writeFileSync(join(repo, 'b.txt'), 'new\n');
    await execFileP('git', ['add', '.'], { cwd: repo });
    await execFileP('git', ['commit', '-q', '-m', 'second'], { cwd: repo });

    const storage = new MemoryStorage();
    const h = await startGitWatcher([repo], storage, { enableFsWatch: false });
    handles.push(h);

    await waitForCount(storage, 2);
    const events = await storage.query({ source: `git:${repo}`, order: 'asc' });
    expect(events).toHaveLength(2);

    for (const evt of events) {
      const md = evt.metadata as Record<string, unknown>;
      expect(md['repo_root']).toBe(repo);
    }

    // Item 025: storage's deterministic id-ASC tie-break on same-second author
    // timestamps means we can no longer assume events[0] is the chronologically
    // earlier commit. Identify each by its commit subject instead.
    const firstEvt = events.find((e) => e.content.includes('first'))!;
    const firstFiles = (firstEvt.metadata as Record<string, unknown>)['files_referenced'];
    expect(firstFiles).toEqual([join(repo, 'a.txt')]);

    const secondEvt = events.find((e) => e.content.includes('second'))!;
    const secondFiles = (secondEvt.metadata as Record<string, unknown>)['files_referenced'];
    expect(secondFiles).toEqual([join(repo, 'a.txt'), join(repo, 'b.txt')]);
  });

  it('only emits new commits on a second boot (resumption from last_seen_sha)', async () => {
    const repo = await makeRepo();
    cleanups.push(pushAllowedRepo(repo));
    cleanups.push(() => rmSync(repo, { recursive: true, force: true }));

    const sha1 = await commitFile(repo, 'a.txt', '1', 'first');
    const sha2 = await commitFile(repo, 'a.txt', '2', 'second');
    const sha3 = await commitFile(repo, 'a.txt', '3', 'third');

    const storage = new MemoryStorage();
    const h1 = await startGitWatcher([repo], storage, { enableFsWatch: false });
    await waitForCount(storage, 3);
    await h1.stop();

    const sha4 = await commitFile(repo, 'a.txt', '4', 'fourth');
    const sha5 = await commitFile(repo, 'a.txt', '5', 'fifth');

    const h2 = await startGitWatcher([repo], storage, { enableFsWatch: false });
    handles.push(h2);

    await waitForCount(storage, 5);
    const events = await storage.query({ source: `git:${repo}`, order: 'asc' });
    // discoverLastSeen walks `git log` and intersects with stored SHAs, so
    // resumption is exactly "the 2 new commits added": no duplicates of the
    // first-boot trio. Length + set-membership is the strict contract; capture
    // order across same-second commits is not asserted (commits in this test
    // complete within one author-second and share a tied timestamp).
    expect(events).toHaveLength(5);
    const shas = events.map((e) => (e.metadata as Record<string, unknown>)['sha']);
    expect(new Set(shas)).toEqual(new Set([sha1, sha2, sha3, sha4, sha5]));
  });

  it('polling fallback catches commits when fs watching is disabled', async () => {
    const repo = await makeRepo();
    cleanups.push(pushAllowedRepo(repo));
    cleanups.push(() => rmSync(repo, { recursive: true, force: true }));

    await commitFile(repo, 'a.txt', '1', 'first');

    const storage = new MemoryStorage();
    const h = await startGitWatcher([repo], storage, {
      enableFsWatch: false,
      pollIntervalMs: 100,
    });
    handles.push(h);

    await waitForCount(storage, 1);

    // Make a new commit AFTER the watcher started; only polling can detect this
    // since FS watching is off.
    await commitFile(repo, 'a.txt', '2', 'detected-by-polling');
    await waitForCount(storage, 2, 5000);

    const events = await storage.query({ source: `git:${repo}`, order: 'asc' });
    // Item 025: deterministic id-ASC secondary sort on tied timestamps means
    // back-to-back test commits with second-precision authors no longer
    // resolve to insertion order. Assert by content membership across the
    // 2-event result rather than by index.
    expect(events.some((e) => e.content.includes('detected-by-polling'))).toBe(true);
  });

  it('truncates large diffs at 100 KB with a marker', async () => {
    const repo = await makeRepo();
    cleanups.push(pushAllowedRepo(repo));
    cleanups.push(() => rmSync(repo, { recursive: true, force: true }));

    // Generate >100 KB of unique line content to force a large diff.
    const lines: string[] = [];
    for (let i = 0; i < 6000; i++) {
      lines.push(`line-${i}-${'x'.repeat(20)}`);
    }
    const sha = await commitFile(repo, 'big.txt', lines.join('\n') + '\n', 'big');

    const storage = new MemoryStorage();
    const h = await startGitWatcher([repo], storage, { enableFsWatch: false });
    handles.push(h);

    await waitForCount(storage, 1);
    const events: CaptureEvent[] = await storage.query({ source: `git:${repo}`, order: 'asc' });
    expect(events).toHaveLength(1);
    const evt = events[0]!;
    expect(evt.content).toContain(`[diff truncated at 102400 bytes; full diff at ${sha}]`);
  });

  it('rejects a git: source with an unknown repo via the gate (unknown_repo)', () => {
    const result = gate({
      source: 'git:/no/such/repo',
      timestamp: '2026-04-30T12:00:00.000Z',
      content: 'whatever',
    });
    expect(result).toEqual({ accepted: false, reason: 'unknown_repo' });
  });

  it('accepts a git: source for an allowlisted repo via the gate', () => {
    // Add a synthetic repo to the allowlist, exercise the gate, then clean up.
    const repos = CAPTURED_SOURCES.git_repos as unknown as string[];
    const fakeRepo = '/tmp/echo-test-fake-repo';
    repos.push(fakeRepo);
    try {
      expect(isAllowedRepo(fakeRepo)).toBe(true);
      const result = gate({
        source: `git:${fakeRepo}`,
        timestamp: '2026-04-30T12:00:00.000Z',
        content: 'whatever',
      });
      expect(result).toEqual({ accepted: true, reason: 'allowlisted' });
    } finally {
      const idx = repos.lastIndexOf(fakeRepo);
      if (idx !== -1) repos.splice(idx, 1);
    }
  });

  it('logs handler_error instead of leaking an unhandled rejection when storage append rejects (Bug C)', async () => {
    const repo = await makeRepo();
    cleanups.push(pushAllowedRepo(repo));
    cleanups.push(() => rmSync(repo, { recursive: true, force: true }));
    await commitFile(repo, 'a.txt', '1', 'first');

    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);
    const captured = captureStdout();
    try {
      const h = await startGitWatcher([repo], new RejectingStorage(), { enableFsWatch: false });
      handles.push(h);

      await waitFor(
        () => unhandled.length > 0 || captured.writes.join('').includes('handler_error'),
        8000,
      );
      // Give any still-in-flight rejection a beat to surface as unhandled.
      await new Promise((r) => setTimeout(r, 100));

      expect(unhandled).toHaveLength(0);
      expect(captured.writes.join('')).toContain('handler_error');
    } finally {
      captured.restore();
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('respects ECHO_GIT_BACKFILL_COMMITS for backfill window', async () => {
    const repo = await makeRepo();
    cleanups.push(pushAllowedRepo(repo));
    cleanups.push(() => rmSync(repo, { recursive: true, force: true }));

    for (let i = 0; i < 5; i++) {
      await commitFile(repo, 'a.txt', String(i), `c${i}`);
    }

    const prev = process.env['ECHO_GIT_BACKFILL_COMMITS'];
    process.env['ECHO_GIT_BACKFILL_COMMITS'] = '2';
    cleanups.push(() => {
      if (prev === undefined) delete process.env['ECHO_GIT_BACKFILL_COMMITS'];
      else process.env['ECHO_GIT_BACKFILL_COMMITS'] = prev;
    });

    const storage = new MemoryStorage();
    const h = await startGitWatcher([repo], storage, { enableFsWatch: false });
    handles.push(h);

    await waitForCount(storage, 2);
    // give an extra moment to ensure no extra emissions trickle in
    await new Promise((r) => setTimeout(r, 200));
    expect(await storage.count()).toBe(2);
  });

  it('captures a fresh commit via fs watching with no polling needed', async () => {
    const repo = await makeRepo();
    cleanups.push(pushAllowedRepo(repo));
    cleanups.push(() => rmSync(repo, { recursive: true, force: true }));

    await commitFile(repo, 'a.txt', 'seed', 'seed');

    const storage = new MemoryStorage();
    // Long poll interval — only fs watching can plausibly catch the commit.
    const h = await startGitWatcher([repo], storage, {
      enableFsWatch: true,
      pollIntervalMs: 60_000,
    });
    handles.push(h);

    await waitForCount(storage, 1);

    await commitFile(repo, 'b.txt', 'second', 'second');
    await waitForCount(storage, 2, 8000);

    const events = await storage.query({ source: `git:${repo}`, order: 'asc' });
    expect(events.length).toBeGreaterThanOrEqual(2);
    // Item 025: deterministic id-ASC tie-break on same-second timestamps —
    // identify by content rather than position.
    expect(events.some((e) => e.content.includes(': second'))).toBe(true);
  });
});

describe('CAPTURED_SOURCES.git_repos', () => {
  it('starts empty so git capture requires explicit configuration', () => {
    expect(CAPTURED_SOURCES.git_repos).toEqual([]);
  });
});

describe('isAllowedRepo', () => {
  it('returns false on malformed input', () => {
    const malformed: unknown[] = [null, undefined, 42, '', {}, []];
    for (const v of malformed) {
      expect(isAllowedRepo(v as string)).toBe(false);
    }
  });

  it('matches an allowlisted repo with or without trailing slash', () => {
    const repos = CAPTURED_SOURCES.git_repos as unknown as string[];
    repos.push('/tmp/echo-isolated-repo');
    try {
      expect(isAllowedRepo('/tmp/echo-isolated-repo')).toBe(true);
      expect(isAllowedRepo('/tmp/echo-isolated-repo/')).toBe(true);
    } finally {
      const idx = repos.lastIndexOf('/tmp/echo-isolated-repo');
      if (idx !== -1) repos.splice(idx, 1);
    }
  });

  it('does not prefix-match (exact path required, unlike fs_paths)', () => {
    const repos = CAPTURED_SOURCES.git_repos as unknown as string[];
    repos.push('/tmp/echo-strict-repo');
    try {
      expect(isAllowedRepo('/tmp/echo-strict-repo/sub')).toBe(false);
      expect(isAllowedRepo('/tmp/echo-strict-repo-prefix-sibling')).toBe(false);
    } finally {
      const idx = repos.lastIndexOf('/tmp/echo-strict-repo');
      if (idx !== -1) repos.splice(idx, 1);
    }
  });
});
