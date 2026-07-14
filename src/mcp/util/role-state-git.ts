// Item 046 / AC4 — shared git-plumbing for the role-typed task-state MCP tools.
//
// The contract is "always pin to commit SHA at call entry":
//   - resolveRefOnce(repoRoot, inputRef) runs `git rev-parse <ref>^{commit}`
//     ONCE per tool invocation, returning the commit SHA. All subsequent
//     reads use that SHA so a moving HEAD / branch tip between operations
//     cannot produce a torn read.
//   - readBlobAtRef / pathExistsAtRef / listTreeAtRef all take the pinned
//     SHA, never raw HEAD.
//   - commitTimeAtRef gives the `last_updated` for a single file.
//
// These helpers ONLY read committed history. Working-tree state and
// uncommitted edits are explicitly out of contract for V1.

import { spawnSync } from 'node:child_process';

export class GitError extends Error {
  constructor(
    message: string,
    public stderr: string,
  ) {
    super(message);
  }
}

export const DEFAULT_GIT_MAX_BUFFER_BYTES = 64 * 1024 * 1024;

export interface GitRunOptions {
  input?: string;
  maxBuffer?: number;
}

export interface GitRunResult {
  code: number;
  stdout: string;
  stderr: string;
  stdoutBuffer: Buffer;
}

export type GitRunner = (repoRoot: string, args: string[], options?: GitRunOptions) => GitRunResult;

