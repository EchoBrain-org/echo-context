import chokidar, { type FSWatcher } from 'chokidar';
import { execFile } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { isNonEmptyString } from '../../guards.js';
import { createLogger } from '../../logging/index.js';
import type { Storage } from '../../storage/interface.js';
import { scrubOriginUrlCredentials } from '../git-state.js';
import { processCandidate } from '../pipeline.js';
import { normalizeRepoPath } from '../sources.js';
import { canonicalizePath, GIT_PROBE_TIMEOUT_MS, gitToplevel } from '../workspace-root.js';

const log = createLogger('capture.surfaces.git');
const execFileP = promisify(execFile);

const DIFF_TRUNCATE_BYTES = 100 * 1024;
const DEFAULT_POLL_MS = 30_000;
const DEFAULT_BACKFILL = 50;
const FORMAT = '%H%x1f%P%x1f%aI%x1f%an%x1f%s%x1f%b%x1e';
const ORIGIN_CACHE_TTL_MS = 5_000;
const ORIGIN_CACHE_MAX_ENTRIES = 256;

function getBackfillCount(): number {
  const env = process.env['ECHO_GIT_BACKFILL_COMMITS'];
  if (isNonEmptyString(env)) {
    const n = Number.parseInt(env, 10);
    if (Number.isInteger(n) && n >= 0) return n;
  }
  return DEFAULT_BACKFILL;
}

interface CommitInfo {
  sha: string;
  parent_sha: string | undefined;
  author: string;
  author_iso: string;
  subject: string;
  body: string;
}

async function git(args: string[], cwd: string): Promise<string | null> {
  try {
    const { stdout } = await execFileP('git', args, {
      cwd,
      maxBuffer: 16 * 1024 * 1024,
    });
    return stdout;
  } catch (err) {
    log.warn('git_command_failed', {
      cwd,
      args: args.slice(0, 2),
      message: (err as Error).message,
    });
    return null;
  }
}

interface OriginCacheEntry {
  originUrl: string;
  expiresAt: number;
  configMtimeMs: number | null;
}

const originCache = new Map<string, OriginCacheEntry>();

function lruSet<K, V>(map: Map<K, V>, key: K, value: V, maxEntries: number): void {
  if (map.size >= maxEntries && !map.has(key)) {
    const oldest = map.keys().next().value;
    if (oldest !== undefined) map.delete(oldest);
  }
  map.set(key, value);
}

async function repoConfigMtime(repo: string): Promise<number | null> {
  try {
    const st = await stat(join(repo, '.git', 'config'));
    return st.mtimeMs;
  } catch {
    return null;
  }
}

async function getOriginUrl(repo: string): Promise<string | null> {
  try {
    const { stdout } = await execFileP('git', ['-C', repo, 'remote', 'get-url', 'origin'], {
      timeout: GIT_PROBE_TIMEOUT_MS,
      maxBuffer: 1_024 * 1_024,
    });
    return stdout.trim();
  } catch {
    return null;
  }
}

async function resolveOriginUrl(repo: string): Promise<string | undefined> {
  const now = Date.now();
  const configMtimeMs = await repoConfigMtime(repo);
  const cached = originCache.get(repo);
  if (cached !== undefined && cached.expiresAt > now && cached.configMtimeMs === configMtimeMs) {
    return cached.originUrl;
  }

  const originUrl = scrubOriginUrlCredentials(await getOriginUrl(repo));
  if (originUrl === undefined) {
    originCache.delete(repo);
    return undefined;
  }

  lruSet(
    originCache,
    repo,
    { originUrl, expiresAt: now + ORIGIN_CACHE_TTL_MS, configMtimeMs },
    ORIGIN_CACHE_MAX_ENTRIES,
  );
  return originUrl;
}

async function resolveGitCanonicalRoot(repo: string): Promise<string | undefined> {
  const toplevel = await gitToplevel(repo);
  if (toplevel === null) return undefined;
  return canonicalizePath(toplevel);
}

async function getHead(repo: string): Promise<string | null> {
  const out = await git(['rev-parse', 'HEAD'], repo);
  return out === null ? null : out.trim();
}

function parseCommitRecords(out: string): CommitInfo[] {
  const commits: CommitInfo[] = [];
  const records = out.split('\x1e');
  for (const rec of records) {
    if (rec.length === 0) continue;
    const fields = rec.split('\x1f');
    if (fields.length < 6) continue;
    const sha = fields[0];
    const parents = fields[1];
    const authorIso = fields[2];
    const author = fields[3];
    const subject = fields[4];
    const body = fields[5];
    if (
      sha === undefined ||
      parents === undefined ||
      authorIso === undefined ||
      author === undefined ||
      subject === undefined ||
      body === undefined
    ) {
      continue;
    }
    const trimmedSha = sha.replace(/^\n+/, '').trim();
    if (trimmedSha.length === 0) continue;
    const parentList = parents.trim();
    const parent_sha = parentList.length === 0 ? undefined : parentList.split(' ')[0];
    commits.push({
      sha: trimmedSha,
      parent_sha,
      author_iso: authorIso.trim(),
      author: author.trim(),
      subject: subject.trim(),
      body: body.replace(/^\n+/, '').replace(/\n+$/, ''),
    });
  }
  return commits;
}

