// Single source of truth for excluding historical raw filesystem
// notifications from semantic retrieval. The CI grep-scan test fails if a
// future tool re-hardcodes `exclude_metadata_surface: ['fs']`.
//
// Migrated raw events (`metadata.surface === 'fs'`) carry only
// `{event_type, path, mtime, size}`. Semantic conversation/git atoms sharing
// the same `fs:/Users/...` prefix have no `surface: 'fs'` and remain visible.

import type { QueryFilter } from '../../storage/interface.js';

/** The canonical surface set excluded by every retrieval tool. Mutating a
 *  shared array would break callers that pass it directly into storage;
 *  exported `as const` so consumers spread it (`[...EXCLUDE_FS_SURFACE]`)
 *  when storage expects a fresh `string[]`. */
export const EXCLUDE_FS_SURFACE: readonly ['fs'] = ['fs'] as const;

/** Compose a `QueryFilter` with the historical raw-fs exclusion applied.
 *  Use this instead of inlining `exclude_metadata_surface: ['fs']` — the
 *  grep-scan CI test fails on the inline form. */
export function withFsExclusion<F extends Omit<QueryFilter, 'exclude_metadata_surface'>>(
  filter: F,
): F & { exclude_metadata_surface: string[] } {
  return { ...filter, exclude_metadata_surface: [...EXCLUDE_FS_SURFACE] };
}
