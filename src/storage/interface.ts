import type { SourceFamily } from './source-match.js';

export type EventId = string;

export interface CaptureEvent {
  id: EventId;
  source: string;
  timestamp: string;
  content: string;
  metadata?: Record<string, unknown>;
  embedding?: number[];
}

export interface AppendOptions {
  /** Stable extractor-owned replay identity. First write wins: every retry of
   * the same key returns the original event id without rewriting payload. */
  dedupeKey?: string;
}

/** Durable capture progress for one extractor-owned resource partition.
 *
 * `resource` is the concrete source path/identifier consumed by an extractor.
 * Current file extractors use the default empty partition. Migrated legacy
 * Cursor checkpoints retain one partition per composer from the former shared
 * global database. Numeric progress fields remain generic so the same storage
 * substrate can represent byte offsets, turn ordinals, and source mtimes. */
export interface CaptureCheckpoint {
  extractor: string;
  resource: string;
  partition: string;
  position?: number;
  cursor?: string;
  ordinal?: number;
  mtime_ms?: number;
  state: Record<string, unknown>;
  updated_at: string;
}

export interface CaptureCheckpointKey {
  extractor: string;
  resource: string;
  /** Defaults to the empty partition. */
  partition?: string;
}

export interface CaptureCheckpointInput extends CaptureCheckpointKey {
  position?: number;
  cursor?: string;
  ordinal?: number;
  mtime_ms?: number;
  /** Defaults to an empty JSON object. */
  state?: Record<string, unknown>;
  updated_at: string;
}

/** Opaque-to-callers keyset boundary returned by checkpoint listing. */
export interface CaptureCheckpointListCursor {
  extractor: string;
  resource: string;
  partition: string;
}

export interface CaptureCheckpointListOptions {
  /** Required namespace bound: startup callers page one extractor at a time. */
  extractor: string;
  /** Required and runtime-capped; see MAX_CAPTURE_CHECKPOINT_PAGE_SIZE. */
  limit: number;
  /** Return keys strictly after this `(extractor, resource, partition)` tuple. */
  after?: CaptureCheckpointListCursor;
}

export interface CaptureCheckpointPage {
  checkpoints: CaptureCheckpoint[];
  next_cursor: CaptureCheckpointListCursor | null;
}

export interface QueryFilter {
  source?: string;
  source_prefix?: string;
  /** Internal finite candidate dimension for app-scoped prefix retrieval.
   * When present it composes as an AND with source_prefix. SQLite can seek an
   * order-compatible partial index; the source_prefix predicate remains the
   * authoritative result filter. */
  source_family?: SourceFamily;
  since?: string;
  until?: string;
  /** Maximum returned rows. Omitted uses the storage default; adapters enforce
   * a finite hard ceiling even when callers request a larger value. */
  limit?: number;
  // Default 'desc' (newest-first). Flipped from historical ASC because every
  // current caller's intent is "give me the recent N events" — ASC + LIMIT
  // silently dropped the newest. Pass 'asc' explicitly when downstream logic
  // needs oldest-first (e.g., turn-pair reconstruction).
  order?: 'asc' | 'desc';
  // Exclude rows whose metadata.surface is in this list. Retrieval uses this
  // to drop historical raw filesystem notifications (`surface: 'fs'`) that
  // normalization intentionally ignores; they otherwise dominate newest-N
  // scans and starve conversation/git atoms from the result window.
  exclude_metadata_surface?: string[];
  // Restrict rows to those whose JSON metadata matches the given key→value
  // pairs using string equality; each entry implies an AND clause. Mirrors
  // `exclude_metadata_surface` (set-membership on a single key); this is
  // general key/value equality across N keys. Empty `{}` is a no-op (treated
  // as if omitted). `repo_root` supports current repo-scoped retrieval;
  // workspace, composer, and session keys remain readable for stored
  // compatibility. The storage layer enforces a whitelist so callers cannot
  // probe arbitrary metadata fields; see METADATA_MATCH_KEY_WHITELIST.
  metadata_match?: Record<string, string>;
  /** Canonical project identity. Matches metadata.project_key, falling back to
   * canonical_root and finally legacy repo_root without rewriting raw rows.
   * With an exact `git:<legacy-root>` source filter, a row lacking all three
   * identity fields is also eligible; present malformed or mismatched identity
   * fields remain authoritative and fail closed. */
  project_key?: string;
  /** Internal compatibility aliases for rows captured before project_key and
   * canonical_root existed. At most three normalized absolute roots are
   * allowed: canonical identity, case-preserved real root, and normalized
   * caller path. A legacy repo_root matches when it equals one of these roots
   * or is its path-component descendant. These aliases are ignored whenever a
   * row has project_key or canonical_root, even when that authoritative value
   * does not match. */
  legacy_project_roots?: readonly string[];
  // Composite-key cursor pagination boundary: returns rows strictly older than
  // (timestamp, id) under the storage `(timestamp DESC, id DESC)` ordering.
  // Defined for descending queries only — passing `before` together with
  // `order: 'asc'` MUST throw a synchronous validation error at the storage
  // seam rather than silently inverting. Adding asymmetric semantics here
  // would re-introduce the same kind of "minus 1ms" tie-skip bug the
  // composite cursor was designed to close.
  before?: { timestamp: string; id: string };
  /** Ascending counterpart to `before`, used to resume an explicitly bounded
   * descriptor scan. Passing it with descending order is invalid. */
  after?: { timestamp: string; id: string };
}

