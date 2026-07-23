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
import {
  StorageBudgetExceededError,
  StorageScanBudgetExceededError,
} from '../../storage/budgets.js';
import { withFsExclusion } from '../util/fs-exclusion.js';
import {
  assertAbsoluteRepoPath,
  resolveRepoPath,
  type ResolvedRepoPath,
} from '../util/repo-path.js';
import { buildSourceAppMap, SOURCE_APP_VALUES, type SourceApp } from '../util/source-app.js';

export const ECHO_RESOLVE_MRU_MAX_SOURCES = 8;
export const ECHO_RESOLVE_MRU_MAX_SCAN_WINDOWS = 4;
const ECHO_RESOLVE_MRU_CANDIDATES_PER_WINDOW = 8;

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

/** Only a row explicitly classified as inherited is ineligible MRU activity.
 * Missing, `unknown`, and malformed markers remain eligible so historical
 * rows captured before observation metadata existed retain their previous
 * behavior. Eligible rows continue to rank by their stored event timestamp;
 * that is the physical observation clock this raw-storage resolver has always
 * exposed, while excluding inherited copies prevents that clock from making
 * old logical work look newly active. */
function isMruEligibleObservation(event: CaptureEvent): boolean {
  return event.metadata?.['observation_kind'] !== 'inherited';
}

async function hydrateFirstEligibleMatch(
  storage: Storage,
  ids: readonly string[],
): Promise<CaptureEvent | null> {
  // Hydrate one-at-a-time in the storage-provided order. Sparse descriptor
  // matches are exceptional, and this keeps each payload request byte-safe
  // while allowing inherited copies to be skipped without reordering MRU.
  for (const id of ids) {
    const [row] = await storage.getByIds([id]);
    if (row !== undefined && isMruEligibleObservation(row)) return row;
  }
  return null;
}

interface MruCandidatePage {
  rows: CaptureEvent[];
  rowLimit: number;
}

/** Fetch a small descending candidate page. Raising the raw page above one
 * lets a bounded resolver step over a short inherited-copy burst. SQLite's
 * byte budget remains authoritative: halve the same page at the same cursor
 * when the requested payload set is too large. */
async function queryMruCandidatePage(
  storage: Storage,
  filter: QueryFilter,
  before: QueryFilter['before'],
  rowLimit = ECHO_RESOLVE_MRU_CANDIDATES_PER_WINDOW,
): Promise<MruCandidatePage> {
  try {
    return {
      rows: await storage.query({ ...filter, before, limit: rowLimit }),
      rowLimit,
    };
  } catch (error) {
    if (
      error instanceof StorageBudgetExceededError &&
      error.code === 'request_too_large' &&
      error.operation === 'query' &&
      rowLimit > 1
    ) {
      return queryMruCandidatePage(storage, filter, before, Math.max(1, Math.floor(rowLimit / 2)));
    }
    throw error;
  }
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
      const page = await queryMruCandidatePage(storage, filter, before);
      const eligible = page.rows.find(isMruEligibleObservation);
      if (eligible !== undefined) return eligible;
      if (page.rows.length < page.rowLimit) return null;
      const last = page.rows[page.rows.length - 1];
      if (last === undefined) return null;
      before = { timestamp: last.timestamp, id: last.id };
    } catch (error) {
      if (!(error instanceof StorageScanBudgetExceededError)) throw error;
      const admitted = await hydrateFirstEligibleMatch(storage, error.matched_ids);
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
  repoPath: ResolvedRepoPath | null,
  scanState: ScanState,
): Promise<ResolvedSourceDescriptor | null> {
  const prefix = buildSourceAppMap()[app];

  // Git branch (037 AC6 Note 2 port): two-path OR when repo_path is set.
  if (app === 'git' && repoPath !== null) {
    const exactSources = [
      ...new Set(
        [repoPath.normalized_path, ...repoPath.legacy_project_roots].map(
          (root) => `git:${root}`,
        ),
      ),
    ];
    const [rowA, ...exactRows] = await Promise.all([
      newestMatching(
        storage,
        withFsExclusion({
          source_prefix: prefix,
          project_key: repoPath.project_key,
          legacy_project_roots: repoPath.legacy_project_roots,
        }),
        scanState,
      ),
      ...exactSources.map((source) =>
        newestMatching(
          storage,
          withFsExclusion({
            source,
            project_key: repoPath.project_key,
            legacy_project_roots: repoPath.legacy_project_roots,
          }),
          scanState,
        ),
      ),
    ]);
    const rowB = exactRows.reduce<CaptureEvent | null>((newest, row) => {
      if (row === null) return newest;
      if (newest === null || row.timestamp > newest.timestamp) return row;
      return newest;
    }, null);
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
        filter: { repo_path: repoPath.normalized_path },
      };
    }
    // Query B admits metadata-less legacy rows only because its exact
    // `git:<repo_path>` source structurally identifies this project. Preserve
    // that same fail-closed project predicate in the downstream descriptor:
    // search_memories combines the exact source with repo_path, admitting
    // metadata-less legacy rows while rejecting present mismatched or
    // malformed project identity.
    return {
      source: rowB!.source,
      filter: { repo_path: repoPath.normalized_path },
    };
  }

  // Default app-name branch (claude_code / codex / cursor-without-repo /
  // git-without-repo): single prefix query, optional canonical-project filter.
  const filter: QueryFilter = withFsExclusion({ source_prefix: prefix });
  if (repoPath !== null) {
    filter.project_key = repoPath.project_key;
    filter.legacy_project_roots = repoPath.legacy_project_roots;
  }
  const row = await newestMatching(storage, filter, scanState);
  if (row === null) return null;
  return {
    source: row.source,
    filter: repoPath !== null ? { repo_path: repoPath.normalized_path } : {},
  };
}

async function resolveLiteralSourceEntry(
  storage: Storage,
  literal: string,
  repoPath: ResolvedRepoPath | null,
  scanState: ScanState,
): Promise<ResolvedSourceDescriptor | null> {
  const filter: QueryFilter = withFsExclusion({ source: literal });
  if (repoPath !== null) {
    filter.project_key = repoPath.project_key;
    filter.legacy_project_roots = repoPath.legacy_project_roots;
  }
  const row = await newestMatching(storage, filter, scanState);
  if (row === null) return null;
  return {
    source: literal,
    filter: repoPath !== null ? { repo_path: repoPath.normalized_path } : {},
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

  let repoPath: ResolvedRepoPath | null = null;
  if (params.repo_path !== undefined) {
    assertAbsoluteRepoPath('echo_resolve_mru', params.repo_path);
    repoPath = await resolveRepoPath(params.repo_path);
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
          repoPath,
          scanState,
        );
      } else {
        result[entry] = await resolveLiteralSourceEntry(
          storage,
          entry,
          repoPath,
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
  if (repoPath !== null) {
    out.repo_path = repoPath.normalized_path;
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
            'Absolute project root. Restricts eligible activity by canonical project identity, with bounded legacy path fallback.',
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
