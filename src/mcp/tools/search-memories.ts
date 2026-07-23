import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  GRANOLA_SIGNAL_INDEX_SOURCE,
  GRANOLA_SIGNAL_SOURCE,
  resolveCurrentGranolaSignalRuns,
} from '../util/granola-signal-runs.js';
import {
  METADATA_MATCH_KEY_WHITELIST,
  type CaptureEvent,
  type QueryFilter,
  type Storage,
} from '../../storage/interface.js';
import {
  STORAGE_GET_BY_IDS_MAX_IDS,
  StorageScanBudgetExceededError,
} from '../../storage/budgets.js';
import { withFsExclusion } from '../util/fs-exclusion.js';
import { hasTzMarker, isoString, TZ_NAIVE_WARNING } from '../util/iso8601.js';
import {
  assertAbsoluteRepoPath,
  normaliseRepoPath,
  projectKeyForRepoPath,
} from '../util/repo-path.js';
import { buildSourceAppMap, SOURCE_APP_VALUES, type SourceApp } from '../util/source-app.js';
import { jsonByteLength } from '../wire-shape/bytes.js';
import { clipString } from '../wire-shape/clip.js';
import { projectMatch, type ProjectedMatch } from '../wire-shape/match.js';
import { CursorDecodeError, decodeCursor, emitCursor, encodeCursor } from './_cursor.js';
// Re-export for any pre-existing callers / tests that imported the cursor
// helpers from search-memories. New callers should import from `_cursor.ts`.
export { CursorDecodeError, decodeCursor, encodeCursor, type DecodedCursor } from './_cursor.js';

export const SEARCH_MEMORIES_DESCRIPTION =
  "Search the user's captured ECHO memories with case-insensitive literal substring matching; this is NOT a semantic search. Use exact phrases, paths, SHAs, IDs, or error text. Results are newest first and the complete JSON result is capped at 25,000 UTF-8 bytes.\n\n" +
  'Choose at most one source selector: `source` (one exact captured source), `source_prefix` (all sources beginning with a prefix), or `source_app` (`cursor`, `claude_code`, `codex`, `git`, `granola`). `cursor` covers historical Cursor records; this runtime does not capture new ones. For compatibility, multiple selectors still use `source > source_prefix > source_app` and emit a warning naming ignored selectors. `repo_path` and `metadata_match` add AND filters.\n\n' +
  'Pass `next_cursor` back unchanged as `cursor`. A non-null cursor can mean more matches, a bounded scan continuation, or response-budget trimming; inspect coded `warnings`. `next_cursor: null` means the scanned window ended, but a manifest-cap warning can still make older Granola coverage incomplete. Per-match `truncations` and metadata omission fields are trust signals; use `get_atom(id)` for verbatim content when it fits, but remember its metadata remains projected.';

export const DEFAULT_LIMIT = 10;
export const MAX_LIMIT = 50;
export const SEARCH_RESPONSE_BYTE_CEILING = 25_000;
export const SEARCH_QUERY_ECHO_BYTE_CEILING = 4_096;
// Hard work budget for paths that need post-storage filtering (literal
// substring search, array-valued metadata filters, and current-Granola-run
// filtering). A request inspects at most PAGE_ROWS * MAX_PAGES rows and stops
// early at MAX_BYTES. Continuing older history is explicit through the opaque
// next_cursor; no request is allowed to materialise the whole ledger.
export const SEARCH_SCAN_PAGE_ROWS = 128;
export const SEARCH_SCAN_MAX_PAGES = 16;
export const SEARCH_SCAN_MAX_ROWS = SEARCH_SCAN_PAGE_ROWS * SEARCH_SCAN_MAX_PAGES;
export const SEARCH_SCAN_MAX_BYTES = 16 * 1024 * 1024;
export const SEARCH_MANIFEST_PAGE_ROWS = 128;
export const SEARCH_MANIFEST_MAX_PAGES = 8;
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
  /** Count of keys omitted by the per-match whole-metadata budget. */
  metadata_keys_omitted?: number;
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
    /** Item 038 / AC0: the caller-supplied `metadata_match`, verbatim and
     *  separate from repo_path's canonical project filter. Lets the caller
     *  verify which exact metadata-equality keys were forwarded. */
    metadata_match: Record<string, MetadataMatchValue> | null;
  };
  /** V1.5.7 (Gap 6): non-blocking advisories. Mirrors
   *  `RecentWorkContextResponse.warnings`. Today emits the TZ-naive
   *  warning; future small advisories live here too. Always present
   *  (possibly empty) so consumers can do `r.warnings.length > 0` without
   *  optional-chaining. */
  warnings: string[];
}