// Whitelist of metadata keys callers may reach via `QueryFilter.metadata_match`.
// Enforced inside both storage adapters (SQLite + Memory) so adding a future
// MCP tool that forwards `metadata_match` cannot accidentally probe arbitrary
// JSON paths. Adding a key here is a deliberate decision. `repo_root` serves
// current retrieval; the other keys preserve stored-data compatibility and
// bounded integration seams.
export const METADATA_MATCH_KEY_WHITELIST: ReadonlySet<string> = new Set([
  'workspace_id',
  'composer_id',
  'session_id',
  'repo_root',
]);

export interface Storage {
  append(event: Omit<CaptureEvent, 'id'>, options?: AppendOptions): Promise<EventId>;
  query(filter?: QueryFilter): Promise<CaptureEvent[]>;
  count(): Promise<number>;
  // Order-preserving, hard-capped fetch by id list. Returns events in the order of the
  // input `ids[]`; missing ids are silently filtered out (caller diffs the
  // input vs output id sets if it cares about misses). Required by the
  // V1.6 `get_atoms` MCP tool, which materialises atom bodies for ids the
  // caller already obtained from `find_clusters` / `search_memories`.
  getByIds(ids: readonly EventId[]): Promise<CaptureEvent[]>;

  /** Exact bounded checkpoint lookup. Missing keys return null. */
  getCaptureCheckpoint(key: CaptureCheckpointKey): Promise<CaptureCheckpoint | null>;

  /** Insert or replace one checkpoint atomically at its composite primary key. */
  upsertCaptureCheckpoint(checkpoint: CaptureCheckpointInput): Promise<CaptureCheckpoint>;

  /** Keyset-paginated checkpoint scan. `limit` is mandatory and hard-capped. */
  listCaptureCheckpoints(options: CaptureCheckpointListOptions): Promise<CaptureCheckpointPage>;

  // 057a AC3 — durable append-order coord seam for the deadline tracker's
  // boot reconstruction + periodic reconciliation paths. The r4 design
  // dropped the r3 third method `getCoordSequenceAtOrAfter(timestamp)`
  // because its timestamp-order semantics couldn't compose with
  // append-order replay under skewed `emitted_at`. V1 reconstruction does
  // full-ledger replay; the half-open `[sinceSeq, +∞)` + watermark snapshot
  // (`getCurrentCoordSequence()`) lets the reconciliation pass make
  // forward-only progress without skipping or re-processing atoms.
  //
  // Item 113 AC3 generalizes this coord-only seam into the two methods below
  // (`iterateAtomsByAppendOrder` / `getCurrentSequence`), which accept an
  // optional `sourcePrefixes` filter instead of a hardcoded `coord:%`. The
  // two coord methods here are RETAINED (the 057a deadline tracker + wizard
  // consumers call them) and reimplemented as thin `sourcePrefixes: ['coord:']`
  // wrappers over the generic seam. Their external behavior — coord prefix,
  // rowid ordering, half-open `sinceSeq` boundary, `0`-on-empty watermark —
  // is UNCHANGED; `tests/storage/iterate-coord-by-append-order.test.ts` pins it.

