import { randomUUID } from 'node:crypto';
import {
  METADATA_MATCH_KEY_WHITELIST,
  type AppendOptions,
  type AtomIterationRecord,
  type CaptureCheckpoint,
  type CaptureCheckpointInput,
  type CaptureCheckpointKey,
  type CaptureCheckpointListOptions,
  type CaptureCheckpointPage,
  type CaptureEvent,
  type CoordAtomIterationRecord,
  type EventId,
  type QueryFilter,
  type Storage,
} from './interface.js';
import {
  captureCheckpointCursor,
  cloneCaptureCheckpoint,
  compareCaptureCheckpointKeys,
  normalizeCaptureCheckpointInput,
  normalizeCaptureCheckpointKey,
  normalizeCaptureCheckpointListOptions,
} from './checkpoint.js';
import { eventIdForDedupeKey } from './dedupe.js';
import {
  assertStorageDescriptorField,
  cappedStorageRowLimit,
  eventStoredBytes,
  STORAGE_GET_BY_IDS_MAX_IDS,
  STORAGE_PAYLOAD_PAGE_BYTES,
  StorageBudgetExceededError,
} from './budgets.js';
import { sourceEquals, sourceHasPrefix } from './source-match.js';
import { canonicalizeTimestamp } from '../util/timestamp.js';

// 057a AC3 — monotonic insertion counter parallel to SQLite's rowid.
// Stored alongside the event so iterateCoordAtomsByAppendOrder + the
// MAX-watermark query both have a stable per-row sequence number that
// survives reordering by query() (which sorts by timestamp DESC).
interface InternalEvent extends CaptureEvent {
  _seq: number;
}

function stripSeq(e: InternalEvent): CaptureEvent {
  // Re-construct to drop `_seq` — the internal sequence counter is
  // exposed only via iterateCoordAtomsByAppendOrder's typed
  // CoordAtomIterationRecord shape. `query()` and `getByIds()` must
  // return plain CaptureEvent so a deep-equal roundtrip test passes.
  const out: CaptureEvent = {
    id: e.id,
    source: e.source,
    timestamp: e.timestamp,
    content: e.content,
  };
  if (e.metadata !== undefined) out.metadata = e.metadata;
  if (e.embedding !== undefined) out.embedding = e.embedding;
  return out;
}

export class MemoryStorage implements Storage {
  private readonly events: InternalEvent[] = [];
  private readonly captureCheckpoints = new Map<string, CaptureCheckpoint>();
  private seqCounter = 0;

  async append(event: Omit<CaptureEvent, 'id'>, options?: AppendOptions): Promise<EventId> {
    const dedupe = options?.dedupeKey !== undefined;
    const id: EventId = dedupe ? eventIdForDedupeKey(options.dedupeKey!) : randomUUID();
    assertStorageDescriptorField('append', 'source', event.source);
    assertStorageDescriptorField('append', 'timestamp', event.timestamp);
    if (dedupe && this.events.some((candidate) => candidate.id === id)) return id;
    const timestamp = canonicalizeTimestamp(event.timestamp);
    const metadataJson = event.metadata === undefined ? null : JSON.stringify(event.metadata);
    const storedBytes = eventStoredBytes({
      id,
      source: event.source,
      timestamp,
      content: event.content,
      metadataJson: metadataJson ?? null,
      embeddingBytes: (event.embedding?.length ?? 0) * Float32Array.BYTES_PER_ELEMENT,
    });
    if (storedBytes > STORAGE_PAYLOAD_PAGE_BYTES) {
      throw new StorageBudgetExceededError({
        code: 'event_too_large',
        operation: 'append',
        stored_bytes: storedBytes,
        budget_bytes: STORAGE_PAYLOAD_PAGE_BYTES,
      });
    }
    this.seqCounter += 1;
    this.events.push({
      ...event,
      timestamp,
      id,
      _seq: this.seqCounter,
    });
    return id;
  }

