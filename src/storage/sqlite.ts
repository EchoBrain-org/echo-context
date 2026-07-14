import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import {
  METADATA_MATCH_KEY_WHITELIST,
  type AtomIterationRecord,
  type CaptureEvent,
  type CoordAtomIterationRecord,
  type EventId,
  type QueryFilter,
  type Storage,
} from './interface.js';
import { canonicalizeTimestamps, migrate } from './migrate.js';
import {
  likePrefilterChunk,
  normalizePathLikeSource,
  sourceEquals,
  sourceHasPrefix,
} from './source-match.js';
import { createLogger } from '../logging/index.js';
import { canonicalizeTimestamp } from '../util/timestamp.js';

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), 'migrations');

const log = createLogger('storage.sqlite');

interface EventRow {
  id: string;
  source: string;
  timestamp: string;
  content: string;
  metadata: string | null;
  embedding: Buffer | null;
}

function rowToEvent(row: EventRow): CaptureEvent {
  const event: CaptureEvent = {
    id: row.id,
    source: row.source,
    timestamp: row.timestamp,
    content: row.content,
  };
  if (row.metadata !== null) {
    event.metadata = JSON.parse(row.metadata) as Record<string, unknown>;
  }
  if (row.embedding !== null) {
    const buf = row.embedding;
    event.embedding = Array.from(
      new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / Float32Array.BYTES_PER_ELEMENT),
    );
  }
  return event;
}

export class SqliteStorage implements Storage {
  private readonly db: Database.Database;
  private readonly insertStmt: Database.Statement;
  private readonly countStmt: Database.Statement;
  private readonly queryStmtCache = new Map<string, Database.Statement>();

  constructor(dbPath: string) {
    if (dbPath !== ':memory:') {
      mkdirSync(dirname(dbPath), { recursive: true });
    }
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    // NORMAL is safe under WAL and avoids per-append fsync — recommended by SQLite for app use.
    this.db.pragma('synchronous = NORMAL');
    this.db.pragma('foreign_keys = ON');
    migrate(this.db, MIGRATIONS_DIR);
    const { converted } = canonicalizeTimestamps(this.db);
    if (converted > 0) {
      log.info('canonicalized_timestamps', { converted });
    }

    this.insertStmt = this.db.prepare(
      `INSERT INTO events (id, source, timestamp, content, metadata, embedding)
       VALUES (@id, @source, @timestamp, @content, @metadata, @embedding)`,
    );
    this.countStmt = this.db.prepare(`SELECT COUNT(*) AS n FROM events`);
  }

  async append(event: Omit<CaptureEvent, 'id'>): Promise<EventId> {
    const id: EventId = randomUUID();
    const metadata = event.metadata !== undefined ? JSON.stringify(event.metadata) : null;
    const embedding =
      event.embedding !== undefined ? Buffer.from(new Float32Array(event.embedding).buffer) : null;
    this.insertStmt.run({
      id,
      source: event.source,
      timestamp: event.timestamp,
      content: event.content,
      metadata,
      embedding,
    });
    return id;
  }

