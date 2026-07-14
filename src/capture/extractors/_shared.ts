import { open, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import chokidar, { type FSWatcher } from 'chokidar';
import type { Logger } from '../../logging/index.js';
import type { CaptureEvent } from '../../storage/interface.js';

/** Path-fragment markers used to identify which agent surface produced an
 *  event. Centralised so causal.ts, render-trace, serve-trace, and
 *  stream-watch all sniff against the same strings. */
export const SOURCE_MARKERS = {
  codex: '/.codex/sessions/',
  cc: '/.claude/projects/',
  cursor: '/Cursor/',
} as const;

export type Lane = 'cc' | 'codex' | 'cursor' | 'git' | 'other';

export function laneOf(event: CaptureEvent): Lane {
  if (event.source.startsWith('git:')) return 'git';
  if (event.source.includes(SOURCE_MARKERS.codex)) return 'codex';
  if (event.source.includes(SOURCE_MARKERS.cc)) return 'cc';
  if (event.source.includes(SOURCE_MARKERS.cursor)) return 'cursor';
  return 'other';
}

export function dedupStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of values) {
    if (!seen.has(v)) {
      seen.add(v);
      out.push(v);
    }
  }
  return out;
}

// On daemon boot, chokidar's `ignoreInitial: true` suppresses the `add` events
// for already-existing JSONL files, and the offset-map backfill only seeds
// entries for files already in storage. Files that exist at boot AND never
// see a post-boot write — most acutely, write-then-closed subagent JSONLs —
// would otherwise be silently never processed. This walk schedules one
// `handle` call per existing `.jsonl` so the offset-map's prior bytes are
// honored and only newly-appended bytes get emitted as fresh CaptureEvents.
// Shared chokidar config for both JSONL extractors. Polling exists because
// macOS FSEvents coalesces rapid in-place appends; polling caps staleness at
// the interval. The cursor extractor uses a different substrate (sqlite) and
// owns its own watch options.
export const JSONL_WATCH_OPTS = {
  ignoreInitial: true,
  persistent: true,
  awaitWriteFinish: false,
  usePolling: true,
  interval: 1000,
} as const;

export interface FreshnessProbe {
  maxGapBytes: number;
  maxGapPath: string | null;
  filesChecked: number;
}

export interface ExtractorHandle {
  stop: () => Promise<void>;
  probeFreshness: () => Promise<FreshnessProbe>;
}

/** Persistent non-zero gap = the watcher is dropping events. */
export async function probeFreshness(
  offsetMap: Map<string, { offset: number }>,
): Promise<FreshnessProbe> {
  const results = await Promise.all(
    Array.from(offsetMap, async ([path, entry]) => {
      try {
        const st = await stat(path);
        return { path, gap: st.size - entry.offset, ok: true as const };
      } catch {
        return { path, gap: 0, ok: false as const };
      }
    }),
  );
  let maxGapBytes = 0;
  let maxGapPath: string | null = null;
  let filesChecked = 0;
  for (const r of results) {
    if (!r.ok) continue;
    filesChecked += 1;
    if (r.gap > maxGapBytes) {
      maxGapBytes = r.gap;
      maxGapPath = r.path;
    }
  }
  return { maxGapBytes, maxGapPath, filesChecked };
}

export async function bootScanJsonl(
  prefix: string,
  schedule: (work: () => Promise<void>) => void,
  handle: (path: string) => Promise<void>,
  log: Logger,
): Promise<void> {
  try {
    const entries = await readdir(prefix, { recursive: true, withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      if (!entry.name.endsWith('.jsonl')) continue;
      schedule(() => handle(join(entry.parentPath, entry.name)));
    }
  } catch (err) {
    log.warn('boot_scan_failed', { prefix, message: (err as Error).message });
  }
}

/** Read newly-appended lines from a JSONL file since `lastByteOffset`.
 *  Returns `null` on stat/open failures (caller should bail). On success
 *  returns the line list and the byte offset of the start of the first line
 *  in that list — line offsets advance by `Buffer.byteLength(line)+1`. The
 *  returned `lines` array is empty (with a defined `mtimeMs`) when the file
 *  has not grown or has no complete line. */
export async function readJsonlTail(
  jsonlPath: string,
  lastByteOffset: number,
  log: Logger,
): Promise<{ lines: string[]; firstLineOffset: number; mtimeMs: number } | null> {
  let st: Awaited<ReturnType<typeof stat>>;
  try {
    st = await stat(jsonlPath);
  } catch (err) {
    log.warn('stat_failed', { path: jsonlPath, message: (err as Error).message });
    return null;
  }
  if (st.size <= lastByteOffset) {
    return { lines: [], firstLineOffset: lastByteOffset, mtimeMs: st.mtimeMs };
  }

  const length = st.size - lastByteOffset;
  const buffer = Buffer.alloc(length);
  let fh: Awaited<ReturnType<typeof open>>;
  try {
    fh = await open(jsonlPath, 'r');
  } catch (err) {
    log.warn('open_failed', { path: jsonlPath, message: (err as Error).message });
    return null;
  }
  try {
    await fh.read(buffer, 0, length, lastByteOffset);
  } finally {
    await fh.close();
  }

  const text = buffer.toString('utf8');
  const lastNewline = text.lastIndexOf('\n');
  if (lastNewline === -1) {
    return { lines: [], firstLineOffset: lastByteOffset, mtimeMs: st.mtimeMs };
  }
  const consumable = text.slice(0, lastNewline + 1);
  const lines = consumable.split('\n').filter((l) => l.length > 0);
  return { lines, firstLineOffset: lastByteOffset, mtimeMs: st.mtimeMs };
}

/** Wire up a chokidar watcher + serialised processing queue + boot scan for a
 *  JSONL prefix. Returns an `ExtractorHandle` whose `stop` shuts the watcher
 *  and drains the queue. Caller supplies the per-file handler and the offset
 *  map the freshness probe should read. */
export async function wireJsonlExtractor(opts: {
  prefix: string;
  offsetMap: Map<string, { offset: number }>;
  handle: (path: string) => Promise<void>;
  log: Logger;
}): Promise<ExtractorHandle> {
  const { prefix, offsetMap, handle, log } = opts;
  let processing: Promise<void> = Promise.resolve();
  let stopped = false;

  function isJsonl(p: string): boolean {
    return p.startsWith(prefix) && p.endsWith('.jsonl');
  }

  function schedule(work: () => Promise<void>): void {
    if (stopped) return;
    processing = processing.then(async () => {
      if (stopped) return;
      try {
        await work();
      } catch (err) {
        log.error('handler_error', { message: (err as Error).message });
      }
    });
  }

  const watcher: FSWatcher = chokidar.watch(prefix, JSONL_WATCH_OPTS);

  function dispatch(p: string): void {
    if (isJsonl(p)) schedule(() => handle(p));
  }

  watcher.on('add', dispatch);
  watcher.on('change', dispatch);
  watcher.on('error', (err: unknown) => {
    log.error('watcher_error', { message: (err as Error).message });
  });

  await new Promise<void>((resolve) => {
    watcher.once('ready', () => resolve());
  });

  await bootScanJsonl(prefix, schedule, handle, log);

  return {
    stop: async () => {
      stopped = true;
      await watcher.close();
      await processing;
    },
    probeFreshness: () => probeFreshness(offsetMap),
  };
}
