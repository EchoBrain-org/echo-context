// Item 037 / AC3-AC6: shared `repo_path` parameter validation + normalization
// for the retrieval tools (`search_memories`, `find_clusters` /
// `recent_work_context`, `wait_for_new_turns`, `echo_resolve_mru`).
// Centralised here so a future tightening of the contract (e.g. symlink
// resolution, Windows path canonicalisation, multi-root workspace handling)
// touches one file instead of four.
//
// Two concerns separated:
//   - validation: caller passed a non-absolute string → throw a clear
//     `<tool>: repo_path must be absolute` Error. The MCP envelope handler
//     converts this to `isError: true` per the consistent error-prefix
//     pattern across retrieval tools.
//   - resolution: preserve the normalized caller path for query echoes and
//     legacy git-source fallback, while deriving metadata.project_key through
//     the same realpath/case/project-root semantics used at capture time.
//
import { realpath, stat } from 'node:fs/promises';
import { isAbsolute, normalize as pathNormalize } from 'node:path';
import {
  projectKeyForCanonicalRoot,
  resolveCanonicalRoot,
} from '../../project-identity.js';
import { normalizeLegacyProjectRoots } from '../../storage/project-filter.js';

/** Normalize a repository path without touching the filesystem or resolving
 * symlinks. */
export function normaliseRepoPath(p: string): string {
  const normalized = pathNormalize(p);
  if (
    normalized.length > 1 &&
    (normalized.endsWith('/') || normalized.endsWith('\\'))
  ) {
    return normalized.slice(0, -1);
  }
  return normalized;
}

export interface ResolvedRepoPath {
  normalized_path: string;
  project_key: string;
  /** Bounded storage-only aliases for pre-project-key repo_root/source rows. */
  legacy_project_roots: readonly string[];
}

/** Resolve an existing project path exactly as capture does. Non-existent
 * paths retain the historical structural key so stored legacy/test fixtures
 * remain queryable without turning a missing path into an I/O failure. */
export async function resolveRepoPath(p: string): Promise<ResolvedRepoPath> {
  const normalizedPath = normaliseRepoPath(p);
  let canonicalRoot = normalizedPath;
  try {
    const pathStat = await stat(normalizedPath);
    if (pathStat.isDirectory()) {
      canonicalRoot = await resolveCanonicalRoot(normalizedPath);
    }
  } catch {
    // A repo may be historical, offline, or represented by a synthetic test
    // fixture. Preserve the old structural identity in that bounded fallback.
  }
  let casePreservedRoot = canonicalRoot;
  try {
    // canonicalRoot intentionally case-folds on case-insensitive filesystems.
    // realpath recovers the directory spelling older repo_root/git:<path>
    // rows may have stored before canonical identity existed.
    casePreservedRoot = normaliseRepoPath(await realpath(canonicalRoot));
  } catch {
    // Missing/offline paths retain their structural canonical identity.
  }
  const projectKey = projectKeyForCanonicalRoot(canonicalRoot);
  return {
    normalized_path: normalizedPath,
    project_key: projectKey,
    legacy_project_roots: normalizeLegacyProjectRoots(projectKey, [
      canonicalRoot,
      casePreservedRoot,
      normalizedPath,
    ]),
  };
}

/**
 * Throw a structured Error when `repo_path` is set but not absolute. The
 * message is prefixed with `<toolName>: ` so the existing MCP envelope
 * handlers recognise it and emit `isError: true` instead of a JSON-RPC
 * fault. `toolName` is the tool's snake_case identifier.
 */
export function assertAbsoluteRepoPath(toolName: string, repo_path: string): void {
  if (!isAbsolute(repo_path)) {
    throw new Error(`${toolName}: repo_path must be absolute`);
  }
}
