import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  filterToCurrentSignalRuns,
  GRANOLA_SIGNAL_INDEX_SOURCE,
  GRANOLA_SIGNAL_SOURCE,
} from '../../enrich/granola-signals.js';
import {
  METADATA_MATCH_KEY_WHITELIST,
  type CaptureEvent,
  type QueryFilter,
  type Storage,
} from '../../storage/interface.js';
import { withFsExclusion } from '../util/fs-exclusion.js';
import { hasTzMarker, isoString, TZ_NAIVE_WARNING } from '../util/iso8601.js';
import { assertAbsoluteRepoPath, normaliseRepoPath } from '../util/repo-path.js';
import { buildSourceAppMap, SOURCE_APP_VALUES, type SourceApp } from '../util/source-app.js';
import { projectMatch } from '../wire-shape/match.js';
import { CursorDecodeError, decodeCursor, emitCursor } from './_cursor.js';
// Re-export for any pre-existing callers / tests that imported the cursor
// helpers from search-memories. New callers should import from `_cursor.ts`.
export { CursorDecodeError, decodeCursor, encodeCursor, type DecodedCursor } from './_cursor.js';

export const SEARCH_MEMORIES_DESCRIPTION =
  "Search the user's captured ECHO memories (Cursor + Claude Code + Codex conversations, git commits, Granola meeting notes, and derived Granola signal atoms) by free-text query, app, source prefix, or time range. Returns the most recent matching events. Three-way source selection (more-specific wins): `source` (exact match — single session JSONL, git repo encoding, or API surface) > `source_prefix` (LIKE — path-precise filter, e.g. a single workspaceStorage subdir) > `source_app` (`cursor` | `claude_code` | `codex` | `git` | `granola`, expands to the canonical encoded prefix). All three are independently optional and may co-occur; the most-specific wins. Free-text `query` is matched as a case-insensitive literal substring against event content and `metadata.canonical_subject`; this is NOT a semantic / KNN search. Use exact tokens (file paths, SHAs, error codes) rather than paraphrased questions. Pass `repo_path=<absolute repo root>` (item 037) to scope results to atoms whose capture-side `metadata.repo_root` matches — works across source_apps with repo metadata; Granola normally has no repo_root and is resolved without repo_path. For `source_app='git'`, `repo_path` matches `metadata.repo_root` only; legacy git atoms without that metadata are reachable via `source_prefix='git:<path>'`. For `source_app='granola'`, the canonical prefix is `api:granola`. Pass `metadata_match={key: value, ...}` (item 038 + Granola signals) for an arbitrary AND-joined filter; a scalar value means equality and an array value means membership. Storage-forwarded keys remain `workspace_id`, `composer_id`, `session_id`, and `repo_root`; signal filters (`source`, `signal_type`, `canonical_subject`, `granola_atom_type`, `note_id`, `dedupe_key`, `parent_dedupe_key`, `extraction_run_id`) are applied in the tool before pagination. Passing BOTH `repo_path` and `metadata_match.repo_root` with conflicting values is rejected (isError). Derived Granola signal retrieval returns only the current manifest run for each note. For result sets exceeding `limit`, the response carries an opaque `next_cursor` string — pass it back verbatim as `cursor` on the next call to page through; do not construct one client-side. `next_cursor` is `null` when there are no more rows.";

export const DEFAULT_LIMIT = 10;
export const MAX_LIMIT = 50;
export type MetadataMatchValue = string | string[];

const TOOL_METADATA_MATCH_KEYS: ReadonlySet<string> = new Set([
  ...METADATA_MATCH_KEY_WHITELIST,
  'source',
  'signal_type',
  'canonical_subject',
  'granola_atom_type',
  'note_id',
  'dedupe_key',
  'parent_dedupe_key',
  'extraction_run_id',
]);

// V1.5.6 (2026-05-08): per-match content + per-key metadata caps live in
// the shared `src/mcp/wire-shape/` projector. `projectMatch` enforces them
// in a single call site so a future cap tightening only touches one file.

// Resolved once at module load via os.homedir().
const SOURCE_APP_MAP = buildSourceAppMap();

