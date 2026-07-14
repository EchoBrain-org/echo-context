// Item 038 / AC1: `echo_resolve_mru` — the MRU resolver primitive.
//
// Atomic replacement for compound "where did I leave off" discovery —
// source_app resolution, no-args fallback, repo_path scoping — that returns
// search-ready descriptors per resolved source. The canonical composition
// pattern is:
//
//   r = echo_resolve_mru({sources: ['cursor'], repo_path: X})
//   d = r.sources['cursor']
//   if d != null: search_memories({source: d.source, ...d.filter, limit: N})
//
// The descriptor's `filter` field carries the metadata/path scoping the
// caller must spread through to `search_memories` so cross-repo leak is
// structurally impossible (especially relevant for Cursor, whose resolved
// source is the global `state.vscdb` — the bare source alone would leak
// across repos).
//
// Atomic by design: IDs-only / source-only, no body fetch. Bodies arrive
// through `search_memories` or `get_atoms` on the next call.

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { CaptureEvent, QueryFilter, Storage } from '../../storage/interface.js';
import {
  resolveCursorComposerForRepoPath,
  type CursorComposerResolution,
} from '../cursor-workspace-resolver.js';
import { withFsExclusion } from '../util/fs-exclusion.js';
import { assertAbsoluteRepoPath, normaliseRepoPath } from '../util/repo-path.js';
import { buildSourceAppMap, SOURCE_APP_VALUES, type SourceApp } from '../util/source-app.js';

export const ECHO_RESOLVE_MRU_MAX_SOURCES = 8;

export const ECHO_RESOLVE_MRU_DESCRIPTION =
  'Resolve the most-recently-active source under one or more predicates → returns a `search_memories`-ready descriptor per resolved source (NOT bare paths — bare source loses cross-repo scoping for Cursor). IDs-only / source-only; no atom bodies fetched here.\n\n' +
  'PARAMETERS:\n' +
  '  • `sources: string[]` — required. Non-empty, ≤ ' +
  String(ECHO_RESOLVE_MRU_MAX_SOURCES) +
  '. Mixed entry types accepted (same shape as `wait_for_new_turns`):\n' +
  '      • Source-app name (`cursor` | `claude_code` | `codex` | `git` | `granola`) → PREFIX MATCH on the canonical app prefix; resolves to the newest non-fs source under that prefix.\n' +
  '      • Literal source path (e.g. `fs:/Users/.../session.jsonl`, `git:/Users/.../repo`) → EXACT match; descriptor returned only if the source has at least one non-fs atom.\n' +
  "  • `repo_path?: string` — optional absolute repo root. When set, only sources whose newest non-fs atom matches the repo are eligible. Source-app entries: `claude_code` / `codex` filter via `metadata.repo_root`; `cursor` uses a two-phase fallback (Phase 1 metadata.repo_root, Phase 2 legacy composer↔workspace resolver — descriptor encodes `phase: 'cursor_legacy'` when Phase 2 fires); `git` uses a two-path OR (metadata.repo_root OR `source=git:<repo_path>`) to recover legacy git atoms by path; `granola` normally resolves only when repo_path is omitted because meeting-note atoms have no repo_root.\n\n" +
  "RETURNS: `{ sources: Record<string, ResolvedSourceDescriptor | null>, repo_path?: string, warnings: string[] }`. Each descriptor has shape `{ source, filter: { metadata_match?, repo_path? }, phase?: 'cursor_legacy' }`. The descriptor is `search_memories`-ready ONLY — `filter.metadata_match` is NOT a `wait_for_new_turns` parameter, so the canonical live-watch path uses `wait_for_new_turns({sources: [desc.source], repo_path: desc.filter.repo_path, since: now})` and ignores `metadata_match`. Legacy Cursor atoms via wait are out of scope (wait is for NEW turns; legacy = already-captured).\n\n" +
  'CANONICAL COMPOSITIONS:\n' +
  "  • Tail (search_memories): `r = echo_resolve_mru({sources: ['cursor'], repo_path: X})` → if `r.sources['cursor'] !== null`, `search_memories({source: desc.source, ...desc.filter, limit: N})`. The `...desc.filter` spread carries through repo_path or metadata_match cleanly without the caller needing to know which Cursor phase fired.\n" +
  '  • Live watch (wait_for_new_turns): `wait_for_new_turns({sources: [desc.source], repo_path: desc.filter.repo_path, since: now})`.';

/** The descriptor returned for a resolved source. `filter` encodes the
 *  scoping predicates the caller MUST spread through to `search_memories`
 *  for cross-repo correctness. */
