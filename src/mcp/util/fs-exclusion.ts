// Item 038 / AC5: single source of truth for the fs-watcher meta-event
// exclusion that every retrieval tool needs. Bug B (2026-05-08) fired 3
// times because each new retrieval tool re-hardcoded
// `exclude_metadata_surface: ['fs']`; this helper closes the structural-
// impossibility loop. The CI grep-scan test (tests/mcp/util/fs-exclusion-grep.test.ts)
// fails if any future tool re-hardcodes the literal pattern.
//
// Why fs-watcher events are excluded everywhere: raw fs-watcher change events
// (`metadata.surface === 'fs'`) carry `{event_type, path, mtime, size}` and
// represent capture-implementation detail. The conversation/git atoms riding
// the same `fs:/Users/...` source prefix carry richer per-extractor metadata
// (no `surface: 'fs'`), so they're unaffected by this exclusion.

import type { QueryFilter } from '../../storage/interface.js';

/** The canonical surface set excluded by every retrieval tool. Mutating a
 *  shared array would break callers that pass it directly into storage;
 *  exported `as const` so consumers spread it (`[...EXCLUDE_FS_SURFACE]`)
 *  when storage expects a fresh `string[]`. */
export const EXCLUDE_FS_SURFACE: readonly ['fs'] = ['fs'] as const;

/** Compose a `QueryFilter` with the fs-watcher exclusion already applied.
 *  Use this instead of inlining `exclude_metadata_surface: ['fs']` — the
 *  grep-scan CI test fails on the inline form. */
export function withFsExclusion<F extends Omit<QueryFilter, 'exclude_metadata_surface'>>(
  filter: F,
): F & { exclude_metadata_surface: string[] } {
  return { ...filter, exclude_metadata_surface: [...EXCLUDE_FS_SURFACE] };
}
