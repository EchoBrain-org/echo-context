import { EventEmitter } from 'node:events';
import {
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
  appendFileSync,
  unlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FSWatcher } from 'chokidar';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CAPTURED_SOURCES,
  _isAllowedPathIn,
} from '../../../src/capture/sources.js';
import {
  classifyKind,
  createFsNotificationQueue,
  startFsWatcher,
  type FsWatcherHandle,
} from '../../../src/capture/surfaces/fs-watcher.js';
import type { CaptureEvent, EventId } from '../../../src/storage/interface.js';
import { MemoryStorage } from '../../../src/storage/memory.js';
import {
  resetAllowlist,
  restoreFsPaths,
  snapshotFsPaths,
} from '../../fixtures/allowlist.js';
import { waitFor } from '../../fixtures/jsonl.js';
import { captureStdout } from '../../fixtures/stdout.js';

async function waitForCount(
  storage: MemoryStorage,
  target: number,
  timeoutMs = 5000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const n = await storage.count();
    if (n >= target) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(
    `storage count never reached ${target}; current=${await storage.count()}`,
  );
}

interface FsContent {
  event_type: string;
  path: string;
  mtime?: string;
  size?: number;
}

function parseContent(evt: CaptureEvent): FsContent {
  return JSON.parse(evt.content) as FsContent;
}

// SKIPPED: every test in this block calls startFsWatcher directly, holding
// a chokidar/FSEvents watcher whose `watcher.close()` runs slow under load
// on macOS — afterEach's `handle.stop()` then races the next test's setup,
// flaking ~33% of solo runs (surfaced during 023's verification). The
// failing test rotates across the block (add/change/unlink/ignore-WAL/stop),
// so per-test skips can't pin it. The block is quarantined wholesale by item
// 2026-05-08-024-fs-watcher-test-quarantine-successor; test bodies are intact for when
// the underlying race is fixed.
describe.skip('startFsWatcher', () => {
  let dir: string;
  let storage: MemoryStorage;
  let handle: FsWatcherHandle | null = null;
  let originalFsPaths: string[];
  let restoreStdout: () => void;

  beforeEach(() => {
    originalFsPaths = snapshotFsPaths();
    dir = mkdtempSync(join(tmpdir(), 'echo-fs-watcher-'));
    storage = new MemoryStorage();
    ({ restore: restoreStdout } = captureStdout());

    // Test-only allowlist mutation: include the temp dir as a prefix entry
    (CAPTURED_SOURCES.fs_paths as unknown as string[]).push(`${dir}/`);
  });

  afterEach(async () => {
    if (handle !== null) {
      await handle.stop();
      handle = null;
    }
    restoreStdout();
    resetAllowlist();
    restoreFsPaths(originalFsPaths);
    rmSync(dir, { recursive: true, force: true });
  });

  it('emits an add event when a file is created', async () => {
    handle = await startFsWatcher([dir], storage, { persistRawEvents: true });

    const filePath = join(dir, 'a.txt');
    writeFileSync(filePath, 'hello');

    await waitForCount(storage, 1);
    const all = await storage.query({ order: 'asc' });
    const evt = all[0]!;
    expect(evt.source).toBe(`fs:${filePath}`);
    const content = parseContent(evt);
    expect(content.event_type).toBe('add');
    expect(content.path).toBe(filePath);
    expect(typeof content.mtime).toBe('string');
    expect(typeof content.size).toBe('number');
    expect(evt.metadata).toEqual({ surface: 'fs' });
  });

  it('emits a change event when a file is modified', async () => {
    const filePath = join(dir, 'b.txt');
    writeFileSync(filePath, 'first');

    handle = await startFsWatcher([dir], storage, { persistRawEvents: true });

    appendFileSync(filePath, ' second');

    await waitForCount(storage, 1);
    const all = await storage.query({ order: 'asc' });
    const matching = all.filter((e) => e.source === `fs:${filePath}`);
    expect(matching.length).toBeGreaterThanOrEqual(1);
    const types = matching.map((e) => parseContent(e).event_type);
    expect(types).toContain('change');
  });

  it('ignores SQLite WAL artifacts while still capturing normal files', async () => {
    handle = await startFsWatcher([dir], storage, { persistRawEvents: true });

    const walPath = join(dir, 'state.vscdb-wal');
    const filePath = join(dir, 'normal.txt');
    writeFileSync(walPath, '');
    writeFileSync(filePath, 'hello');

    await waitForCount(storage, 1);
    await new Promise((r) => setTimeout(r, 300));
    const all = await storage.query({ order: 'asc' });
    expect(all.some((e) => e.source === `fs:${walPath}`)).toBe(false);
    expect(all.some((e) => e.source === `fs:${filePath}`)).toBe(true);
  });

  it('emits an unlink event when a file is deleted (no size in content)', async () => {
    const filePath = join(dir, 'c.txt');
    writeFileSync(filePath, 'gone soon');

    handle = await startFsWatcher([dir], storage, { persistRawEvents: true });

    unlinkSync(filePath);

    await waitForCount(storage, 1);
    const all = await storage.query({ order: 'asc' });
    const matching = all.filter((e) => parseContent(e).event_type === 'unlink');
    expect(matching.length).toBeGreaterThanOrEqual(1);
    const c = parseContent(matching[0]!);
    expect(c.path).toBe(filePath);
    expect(c.size).toBeUndefined();
  });

  it('does not fire for files that already exist when the watcher starts', async () => {
    const pre = join(dir, 'pre.txt');
    writeFileSync(pre, 'already here');
    // Let macOS FSEvents flush the create-event for pre.txt before the watcher
    // starts, so chokidar's initial-scan suppression (ignoreInitial=true) sees
    // it as old, not a fresh post-ready event.
    await new Promise((r) => setTimeout(r, 600));

    handle = await startFsWatcher([dir], storage, { persistRawEvents: true });

    await new Promise((r) => setTimeout(r, 300));
    expect(await storage.count()).toBe(0);

    // A subsequent change should still fire
    const newer = join(dir, 'new.txt');
    writeFileSync(newer, 'fresh');
    await waitForCount(storage, 1);
  });

  it('stop() resolves and prevents further events from being captured', async () => {
    handle = await startFsWatcher([dir], storage, { persistRawEvents: true });
    writeFileSync(join(dir, 'one.txt'), 'a');
    await waitForCount(storage, 1);
    const before = await storage.count();

    await handle.stop();
    handle = null;

    writeFileSync(join(dir, 'two.txt'), 'b');
    await new Promise((r) => setTimeout(r, 300));
    expect(await storage.count()).toBe(before);
  });
});

