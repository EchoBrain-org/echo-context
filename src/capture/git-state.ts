// Live git-state probe for Layer 2 ("cheap world state").
//
// Runs cheap git probes in a target cwd and returns a GitState snapshot.
// Caches per-cwd for FRESH_TTL_MS so a burst of turn emissions in the same
// repo doesn't fan out into N subprocesses. Failures are silent (returns
// undefined) — non-git-repo cwds are common and not interesting.

import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

import type { GitState } from './extractors/_turn_meta.js';
import { GIT_PROBE_TIMEOUT_MS, gitToplevel } from './workspace-root.js';

const execFileAsync = promisify(execFile);

/** A sample is "fresh" iff captured_at - turn_timestamp ≤ FRESHNESS_WINDOW_MS. */
export const FRESHNESS_WINDOW_MS = 30_000;
/** Cached samples are reused inside this window — burst-safe. */
const CACHE_TTL_MS = 5_000;

// Bound for long-running serve-trace, where many distinct cwds may be touched.
// Map preserves insertion order, so we evict the oldest entry when at cap.
const CACHE_MAX_ENTRIES = 256;

function lruSet<K, V>(map: Map<K, V>, key: K, value: V): void {
  if (map.size >= CACHE_MAX_ENTRIES && !map.has(key)) {
    const oldest = map.keys().next().value;
    if (oldest !== undefined) map.delete(oldest);
  }
  map.set(key, value);
}

interface CacheEntry {
  state: Omit<GitState, 'fresh'>;
  expiresAt: number;
}
const cache = new Map<string, CacheEntry>();

async function gitOne(cwd: string, args: string[]): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('git', args, {
      cwd,
      timeout: GIT_PROBE_TIMEOUT_MS,
      maxBuffer: 1_024 * 1_024,
    });
    return stdout.trim();
  } catch {
    return null;
  }
}

export function scrubOriginUrlCredentials(raw: string | null | undefined): string | undefined {
  const trimmed = raw?.trim();
  if (trimmed === undefined || trimmed.length === 0) return undefined;
  const schemeIdx = trimmed.indexOf('://');
  if (schemeIdx === -1) return trimmed;
  const prefix = trimmed.slice(0, schemeIdx + 3);
  const rest = trimmed.slice(schemeIdx + 3);
  const atIdx = rest.indexOf('@');
  if (atIdx === -1) return trimmed;
  const firstPathIdx = rest.search(/[/?#]/);
  if (firstPathIdx !== -1 && atIdx > firstPathIdx) return trimmed;
  return `${prefix}${rest.slice(atIdx + 1)}`;
}

export async function probeGitState(
  cwd: string | undefined,
  turnTimestampIso: string,
): Promise<GitState | undefined> {
  if (cwd === undefined || cwd.length === 0) return undefined;

  const now = Date.now();
  const turnMs = Date.parse(turnTimestampIso);
  const fresh = Number.isFinite(turnMs) && now - turnMs <= FRESHNESS_WINDOW_MS;
  // Historical turns get nothing useful out of a current git probe — the
  // sample reflects HEAD at extraction time, not at the turn's actual moment.
  // Skip the subprocess fan-out entirely for them so boot-scan stays fast.
  if (!fresh) return undefined;

  const cached = cache.get(cwd);
  if (cached !== undefined && cached.expiresAt > now) {
    return { ...cached.state, fresh };
  }

  const repoRoot = await gitToplevel(cwd);
  if (repoRoot === null) {
    // Not a git repo, or git not available — cache the negative briefly.
    lruSet(cache, cwd, {
      state: { captured_at: new Date(now).toISOString() },
      expiresAt: now + CACHE_TTL_MS,
    });
    return undefined;
  }

  const [headSha, branch, dirty, originUrl] = await Promise.all([
    gitOne(repoRoot, ['rev-parse', 'HEAD']),
    gitOne(repoRoot, ['rev-parse', '--abbrev-ref', 'HEAD']),
    gitOne(repoRoot, ['status', '--porcelain']),
    gitOne(repoRoot, ['remote', 'get-url', 'origin']),
  ]);

  if (headSha === null) {
    // Not a git repo, or git not available — cache the negative briefly.
    lruSet(cache, cwd, {
      state: { captured_at: new Date(now).toISOString() },
      expiresAt: now + CACHE_TTL_MS,
    });
    return undefined;
  }

  const state: Omit<GitState, 'fresh'> = {
    head_sha: headSha,
    captured_at: new Date(now).toISOString(),
  };
  if (branch !== null && branch.length > 0) state.branch = branch;
  const scrubbedOriginUrl = scrubOriginUrlCredentials(originUrl);
  if (scrubbedOriginUrl !== undefined) state.origin_url = scrubbedOriginUrl;
  if (dirty !== null) {
    state.dirty_count = dirty.length === 0 ? 0 : dirty.split('\n').length;
  }

  lruSet(cache, cwd, { state, expiresAt: now + CACHE_TTL_MS });
  return { ...state, fresh };
}

// Branch is stable across most turn windows, so probing it is safe even for
// stale (boot-scanned) turns where probeGitState would refuse — branch rarely
// lies the way HEAD or dirty_count would. Reading .git/HEAD directly avoids a
// subprocess and keeps boot scan cheap.
const BRANCH_CACHE_TTL_MS = 5_000;
interface BranchCacheEntry {
  branch: string | null;
  expiresAt: number;
}
const branchCache = new Map<string, BranchCacheEntry>();

export async function readBranch(cwd: string | undefined): Promise<string | undefined> {
  if (cwd === undefined || cwd.length === 0) return undefined;
  const now = Date.now();
  const cached = branchCache.get(cwd);
  if (cached !== undefined && cached.expiresAt > now) {
    return cached.branch ?? undefined;
  }
  let branch: string | null = null;
  try {
    const head = await readFile(join(cwd, '.git', 'HEAD'), 'utf8');
    const m = head.match(/^ref: refs\/heads\/(.+?)\s*$/m);
    if (m && m[1] !== undefined) branch = m[1];
  } catch {
    // not a git repo, or worktree (.git is a file pointing elsewhere) — skip
  }
  lruSet(branchCache, cwd, { branch, expiresAt: now + BRANCH_CACHE_TTL_MS });
  return branch ?? undefined;
}

/** For tests: clear the in-memory cache. */
export function _resetGitStateCache(): void {
  cache.clear();
  branchCache.clear();
}