  async query(filter?: QueryFilter): Promise<CaptureEvent[]> {
    const source = filter?.source;
    const sourcePrefix = filter?.source_prefix;
    if (source !== undefined && sourcePrefix !== undefined) {
      throw new Error('QueryFilter.source and source_prefix are mutually exclusive');
    }
    if (filter?.before !== undefined && filter?.order === 'asc') {
      throw new RangeError(
        'QueryFilter.before is defined for descending queries only; pass order: "desc" or omit it',
      );
    }
    if (filter?.after !== undefined && filter?.order !== 'asc') {
      throw new RangeError('QueryFilter.after is defined for ascending queries only');
    }
    if (filter?.before !== undefined && filter?.after !== undefined) {
      throw new RangeError('QueryFilter.before and after are mutually exclusive');
    }
    if (source !== undefined) assertStorageDescriptorField('query', 'source', source);
    if (sourcePrefix !== undefined) {
      assertStorageDescriptorField('query', 'source', sourcePrefix);
    }
    if (filter?.since !== undefined) {
      assertStorageDescriptorField('query', 'timestamp', filter.since);
    }
    if (filter?.until !== undefined) {
      assertStorageDescriptorField('query', 'timestamp', filter.until);
    }
    if (filter?.project_key !== undefined) {
      assertStorageDescriptorField('query', 'source', filter.project_key);
    }
    if (filter?.before !== undefined) {
      assertStorageDescriptorField('query', 'timestamp', filter.before.timestamp);
      assertStorageDescriptorField('query', 'id', filter.before.id);
    }
    if (filter?.after !== undefined) {
      assertStorageDescriptorField('query', 'timestamp', filter.after.timestamp);
      assertStorageDescriptorField('query', 'id', filter.after.id);
    }
    const since = filter?.since !== undefined ? canonicalizeTimestamp(filter.since) : undefined;
    const until = filter?.until !== undefined ? canonicalizeTimestamp(filter.until) : undefined;
    const limit = cappedStorageRowLimit(filter?.limit);
    const order = filter?.order ?? 'desc';
    const before = filter?.before;
    const after = filter?.after;
    const excludeSurfaces =
      filter?.exclude_metadata_surface !== undefined && filter.exclude_metadata_surface.length > 0
        ? new Set(filter.exclude_metadata_surface)
        : undefined;

    // Parity with SqliteStorage: whitelist-validate at the entry of the
    // function (throw before scanning events). Empty `{}` is a no-op.
    let metadataMatchEntries: Array<[string, string]> | undefined;
    if (filter?.metadata_match !== undefined) {
      const keys = Object.keys(filter.metadata_match);
      for (const key of keys) {
        if (!METADATA_MATCH_KEY_WHITELIST.has(key)) {
          throw new Error(
            `QueryFilter.metadata_match key "${key}" is not on the whitelist (${[
              ...METADATA_MATCH_KEY_WHITELIST,
            ].join(', ')})`,
          );
        }
      }
      if (keys.length > 0) {
        metadataMatchEntries = keys.map((k) => [k, filter.metadata_match![k]!] as [string, string]);
      }
    }

    // Filter first (full pass), then sort by (timestamp, id) in the requested
    // order, then truncate. Sorting before truncation preserves "keep the
    // newest N" semantics regardless of insertion order. Tie-break on `id`
    // matches the sqlite adapter's `ORDER BY timestamp DESC, id DESC` (and
    // ASC, ASC) — parallel directions, never mixed.
    const filtered: InternalEvent[] = [];
    for (const event of this.events) {
      if (source !== undefined && !sourceEquals(event.source, source)) continue;
      if (sourcePrefix !== undefined && !sourceHasPrefix(event.source, sourcePrefix)) continue;
      if (since !== undefined && event.timestamp < since) continue;
      if (until !== undefined && event.timestamp >= until) continue;
      if (before !== undefined) {
        // Row-value comparison equivalent to sqlite's `(timestamp, id) < (...)`.
        if (event.timestamp > before.timestamp) continue;
        if (event.timestamp === before.timestamp && event.id >= before.id) continue;
      }
      if (after !== undefined) {
        if (event.timestamp < after.timestamp) continue;
        if (event.timestamp === after.timestamp && event.id <= after.id) continue;
      }
      if (excludeSurfaces !== undefined) {
        const surface = (event.metadata as { surface?: unknown } | undefined)?.surface;
        if (typeof surface === 'string' && excludeSurfaces.has(surface)) continue;
      }
      if (metadataMatchEntries !== undefined) {
        const md = event.metadata as Record<string, unknown> | undefined;
        let skip = false;
        for (const [k, v] of metadataMatchEntries) {
          const got = md?.[k];
          if (typeof got !== 'string' || got !== v) {
            skip = true;
            break;
          }
        }
        if (skip) continue;
      }
      if (filter?.project_key !== undefined) {
        const md = event.metadata as Record<string, unknown> | undefined;
        const explicit = md?.['project_key'];
        const canonicalRoot = md?.['canonical_root'];
        const repoRoot = md?.['repo_root'];
        const eventProjectKey =
          typeof explicit === 'string'
            ? explicit
            : typeof canonicalRoot === 'string'
              ? `local:workspace:${canonicalRoot}`
              : typeof repoRoot === 'string'
                ? `local:workspace:${repoRoot}`
                : undefined;
        if (eventProjectKey !== filter.project_key) continue;
      }
      filtered.push(event);
    }
    filtered.sort((a, b) => {
      if (a.timestamp < b.timestamp) return order === 'asc' ? -1 : 1;
      if (a.timestamp > b.timestamp) return order === 'asc' ? 1 : -1;
      if (a.id < b.id) return order === 'asc' ? -1 : 1;
      if (a.id > b.id) return order === 'asc' ? 1 : -1;
      return 0;
    });
    const truncated = filtered.length > limit ? filtered.slice(0, limit) : filtered;
    return truncated.map(stripSeq);
  }