  /** Iterate coord atoms (source LIKE 'coord:%') in monotonic durable-append
   *  order. Each yielded record carries its `sequence_id` (SQLite rowid in
   *  SqliteStorage; insertion counter in MemoryStorage). Half-open interval:
   *  returns atoms with `sequence_id >= sinceSeq`. `sinceSeq` omitted means
   *  "from the beginning of the ledger" (effectively `sinceSeq = 1`). */
  iterateCoordAtomsByAppendOrder(opts?: {
    sinceSeq?: number;
    limit?: number;
  }): Promise<CoordAtomIterationRecord[]>;

  /** Return `max(sequence_id)` over all currently-durable coord atoms
   *  (`source LIKE 'coord:%'`). Returns `0` if no coord atoms exist yet.
   *  Used by reconstruction + reconciliation to capture an inclusive
   *  watermark; the next pass starts at `last_full_replay_watermark + 1`. */
  getCurrentCoordSequence(): Promise<number>;

  // 113 AC3 — generalized durable append-order seam. Same durability
  // invariant as the coord seam: `sequence_id` is the SQLite events-table
  // rowid (SqliteStorage) / insertion counter (MemoryStorage), monotonic and
  // durable across restart because the events table is append-only,
  // single-writer, and never VACUUMed (wiki/architecture/storage.md). 113
  // PINS that invariant; it does not add an explicit sequence column.

  /** Iterate atoms in monotonic durable-append order, each record carrying
   *  its `sequence_id`. Optional `sourcePrefixes` restricts to atoms whose
   *  `source` begins with any of the given prefixes (e.g. `['fs:', 'git:']`);
   *  omitted/empty means all sources. Half-open interval: returns atoms with
   *  `sequence_id >= sinceSeq`; `sinceSeq` omitted means "from the beginning
   *  of the ledger" (`sinceSeq = 1`). `limit` caps the append-ordered result;
   *  omitted limits use the storage default and all requests have a hard ceiling.
   *  This generalizes `iterateCoordAtomsByAppendOrder` — coord iteration is
   *  now `sourcePrefixes: ['coord:']` over this method. */
  iterateAtomsByAppendOrder(opts?: {
    sinceSeq?: number;
    sourcePrefixes?: readonly string[];
    limit?: number;
  }): Promise<AtomIterationRecord[]>;

  /** Return `max(sequence_id)` over currently-durable atoms matching the
   *  optional `sourcePrefixes` filter (all sources when omitted/empty).
   *  Returns `0` if none. Generalizes `getCurrentCoordSequence()`; used to
   *  snapshot an inclusive high-watermark `W` so a cursor consumer can start a
   *  fresh scan at `W + 1`. */
  getCurrentSequence(opts?: { sourcePrefixes?: readonly string[] }): Promise<number>;
}

/** Yield-shape for the append-order iteration seams. The `sequence_id` is a
 *  per-row monotonic integer durable across restart (rowid in SQLite;
 *  insertion counter in MemoryStorage). Callers MUST treat it as opaque
 *  beyond ordering + watermark equality — it is NOT embedded in the atom
 *  itself, only surfaced at iteration time. */
export interface AtomIterationRecord extends CaptureEvent {
  readonly sequence_id: number;
}

/** Retained name for the coord seam's yield-shape (057a); identical to
 *  `AtomIterationRecord`. Kept as an alias so existing coord importers are
 *  unchanged by 113's generalization. */
export type CoordAtomIterationRecord = AtomIterationRecord;