class FakeFsWatcher extends EventEmitter {
  async close(): Promise<void> {
    return Promise.resolve();
  }

  asFsWatcher(): FSWatcher {
    return this as unknown as FSWatcher;
  }
}

describe('bounded raw fs notifications', () => {
  it('coalesces each path to its latest event, stays serial, and caps pending paths', async () => {
    const processed: Array<{ eventType: string; path: string }> = [];
    let active = 0;
    let maxActive = 0;
    let releaseFirst: () => void = () => undefined;
    const firstRelease = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let markFirstStarted: () => void = () => undefined;
    const firstStarted = new Promise<void>((resolve) => {
      markFirstStarted = resolve;
    });

    const queue = createFsNotificationQueue({
      maxPendingPaths: 1,
      process: async (notification) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        processed.push({
          eventType: notification.eventType,
          path: notification.path,
        });
        if (processed.length === 1) {
          markFirstStarted();
          await firstRelease;
        }
        active -= 1;
      },
    });

    queue.enqueue({ eventType: 'add', path: '/a' });
    await firstStarted;
    queue.enqueue({ eventType: 'change', path: '/a' });
    queue.enqueue({ eventType: 'unlink', path: '/a' });
    queue.enqueue({ eventType: 'add', path: '/b' });
    queue.enqueue({ eventType: 'change', path: '/b' });
    queue.enqueue({ eventType: 'add', path: '/c' });

    expect(queue.getHealth()).toEqual({ queueDepth: 1, overflowCount: 1 });
    releaseFirst();
    await queue.stop();

    expect(processed).toEqual([
      { eventType: 'add', path: '/a' },
      { eventType: 'change', path: '/b' },
      { eventType: 'unlink', path: '/a' },
    ]);
    expect(maxActive).toBe(1);
    expect(queue.getHealth()).toEqual({ queueDepth: 0, overflowCount: 1 });
  });

  it('does not persist raw notifications by default, but supports explicit legacy persistence', async () => {
    const originalFsPaths = snapshotFsPaths();
    const dir = realpathSync(
      mkdtempSync(join(tmpdir(), 'echo-fs-watcher-default-')),
    );
    (CAPTURED_SOURCES.fs_paths as unknown as string[]).push(`${dir}/`);
    const filePath = join(dir, 'event.txt');
    writeFileSync(filePath, 'hello');

    try {
      const defaultStorage = new MemoryStorage();
      const defaultWatcher = new FakeFsWatcher();
      const defaultHandlePromise = startFsWatcher([dir], defaultStorage, {
        watcherFactory: () => {
          queueMicrotask(() => defaultWatcher.emit('ready'));
          return defaultWatcher.asFsWatcher();
        },
      });
      const defaultHandle = await defaultHandlePromise;
      defaultWatcher.emit('add', filePath);
      await defaultHandle.stop();
      expect(await defaultStorage.count()).toBe(0);

      const legacyStorage = new MemoryStorage();
      const legacyWatcher = new FakeFsWatcher();
      const legacyHandlePromise = startFsWatcher([dir], legacyStorage, {
        persistRawEvents: true,
        watcherFactory: () => {
          queueMicrotask(() => legacyWatcher.emit('ready'));
          return legacyWatcher.asFsWatcher();
        },
      });
      const legacyHandle = await legacyHandlePromise;
      legacyWatcher.emit('add', filePath);
      await legacyHandle.stop();
      expect(await legacyStorage.count()).toBe(1);
    } finally {
      resetAllowlist();
      restoreFsPaths(originalFsPaths);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// NOT part of the quarantined block above: a single watcher instance with no
// sibling watcher tests racing its stop() — the quarantine's flake mode
// (afterEach close racing the NEXT test's chokidar setup) doesn't apply.
describe('startFsWatcher emit-path error containment (Bug C)', () => {
  class RejectingStorage extends MemoryStorage {
    override async append(): Promise<EventId> {
      throw new Error('synthetic storage failure');
    }
  }

  let dir: string;
  let handle: FsWatcherHandle | null = null;
  let originalFsPaths: string[];
  let captured: ReturnType<typeof captureStdout>;

  beforeEach(() => {
    originalFsPaths = snapshotFsPaths();
    // realpath so chokidar's resolved event paths (macOS /var → /private/var)
    // match the allowlist entry — same trick as the git-watcher harness.
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'echo-fs-watcher-bugc-')));
    captured = captureStdout();
    (CAPTURED_SOURCES.fs_paths as unknown as string[]).push(`${dir}/`);
  });

  afterEach(async () => {
    if (handle !== null) {
      await handle.stop();
      handle = null;
    }
    captured.restore();
    resetAllowlist();
    restoreFsPaths(originalFsPaths);
    rmSync(dir, { recursive: true, force: true });
  });

  it('logs handler_error instead of leaking an unhandled rejection when storage append rejects', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);
    try {
      const watcher = new FakeFsWatcher();
      handle = await startFsWatcher([dir], new RejectingStorage(), {
        persistRawEvents: true,
        watcherFactory: () => {
          queueMicrotask(() => watcher.emit('ready'));
          return watcher.asFsWatcher();
        },
      });
      const filePath = join(dir, 'a.txt');
      writeFileSync(filePath, 'hello');
      watcher.emit('add', filePath);

      await waitFor(
        () =>
          unhandled.length > 0 ||
          captured.writes.join('').includes('handler_error'),
      );
      // Give any still-in-flight rejection a beat to surface as unhandled.
      await new Promise((r) => setTimeout(r, 100));

      expect(unhandled).toHaveLength(0);
      expect(captured.writes.join('')).toContain('handler_error');
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });
});