  async count(): Promise<number> {
    return this.events.length;
  }

  async getByIds(ids: readonly EventId[]): Promise<CaptureEvent[]> {
    if (ids.length === 0) return [];
    if (ids.length > STORAGE_GET_BY_IDS_MAX_IDS) {
      throw new RangeError(`getByIds accepts at most ${STORAGE_GET_BY_IDS_MAX_IDS} ids`);
    }
    for (const id of ids) assertStorageDescriptorField('getByIds', 'id', id);
    // Re-order by input `ids[]` so the order-preserving contract holds
    // regardless of insertion order. Missing ids are silently dropped
    // here; get_atoms surfaces them in atoms_dropped_ids.
    const wanted = new Set(ids);
    const byId = new Map<EventId, InternalEvent>();
    for (const e of this.events) {
      if (wanted.has(e.id)) byId.set(e.id, e);
    }
    const out: CaptureEvent[] = [];
    for (const id of ids) {
      const ev = byId.get(id);
      if (ev !== undefined) out.push(stripSeq(ev));
    }
    return out;
  }

  private captureCheckpointMapKey(key: CaptureCheckpointKey): string {
    const normalized = normalizeCaptureCheckpointKey(key);
    return JSON.stringify([normalized.extractor, normalized.resource, normalized.partition]);
  }

  async getCaptureCheckpoint(key: CaptureCheckpointKey): Promise<CaptureCheckpoint | null> {
    const checkpoint = this.captureCheckpoints.get(this.captureCheckpointMapKey(key));
    return checkpoint === undefined ? null : cloneCaptureCheckpoint(checkpoint);
  }

  async upsertCaptureCheckpoint(
    input: CaptureCheckpointInput,
  ): Promise<CaptureCheckpoint> {
    const checkpoint = normalizeCaptureCheckpointInput(input);
    this.captureCheckpoints.set(
      this.captureCheckpointMapKey(checkpoint),
      cloneCaptureCheckpoint(checkpoint),
    );
    return cloneCaptureCheckpoint(checkpoint);
  }