export interface ResolvedSourceDescriptor {
  source: string;
  filter: {
    metadata_match?: Record<string, string>;
    repo_path?: string;
  };
  /** Set ONLY when the Cursor Phase 2 legacy fallback fired (i.e. Phase 1
   *  returned 0 atoms AND `resolveCursorComposerForRepoPath` returned a
   *  non-null composer_id). When `phase` is set, `filter.metadata_match`
   *  carries `{composer_id: <resolved>}` and `filter.repo_path` is absent
   *  (legacy atoms predate the repo_root capture write). */
  phase?: 'cursor_legacy';
}

export interface EchoResolveMruResult {
  sources: Record<string, ResolvedSourceDescriptor | null>;
  /** Echo of the normalised input (when set), so callers can verify the
   *  trailing-slash / normalize behavior. */
  repo_path?: string;
  warnings: string[];
}

export interface EchoResolveMruParams {
  sources: string[];
  repo_path?: string;
}

export interface EchoResolveMruInjections {
  /** Injection seam for the Cursor workspace + composer resolver. Tests
   *  override this to point at mock-fs fixtures; production passes the
   *  live `resolveCursorComposerForRepoPath` (the default). */
  resolveCursorComposer?: (repoPath: string) => CursorComposerResolution | null;
}

const SOURCE_APP_SET = new Set<string>(SOURCE_APP_VALUES);

function isSourceAppName(s: string): s is SourceApp {
  return SOURCE_APP_SET.has(s);
}

// Fetch the newest single non-fs row matching the supplied filter; returns
// null when no rows match. Storage already orders DESC (timestamp DESC,
// id DESC) and we apply limit=1.
async function newestMatching(storage: Storage, filter: QueryFilter): Promise<CaptureEvent | null> {
  const rows = await storage.query({ ...filter, limit: 1 });
  return rows[0] ?? null;
}

async function resolveAppNameEntry(
  storage: Storage,
  app: SourceApp,
  normalisedRepoPath: string | null,
  rawRepoPath: string | undefined,
  injections: EchoResolveMruInjections,
): Promise<ResolvedSourceDescriptor | null> {
  const prefix = buildSourceAppMap()[app];

  // Cursor branch (037 cooperation): when repo_path is set, run Phase 1
  // (metadata.repo_root) first; only fall back to Phase 2 (legacy composer
  // resolver) when Phase 1 returns 0 atoms.
  if (app === 'cursor' && normalisedRepoPath !== null) {
    const phase1 = await newestMatching(
      storage,
      withFsExclusion({
        source_prefix: prefix,
        metadata_match: { repo_root: normalisedRepoPath },
      }),
    );
    if (phase1 !== null) {
      return {
        source: phase1.source,
        filter: { repo_path: normalisedRepoPath },
      };
    }
    // Phase 2: legacy composer fallback. `rawRepoPath` (un-normalised) is
    // passed to the resolver because the resolver normalises internally and
    // accepts the trailing-slash shape too.
    const resolver = injections.resolveCursorComposer ?? resolveCursorComposerForRepoPath;
    const resolved = resolver(rawRepoPath ?? normalisedRepoPath);
    if (resolved === null) return null;
    // Pick the newest cursor source globally (independent of repo_root —
    // legacy atoms by definition lack repo_root metadata).
    const cursorNewest = await newestMatching(storage, withFsExclusion({ source_prefix: prefix }));
    if (cursorNewest === null) return null;
    return {
      source: cursorNewest.source,
      filter: { metadata_match: { composer_id: resolved.composer_id } },
      phase: 'cursor_legacy',
    };
  }

  // Git branch (037 AC6 Note 2 port): two-path OR when repo_path is set.
  if (app === 'git' && normalisedRepoPath !== null) {
    const exactSource = `git:${normalisedRepoPath}`;
    const [rowA, rowB] = await Promise.all([
      newestMatching(
        storage,
        withFsExclusion({
          source_prefix: prefix,
          metadata_match: { repo_root: normalisedRepoPath },
        }),
      ),
      newestMatching(storage, withFsExclusion({ source: exactSource })),
    ]);
    if (rowA === null && rowB === null) return null;
    // Pick the newer of the two; tie-break on Query A (post-AC1 metadata is
    // the canonical encoding going forward).
    let winnerIsA: boolean;
    if (rowA === null) winnerIsA = false;
    else if (rowB === null) winnerIsA = true;
    else if (rowA.timestamp >= rowB.timestamp) winnerIsA = true;
    else winnerIsA = false;
    if (winnerIsA) {
      // Query A's row has both source AND repo_root metadata — filter
      // carries repo_path through so the downstream search_memories call
      // scopes correctly (multiple git: sources may share the same repo).
      return {
        source: rowA!.source,
        filter: { repo_path: normalisedRepoPath },
      };
    }
    // Query B's row: exact-source `git:<repo_path>` IS the scoping
    // predicate; no metadata_match needed because the source path encodes
    // the repo. Downstream search_memories(source=desc.source) is sufficient.
    return {
      source: rowB!.source,
      filter: {},
    };
  }

  // Default app-name branch (claude_code / codex / cursor-without-repo /
  // git-without-repo): single prefix query, optional repo_root filter.
  const filter: QueryFilter = withFsExclusion({ source_prefix: prefix });
  if (normalisedRepoPath !== null) {
    filter.metadata_match = { repo_root: normalisedRepoPath };
  }
  const row = await newestMatching(storage, filter);
  if (row === null) return null;
  return {
    source: row.source,
    filter: normalisedRepoPath !== null ? { repo_path: normalisedRepoPath } : {},
  };
}