export interface SearchMatch {
  id: string;
  source: string;
  timestamp: string;
  /** Capped by `WIRE_SHAPE_CAPS.match_content`. When clipped, format is
   *  head + elision marker + tail. Missing-chars invariant for consumers:
   *  retained-byte-count + bytes_elided + marker-overhead = original. */
  content: string;
  /** Present only when `content` was clipped by the wire-shape projector. */
  bytes_elided?: number;
  /** Per-KEY clipped: any single value whose JSON-stringified form exceeds
   *  `WIRE_SHAPE_CAPS.metadata_value` is replaced by
   *  `{__elided: true, original_size: N}`. Other keys pass through verbatim. */
  metadata?: Record<string, unknown>;
  /** Sum of bytes dropped across (a) per-key elision placeholders and
   *  (b) shape-aware projections (e.g. tool_calls → name trajectory). */
  metadata_bytes_elided?: number;
  /** Keys whose value was REPLACED by `{__elided: true, original_size: N}`.
   *  Original shape is opaque on the wire; consumers wanting depth must
   *  hydrate via a follow-up call (deferred V1.6 deep-dive primitive). */
  metadata_keys_elided?: string[];
  /** V1.5.6.1: keys whose value was RESHAPED to a smaller useful
   *  representation (NOT opaqued). Today: `["tool_calls"]` when the
   *  original ToolCall[] was projected to its name trajectory. The
   *  consumer can read the projected value at face value — it carries
   *  legitimate signal (workflow shape), not just a size hint. */
  metadata_keys_projected?: string[];
  /** V1.6 (item 030): additive trust signal — ALWAYS present (possibly
   *  empty). See `ProjectedMatch.truncations` for the vocabulary. */
  truncations: string[];
}

export interface SearchResult {
  matches: SearchMatch[];
  total_returned: number;
  limit_applied: number;
  next_cursor: string | null;
  query_echo: {
    query: string | null;
    source_app: SourceApp | null;
    source_prefix: string | null;
    /** Item 038 / AC0: the exact-match `source` filter, when set. The 3-way
     *  precedence (`source` > `source_prefix` > `source_app`) is resolved
     *  inside the handler — query_echo surfaces ALL three input fields
     *  verbatim so the caller can see which one(s) were passed and which
     *  ended up applied. */
    source: string | null;
    since: string | null;
    until: string | null;
    cursor: string | null;
    limit: number;
    /** Item 037 / AC3: the normalised form (post `normaliseRepoPath`) of
     *  the caller-supplied `repo_path` — `null` when not passed. Echoing
     *  the normalised form lets the caller see what actually filtered
     *  storage (e.g. a trailing-slash input vs. the stored shape). */
    repo_path: string | null;
    /** Item 038 / AC0: the caller-supplied `metadata_match`, verbatim
     *  (BEFORE merge with `repo_path`'s implicit `metadata_match.repo_root`).
     *  Lets the caller verify which metadata-equality keys were forwarded
     *  to storage. `null` when not passed. */
    metadata_match: Record<string, MetadataMatchValue> | null;
  };
  /** V1.5.7 (Gap 6): non-blocking advisories. Mirrors
   *  `RecentWorkContextResponse.warnings`. Today emits the TZ-naive
   *  warning; future small advisories live here too. Always present
   *  (possibly empty) so consumers can do `r.warnings.length > 0` without
   *  optional-chaining. */
  warnings: string[];
}

export interface SearchMemoriesParams {
  query?: string;
  source_app?: SourceApp;
  source_prefix?: string;
  /** Item 038 / AC0: exact-source filter. Most specific of the 3-way source
   *  axis; when set, `source_prefix` and `source_app` are ignored. Used by
   *  the descriptor-spread composition (`search_memories(source: desc.source,
   *  ...desc.filter)`) where `echo_resolve_mru` returns an exact path. */
  source?: string;
  since?: string;
  until?: string;
  cursor?: string;
  limit?: number;
  /** Item 037 / AC3: work-artifact (repo) scoping. Absolute repo root path.
   *  When set, restricts results to atoms whose `metadata.repo_root` equals
   *  `normaliseRepoPath(repo_path)`. Joins AND with other filters. */
  repo_path?: string;
  /** Item 038 / AC0: arbitrary metadata-equality predicate. Each key/value
   *  pair AND-joins as `metadata[key] === value`. Allowed keys are the
   *  storage whitelist (`workspace_id`, `composer_id`, `session_id`,
   *  `repo_root`); non-whitelisted keys → isError at the tool layer
   *  (defense-in-depth on top of the storage-seam check). Conflicts on
   *  `repo_root` with `repo_path` → isError. */
  metadata_match?: Record<string, MetadataMatchValue>;
}