type SearchQueryEcho = SearchResult['query_echo'];

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
  /** Item 037 / AC3: canonical project scoping. Absolute project root path.
   *  Joins AND with other filters while retaining nested adapter cwd values. */
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

function clipJsonString(value: string, jsonBudget: number): string {
  if (jsonByteLength(value) <= jsonBudget) return value;
  let retainedBytes = Math.max(16, Math.floor(jsonBudget / 2));
  let clipped = clipString(value, retainedBytes).value;
  while (jsonByteLength(clipped) > jsonBudget && retainedBytes > 16) {
    retainedBytes = Math.max(16, Math.floor(retainedBytes / 2));
    clipped = clipString(value, retainedBytes).value;
  }
  return clipped;
}

function boundQueryEcho(full: SearchQueryEcho): { echo: SearchQueryEcho; capped: boolean } {
  if (jsonByteLength(full) <= SEARCH_QUERY_ECHO_BYTE_CEILING) {
    return { echo: full, capped: false };
  }
  const clipNullable = (value: string | null): string | null =>
    value === null ? null : clipJsonString(value, 384);
  const echo: SearchQueryEcho = {
    query: clipNullable(full.query),
    source_app: full.source_app,
    source_prefix: clipNullable(full.source_prefix),
    source: clipNullable(full.source),
    since: clipNullable(full.since),
    until: clipNullable(full.until),
    cursor: clipNullable(full.cursor),
    limit: full.limit,
    repo_path: clipNullable(full.repo_path),
    metadata_match: full.metadata_match === null ? null : {},
  };
  if (full.metadata_match !== null) {
    const bounded: Record<string, MetadataMatchValue> = {};
    const entries = Object.entries(full.metadata_match).sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0,
    );
    for (const [key, value] of entries) {
      const projected = Array.isArray(value)
        ? value.slice(0, 8).map((entry) => clipJsonString(entry, 128))
        : clipJsonString(value, 384);
      const candidate = { ...bounded, [key]: projected };
      const candidateEcho = { ...echo, metadata_match: candidate };
      if (jsonByteLength(candidateEcho) > SEARCH_QUERY_ECHO_BYTE_CEILING) break;
      bounded[key] = projected;
    }
    echo.metadata_match = bounded;
  }
  return { echo, capped: true };
}

function responseCursorAfter(event: CaptureEvent): string {
  return encodeCursor({ timestamp: event.timestamp, id: event.id });
}