async function resolveLiteralSourceEntry(
  storage: Storage,
  literal: string,
  normalisedRepoPath: string | null,
): Promise<ResolvedSourceDescriptor | null> {
  const filter: QueryFilter = withFsExclusion({ source: literal });
  if (normalisedRepoPath !== null) {
    filter.metadata_match = { repo_root: normalisedRepoPath };
  }
  const row = await newestMatching(storage, filter);
  if (row === null) return null;
  return {
    source: literal,
    filter: normalisedRepoPath !== null ? { repo_path: normalisedRepoPath } : {},
  };
}

export async function echoResolveMru(
  storage: Storage,
  params: EchoResolveMruParams,
  injections: EchoResolveMruInjections = {},
): Promise<EchoResolveMruResult> {
  // Defense-in-depth validation — Zod also enforces these at the MCP
  // boundary, but the in-process function is also called directly by tests
  // (and the descriptor-spread composition test in AC2).
  if (!Array.isArray(params.sources) || params.sources.length === 0) {
    throw new Error('echo_resolve_mru: sources must be a non-empty array');
  }
  if (params.sources.length > ECHO_RESOLVE_MRU_MAX_SOURCES) {
    throw new Error(
      `echo_resolve_mru: sources exceeds max ${ECHO_RESOLVE_MRU_MAX_SOURCES} per call`,
    );
  }

  let normalisedRepoPath: string | null = null;
  if (params.repo_path !== undefined) {
    assertAbsoluteRepoPath('echo_resolve_mru', params.repo_path);
    normalisedRepoPath = normaliseRepoPath(params.repo_path);
  }

  const result: Record<string, ResolvedSourceDescriptor | null> = {};
  // Per-entry parallel resolution — each entry's storage query is independent.
  await Promise.all(
    params.sources.map(async (entry) => {
      if (isSourceAppName(entry)) {
        result[entry] = await resolveAppNameEntry(
          storage,
          entry,
          normalisedRepoPath,
          params.repo_path,
          injections,
        );
      } else {
        result[entry] = await resolveLiteralSourceEntry(storage, entry, normalisedRepoPath);
      }
    }),
  );

  const out: EchoResolveMruResult = {
    sources: result,
    warnings: [],
  };
  if (normalisedRepoPath !== null) {
    out.repo_path = normalisedRepoPath;
  }
  return out;
}

const descriptorSchema = z.object({
  source: z.string(),
  filter: z.object({
    metadata_match: z.record(z.string(), z.string()).optional(),
    repo_path: z.string().optional(),
  }),
  phase: z.literal('cursor_legacy').optional(),
});

const echoResolveMruOutputSchema = {
  sources: z.record(z.string(), descriptorSchema.nullable()),
  repo_path: z.string().optional(),
  warnings: z.array(z.string()),
};

export function registerEchoResolveMru(server: McpServer, storage: Storage): void {
  server.registerTool(
    'echo_resolve_mru',
    {
      description: ECHO_RESOLVE_MRU_DESCRIPTION,
      inputSchema: {
        sources: z.array(z.string()).min(1).max(ECHO_RESOLVE_MRU_MAX_SOURCES),
        repo_path: z
          .string()
          .optional()
          .describe(
            'Absolute filesystem path to a repo root. When set, only sources whose newest non-fs atom matches the repo (per the source-app-specific rules above) are eligible.',
          ),
      },
      outputSchema: echoResolveMruOutputSchema,
      annotations: { readOnlyHint: true },
    },
    async (input) => {
      const params = input as EchoResolveMruParams;
      let result: EchoResolveMruResult;
      try {
        result = await echoResolveMru(storage, params);
      } catch (err) {
        return {
          isError: true,
          content: [{ type: 'text', text: (err as Error).message }],
        };
      }
      return {
        content: [{ type: 'text', text: JSON.stringify(result) }],
        structuredContent: result as unknown as Record<string, unknown>,
      };
    },
  );
}
