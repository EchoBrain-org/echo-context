import chokidar, { type FSWatcher } from 'chokidar';
import { stat, type Stats } from 'node:fs';
import { homedir } from 'node:os';
import { createLogger } from '../../logging/index.js';
import type { Storage } from '../../storage/interface.js';
import { expandTilde } from '../sources.js';
import { processCandidate } from '../pipeline.js';

const log = createLogger('capture.surfaces.fs');

const HOME = homedir();
const CURSOR_PREFIX = `${HOME}/Library/Application Support/Cursor/User/workspaceStorage/`;
const CLAUDE_PREFIX = `${HOME}/.claude/projects/`;

export type FsFileKind = 'cursor-workspace' | 'claude-project';

export function classifyKind(absPath: string): FsFileKind | undefined {
  if (absPath.startsWith(CURSOR_PREFIX)) return 'cursor-workspace';
  if (absPath.startsWith(CLAUDE_PREFIX)) return 'claude-project';
  return undefined;
}

export interface FsWatcherHandle {
  stop: () => Promise<void>;
}

type EventType = 'add' | 'change' | 'unlink';

interface FsEventContent {
  event_type: EventType;
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
  // Cursor's SQLite triplet is owned by the cursor extractor; don't double-capture.
  if (/\bstate\.vscdb(-wal|-shm|-journal)?$/.test(filepath)) return true;
  if (filepath.endsWith('-journal')) return true;
  if (filepath.endsWith('.tmp')) return true;
  if (filepath.endsWith('/.DS_Store')) return true;
  return false;
}

async function emitCandidate(
  event_type: EventType,
  absPath: string,
  stats: Stats | undefined,
  storage: Storage,
): Promise<void> {
  log.debug('chokidar_event', { event_type, path: absPath });

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

export async function startFsWatcher(
  paths: ReadonlyArray<string>,
  storage: Storage,
): Promise<FsWatcherHandle> {
  const expanded = paths.map(expandTilde);
  const watcher: FSWatcher = chokidar.watch(expanded, {
    ignoreInitial: true,
    persistent: true,
    alwaysStat: true,
    awaitWriteFinish: false,
    ignored,
  });

  // emitCandidate has no internal try/catch, so a storage failure would
  // otherwise escape the fire-and-forget call as an unhandled rejection and
  // kill the daemon. Mirror the extractors' handler_error containment.
  function emitSafely(event_type: EventType, p: string, stats: Stats | undefined): void {
    emitCandidate(event_type, p, stats, storage).catch((err: unknown) => {
      log.error('handler_error', { message: (err as Error).message, path: p });
    });
  }

  watcher.on('add', (p: string, stats?: Stats) => {
    emitSafely('add', p, stats);
  });
  watcher.on('change', (p: string, stats?: Stats) => {
    emitSafely('change', p, stats);
  });
  watcher.on('unlink', (p: string) => {
    emitSafely('unlink', p, undefined);
  });
  watcher.on('error', (err: unknown) => {
    log.error('watcher_error', { message: (err as Error).message });
  });

  await new Promise<void>((resolve) => {
    watcher.once('ready', () => resolve());
  });

  log.info('started', { paths: expanded });

  return {
    stop: async () => {
      await watcher.close();
      log.info('stopped', {});
    },
  };
}