function identityStub(event: CaptureEvent): ProjectedMatch {
  const source = clipJsonString(event.source, 1_024);
  const truncations = ['content', 'metadata'];
  if (source !== event.source) truncations.unshift('source');
  return {
    id: event.id,
    source,
    timestamp: event.timestamp,
    content: '',
    ...(event.content.length > 0
      ? { bytes_elided: Buffer.byteLength(event.content, 'utf8') }
      : {}),
    ...(event.metadata !== undefined
      ? { metadata_keys_omitted: Object.keys(event.metadata).length }
      : {}),
    truncations,
  };
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

function eventBytes(event: CaptureEvent): number {
  let bytes =
    Buffer.byteLength(event.id, 'utf8') +
    Buffer.byteLength(event.source, 'utf8') +
    Buffer.byteLength(event.timestamp, 'utf8') +
    Buffer.byteLength(event.content, 'utf8');
  if (event.metadata !== undefined) {
    bytes += Buffer.byteLength(JSON.stringify(event.metadata), 'utf8');
  }
  if (event.embedding !== undefined) {
    bytes += event.embedding.length * Float32Array.BYTES_PER_ELEMENT;
  }
  return bytes;
}

interface BoundedScanResult {
  matches: CaptureEvent[];
  next_cursor: string | null;
  budgetExhausted: boolean;
  rowsScanned: number;
  bytesScanned: number;
  pagesScanned: number;
}

interface ManifestWindow {
  events: CaptureEvent[];
  truncated: boolean;
}

interface StorageQueryPage {
  rows: CaptureEvent[];
  resume: QueryFilter['before'];
  scanBudgetExhausted: boolean;
}

async function queryStoragePage(
  storage: Storage,
  filter: QueryFilter,
): Promise<StorageQueryPage> {
  try {
    return {
      rows: sortDesc(await storage.query(filter)),
      resume: undefined,
      scanBudgetExhausted: false,
    };
  } catch (err) {
    if (!(err instanceof StorageScanBudgetExceededError) || err.order !== 'desc') throw err;
    if (err.matched_ids.length > SEARCH_SCAN_PAGE_ROWS) {
      throw new RangeError(
        `storage scan returned ${err.matched_ids.length} matches for a ${SEARCH_SCAN_PAGE_ROWS}-row page`,
      );
    }
    const rows: CaptureEvent[] = [];
    for (let offset = 0; offset < err.matched_ids.length; offset += STORAGE_GET_BY_IDS_MAX_IDS) {
      rows.push(
        ...(await storage.getByIds(
          err.matched_ids.slice(offset, offset + STORAGE_GET_BY_IDS_MAX_IDS),
        )),
      );
    }
    return {
      rows: sortDesc(rows),
      resume: err.resume_cursor,
      scanBudgetExhausted: true,
    };
  }
}

async function loadBoundedManifestWindow(storage: Storage): Promise<ManifestWindow> {
  const events: CaptureEvent[] = [];
  let before: QueryFilter['before'];
  for (let page = 0; page < SEARCH_MANIFEST_MAX_PAGES; page += 1) {
    const rows = await storage.query({
      source: GRANOLA_SIGNAL_INDEX_SOURCE,
      limit: SEARCH_MANIFEST_PAGE_ROWS,
      ...(before !== undefined ? { before } : {}),
    });
    const ordered = sortDesc(rows);
    events.push(...ordered);
    if (ordered.length < SEARCH_MANIFEST_PAGE_ROWS) {
      return { events, truncated: false };
    }
    const last = ordered[ordered.length - 1]!;
    before = { timestamp: last.timestamp, id: last.id };
  }
  return { events, truncated: true };
}

async function scanFilteredPages(
  storage: Storage,
  baseFilter: QueryFilter,
  limitApplied: number,
  predicate: (event: CaptureEvent) => boolean,
): Promise<BoundedScanResult> {
  const matches: CaptureEvent[] = [];
  let before = baseFilter.before;
  let lastScanned: CaptureEvent | undefined;
  let rowsScanned = 0;
  let bytesScanned = 0;
  let pagesScanned = 0;
  let reachedEnd = false;

  while (
    pagesScanned < SEARCH_SCAN_MAX_PAGES &&
    rowsScanned < SEARCH_SCAN_MAX_ROWS &&
    bytesScanned < SEARCH_SCAN_MAX_BYTES
  ) {
    const storagePage = await queryStoragePage(storage, {
      ...baseFilter,
      ...(before !== undefined ? { before } : {}),
      limit: SEARCH_SCAN_PAGE_ROWS,
    });
    const rows = storagePage.rows;
    pagesScanned += 1;
    if (rows.length === 0) {
      if (storagePage.scanBudgetExhausted) {
        return {
          matches,
          next_cursor:
            storagePage.resume === undefined ? null : encodeCursor(storagePage.resume),
          budgetExhausted: true,
          rowsScanned,
          bytesScanned,
          pagesScanned,
        };
      }
      reachedEnd = true;
      break;
    }

    let rowsConsumedFromPage = 0;
    for (const row of rows) {
      const size = eventBytes(row);
      // Always permit one row so a single large atom cannot pin the cursor
      // forever. The SQLite adapter independently enforces its per-call byte
      // ceiling before this layer receives rows.
      if (rowsScanned > 0 && bytesScanned + size > SEARCH_SCAN_MAX_BYTES) {
        break;
      }
      rowsScanned += 1;
      bytesScanned += size;
      lastScanned = row;
      rowsConsumedFromPage += 1;
      if (predicate(row)) matches.push(row);
      if (matches.length > limitApplied) {
        const { kept, next_cursor } = emitCursor(matches, limitApplied);
        return {
          matches: kept,
          next_cursor,
          budgetExhausted: false,
          rowsScanned,
          bytesScanned,
          pagesScanned,
        };
      }
      if (rowsScanned >= SEARCH_SCAN_MAX_ROWS || bytesScanned >= SEARCH_SCAN_MAX_BYTES) break;
    }

    // A byte/row stop can happen in the middle of even a short final storage
    // page. In that case the page length says nothing about end-of-history:
    // the unconsumed suffix must remain reachable from `lastScanned` on the
    // next request. The same rule takes precedence over a deeper storage-scan
    // resume cursor, which may already be older than the hydrated page.
    const pagePartiallyConsumed = rowsConsumedFromPage < rows.length;

    if (storagePage.scanBudgetExhausted) {
      const overflow = emitCursor(matches, limitApplied);
      let continuationCursor = overflow.next_cursor;
      if (matches.length <= limitApplied) {
        if (pagePartiallyConsumed && lastScanned !== undefined) {
          continuationCursor = encodeCursor({
            timestamp: lastScanned.timestamp,
            id: lastScanned.id,
          });
        } else if (storagePage.resume !== undefined) {
          continuationCursor = encodeCursor(storagePage.resume);
        }
      }
      return {
        matches: overflow.kept,
        next_cursor: continuationCursor,
        budgetExhausted: true,
        rowsScanned,
        bytesScanned,
        pagesScanned,
      };
    }

    if (pagePartiallyConsumed) break;
    if (rows.length < SEARCH_SCAN_PAGE_ROWS) {
      reachedEnd = true;
      break;
    }
    if (lastScanned === undefined) break;
    before = { timestamp: lastScanned.timestamp, id: lastScanned.id };
  }

  const budgetExhausted = !reachedEnd && lastScanned !== undefined;
  const nextCursor =
    budgetExhausted && lastScanned !== undefined
      ? encodeCursor({ timestamp: lastScanned.timestamp, id: lastScanned.id })
      : null;
  return {
    matches,
    next_cursor: nextCursor,
    budgetExhausted,
    rowsScanned,
    bytesScanned,
    pagesScanned,
  };
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
    // An explicit repo_root equality predicate must agree with the broader
    // canonical-project filter. Equal values remain an idempotent AND.
    const requestedRepoRoot = metadata_match?.['repo_root'];
    if (
      requestedRepoRoot !== undefined &&
      !metadataMatchValuesContain(requestedRepoRoot, normalisedRepoPath)
    ) {
      throw new Error(
        'search_memories: metadata_match.repo_root conflicts with repo_path; pass one or the other',
      );
    }
    // Canonical project scoping is applied separately below. Keep an explicit
    // metadata_match.repo_root only when the caller intentionally supplied it.
  }

  let before: { timestamp: string; id: string } | undefined;
  if (cursor !== undefined) {
    before = decodeCursor(cursor);
  }

  // Keep migrated raw filesystem notifications out of semantic results. The
  // shared helper prevents retrieval tools from drifting on this filter.
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
  if (normalisedRepoPath !== null) {
    filter.project_key = projectKeyForRepoPath(normalisedRepoPath);
  }

  const restrictToCurrentGranolaSignals = requestedGranolaSignals(
    effectiveSource,
    effectivePrefix,
    metadata_match,
  );

  // Two bounded paths through the result list:
  //   (A) recency-only requests overfetch exactly one row in SQLite.
  //   (B) requests needing a JS predicate scan fixed-size keyset pages until
  //       limit+1 matches, end-of-window, or a hard rows/bytes/pages budget.
  //       A budget stop returns a cursor at the last INSPECTED row, allowing
  //       the caller to continue without reloading or skipping history.
  const requiresFullWindowFilter =
    query !== undefined || metadata_match !== undefined || restrictToCurrentGranolaSignals;
  let kept: CaptureEvent[];
  let next_cursor: string | null;
  let scanBudgetExhausted = false;
  let manifestWindowTruncated = false;

  if (!requiresFullWindowFilter) {
    filter.limit = limitApplied + 1;
    const storagePage = await queryStoragePage(storage, filter);
    ({ kept, next_cursor } = emitCursor(storagePage.rows, limitApplied));
    if (
      next_cursor === null &&
      storagePage.scanBudgetExhausted &&
      storagePage.resume !== undefined
    ) {
      next_cursor = encodeCursor(storagePage.resume);
    }
    scanBudgetExhausted = storagePage.scanBudgetExhausted;
  } else {
    let currentGranolaSignalIds: Set<string> | null = null;
    if (restrictToCurrentGranolaSignals) {
      const window = await loadBoundedManifestWindow(storage);
      manifestWindowTruncated = window.truncated;
      currentGranolaSignalIds = new Set<string>();
      for (const manifest of resolveCurrentGranolaSignalRuns(window.events).values()) {
        for (const id of manifest.signal_atom_ids) currentGranolaSignalIds.add(id);
      }
    }
    const scan = await scanFilteredPages(storage, filter, limitApplied, (event) => {
      if (query !== undefined && !queryMatches(event, query)) return false;
      if (metadata_match !== undefined && !matchesMetadata(event, metadata_match)) return false;
      if (
        restrictToCurrentGranolaSignals &&
        event.source === GRANOLA_SIGNAL_SOURCE &&
        !currentGranolaSignalIds!.has(event.id)
      ) {
        return false;
      }
      return true;
    });
    kept = scan.matches;
    next_cursor = scan.next_cursor;
    scanBudgetExhausted = scan.budgetExhausted;
  }

  // V1.5.7 (Gap 6): same TZ-naive warning as get_recent_work_context. The
  // schema regex ISO8601_RE is intentionally permissive (accepts naive
  // strings); the warning surfaces the parse-as-local-time foot-gun on
  // non-UTC machines without breaking callers that pass naive strings on
  // purpose.
  const warnings: string[] = [];
  const sourceSelectors = [
    source !== undefined ? 'source' : null,
    source_prefix !== undefined ? 'source_prefix' : null,
    source_app !== undefined ? 'source_app' : null,
  ].filter((selector): selector is string => selector !== null);
  if (sourceSelectors.length > 1) {
    const applied = source !== undefined ? 'source' : 'source_prefix';
    const ignored = sourceSelectors.filter((selector) => selector !== applied);
    warnings.push(
      `[SOURCE_SELECTOR_PRECEDENCE] applied ${applied}; ignored ${ignored.join(', ')}. Pass one source selector per call.`,
    );
  }
  if (
    (since !== undefined && !hasTzMarker(since)) ||
    (until !== undefined && !hasTzMarker(until))
  ) {
    warnings.push(TZ_NAIVE_WARNING);
  }
  if (scanBudgetExhausted) {
    warnings.push(
      `[SEARCH_SCAN_BUDGET] scan budget reached: ${SEARCH_SCAN_MAX_ROWS} rows / ${SEARCH_SCAN_MAX_BYTES} bytes / ${SEARCH_SCAN_MAX_PAGES} pages maximum; pass next_cursor to continue`,
    );
  }
  if (manifestWindowTruncated) {
    warnings.push(
      `[SEARCH_MANIFEST_CAP] Granola manifest lookup reached its bounded ${SEARCH_MANIFEST_PAGE_ROWS * SEARCH_MANIFEST_MAX_PAGES}-row window; older-note coverage may be incomplete`,
    );
  }

  const projected = kept.map(projectMatch);
  const fullEcho: SearchQueryEcho = {
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
  };
  const boundedEcho = boundQueryEcho(fullEcho);
  if (boundedEcho.capped) {
    warnings.push(
      `[SEARCH_QUERY_ECHO_CAP] query_echo was clipped to ${SEARCH_QUERY_ECHO_BYTE_CEILING} UTF-8 JSON bytes; filtering still used the full input`,
    );
  }

  const buildResult = (
    matches: ProjectedMatch[],
    cursorOut: string | null,
    extraWarnings: string[] = [],
  ): SearchResult => ({
    matches,
    total_returned: matches.length,
    limit_applied: limitApplied,
    next_cursor: cursorOut,
    query_echo: boundedEcho.echo,
    warnings: [
      ...warnings,
      ...(matches.some((match) => (match.metadata_keys_omitted ?? 0) > 0)
        ? [
            '[SEARCH_METADATA_CAP] one or more matches omitted metadata keys; inspect metadata_keys_omitted. get_atom(id) can recover verbatim content when it fits, but metadata remains projected; read the captured source when exact metadata is required',
          ]
        : []),
      ...extraWarnings,
    ],
  });

  let returned = [...projected];
  let result = buildResult(returned, next_cursor);
  if (jsonByteLength(result) > SEARCH_RESPONSE_BYTE_CEILING && kept.length > 0) {
    while (returned.length > 0) {
      const lastRaw = kept[returned.length - 1]!;
      const responseWarning =
        `[SEARCH_RESPONSE_CAP] returned newest ${returned.length} of ${projected.length} candidate matches; ` +
        'next_cursor resumes after the last returned match';
      result = buildResult(returned, responseCursorAfter(lastRaw), [responseWarning]);
      if (jsonByteLength(result) <= SEARCH_RESPONSE_BYTE_CEILING) break;
      returned = returned.slice(0, -1);
    }
    if (returned.length === 0) {
      const stub = identityStub(kept[0]!);
      result = buildResult([stub], responseCursorAfter(kept[0]!), [
        '[SEARCH_RESPONSE_CAP] newest match required an identity-only stub; use get_atom(id) for verbatim content when it fits, but metadata remains projected',
      ]);
    }
  }
  return result;
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
  metadata_keys_omitted: z.number().int().nonnegative().optional(),
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
        query: z.string().max(4096).optional(),
        source_app: z.enum(SOURCE_APP_VALUES).optional(),
        source_prefix: z.string().max(4096).optional(),
        source: z
          .string()
          .max(4096)
          .optional()
          .describe(
            'Exact captured-source filter. Pass only one of source, source_prefix, or source_app; legacy mixed calls preserve precedence and emit a warning.',
          ),
        since: isoString.optional(),
        until: isoString.optional(),
        cursor: z.string().max(4096).optional(),
        limit: z.number().int().min(1).max(MAX_LIMIT).optional(),
        repo_path: z
          .string()
          .max(4096)
          .optional()
          .describe(
            'Absolute project root. AND-filters atoms by canonical project identity; conflicting explicit metadata_match.repo_root is rejected.',
          ),
        metadata_match: z
          .record(
            z.string(),
            z.union([
              z.string().max(4096),
              z.array(z.string().max(4096)).nonempty().max(50),
            ]),
          )
          .optional()
          .describe(
            'AND-joined allow-listed metadata filters. A string means equality; an array means membership.',
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