  async listCaptureCheckpoints(
    options: CaptureCheckpointListOptions,
  ): Promise<CaptureCheckpointPage> {
    const normalized = normalizeCaptureCheckpointListOptions(options);
    const matching: CaptureCheckpoint[] = [];
    for (const checkpoint of this.captureCheckpoints.values()) {
      if (checkpoint.extractor !== normalized.extractor) continue;
      if (
        normalized.after !== undefined &&
        compareCaptureCheckpointKeys(captureCheckpointCursor(checkpoint), normalized.after) <= 0
      ) {
        continue;
      }
      matching.push(checkpoint);
    }
    matching.sort((left, right) =>
      compareCaptureCheckpointKeys(captureCheckpointCursor(left), captureCheckpointCursor(right)),
    );
    const hasMore = matching.length > normalized.limit;
    const kept = matching.slice(0, normalized.limit).map(cloneCaptureCheckpoint);
    return {
      checkpoints: kept,
      next_cursor:
        hasMore && kept.length > 0 ? captureCheckpointCursor(kept[kept.length - 1]!) : null,
    };
  }

  // 057a AC3 / 113 AC3 — durable append-order seam (parity with
  // SqliteStorage). `_seq` is the insertion counter parallel to SQLite's
  // rowid. The generic `iterateAtomsByAppendOrder` accepts an optional
  // `sourcePrefixes` filter; the coord seam is `sourcePrefixes: ['coord:']`.

  // Prefix match parallel to SqliteStorage's `source LIKE @prefix || '%'`.
  // `undefined`/empty means "all sources". Empty-array parity matters: a
  // caller passing `[]` matches nothing-specific → all, same as omitting it.
  private matchesPrefixes(source: string, prefixes: readonly string[] | undefined): boolean {
    if (prefixes === undefined || prefixes.length === 0) return true;
    return prefixes.some((prefix) => source.startsWith(prefix));
  }

  async iterateAtomsByAppendOrder(opts?: {
    sinceSeq?: number;
    sourcePrefixes?: readonly string[];
    limit?: number;
  }): Promise<AtomIterationRecord[]> {
    const sinceSeq = opts?.sinceSeq ?? 1;
    const limit = cappedStorageRowLimit(opts?.limit);
    if (limit === 0) return [];
    const prefixes = opts?.sourcePrefixes;
    for (const prefix of prefixes ?? []) {
      assertStorageDescriptorField('iterateAtomsByAppendOrder', 'source', prefix);
    }
    const out: AtomIterationRecord[] = [];
    // Iterate in insertion order (this.events.push appends, so iteration
    // order IS insertion order). Filter to matching sources with _seq >= sinceSeq.
    for (const e of this.events) {
      if (!this.matchesPrefixes(e.source, prefixes)) continue;
      if (e._seq < sinceSeq) continue;
      // Strip the internal _seq from the surface CaptureEvent; re-expose
      // as a top-level `sequence_id` field per the iteration contract.
      const publicEvent = stripSeq(e);
      out.push({ ...publicEvent, sequence_id: e._seq });
      if (out.length >= limit) break;
    }
    return out;
  }

  async getCurrentSequence(opts?: { sourcePrefixes?: readonly string[] }): Promise<number> {
    const prefixes = opts?.sourcePrefixes;
    let max = 0;
    for (const e of this.events) {
      if (!this.matchesPrefixes(e.source, prefixes)) continue;
      if (e._seq > max) max = e._seq;
    }
    return max;
  }

  async iterateCoordAtomsByAppendOrder(opts?: {
    sinceSeq?: number;
    limit?: number;
  }): Promise<CoordAtomIterationRecord[]> {
    return this.iterateAtomsByAppendOrder({
      sinceSeq: opts?.sinceSeq,
      sourcePrefixes: ['coord:'],
      limit: opts?.limit,
    });
  }

  async getCurrentCoordSequence(): Promise<number> {
    return this.getCurrentSequence({ sourcePrefixes: ['coord:'] });
  }
}