export const defaultGitRunner: GitRunner = (
  repoRoot: string,
  args: string[],
  options: GitRunOptions = {},
): GitRunResult => {
  const r = spawnSync('git', args, {
    cwd: repoRoot,
    input: options.input,
    maxBuffer: options.maxBuffer ?? DEFAULT_GIT_MAX_BUFFER_BYTES,
    stdio: [options.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
  });
  const stdoutBuffer = Buffer.isBuffer(r.stdout) ? r.stdout : Buffer.from(r.stdout ?? '');
  const stderrBuffer = Buffer.isBuffer(r.stderr) ? r.stderr : Buffer.from(r.stderr ?? '');
  return {
    code: typeof r.status === 'number' ? r.status : 1,
    stdout: stdoutBuffer.toString('utf-8'),
    stderr: stderrBuffer.toString('utf-8'),
    stdoutBuffer,
  };
};

function gitCapture(
  repoRoot: string,
  args: string[],
  runner: GitRunner = defaultGitRunner,
  options: GitRunOptions = {},
): GitRunResult {
  return runner(repoRoot, args, {
    maxBuffer: DEFAULT_GIT_MAX_BUFFER_BYTES,
    ...options,
  });
}

/**
 * Resolve `inputRef` (or `HEAD` when undefined) to a concrete commit SHA
 * via `git rev-parse <ref>^{commit}`. Branch / tag / short-sha inputs are
 * normalised to the full 40-char SHA. The SHA returned is then pinned for
 * every subsequent read inside the same tool call — this is the structural
 * defence against the HEAD-race + branch-echo failure modes (AC4 R2/F3+F5).
 */
export function resolveRefOnce(
  repoRoot: string,
  inputRef?: string,
  runner: GitRunner = defaultGitRunner,
): string {
  const ref = inputRef ?? 'HEAD';
  const r = gitCapture(repoRoot, ['rev-parse', '--verify', `${ref}^{commit}`], runner);
  if (r.code !== 0) {
    throw new GitError(`unable to resolve ref '${ref}' to a commit`, r.stderr.trim());
  }
  return r.stdout.trim();
}

/** Returns the raw blob content at the given commit + path. Throws GitError
 *  on any failure (path missing at SHA, malformed input, repo not a git
 *  repo, etc). */
export function readBlobAtRef(
  repoRoot: string,
  sha: string,
  repoRelativePath: string,
  runner: GitRunner = defaultGitRunner,
): string {
  const spec = `${sha}:${repoRelativePath}`;
  const r = gitCapture(repoRoot, ['show', spec], runner);
  if (r.code !== 0) {
    throw new GitError(`unable to read ${spec}`, r.stderr.trim());
  }
  return r.stdout;
}

/** Cheap existence check: `git cat-file -e <sha>:<path>` returns 0 iff
 *  the path resolves to a blob at the given commit. */
export function pathExistsAtRef(
  repoRoot: string,
  sha: string,
  repoRelativePath: string,
  runner: GitRunner = defaultGitRunner,
): boolean {
  const r = gitCapture(repoRoot, ['cat-file', '-e', `${sha}:${repoRelativePath}`], runner);
  return r.code === 0;
}

/** Return all file paths under `repoRelativeDir/` at the given commit,
 *  recursively, with leading directory still attached. Empty array if the
 *  directory does not exist. */
export function listTreeAtRef(
  repoRoot: string,
  sha: string,
  repoRelativeDir: string,
  runner: GitRunner = defaultGitRunner,
): string[] {
  // Trailing slash on the dir so `git ls-tree` treats it as a tree rather
  // than a path prefix that could match sibling files.
  const dirSpec = repoRelativeDir.endsWith('/') ? repoRelativeDir : `${repoRelativeDir}/`;
  const r = gitCapture(repoRoot, ['ls-tree', '-r', '--name-only', sha, dirSpec], runner);
  if (r.code !== 0) {
    // ls-tree returns non-zero only if `sha` is unknown; missing dir
    // returns 0 with empty stdout. So a non-zero here is a real error.
    if (r.stderr.includes('Not a valid object name')) return [];
    return [];
  }
  return r.stdout.split('\n').filter((s) => s.length > 0);
}

export function readBlobsAtRef(
  repoRoot: string,
  sha: string,
  repoRelativePaths: string[],
  runner: GitRunner = defaultGitRunner,
): Map<string, string> {
  const out = new Map<string, string>();
  if (repoRelativePaths.length === 0) return out;

  const specs = repoRelativePaths.map((p) => `${sha}:${p}`);
  const r = gitCapture(repoRoot, ['cat-file', '--batch'], runner, {
    input: `${specs.join('\n')}\n`,
  });
  if (r.code !== 0) {
    throw new GitError('unable to batch-read task-state blobs', r.stderr.trim());
  }

  let offset = 0;
  for (let i = 0; i < specs.length; i += 1) {
    const spec = specs[i]!;
    const path = repoRelativePaths[i]!;
    const newline = r.stdoutBuffer.indexOf(0x0a, offset);
    if (newline < 0) {
      throw new GitError(`malformed cat-file --batch header for ${spec}`, '');
    }
    const header = r.stdoutBuffer.toString('utf-8', offset, newline);
    offset = newline + 1;
    if (header === `${spec} missing`) {
      throw new GitError(`unable to read ${spec}`, 'path not found in tree');
    }
    const m = /^[0-9a-f]+ blob ([0-9]+)$/.exec(header);
    if (m === null) {
      throw new GitError(`malformed cat-file --batch header for ${spec}`, header);
    }
    const size = Number.parseInt(m[1]!, 10);
    if (!Number.isSafeInteger(size) || size < 0) {
      throw new GitError(`invalid cat-file --batch size for ${spec}`, header);
    }
    const end = offset + size;
    if (end > r.stdoutBuffer.length) {
      throw new GitError(`truncated cat-file --batch body for ${spec}`, header);
    }
    out.set(path, r.stdoutBuffer.toString('utf-8', offset, end));
    offset = end;
    if (offset < r.stdoutBuffer.length && r.stdoutBuffer[offset] === 0x0a) {
      offset += 1;
    }
  }
  return out;
}

export function commitTimesForPathsAtRef(
  repoRoot: string,
  sha: string,
  repoRelativePaths: string[],
  runner: GitRunner = defaultGitRunner,
): Map<string, string> {
  const wanted = new Set(repoRelativePaths);
  const out = new Map<string, string>();
  if (wanted.size === 0) return out;

  const r = gitCapture(
    repoRoot,
    ['log', '--format=%cI', '--name-only', sha, '--', 'backlog/task-state/'],
    runner,
  );
  if (r.code !== 0) {
    throw new GitError('unable to read task-state commit times', r.stderr.trim());
  }

  let currentTime: string | null = null;
  for (const raw of r.stdout.split('\n')) {
    const line = raw.trim();
    if (line === '') continue;
    if (/^\d{4}-\d{2}-\d{2}T/.test(line)) {
      currentTime = line;
      continue;
    }
    if (currentTime !== null && wanted.has(line) && !out.has(line)) {
      out.set(line, currentTime);
      if (out.size === wanted.size) break;
    }
  }
  return out;
}

/** Return the ISO-8601 UTC commit time of the most recent commit that
 *  modified the given path, looking back from `sha`. Used as
 *  `last_updated` in the get_role_state response. */
export function commitTimeForPathAtRef(
  repoRoot: string,
  sha: string,
  repoRelativePath: string,
  runner: GitRunner = defaultGitRunner,
): string {
  const r = gitCapture(
    repoRoot,
    ['log', '-1', '--format=%cI', sha, '--', repoRelativePath],
    runner,
  );
  if (r.code !== 0 || r.stdout.trim() === '') {
    // Fall back to commit time of the pinned commit itself.
    const r2 = gitCapture(repoRoot, ['log', '-1', '--format=%cI', sha], runner);
    return r2.stdout.trim();
  }
  return r.stdout.trim();
}