  async query(filter?: QueryFilter): Promise<CaptureEvent[]> {
    if (filter?.source !== undefined && filter?.source_prefix !== undefined) {
      throw new Error('QueryFilter.source and source_prefix are mutually exclusive');
    }
    if (filter?.before !== undefined && filter?.order === 'asc') {
      throw new RangeError(
        'QueryFilter.before is defined for descending queries only; pass order: "desc" or omit it',
      );
    }
    const since = filter?.since !== undefined ? canonicalizeTimestamp(filter.since) : undefined;
    const until = filter?.until !== undefined ? canonicalizeTimestamp(filter.until) : undefined;
    const clauses: string[] = [];
    const params: Record<string, unknown> = {};
    // Source matching semantics are shared with MemoryStorage via
    // source-match.ts — raw SQL `=` / `LIKE prefix%` diverged on
    // backslash-stored Windows sources, component boundaries, prefix
    // case (LIKE is ASCII-case-insensitive), and trailing-slash
    // equality. When the JS predicate is needed, SQL keeps only a
    // provably-superset coarse prefilter (LIKE on the pre-separator
    // chunk — see likePrefilterChunk) and the predicate + LIMIT move to
    // JS so the page can't run short.
    let jsSourcePredicate: ((source: string) => boolean) | undefined;
    if (filter?.source !== undefined) {
      const source = filter.source;
      if (normalizePathLikeSource(source) === null) {
        // Non-path-like source: sourceEquals degrades to raw string
        // equality for every stored row, which SQL's BINARY `=`
        // implements exactly — keep the pure-SQL fast path.
        clauses.push('source = @source');
        params['source'] = source;
      } else {
        jsSourcePredicate = (s) => sourceEquals(s, source);
      }
    }
    if (filter?.source_prefix !== undefined) {
      // Even non-path-like prefixes need the JS predicate: LIKE's
      // ASCII-case-insensitivity would let 'GIT:%' match 'git:...'.
      const prefix = filter.source_prefix;
      jsSourcePredicate = (s) => sourceHasPrefix(s, prefix);
    }
    if (jsSourcePredicate !== undefined) {
      const chunk = likePrefilterChunk(filter!.source ?? filter!.source_prefix!);
      if (chunk !== null) {
        clauses.push("source LIKE @source_chunk || '%' ESCAPE '\\'");
        params['source_chunk'] = chunk.replace(/[\\%_]/g, '\\$&');
      }
    }
    if (since !== undefined) {
      clauses.push('timestamp >= @since');
      params['since'] = since;
    }
    if (until !== undefined) {
      clauses.push('timestamp < @until');
      params['until'] = until;
    }
    if (filter?.before !== undefined) {
      // SQLite ≥3.0 supports row-value comparison; this is the canonical way
      // to express "rows strictly older than (ts, id)" in the composite-key
      // ordering and matches the JS predicate in MemoryStorage exactly.
      clauses.push('(timestamp, id) < (@before_ts, @before_id)');
      params['before_ts'] = filter.before.timestamp;
      params['before_id'] = filter.before.id;
    }
    if (filter?.metadata_match !== undefined) {
      // Whitelist enforcement lives at the storage seam (NOT only the MCP
      // tool) so even direct storage callers can't probe arbitrary JSON
      // paths. Empty `{}` is a no-op (no clause added). Each entry binds
      // its value through a named placeholder — no string interpolation
      // of either keys (which are whitelisted, then literal-baked into
      // the SQL text) or values.
      for (const key of Object.keys(filter.metadata_match)) {
        if (!METADATA_MATCH_KEY_WHITELIST.has(key)) {
          throw new Error(
            `QueryFilter.metadata_match key "${key}" is not on the whitelist (${[
              ...METADATA_MATCH_KEY_WHITELIST,
            ].join(', ')})`,
          );
        }
      }
      // Sorted key iteration: keeps the generated SQL text deterministic
      // across call shapes that pass the same key set in different
      // orders, so the prepared-statement cache below keys cleanly.
      // Note: the cache is keyed on the FULL `sql` text, so each distinct
      // metadata_match key combination produces its own cached prepared
      // statement. That is fine in practice — the whitelist is tiny (3
      // keys ⇒ at most 7 non-empty subsets) so the cache size is bounded.
      const matchKeys = Object.keys(filter.metadata_match).sort();
      matchKeys.forEach((key, i) => {
        const placeholder = `__metadata_match_${i}`;
        clauses.push(`json_extract(metadata, '$.${key}') = @${placeholder}`);
        params[placeholder] = filter.metadata_match![key];
      });
    }
    if (
      filter?.exclude_metadata_surface !== undefined &&
      filter.exclude_metadata_surface.length > 0
    ) {
      // SQL parameter binding doesn't support IN-list expansion directly with
      // better-sqlite3 named params, so the clause is built with positional
      // placeholders and the list is encoded into params under indexed names.
      const placeholders: string[] = [];
      filter.exclude_metadata_surface.forEach((surface, i) => {
        const key = `__exclude_surface_${i}`;
        placeholders.push(`@${key}`);
        params[key] = surface;
      });
      clauses.push(
        `COALESCE(json_extract(metadata, '$.surface'), '') NOT IN (${placeholders.join(', ')})`,
      );
    }

    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    // When a JS source predicate is active, SQL's WHERE is only a superset
    // prefilter — applying LIMIT in SQL would count rows the predicate
    // later drops and return a short page. Move the limit to JS then.
    const limitInSql = filter?.limit !== undefined && jsSourcePredicate === undefined;
    const limitClause = limitInSql ? 'LIMIT @limit' : '';
    if (limitInSql) params['limit'] = filter!.limit;

    const order = filter?.order ?? 'desc';
    const orderSql = order === 'asc' ? 'ASC' : 'DESC';
    // `id` follows the same direction as `timestamp` so same-millisecond ties
    // resolve deterministically. Mixing directions (e.g. `timestamp DESC, id
    // ASC`) would reopen the same-ms tie-skip class of bug that the composite
    // cursor was designed to close. Asc and desc both get parallel keys.
    const sql = `SELECT id, source, timestamp, content, metadata, embedding FROM events ${where} ORDER BY timestamp ${orderSql}, id ${orderSql} ${limitClause}`;
    let stmt = this.queryStmtCache.get(sql);
    if (stmt === undefined) {
      stmt = this.db.prepare(sql);
      this.queryStmtCache.set(sql, stmt);
    }
    let rows = stmt.all(params) as EventRow[];
    if (jsSourcePredicate !== undefined) {
      const predicate = jsSourcePredicate;
      rows = rows.filter((r) => predicate(r.source));
      if (filter?.limit !== undefined && rows.length > filter.limit) {
        rows = rows.slice(0, filter.limit);
      }
    }
    return rows.map(rowToEvent);
  }

