// Item 038 / AC1: `echo_resolve_mru` — the MRU resolver primitive.
//
// Atomic replacement for compound "where did I leave off" discovery —
// source_app resolution, no-args fallback, repo_path scoping — that returns
// search-ready descriptors per resolved source. The canonical composition
// pattern is:
//
//   r = echo_resolve_mru({sources: ['codex'], repo_path: X})
//   d = r.sources['codex']
//   if d != null: search_memories({source: d.source, ...d.filter, limit: N})
//
// The descriptor's `filter` field carries the metadata/path scoping the
// caller must spread through to `search_memories` so cross-repo leak is
// structurally impossible when multiple conversations share one source.
//
// Atomic by design: IDs-only / source-only, no body fetch. Bodies arrive
// through `search_memories` or `get_atoms` on the next call.

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { CaptureEvent, QueryFilter, Storage } from '../../storage/interface.js';
import { StorageScanBudgetExceededError } from '../../storage/budgets.js';
import { withFsExclusion } from '../util/fs-exclusion.js';
import { assertAbsoluteRepoPath, normaliseRepoPath } from '../util/repo-path.js';
import { buildSourceAppMap, SOURCE_APP_VALUES, type SourceApp } from '../util/source-app.js';

export const ECHO_RESOLVE_MRU_MAX_SOURCES = 8;
export const ECHO_RESOLVE_MRU_MAX_SCAN_WINDOWS = 4;

export const ECHO_RESOLVE_MRU_DESCRIPTION =
  'Resolve each requested app or exact source to one most-recently-active exact source; no bodies are fetched. App names (`cursor`, `claude_code`, `codex`, `git`, `granola`) search across that app, while other strings are exact-source lookups. Optional `repo_path` restricts eligible activity. Each non-null result is a `search_memories` descriptor: pass its `source` and spread its `filter`. This tool selects one newest source; use `wait_for_new_turns` when you need to watch all sessions for an app.';

/** The descriptor returned for a resolved source. `filter` encodes the
 *  scoping predicates the caller MUST spread through to `search_memories`
 *  for cross-repo correctness. */
export interface ResolvedSourceDescriptor {
  source: string;
  filter: {
    metadata_match?: Record<string, string>;
    repo_path?: string;
  };
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

const SOURCE_APP_SET = new Set<string>(SOURCE_APP_VALUES);

function isSourceAppName(s: string): s is SourceApp {
  return SOURCE_APP_SET.has(s);
}

interface ScanState {
  truncated: boolean;
}

async function hydrateFirstMatch(
  storage: Storage,
  ids: readonly string[],
): Promise<CaptureEvent | null> {
  // A limit=1 query normally cannot exhaust after admitting a match, but
  // preserve the storage continuation contract for injected/alternate
  // adapters without exceeding getByIds' hard request cap.
  for (let offset = 0; offset < ids.length; offset += 100) {
    const rows = await storage.getByIds(ids.slice(offset, offset + 100));
    if (rows.length > 0) return rows[0]!;
  }
  return null;
}

// Fetch the newest single non-fs row matching the supplied filter. Sparse
// post-filter scans resume through a finite number of storage windows instead
// of turning an expected hard-budget boundary into a public MCP error.
async function newestMatching(
  storage: Storage,
  filter: QueryFilter,
  scanState: ScanState,
): Promise<CaptureEvent | null> {
  let before = filter.before;
  for (let window = 0; window < ECHO_RESOLVE_MRU_MAX_SCAN_WINDOWS; window += 1) {
    try {
      const rows = await storage.query({ ...filter, before, limit: 1 });
      return rows[0] ?? null;
    } catch (error) {
      if (!(error instanceof StorageScanBudgetExceededError)) throw error;
      const admitted = await hydrateFirstMatch(storage, error.matched_ids);
      if (admitted !== null) return admitted;
      before = error.resume_cursor;
    }
  }
  scanState.truncated = true;
  return null;
}

async function resolveAppNameEntry(
  storage: Storage,
  app: SourceApp,
  normalisedRepoPath: string | null,
  scanState: ScanState,
): Promise<ResolvedSourceDescriptor | null> {
  const prefix = buildSourceAppMap()[app];

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
        scanState,
      ),
      newestMatching(storage, withFsExclusion({ source: exactSource }), scanState),
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
  const row = await newestMatching(storage, filter, scanState);
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
  scanState: ScanState,
): Promise<ResolvedSourceDescriptor | null> {
  const filter: QueryFilter = withFsExclusion({ source: literal });
  if (normalisedRepoPath !== null) {
    filter.metadata_match = { repo_root: normalisedRepoPath };
  }
  const row = await newestMatching(storage, filter, scanState);
  if (row === null) return null;
  return {
    source: literal,
    filter: normalisedRepoPath !== null ? { repo_path: normalisedRepoPath } : {},
  };
}

export async function echoResolveMru(
  storage: Storage,
  params: EchoResolveMruParams,
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
  const scanState: ScanState = { truncated: false };
  // Per-entry parallel resolution — each entry's storage query is independent.
  const uniqueSources = [...new Set(params.sources)];
  await Promise.all(
    uniqueSources.map(async (entry) => {
      if (isSourceAppName(entry)) {
        result[entry] = await resolveAppNameEntry(
          storage,
          entry,
          normalisedRepoPath,
          scanState,
        );
      } else {
        result[entry] = await resolveLiteralSourceEntry(
          storage,
          entry,
          normalisedRepoPath,
          scanState,
        );
      }
    }),
  );

  const out: EchoResolveMruResult = {
    sources: result,
    warnings: scanState.truncated
      ? [
          `echo_resolve_mru: bounded storage scan exhausted after ${ECHO_RESOLVE_MRU_MAX_SCAN_WINDOWS} windows; unresolved sources may have older matches — narrow repo/source scope and retry`,
        ]
      : [],
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
        sources: z
          .array(z.string().min(1).max(4096))
          .min(1)
          .max(ECHO_RESOLVE_MRU_MAX_SOURCES),
        repo_path: z
          .string()
          .max(4096)
          .optional()
          .describe(
            'Absolute repo root. Restricts eligible activity to matching capture metadata.',
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
