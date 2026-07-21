import chokidar, { type ChokidarOptions, type FSWatcher } from 'chokidar';
import { stat, type Stats } from 'node:fs';
import { homedir } from 'node:os';
import { createLogger } from '../../logging/index.js';
import type { Storage } from '../../storage/interface.js';
import { expandTilde } from '../sources.js';
import { processCandidate } from '../pipeline.js';

const log = createLogger('capture.surfaces.fs');

const HOME = homedir();
const CLAUDE_PREFIX = `${HOME}/.claude/projects/`;

export type FsFileKind = 'claude-project';

export function classifyKind(absPath: string): FsFileKind | undefined {
  if (absPath.startsWith(CLAUDE_PREFIX)) return 'claude-project';
  return undefined;
}

export type FsEventType = 'add' | 'change' | 'unlink';

export interface FsNotification {
  eventType: FsEventType;
  path: string;
  stats?: Stats;
}

export interface FsNotificationQueueHealth {
  queueDepth: number;
  overflowCount: number;
}

export interface FsNotificationQueue {
  enqueue: (notification: FsNotification) => void;
  drain: () => Promise<void>;
  stop: () => Promise<void>;
  getHealth: () => FsNotificationQueueHealth;
}

export interface FsWatcherHandle {
  stop: () => Promise<void>;
  getHealth: () => FsNotificationQueueHealth;
}

export interface FsWatcherOptions {
  /** Legacy compatibility only. Raw chokidar notifications are observability
   *  signals, not semantic context events, so persistence is disabled by
   *  default. */
  persistRawEvents?: boolean;
  maxPendingPaths?: number;
  /** Test seam; production callers use chokidar.watch. */
  watcherFactory?: (paths: string[], options: ChokidarOptions) => FSWatcher;
}

interface FsEventContent {
  event_type: FsEventType;
  path: string;
  mtime?: string;
  size?: number;
}

interface FsEventMetadata extends Record<string, unknown> {
  surface: 'fs';
  file_kind?: FsFileKind;
}

function statAsync(absPath: string): Promise<Stats | null> {
  return new Promise((resolve) => {
    stat(absPath, (err, s) => resolve(err ? null : s));
  });
}

function ignored(filepath: string): boolean {
  // Database journals and temporary files are not semantic context events.
  if (/\bstate\.vscdb(-wal|-shm|-journal)?$/.test(filepath)) return true;
  if (filepath.endsWith('-journal')) return true;
  if (filepath.endsWith('.tmp')) return true;
  if (filepath.endsWith('/.DS_Store')) return true;
  return false;
}

async function emitCandidate(
  event_type: FsEventType,
  absPath: string,
  stats: Stats | undefined,
  storage: Storage,
): Promise<void> {
  const content: FsEventContent = { event_type, path: absPath };
  if (event_type !== 'unlink') {
    const s = stats ?? (await statAsync(absPath));
    if (s !== null) {
      content.mtime = s.mtime.toISOString();
      content.size = s.size;
    }
  }

  const file_kind = classifyKind(absPath);
  const metadata: FsEventMetadata = { surface: 'fs' };
  if (file_kind !== undefined) metadata.file_kind = file_kind;

  const candidate = {
    source: `fs:${absPath}`,
    timestamp: new Date().toISOString(),
    content: JSON.stringify(content),
    metadata,
  };

  log.info('candidate', { event_type, path: absPath, file_kind });
  const result = await processCandidate(candidate, storage);
  if (!result.accepted) {
    log.debug('rejected', { reason: result.reason, path: absPath });
  }
}

/** A serial, path-coalescing notification queue. At most `maxPendingPaths`
 * distinct paths wait behind the active callback; repeated notifications for
 * a path retain only the latest event. */