  async count(): Promise<number> {
    const row = this.countStmt.get() as { n: number };
    return row.n;
  }

  async getByIds(ids: readonly EventId[]): Promise<CaptureEvent[]> {
    if (ids.length === 0) return [];
    // Bind each id positionally — IN-list expansion isn't supported via
    // named params in better-sqlite3. `WHERE id IN (?...)` returns rows in
    // storage order, so we re-order by the input `ids[]` to satisfy the
    // interface's order-preserving contract. Missing ids are silently
    // dropped here; the get_atoms tool surfaces them in atoms_dropped_ids.
    const placeholders = ids.map(() => '?').join(',');
    const rows = this.db
      .prepare(
        `SELECT id, source, timestamp, content, metadata, embedding FROM events WHERE id IN (${placeholders})`,
      )
      .all(...ids) as EventRow[];
    const byId = new Map<EventId, CaptureEvent>();
    for (const row of rows) {
      byId.set(row.id, rowToEvent(row));
    }
    const out: CaptureEvent[] = [];
    for (const id of ids) {
      const ev = byId.get(id);
      if (ev !== undefined) out.push(ev);
    }
    return out;
  }

  // 057a AC3 / 113 AC3 — durable append-order seam. SQLite's `rowid` is
  // monotonic per insertion and durable across restart (the single-writer
  // constraint at wiki/architecture/storage.md:119-127 guarantees rowid
  // reflects ingest order). The events table has no rowid alias on `id`
  // (UUID strings), so the implicit rowid is what we expose as
  // `sequence_id`. The generic `iterateAtomsByAppendOrder` accepts an
  // optional `sourcePrefixes` filter; the coord seam is the special case
  // `sourcePrefixes: ['coord:']`.

  // Build a `(source LIKE @p0 ESCAPE '\' OR ...)` clause for the given
  // prefixes, appending its bind params. LIKE-special chars in a prefix are
  // escaped, mirroring the source_prefix prefilter in query() (line ~143).
  // Returns null when no prefix filter should be applied.
  private buildPrefixClause(
    prefixes: readonly string[] | undefined,
    params: Record<string, unknown>,
  ): string | null {
    if (prefixes === undefined || prefixes.length === 0) return null;
    const ors: string[] = [];
    prefixes.forEach((prefix, i) => {
      const key = `__prefix_${i}`;
      ors.push(`source LIKE @${key} ESCAPE '\\'`);
      params[key] = `${prefix.replace(/[\\%_]/g, '\\$&')}%`;
    });
    return `(${ors.join(' OR ')})`;
  }

  async iterateAtomsByAppendOrder(opts?: {
    sinceSeq?: number;
    sourcePrefixes?: readonly string[];
    limit?: number;
  }): Promise<AtomIterationRecord[]> {
    const sinceSeq = opts?.sinceSeq ?? 1;
    const limit = opts?.limit;
    const params: Record<string, unknown> = { sinceSeq };
    const clauses = ['rowid >= @sinceSeq'];
    const prefixClause = this.buildPrefixClause(opts?.sourcePrefixes, params);
    if (prefixClause !== null) clauses.push(prefixClause);
    const baseSql = `SELECT rowid AS sequence_id, id, source, timestamp, content, metadata, embedding
                     FROM events
                     WHERE ${clauses.join(' AND ')}
                     ORDER BY rowid ASC`;
    const sql = limit !== undefined ? `${baseSql} LIMIT @limit` : baseSql;
    if (limit !== undefined) params['limit'] = limit;
    const rows = this.db.prepare(sql).all(params) as Array<EventRow & { sequence_id: number }>;
    return rows.map((r) => {
      const base = rowToEvent(r);
      return Object.assign({}, base, { sequence_id: r.sequence_id });
    });
  }

  async getCurrentSequence(opts?: { sourcePrefixes?: readonly string[] }): Promise<number> {
    const params: Record<string, unknown> = {};
    const prefixClause = this.buildPrefixClause(opts?.sourcePrefixes, params);
    const where = prefixClause !== null ? `WHERE ${prefixClause}` : '';
    const stmt = this.db.prepare(`SELECT COALESCE(MAX(rowid), 0) AS seq FROM events ${where}`);
    const row = (prefixClause !== null ? stmt.get(params) : stmt.get()) as { seq: number };
    return row.seq;
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

  close(): void {
    if (!this.db.open) return;
    this.db.close();
  }
}