describe('classifyKind', () => {
  it("returns 'claude-project' for paths under ~/.claude/projects/", () => {
    const path = `${process.env['HOME']!}/.claude/projects/foo/session.jsonl`;
    expect(classifyKind(path)).toBe('claude-project');
  });

  it('returns undefined for unrelated paths', () => {
    expect(classifyKind('/tmp/foo.txt')).toBeUndefined();
  });
});

describe('_isAllowedPathIn tilde expansion (FS allowlist contract)', () => {
  it('accepts a Claude Code project file under ~/.claude/projects/', () => {
    const home = process.env['HOME']!;
    const concretePath = `${home}/.claude/projects/foo/session.jsonl`;
    const allowlist = ['~/.claude/projects/'];
    expect(_isAllowedPathIn(concretePath, allowlist)).toBe(true);
  });

  it("rejects sibling paths that don't share the prefix", () => {
    const home = process.env['HOME']!;
    expect(
      _isAllowedPathIn(`${home}/Library/Other/foo`, ['~/.claude/projects/']),
    ).toBe(false);
  });

  it('confirms the production allowlist contains only the two live coding sources', () => {
    const fsPaths = CAPTURED_SOURCES.fs_paths as unknown as string[];
    expect(fsPaths).toEqual(['~/.claude/projects/', '~/.codex/sessions/']);
  });
});