function clampLimit(input: number | undefined): number {
  if (input === undefined) return DEFAULT_LIMIT;
  const floored = Math.floor(input);
  return Math.min(Math.max(1, floored), MAX_LIMIT);
}

function sortDesc(events: CaptureEvent[]): CaptureEvent[] {
  // Mirror the storage `ORDER BY timestamp DESC, id DESC` contract: ties on
  // millisecond-equal timestamps break on id lex DESC for deterministic
  // pagination. Same direction as timestamp — never mix asc/desc.
  return [...events].sort((a, b) => {
    if (a.timestamp < b.timestamp) return 1;
    if (a.timestamp > b.timestamp) return -1;
    if (a.id < b.id) return 1;
    if (a.id > b.id) return -1;
    return 0;
  });
}

function metadataMatchValuesContain(expected: MetadataMatchValue, actual: string): boolean {
  return Array.isArray(expected) ? expected.includes(actual) : expected === actual;
}

function metadataValue(event: CaptureEvent, key: string): string | null {
  if (key === 'source') return event.source;
  const value = event.metadata?.[key];
  if (typeof value === 'string') return value;
  // AC5 (item 112): legacy team-decision atoms predate `canonical_subject`
  // and carry only `normalized_subject`. Fall back to `normalized_subject`
  // so a `{canonical_subject}` filter (the drift/`loop` join path) still
  // reaches them. Scoped strictly to team-decision atoms, identified by
  // `metadata.decision_atom_type === 'team_decision'` (the source-equivalent
  // discriminator the spec permits; using it keeps this tool layer from
  // importing the ceo-slack-responder surface, which is not in the packed CLI
  // closure). A signal atom or any other source carrying `normalized_subject`
  // must NOT satisfy a `{canonical_subject}` filter via this fallback. New
  // decision atoms carry `canonical_subject` directly and never reach here.
  if (key === 'canonical_subject' && event.metadata?.['decision_atom_type'] === 'team_decision') {
    const fallback = event.metadata['normalized_subject'];
    return typeof fallback === 'string' ? fallback : null;
  }
  return null;
}

function matchesMetadata(
  event: CaptureEvent,
  metadataMatch: Record<string, MetadataMatchValue>,
): boolean {
  for (const [key, expected] of Object.entries(metadataMatch)) {
    const actual = metadataValue(event, key);
    if (actual === null || !metadataMatchValuesContain(expected, actual)) return false;
  }
  return true;
}

function queryMatches(event: CaptureEvent, query: string): boolean {
  const q = query.toLowerCase();
  if (event.content.toLowerCase().includes(q)) return true;
  const canonicalSubject = event.metadata?.['canonical_subject'];
  return typeof canonicalSubject === 'string' && canonicalSubject.toLowerCase().includes(q);
}

function requestedGranolaSignals(
  effectiveSource: string | undefined,
  effectivePrefix: string | undefined,
  metadataMatch: Record<string, MetadataMatchValue> | undefined,
): boolean {
  if (effectiveSource === GRANOLA_SIGNAL_SOURCE) return true;
  if (
    effectivePrefix !== undefined &&
    (GRANOLA_SIGNAL_SOURCE.startsWith(effectivePrefix) ||
      effectivePrefix.startsWith(GRANOLA_SIGNAL_SOURCE))
  ) {
    return true;
  }
  if (metadataMatch === undefined) return false;
  const source = metadataMatch['source'];
  if (source !== undefined && metadataMatchValuesContain(source, GRANOLA_SIGNAL_SOURCE))
    return true;
  return (
    metadataMatch['signal_type'] !== undefined || metadataMatch['canonical_subject'] !== undefined
  );
}