async function enumerateNewCommits(
  repo: string,
  newHead: string,
  lastSeen: string | undefined,
  backfillLimit: number,
): Promise<CommitInfo[]> {
  const args: string[] = ['log', '--reverse', `--format=${FORMAT}`];
  if (lastSeen !== undefined) {
    args.push(`${lastSeen}..${newHead}`);
  } else {
    if (backfillLimit > 0) args.push(`-${backfillLimit}`);
    args.push(newHead);
  }
  const out = await git(args, repo);
  if (out === null || out.length === 0) return [];
  return parseCommitRecords(out);
}

interface CommitStats {
  files_changed: number;
  additions: number;
  deletions: number;
}

async function getCommitStats(repo: string, sha: string): Promise<CommitStats> {
  const out = await git(['show', sha, '--no-color', '--format=', '--shortstat'], repo);
  if (out === null) return { files_changed: 0, additions: 0, deletions: 0 };
  const line = out.trim();
  let files_changed = 0;
  let additions = 0;
  let deletions = 0;
  const fc = /(\d+)\s+files?\s+changed/.exec(line);
  if (fc !== null) files_changed = Number.parseInt(fc[1] as string, 10);
  const ad = /(\d+)\s+insertions?\(\+\)/.exec(line);
  if (ad !== null) additions = Number.parseInt(ad[1] as string, 10);
  const dl = /(\d+)\s+deletions?\(-\)/.exec(line);
  if (dl !== null) deletions = Number.parseInt(dl[1] as string, 10);
  return { files_changed, additions, deletions };
}

async function getChangedFiles(
  repo: string,
  sha: string,
  parent: string | undefined,
): Promise<string[]> {
  const args =
    parent !== undefined
      ? ['diff', '--name-only', `${parent}..${sha}`]
      : ['show', '--name-only', '--format=', sha];
  const out = await git(args, repo);
  if (out === null) return [];
  const files: string[] = [];
  for (const line of out.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length > 0) files.push(join(repo, trimmed));
  }
  return files;
}

async function getDiff(repo: string, sha: string, parent: string | undefined): Promise<string> {
  const raw =
    parent !== undefined
      ? await git(['diff', `${parent}..${sha}`, '--no-color'], repo)
      : await git(['show', sha, '--no-color', '--format='], repo);
  if (raw === null) return '';
  if (raw.length > DIFF_TRUNCATE_BYTES) {
    return (
      raw.slice(0, DIFF_TRUNCATE_BYTES) +
      `\n[diff truncated at ${DIFF_TRUNCATE_BYTES} bytes; full diff at ${sha}]\n`
    );
  }
  return raw;
}

function shortSha(sha: string): string {
  return sha.slice(0, 7);
}

async function buildAndEmit(repo: string, commit: CommitInfo, storage: Storage): Promise<boolean> {
  const [stats, diff, changedFiles, originUrl, canonicalRoot] = await Promise.all([
    getCommitStats(repo, commit.sha),
    getDiff(repo, commit.sha, commit.parent_sha),
    getChangedFiles(repo, commit.sha, commit.parent_sha),
    resolveOriginUrl(repo),
    resolveGitCanonicalRoot(repo),
  ]);

  const bodyBlock = commit.body.length > 0 ? `${commit.body}\n\n` : '';
  const content = `COMMIT ${shortSha(commit.sha)}: ${commit.subject}\n\n${bodyBlock}--- DIFF ---\n${diff}`;

  const metadata: Record<string, unknown> = {
    sha: commit.sha,
    author: commit.author,
    files_changed: stats.files_changed,
    additions: stats.additions,
    deletions: stats.deletions,
    repo_root: repo,
  };
  if (commit.parent_sha !== undefined) metadata['parent_sha'] = commit.parent_sha;
  if (changedFiles.length > 0) metadata['files_referenced'] = changedFiles;
  if (originUrl !== undefined) metadata['origin_url'] = originUrl;
  if (canonicalRoot !== undefined) metadata['canonical_root'] = canonicalRoot;

  const candidate = {
    source: `git:${repo}`,
    timestamp: commit.author_iso,
    content,
    metadata,
  };

  log.info('candidate', { sha: commit.sha, repo });
  const result = await processCandidate(candidate, storage);
  if (!result.accepted) {
    log.warn('rejected', { reason: result.reason, repo, sha: commit.sha });
    return false;
  }
  return true;
}

/** For tests: clear the per-repo origin cache. */
export function _resetGitWatcherOriginCache(): void {
  originCache.clear();
}

