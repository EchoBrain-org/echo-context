// Item 113 — getSignalWindow: the internal "one door" for a window of context.
//
// Fork-1 of the capture→signals seam (raw/internal/decisions/2026-07-04-seam-v0-decision.md):
// one windowed read hands back a single ordered list of `entries` — the union
// of raw events (fs/git/granola, normalized via the existing source adapters)
// and derived atoms (derived:granola-signals, derived:team-decisions) — at full
// fidelity. Wire-shape truncation caps live ONLY in the MCP cluster-engine and
// are never imported here (AC6 import-closure). Nothing in this module ever
// calls an AI (decision 19): the loop filter is dumb string-equality on 112's
// unified `metadata.canonical_subject` key.
//
// Two orderings, one contract (AC3/AC4):
//   - cursor mode (`cursor.sinceSeq` set): durable append-order over
//     `sequence_id` (half-open `[sinceSeq, +∞)`), so late-arriving atoms
//     ingested with old timestamps are never skipped.
//   - event-time mode (`cursor` absent): the storage `(timestamp DESC, id DESC)`
//     ordering.
// Cursor advancement is caller-derived (`max(entry.sequence_id) + 1`); this
// module never computes or returns a next-cursor.

import { normalizeEvent, NormalizationError } from '../normalize/index.js';
import type { NormalizedContextEvent } from '../normalize/types.js';
import type { AtomIterationRecord, EventId, Storage } from '../storage/interface.js';
import { canonicalizeTimestamp } from '../util/timestamp.js';

export type SignalWindowScope = 'machine' | 'company';

/**
 * AC2 — the ONE scope→source-prefix mapping. Every atom whose `source` begins
 * with any listed prefix belongs to that scope. Adding a future capture source
 * (e.g. `api:slack`, `api:linear`) is a one-line edit here and nowhere else.
 *   machine = code sessions + commits; company = meetings + derived facts.
 */
export const SCOPE_SOURCE_PREFIXES: Readonly<Record<SignalWindowScope, readonly string[]>> = {
  machine: ['fs:', 'git:'],
  company: ['api:granola', 'derived:'],
};

/** Bookkeeping sources are never window entries even when a scope prefix
 *  matches them. `derived:granola-signals-index` is the extractor's dedupe
 *  MANIFEST (see GRANOLA_SIGNAL_INDEX_SOURCE), not context — surfacing it
 *  would hand manifest atoms to company-scope consumers like the drift
 *  sweep. Prefix (not equality) so per-note suffixed variants stay out too. */
export const SCOPE_EXCLUDED_SOURCE_PREFIXES: readonly string[] = [
  'derived:granola-signals-index',
];

/** Half-open durable-append cursor. `sinceSeq` selects atoms with
 *  `sequence_id >= sinceSeq` (matches the shipped coord seam boundary). */
export interface SignalWindowCursor {
  sinceSeq: number;
}

export interface SignalWindowOpts {
  /** Event-time lower bound, inclusive (`timestamp >= since`). */
  since?: string;
  /** Event-time upper bound, exclusive (`timestamp < until`). */
  until?: string;
  /** When set, read in durable append-order from this cursor instead of
   *  event-time order. */
  cursor?: SignalWindowCursor;
  scope: SignalWindowScope;
  /** Dumb topic filter: keep only entries whose `metadata.canonical_subject`
   *  string-equals this value (112's unified key). Keyless entries are
   *  excluded when set. No fuzzy/semantic matching. */
  loop?: string;
  /** Applied LAST, after every other predicate + the ordering, so an eligible
   *  later row is never hidden behind filtered-out leading rows. */
  limit?: number;
}

/**
 * One row of the window. Carries the durable `sequence_id` (for caller-derived
 * cursor advancement) plus the atom's full untruncated `content`/`metadata`.
 * `normalized` is the source adapter's projection (full fidelity, NOT the
 * capped MCP path); it is `null` for atoms with no registered adapter
 * (`fs:*` raw file events, `derived:*` atoms — the latter are already the
 * extracted facts).
 */