function storageMetadataMatchFrom(
  metadataMatch: Record<string, MetadataMatchValue> | undefined,
): Record<string, string> | undefined {
  if (metadataMatch === undefined) return undefined;
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(metadataMatch)) {
    if (METADATA_MATCH_KEY_WHITELIST.has(key) && typeof value === 'string') out[key] = value;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

export async function searchMemories(
  storage: Storage,
  params: SearchMemoriesParams,
): Promise<SearchResult> {
  const {
    query,
    source_app,
    source_prefix,
    source,
    since,
    until,
    cursor,
    limit,
    repo_path,
    metadata_match,
  } = params;
  const limitApplied = clampLimit(limit);

  // Item 037 / AC3: validate + normalise repo_path before any storage call.
  // Throwing here surfaces through the MCP envelope handler as `isError`
  // (same pattern as the historical `search_memories: ` error prefix).
  let normalisedRepoPath: string | null = null;
  if (repo_path !== undefined) {
    assertAbsoluteRepoPath('search_memories', repo_path);
    normalisedRepoPath = normaliseRepoPath(repo_path);
  }

  // Item 038 / AC0: 3-way source precedence — `source` (exact) wins over
  // `source_prefix` (LIKE) wins over `source_app` (LIKE on canonical app
  // prefix). The losing axes are ignored, NOT merged or errored. All three
  // are echoed in `query_echo` so the caller can see what they passed and
  // (by elimination) which one was applied.
  let effectiveSource: string | undefined;
  let effectivePrefix: string | undefined;
  if (source !== undefined) {
    effectiveSource = source;
  } else if (source_prefix !== undefined) {
    effectivePrefix = source_prefix;
  } else if (source_app !== undefined) {
    effectivePrefix = SOURCE_APP_MAP[source_app];
  }

  // Item 038 / AC0: validate + merge `metadata_match`. The storage seam ALSO
  // enforces the whitelist (defense-in-depth — see `METADATA_MATCH_KEY_WHITELIST`
  // in storage/interface.ts); the tool-layer check produces a clean, source-
  // attributed isError envelope instead of letting the storage error bubble up.
  let storageMetadataMatch = storageMetadataMatchFrom(metadata_match);
  if (metadata_match !== undefined) {
    for (const [key, value] of Object.entries(metadata_match)) {
      if (!TOOL_METADATA_MATCH_KEYS.has(key)) {
        // Dynamic whitelist interpolation (R2 #7): the error message can never
        // drift behind the constant if the whitelist is extended.
        throw new Error(
          `search_memories: metadata_match contains non-whitelisted key '${key}'; allowed: ${Array.from(
            TOOL_METADATA_MATCH_KEYS,
          ).join(', ')}`,
        );
      }
      if (Array.isArray(value) && value.length === 0) {
        throw new Error(`search_memories: metadata_match.${key} array must be non-empty`);
      }
    }
  }
  if (normalisedRepoPath !== null) {
    // Merge precedence with `repo_path`'s implicit `metadata_match.repo_root`.
    // Conflict on the `repo_root` key (caller passed both with different
    // values) → isError. Equal values are silently merged (idempotent).
    const requestedRepoRoot = metadata_match?.['repo_root'];
    if (
      requestedRepoRoot !== undefined &&
      !metadataMatchValuesContain(requestedRepoRoot, normalisedRepoPath)
    ) {
      throw new Error(
        'search_memories: metadata_match.repo_root conflicts with repo_path; pass one or the other',
      );
    }
    storageMetadataMatch = {
      ...(storageMetadataMatch ?? {}),
      repo_root: normalisedRepoPath,
    };
  }

  let before: { timestamp: string; id: string } | undefined;
  if (cursor !== undefined) {
    before = decodeCursor(cursor);
  }

  // Gap 3 (V1.5.7, surfaced 2026-05-08 17:01 PDT v1.5-livetest): every
  // retrieval tool excludes fs-watcher meta-events (`metadata.surface ===
  // 'fs'`). Item 038 / AC5 centralised that exclusion in `withFsExclusion`
  // so a new tool re-hardcoding the inline literal is caught structurally
  // by the `tests/mcp/util/fs-exclusion.test.ts` grep-scan.
  const filter: QueryFilter = withFsExclusion({});
  if (effectiveSource !== undefined) filter.source = effectiveSource;
  if (effectivePrefix !== undefined) filter.source_prefix = effectivePrefix;
  // 057a AC1 non-pollution: search_memories() with no filter MUST NOT
  // return coord atoms by default — they're substrate plumbing, not
  // user-facing knowledge. The dedicated exclusion lives here (NOT in
  // the shared withFsExclusion helper — that would also block
  // wait_for_new_turns(source_prefix="coord:") per AC4). The opt-in is
  // an explicit source_prefix starting with "coord:" (forensic
  // retrieval); a coord-targeted exact source filter or source_prefix
  // also opts in.
  const coordExplicitlyRequested =
    (effectiveSource !== undefined && effectiveSource.startsWith('coord:')) ||
    (effectivePrefix !== undefined && effectivePrefix.startsWith('coord:'));
  if (!coordExplicitlyRequested) {
    const exclude = filter.exclude_metadata_surface ?? [];
    filter.exclude_metadata_surface = [...exclude, 'coord'];
  }
  if (since !== undefined) filter.since = since;
  if (until !== undefined) filter.until = until;
  if (before !== undefined) filter.before = before;
  if (storageMetadataMatch !== undefined) filter.metadata_match = storageMetadataMatch;

  const restrictToCurrentGranolaSignals = requestedGranolaSignals(
    effectiveSource,
    effectivePrefix,
    metadata_match,
  );

  // Two paths through the result list, two overfetch sites — keep them legible
  // so the next reader doesn't collapse them into one and re-introduce item
  // 022's filter-before-slice bug:
  //   (A) recency-only path (`query === undefined`): pass `limit + 1` to
  //       storage. Storage returns rows already ordered DESC; we drop the
  //       extra and emit a cursor if it was present.
  //   (B) substring-query path (`query !== undefined`): do NOT pass any limit
  //       to storage — the substring filter runs in JS over the FULL window,
  //       so an upstream limit would silently drop matches outside the
  //       newest-N. Slice to `limit + 1` AFTER the substring filter and emit
  //       cursor from the last kept row.
  const requiresFullWindowFilter =
    query !== undefined || metadata_match !== undefined || restrictToCurrentGranolaSignals;
  if (!requiresFullWindowFilter) filter.limit = limitApplied + 1;

  const all = await storage.query(filter);
  const sorted = sortDesc(all);
  let candidates = sorted;

  if (query !== undefined) {
    candidates = candidates.filter((e) => queryMatches(e, query));
  }

  if (metadata_match !== undefined) {
    candidates = candidates.filter((e) => matchesMetadata(e, metadata_match));
  }

  if (restrictToCurrentGranolaSignals) {
    const manifestEvents = await storage.query({ source: GRANOLA_SIGNAL_INDEX_SOURCE });
    candidates = filterToCurrentSignalRuns(candidates, manifestEvents);
  }

  // Path-aware overfetch slicing. Both paths converge here once their
  // candidate list is in DESC order: keep up to `limit + 1`, drop the extra,
  // emit cursor from the last kept row.
  const overfetched = candidates.slice(0, limitApplied + 1);
  const { kept, next_cursor } = emitCursor(overfetched, limitApplied);

  // V1.5.7 (Gap 6): same TZ-naive warning as get_recent_work_context. The
  // schema regex ISO8601_RE is intentionally permissive (accepts naive
  // strings); the warning surfaces the parse-as-local-time foot-gun on
  // non-UTC machines without breaking callers that pass naive strings on
  // purpose.
  const warnings: string[] = [];
  if (
    (since !== undefined && !hasTzMarker(since)) ||
    (until !== undefined && !hasTzMarker(until))
  ) {
    warnings.push(TZ_NAIVE_WARNING);
  }

  return {
    matches: kept.map(projectMatch),
    total_returned: kept.length,
    limit_applied: limitApplied,
    next_cursor,
    query_echo: {
      query: query ?? null,
      source_app: source_app ?? null,
      source_prefix: source_prefix ?? null,
      source: source ?? null,
      since: since ?? null,
      until: until ?? null,
      cursor: cursor ?? null,
      limit: limitApplied,
      repo_path: normalisedRepoPath,
      metadata_match: metadata_match ?? null,
    },
    warnings,
  };
}

// Single source-of-truth Zod shape for a captured atom in MCP tool responses.
// Exported so any future retrieval tool can reuse the exact same atom shape —
// keeps consumers stable when ECHO adds a tool.
export const searchMatchSchema = z.object({
  id: z.string(),
  source: z.string(),
  timestamp: z.string(),
  content: z.string(),
  // Optional — set by the wire-shape projector when content was clipped.
  bytes_elided: z.number().int().nonnegative().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  // Optional — set by the wire-shape projector when one or more metadata
  // values exceeded the per-key cap and were replaced by elision placeholders.
  metadata_bytes_elided: z.number().int().nonnegative().optional(),
  metadata_keys_elided: z.array(z.string()).optional(),
  // V1.5.6.1 — optional, set when one or more metadata values were
  // RESHAPED to a smaller useful representation (e.g. tool_calls → name
  // trajectory). Distinct semantics from metadata_keys_elided.
  metadata_keys_projected: z.array(z.string()).optional(),
  // V1.6 (item 030) — additive trust signal that unifies BOTH per-field
  // caps AND projector reshapes in one place. ALWAYS present (possibly
  // []). Vocabulary: "content" (content cap fired), "metadata.<k>" (per-
  // key cap fired — value opaqued), "metadata.<k>:projected" (projector
  // reshaped — value reformatted, not clipped).
  truncations: z.array(z.string()),
});

// outputSchema for `tools/list` advertisement and structured-content
// validation by the SDK. Mirrors SearchResult; matches use `z.unknown()` for
// the optional metadata bag (its shape varies per source).
const searchMemoriesOutputSchema = {
  matches: z.array(searchMatchSchema),
  total_returned: z.number(),
  limit_applied: z.number(),
  next_cursor: z.string().nullable(),
  query_echo: z.object({
    query: z.string().nullable(),
    source_app: z.enum(SOURCE_APP_VALUES).nullable(),
    source_prefix: z.string().nullable(),
    source: z.string().nullable(),
    since: z.string().nullable(),
    until: z.string().nullable(),
    cursor: z.string().nullable(),
    limit: z.number(),
    repo_path: z.string().nullable(),
    metadata_match: z
      .record(z.string(), z.union([z.string(), z.array(z.string()).nonempty()]))
      .nullable(),
  }),
  // V1.5.7 (Gap 6): non-blocking advisories. Always present (possibly empty).
  warnings: z.array(z.string()),
};

export function registerSearchMemories(server: McpServer, storage: Storage): void {
  server.registerTool(
    'search_memories',
    {
      description: SEARCH_MEMORIES_DESCRIPTION,
      inputSchema: {
        query: z.string().optional(),
        source_app: z.enum(SOURCE_APP_VALUES).optional(),
        source_prefix: z.string().optional(),
        source: z
          .string()
          .optional()
          .describe(
            'Item 038 / AC0: exact-source filter. 3-way precedence — `source` (exact) > `source_prefix` (LIKE) > `source_app` (canonical app prefix); the most-specific wins. The losing axes are ignored, NOT errored.',
          ),
        since: isoString.optional(),
        until: isoString.optional(),
        cursor: z.string().optional(),
        limit: z.number().optional(),
        repo_path: z
          .string()
          .optional()
          .describe(
            'Item 037: absolute filesystem path to a repo root. When set, scopes the result set to atoms whose `metadata.repo_root` (written at capture time for claude_code, codex, and cursor; reachable across repo-aware source_apps) equals the normalised path. For `source_app=git`, matches `metadata.repo_root` only — legacy git atoms without that metadata are reachable via `source_prefix=git:<path>`. Granola atoms normally have no repo_root, so search them without repo_path. Conflicts on `repo_root` with an explicit `metadata_match` entry → isError.',
          ),
        metadata_match: z
          .record(z.string(), z.union([z.string(), z.array(z.string()).nonempty()]))
          .optional()
          .describe(
            'Item 038 / AC0 + Granola signals: arbitrary AND-joined filter. Scalar value means equality; array value means membership. Storage-forwarded keys are `workspace_id`, `composer_id`, `session_id`, `repo_root`; signal/source keys (`source`, `signal_type`, `canonical_subject`, `granola_atom_type`, `note_id`, `dedupe_key`, `parent_dedupe_key`, `extraction_run_id`) are applied before pagination.',
          ),
      },
      outputSchema: searchMemoriesOutputSchema,
      annotations: { readOnlyHint: true },
    },
    async (input) => {
      let result: SearchResult;
      try {
        result = await searchMemories(storage, input as SearchMemoriesParams);
      } catch (err) {
        if (err instanceof CursorDecodeError) {
          // MCP semantics: tool errors are signalled by isError:true on the
          // result envelope — NOT by a JSON-RPC validation rejection. We
          // deliberately omit `structuredContent` because the success
          // outputSchema's `next_cursor: nullable string` cannot represent
          // the error variant.
          return {
            isError: true,
            content: [{ type: 'text', text: err.message }],
          };
        }
        // Item 037 / AC3: repo_path validation errors surface through the
        // same `isError` envelope (one consistent pattern across retrieval
        // tools — see `src/mcp/util/repo-path.ts`).
        if (err instanceof Error && err.message.startsWith('search_memories: ')) {
          return {
            isError: true,
            content: [{ type: 'text', text: err.message }],
          };
        }
        throw err;
      }
      return {
        content: [{ type: 'text', text: JSON.stringify(result) }],
        structuredContent: result as unknown as Record<string, unknown>,
      };
    },
  );
}
