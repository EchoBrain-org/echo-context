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
//   - normalization: align caller path shape with the stored
//     `metadata.repo_root` shape (no trailing slash; structural normalize
//     only — NO symlink resolution, NO canonicalization). Required because
//     `metadata_match` is a string-equality predicate against the value the
//     capture-side wrote (per AC1's contract).
//
import { isAbsolute, normalize as pathNormalize } from 'node:path';

/** Normalize a repository path for exact metadata equality without touching
 * the filesystem or resolving symlinks. */
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