export interface SignalWindowEntry {
  id: EventId;
  sequence_id: number;
  source: string;
  timestamp: string;
  content: string;
  metadata?: Record<string, unknown>;
  normalized: NormalizedContextEvent | null;
}

function toEntry(record: AtomIterationRecord): SignalWindowEntry {
  // Reuse the existing source adapters for the normalized projection. A
  // malformed atom (adapter throws NormalizationError) must not sink the whole
  // window — its raw content/metadata still ride through as an entry, with
  // `normalized: null`. This is deterministic (normalizeEvent is pure).
  let normalized: NormalizedContextEvent | null = null;
  try {
    normalized = normalizeEvent(record);
  } catch (err) {
    if (!(err instanceof NormalizationError)) throw err;
    normalized = null;
  }
  const entry: SignalWindowEntry = {
    id: record.id,
    sequence_id: record.sequence_id,
    source: record.source,
    timestamp: record.timestamp,
    content: record.content,
    normalized,
  };
  if (record.metadata !== undefined) entry.metadata = record.metadata;
  return entry;
}

// Event-time comparator — parity with the storage `(timestamp DESC, id DESC)`
// ordering (parallel directions, never mixed, so same-ms ties are stable).
function byEventTimeDesc(a: SignalWindowEntry, b: SignalWindowEntry): number {
  if (a.timestamp < b.timestamp) return 1;
  if (a.timestamp > b.timestamp) return -1;
  if (a.id < b.id) return 1;
  if (a.id > b.id) return -1;
  return 0;
}

/**
 * The seam. Returns one ordered list of entries for the requested scope/window.
 *
 * Composition (AC3): the full in-scope row set is materialized first (via the
 * generalized append-order storage seam, which supplies `sequence_id`), then
 * ALL predicates (`sinceSeq` via the fetch, `since`/`until`/`loop` in-process)
 * filter it, then it is ordered, then `limit` truncates — never before. No
 * caching / materialized views (decision 12: measured slowness first).
 */
export async function getSignalWindow(
  storage: Storage,
  opts: SignalWindowOpts,
): Promise<SignalWindowEntry[]> {
  const prefixes = SCOPE_SOURCE_PREFIXES[opts.scope];
  const cursorMode = opts.cursor !== undefined;

  // Fetch the in-scope rows in durable append order (carries sequence_id).
  // In cursor mode the half-open `sinceSeq` boundary is applied at the storage
  // seam; in event-time mode we take the whole in-scope ledger and re-order
  // below. `limit` is NOT pushed down — it must apply after since/until/loop.
  const records = await storage.iterateAtomsByAppendOrder({
    ...(cursorMode ? { sinceSeq: opts.cursor!.sinceSeq } : {}),
    sourcePrefixes: prefixes,
  });

  const since = opts.since !== undefined ? canonicalizeTimestamp(opts.since) : undefined;
  const until = opts.until !== undefined ? canonicalizeTimestamp(opts.until) : undefined;
  const loop = opts.loop;

  let entries: SignalWindowEntry[] = [];
  for (const record of records) {
    if (SCOPE_EXCLUDED_SOURCE_PREFIXES.some((p) => record.source.startsWith(p))) continue;
    if (since !== undefined && record.timestamp < since) continue;
    if (until !== undefined && record.timestamp >= until) continue;
    if (loop !== undefined) {
      const subject = (record.metadata as { canonical_subject?: unknown } | undefined)
        ?.canonical_subject;
      if (subject !== loop) continue; // keyless or mismatched → excluded
    }
    entries.push(toEntry(record));
  }

  // Ordering: cursor mode is already append-order (sequence_id ASC, preserved
  // by the in-order filter above); event-time mode sorts (timestamp DESC, id DESC).
  if (!cursorMode) {
    entries.sort(byEventTimeDesc);
  }

  // limit LAST.
  if (opts.limit !== undefined && entries.length > opts.limit) {
    entries = entries.slice(0, opts.limit);
  }

  return entries;
}