export function createFsNotificationQueue(options: {
  maxPendingPaths?: number;
  process: (notification: FsNotification) => Promise<void>;
  onError?: (error: unknown, notification: FsNotification) => void;
  onOverflow?: (notification: FsNotification, overflowCount: number) => void;
}): FsNotificationQueue {
  const maxPendingPaths = positiveInteger(options.maxPendingPaths, 1024);
  const pending = new Map<string, FsNotification>();
  const idleWaiters = new Set<() => void>();
  let accepting = true;
  let activePath: string | null = null;
  let activeReplacement: FsNotification | null = null;
  let deferredActive: FsNotification | null = null;
  let worker: Promise<void> | null = null;
  let stopPromise: Promise<void> | null = null;
  let overflowCount = 0;

  function isIdle(): boolean {
    return activePath === null && pending.size === 0 && deferredActive === null;
  }

  function notifyIdle(): void {
    if (!isIdle()) return;
    for (const resolve of idleWaiters) resolve();
    idleWaiters.clear();
  }

  function drain(): Promise<void> {
    if (isIdle()) return Promise.resolve();
    return new Promise((resolve) => idleWaiters.add(resolve));
  }

  function kickWorker(): void {
    if (worker !== null) return;
    // Assign the worker slot before a no-work run can synchronously clear it.
    worker = Promise.resolve().then(async () => {
      try {
        while (true) {
          let next: FsNotification | undefined;
          const first = pending.entries().next();
          if (first.done !== true) {
            const [path, notification] = first.value;
            pending.delete(path);
            next = notification;
          } else if (deferredActive !== null) {
            next = deferredActive;
            deferredActive = null;
          }
          if (next === undefined) break;

          activePath = next.path;
          activeReplacement = null;
          try {
            await options.process(next);
          } catch (err) {
            options.onError?.(err, next);
          } finally {
            activePath = null;
            if (activeReplacement !== null) {
              deferredActive = activeReplacement;
              activeReplacement = null;
            }
          }
        }
      } finally {
        worker = null;
        notifyIdle();
        if (!isIdle()) kickWorker();
      }
    });
  }

  function enqueue(notification: FsNotification): void {
    if (!accepting) return;
    if (activePath === notification.path) {
      activeReplacement = notification;
      return;
    }
    if (deferredActive?.path === notification.path) {
      deferredActive = notification;
      return;
    }
    if (pending.has(notification.path)) {
      pending.set(notification.path, notification);
      return;
    }
    if (pending.size >= maxPendingPaths) {
      overflowCount += 1;
      options.onOverflow?.(notification, overflowCount);
      return;
    }
    pending.set(notification.path, notification);
    kickWorker();
  }

  return {
    enqueue,
    drain,
    stop: async () => {
      if (stopPromise !== null) return stopPromise;
      stopPromise = (async () => {
        accepting = false;
        kickWorker();
        await drain();
        if (worker !== null) await worker;
      })();
      return stopPromise;
    },
    getHealth: () => ({ queueDepth: pending.size, overflowCount }),
  };
}

export async function startFsWatcher(
  paths: ReadonlyArray<string>,
  storage: Storage,
  options: FsWatcherOptions = {},
): Promise<FsWatcherHandle> {
  const expanded = paths.map(expandTilde);
  const watch = options.watcherFactory ?? chokidar.watch;
  const watcher: FSWatcher = watch(expanded, {
    ignoreInitial: true,
    persistent: true,
    alwaysStat: true,
    awaitWriteFinish: false,
    ignored,
  });

  const queue = createFsNotificationQueue({
    maxPendingPaths: options.maxPendingPaths,
    process: async ({ eventType, path, stats }) => {
      log.debug('chokidar_event', { event_type: eventType, path });
      if (options.persistRawEvents !== true) return;
      await emitCandidate(eventType, path, stats, storage);
    },
    onError: (err, notification) => {
      log.error('handler_error', {
        message: (err as Error).message,
        path: notification.path,
      });
    },
    onOverflow: (notification, overflowCount) => {
      if (overflowCount === 1 || overflowCount % 100 === 0) {
        log.warn('pending_queue_overflow', {
          path: notification.path,
          max_pending_paths: positiveInteger(options.maxPendingPaths, 1024),
          overflow_count: overflowCount,
        });
      }
    },
  });

  watcher.on('add', (p: string, stats?: Stats) => {
    queue.enqueue({ eventType: 'add', path: p, stats });
  });
  watcher.on('change', (p: string, stats?: Stats) => {
    queue.enqueue({ eventType: 'change', path: p, stats });
  });
  watcher.on('unlink', (p: string) => {
    queue.enqueue({ eventType: 'unlink', path: p });
  });
  watcher.on('error', (err: unknown) => {
    log.error('watcher_error', { message: (err as Error).message });
  });

  await new Promise<void>((resolve) => {
    watcher.once('ready', () => resolve());
  });

  log.info('started', {
    paths: expanded,
    persist_raw_events: options.persistRawEvents === true,
  });

  return {
    stop: async () => {
      await watcher.close();
      await queue.stop();
      log.info('stopped', {});
    },
    getHealth: queue.getHealth,
  };
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isSafeInteger(value) && value > 0
    ? value
    : fallback;
}