async function discoverLastSeen(repo: string, storage: Storage): Promise<string | undefined> {
  // Walk git log from HEAD backwards, return the first SHA that's already in
  // storage. This is deterministic regardless of storage's timestamp tie-break:
  // event ids are uuids and don't reflect git chronology on same-second commits,
  // so the prior storage-only resolution would re-emit prior commits as
  // duplicates after restart whenever two commits shared an author timestamp.
  const events = await storage.query({ source: `git:${repo}` });
  if (events.length === 0) return undefined;
  const stored = new Set<string>();
  for (const evt of events) {
    const meta = evt.metadata as Record<string, unknown> | undefined;
    const sha = meta?.['sha'];
    if (typeof sha === 'string') stored.add(sha);
  }
  if (stored.size === 0) return undefined;
  const log = await git(['log', '--format=%H'], repo);
  if (log === null) return undefined;
  for (const sha of log.split('\n')) {
    const trimmed = sha.trim();
    if (trimmed.length > 0 && stored.has(trimmed)) return trimmed;
  }
  return undefined;
}

export interface GitWatcherHandle {
  stop: () => Promise<void>;
}

export interface GitWatcherOptions {
  pollIntervalMs?: number;
  enableFsWatch?: boolean;
}

interface RepoState {
  repo: string;
  lastSeen: string | undefined;
  busy: boolean;
}

export async function startGitWatcher(
  repoPaths: ReadonlyArray<string>,
  storage: Storage,
  options: GitWatcherOptions = {},
): Promise<GitWatcherHandle> {
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_MS;
  const enableFsWatch = options.enableFsWatch ?? true;
  const backfillLimit = getBackfillCount();

  const repos = repoPaths.map(normalizeRepoPath);
  const states = new Map<string, RepoState>();
  for (const repo of repos) {
    states.set(repo, { repo, lastSeen: undefined, busy: false });
  }

  let stopped = false;
  const inFlight = new Set<Promise<void>>();

  function track(p: Promise<void>): void {
    inFlight.add(p);
    // .catch before .finally: a bare .finally on a rejected promise derives a
    // NEW rejected promise with no handler — an unhandled rejection that can
    // kill the daemon. Log instead (extractors' handler_error pattern).
    p.catch((err: unknown) => {
      log.error('handler_error', { message: (err as Error).message });
    }).finally(() => inFlight.delete(p));
  }

  async function refreshRepo(state: RepoState): Promise<void> {
    if (stopped || state.busy) return;
    state.busy = true;
    try {
      if (state.lastSeen === undefined) {
        const discovered = await discoverLastSeen(state.repo, storage);
        if (stopped) return;
        state.lastSeen = discovered;
      }
      const head = await getHead(state.repo);
      if (stopped) return;
      if (head === null) {
        log.warn('rev_parse_failed', { repo: state.repo });
        return;
      }
      if (state.lastSeen === head) return;

      const commits = await enumerateNewCommits(state.repo, head, state.lastSeen, backfillLimit);
      if (stopped) return;

      for (const commit of commits) {
        if (stopped) return;
        const ok = await buildAndEmit(state.repo, commit, storage);
        if (!ok) {
          log.error('emit_failed', { repo: state.repo, sha: commit.sha });
          break;
        }
        state.lastSeen = commit.sha;
      }
      if (commits.length === 0) state.lastSeen = head;
    } finally {
      state.busy = false;
    }
  }

  const fsWatchers: FSWatcher[] = [];
  if (enableFsWatch) {
    for (const state of states.values()) {
      const watchPaths = [
        join(state.repo, '.git', 'HEAD'),
        join(state.repo, '.git', 'refs', 'heads'),
      ];
      const watcher = chokidar.watch(watchPaths, {
        ignoreInitial: true,
        persistent: true,
      });
      const onChange = (): void => {
        if (stopped) return;
        track(refreshRepo(state));
      };
      watcher.on('add', onChange);
      watcher.on('change', onChange);
      watcher.on('unlink', onChange);
      watcher.on('error', (err: unknown) => {
        log.error('watcher_error', {
          repo: state.repo,
          message: (err as Error).message,
        });
      });
      await new Promise<void>((resolve) => {
        watcher.once('ready', () => {
          resolve();
        });
      });
      fsWatchers.push(watcher);
    }
  }

  const pollHandle = setInterval(() => {
    if (stopped) return;
    for (const state of states.values()) {
      track(refreshRepo(state));
    }
  }, pollIntervalMs);
  pollHandle.unref();

  // Kick off initial backfill in the background so startGitWatcher returns
  // quickly. stop() awaits any in-flight refresh before resolving.
  for (const state of states.values()) {
    track(refreshRepo(state));
  }

  log.info('started', {
    repos,
    poll_interval_ms: pollIntervalMs,
    fs_watch: enableFsWatch,
  });

  return {
    stop: async () => {
      stopped = true;
      clearInterval(pollHandle);
      for (const w of fsWatchers) {
        await w.close();
      }
      await Promise.allSettled(Array.from(inFlight));
      log.info('stopped', {});
    },
  };
}
