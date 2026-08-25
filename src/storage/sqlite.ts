import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
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
} from "./interface.js";
import {
  CAPTURE_CHECKPOINT_CURSOR_BYTES,
  CAPTURE_CHECKPOINT_EXTRACTOR_BYTES,
  CAPTURE_CHECKPOINT_FIELD_BUDGETS,
  CAPTURE_CHECKPOINT_PARTITION_BYTES,
  CAPTURE_CHECKPOINT_RESOURCE_BYTES,
  CAPTURE_CHECKPOINT_STATE_BYTES,
  CAPTURE_CHECKPOINT_UPDATED_AT_BYTES,
  CaptureCheckpointFieldExceededError,
  captureCheckpointCursor,
  normalizeCaptureCheckpointInput,
  normalizeCaptureCheckpointKey,
  normalizeCaptureCheckpointListOptions,
} from "./checkpoint.js";
import { embeddingBytes, eventIdForDedupeKey } from "./dedupe.js";
import {
  assertStorageDescriptorField,
  cappedStorageRowLimit,
  eventStoredBytes,
  STORAGE_DESCRIPTOR_FIELD_BUDGETS,
  STORAGE_DESCRIPTOR_ID_BYTES,
  STORAGE_DESCRIPTOR_PAGE_ROWS,
  STORAGE_DESCRIPTOR_SOURCE_BYTES,
  STORAGE_DESCRIPTOR_TIMESTAMP_BYTES,
  STORAGE_GET_BY_IDS_MAX_IDS,
  STORAGE_MAX_DESCRIPTOR_PAGES,
  STORAGE_PAYLOAD_PAGE_BYTES,
  STORAGE_PAYLOAD_PAGE_ROWS,
  STORAGE_QUERY_STORED_BYTES,
  StorageBudgetExceededError,
  StorageDescriptorFieldExceededError,
  StorageAppendScanBudgetExceededError,
  StorageScanBudgetExceededError,
  type SqliteStorageOptions,
  type StoragePayloadOperation,
  type StorageSelectPageObservation,
} from "./budgets.js";
import { migrate } from "./migrate.js";
import {
  isLegacyGitSourceForProject,
  normalizeLegacyProjectRoots,
  pathEqualsOrDescendsFrom,
  preserveUndefinedProjectIdentityForJson,
} from "./project-filter.js";
import {
  isSourceFamily,
  normalizePathLikeSource,
  SOURCE_FAMILY_BITS,
  sourceHasPrefix,
} from "./source-match.js";
import { canonicalizeTimestamp } from "../util/timestamp.js";

const MIGRATIONS_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "migrations",
);

function restrictAuthorityFile(path: string): void {
  if (process.platform === "win32") return;
  try {
    chmodSync(path, 0o600);
  } catch (error) {
    // WAL/SHM files can disappear between a transaction closing and chmod.
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

interface EventRow {
  id: string;
  source: string;
  timestamp: string;
  content: string;
  metadata: string | null;
  embedding: Buffer | null;
}

interface RawEventDescriptor {
  id: string | null;
  id_bytes: number;
  source: string | null;
  source_bytes: number;
  timestamp: string | null;
  timestamp_bytes: number;
  stored_bytes: number;
  post_filter_matches?: number;
}

interface EventDescriptor extends RawEventDescriptor {
  id: string;
  source: string;
  timestamp: string;
}

interface RawAppendOrderEventDescriptor extends RawEventDescriptor {
  sequence_id: number;
}

interface AppendOrderEventDescriptor extends EventDescriptor {
  sequence_id: number;
}

interface RawCaptureCheckpointRow {
  extractor: string | null;
  extractor_bytes: number;
  resource: string | null;
  resource_bytes: number;
  partition: string | null;
  partition_bytes: number;
  position: number | null;
  cursor: string | null;
  cursor_bytes: number | null;
  ordinal: number | null;
  mtime_ms: number | null;
  state: string | null;
  state_bytes: number;
  updated_at: string | null;
  updated_at_bytes: number;
}

interface CaptureCheckpointRow extends RawCaptureCheckpointRow {
  extractor: string;
  resource: string;
  partition: string;
  state: string;
  updated_at: string;
}

function assertDescriptorFieldsFit<T extends RawEventDescriptor>(
  descriptor: T,
  operation: StoragePayloadOperation,
): asserts descriptor is T & EventDescriptor {
  const fields = [
    ["id", descriptor.id, descriptor.id_bytes],
    ["source", descriptor.source, descriptor.source_bytes],
    ["timestamp", descriptor.timestamp, descriptor.timestamp_bytes],
  ] as const;
  for (const [field, value, fieldBytes] of fields) {
    const budgetBytes = STORAGE_DESCRIPTOR_FIELD_BUDGETS[field];
    if (value === null || fieldBytes > budgetBytes) {
      throw new StorageDescriptorFieldExceededError({
        operation,
        field,
        field_bytes: fieldBytes,
        budget_bytes: budgetBytes,
      });
    }
  }
}

function assertCursorDescriptorFields(
  operation: StoragePayloadOperation,
  cursor: { timestamp: string; id: string } | undefined,
): void {
  if (cursor === undefined) return;
  assertStorageDescriptorField(operation, "timestamp", cursor.timestamp);
  assertStorageDescriptorField(operation, "id", cursor.id);
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
      new Float32Array(
        buf.buffer,
        buf.byteOffset,
        buf.byteLength / Float32Array.BYTES_PER_ELEMENT,
      ),
    );
  }
  return event;
}

function assertCaptureCheckpointRowFits(
  row: RawCaptureCheckpointRow,
): asserts row is CaptureCheckpointRow {
  const requiredFields = [
    ["extractor", row.extractor, row.extractor_bytes],
    ["resource", row.resource, row.resource_bytes],
    ["partition", row.partition, row.partition_bytes],
    ["state", row.state, row.state_bytes],
    ["updated_at", row.updated_at, row.updated_at_bytes],
  ] as const;
  for (const [field, value, fieldBytes] of requiredFields) {
    const budgetBytes = CAPTURE_CHECKPOINT_FIELD_BUDGETS[field];
    if (value === null || fieldBytes > budgetBytes) {
      throw new CaptureCheckpointFieldExceededError({
        field,
        field_bytes: fieldBytes,
        budget_bytes: budgetBytes,
      });
    }
  }
  if (
    row.cursor_bytes !== null &&
    (row.cursor === null || row.cursor_bytes > CAPTURE_CHECKPOINT_CURSOR_BYTES)
  ) {
    throw new CaptureCheckpointFieldExceededError({
      field: "cursor",
      field_bytes: row.cursor_bytes,
      budget_bytes: CAPTURE_CHECKPOINT_CURSOR_BYTES,
    });
  }
}

function rowToCaptureCheckpoint(
  row: RawCaptureCheckpointRow,
): CaptureCheckpoint {
  assertCaptureCheckpointRowFits(row);
  const checkpoint: CaptureCheckpoint = {
    extractor: row.extractor,
    resource: row.resource,
    partition: row.partition,
    state: JSON.parse(row.state) as Record<string, unknown>,
    updated_at: row.updated_at,
  };
  if (row.position !== null) checkpoint.position = row.position;
  if (row.cursor !== null) checkpoint.cursor = row.cursor;
  if (row.ordinal !== null) checkpoint.ordinal = row.ordinal;
  if (row.mtime_ms !== null) checkpoint.mtime_ms = row.mtime_ms;
  return checkpoint;
}

/** CASE projections keep oversized or non-text legacy values inside SQLite;
 * only a NULL sentinel and the byte count enter JS, where the row is rejected
 * before JSON parsing or checkpoint materialization. */
const CAPTURE_CHECKPOINT_COLUMNS = `
  CASE
    WHEN typeof(extractor) = 'text'
      AND length(CAST(extractor AS BLOB)) <= ${CAPTURE_CHECKPOINT_EXTRACTOR_BYTES}
    THEN extractor ELSE NULL
  END AS extractor,
  length(CAST(extractor AS BLOB)) AS extractor_bytes,
  CASE
    WHEN typeof(resource) = 'text'
      AND length(CAST(resource AS BLOB)) <= ${CAPTURE_CHECKPOINT_RESOURCE_BYTES}
    THEN resource ELSE NULL
  END AS resource,
  length(CAST(resource AS BLOB)) AS resource_bytes,
  CASE
    WHEN typeof(partition) = 'text'
      AND length(CAST(partition AS BLOB)) <= ${CAPTURE_CHECKPOINT_PARTITION_BYTES}
    THEN partition ELSE NULL
  END AS partition,
  length(CAST(partition AS BLOB)) AS partition_bytes,
  position,
  CASE
    WHEN cursor IS NULL THEN NULL
    WHEN typeof(cursor) = 'text'
      AND length(CAST(cursor AS BLOB)) <= ${CAPTURE_CHECKPOINT_CURSOR_BYTES}
    THEN cursor ELSE NULL
  END AS cursor,
  CASE WHEN cursor IS NULL THEN NULL ELSE length(CAST(cursor AS BLOB)) END AS cursor_bytes,
  ordinal,
  mtime_ms,
  CASE
    WHEN typeof(state) = 'text'
      AND length(CAST(state AS BLOB)) <= ${CAPTURE_CHECKPOINT_STATE_BYTES}
    THEN state ELSE NULL
  END AS state,
  length(CAST(state AS BLOB)) AS state_bytes,
  CASE
    WHEN typeof(updated_at) = 'text'
      AND length(CAST(updated_at AS BLOB)) <= ${CAPTURE_CHECKPOINT_UPDATED_AT_BYTES}
    THEN updated_at ELSE NULL
  END AS updated_at,
  length(CAST(updated_at AS BLOB)) AS updated_at_bytes`;

const EVENT_PAYLOAD_COLUMNS =
  "id, source, timestamp, content, metadata, embedding";
const EVENT_STORED_BYTES_SQL = `(
  length(CAST(id AS BLOB)) +
  length(CAST(source AS BLOB)) +
  length(CAST(timestamp AS BLOB)) +
  length(CAST(content AS BLOB)) +
  COALESCE(length(CAST(metadata AS BLOB)), 0) +
  COALESCE(length(embedding), 0)
)`;
const QUALIFIED_EVENT_STORED_BYTES_SQL = `(
  length(CAST(e.id AS BLOB)) +
  length(CAST(e.source AS BLOB)) +
  length(CAST(e.timestamp AS BLOB)) +
  length(CAST(e.content AS BLOB)) +
  COALESCE(length(CAST(e.metadata AS BLOB)), 0) +
  COALESCE(length(e.embedding), 0)
)`;

/** CASE projections ensure an oversized legacy descriptor crosses the native
 * SQLite boundary only as NULL plus its byte length. The full text remains in
 * SQLite and is rejected before any source predicate or payload SELECT. */
const EVENT_DESCRIPTOR_COLUMNS_SQL = `
  CASE WHEN length(CAST(id AS BLOB)) <= ${STORAGE_DESCRIPTOR_ID_BYTES} THEN id ELSE NULL END AS id,
  length(CAST(id AS BLOB)) AS id_bytes,
  CASE WHEN length(CAST(source AS BLOB)) <= ${STORAGE_DESCRIPTOR_SOURCE_BYTES} THEN source ELSE NULL END AS source,
  length(CAST(source AS BLOB)) AS source_bytes,
  CASE WHEN length(CAST(timestamp AS BLOB)) <= ${STORAGE_DESCRIPTOR_TIMESTAMP_BYTES} THEN timestamp ELSE NULL END AS timestamp,
  length(CAST(timestamp AS BLOB)) AS timestamp_bytes`;

const EVENT_CANDIDATE_DESCRIPTOR_COLUMNS_SQL = `
  CASE WHEN length(CAST(id AS BLOB)) <= ${STORAGE_DESCRIPTOR_ID_BYTES} THEN id ELSE NULL END AS descriptor_id,
  length(CAST(id AS BLOB)) AS id_bytes,
  CASE WHEN length(CAST(source AS BLOB)) <= ${STORAGE_DESCRIPTOR_SOURCE_BYTES} THEN source ELSE NULL END AS descriptor_source,
  length(CAST(source AS BLOB)) AS source_bytes,
  CASE WHEN length(CAST(timestamp AS BLOB)) <= ${STORAGE_DESCRIPTOR_TIMESTAMP_BYTES} THEN timestamp ELSE NULL END AS descriptor_timestamp,
  length(CAST(timestamp AS BLOB)) AS timestamp_bytes`;

export class SqliteStorage implements Storage {
  private readonly db: Database.Database;
  private readonly insertStmt: Database.Statement;
  private readonly dedupeInsertStmt: Database.Statement;
  private readonly eventIdExistsStmt: Database.Statement;
  private readonly countStmt: Database.Statement;
  private readonly getCaptureCheckpointStmt: Database.Statement;
  private readonly upsertCaptureCheckpointStmt: Database.Statement;
  private readonly listCaptureCheckpointsStmt: Database.Statement;
  private readonly listCaptureCheckpointsAfterStmt: Database.Statement;
  private readonly queryStmtCache = new Map<string, Database.Statement>();
  private readonly payloadStmtCache = new Map<number, Database.Statement>();
  private readonly onSelectPage:
    ((observation: StorageSelectPageObservation) => void) | undefined;

  constructor(dbPath: string, options: SqliteStorageOptions = {}) {
    const createsAuthority = dbPath !== ":memory:" && !existsSync(dbPath);
    if (dbPath !== ":memory:") {
      // `mode` applies only to directories created by this call; never rewrite
      // permissions on an existing caller-owned parent directory.
      mkdirSync(dirname(dbPath), { recursive: true, mode: 0o700 });
    }
    this.db = new Database(dbPath);
    // better-sqlite3 creates a new database with the process umask. Tighten
    // only authority created by this constructor; pre-existing DBs are never
    // chmodded as they may be caller-owned source material.
    if (createsAuthority) restrictAuthorityFile(dbPath);
    try {
      // Run the schema-version guard before changing persistent journal mode;
      // unknown future schemas fail closed without being rewritten.
      migrate(this.db, MIGRATIONS_DIR);
    } catch (error) {
      this.db.close();
      throw error;
    }
    this.db.pragma("journal_mode = WAL");
    // NORMAL is safe under WAL and avoids per-append fsync — recommended by SQLite for app use.
    this.db.pragma("synchronous = NORMAL");
    this.db.pragma("foreign_keys = ON");
    // Project filtering runs only across bounded descriptor pages. Register the
    // shared path predicate as a deterministic scalar so SQLite and the memory
    // adapter normalize both stored repo_root values and requested roots with
    // identical dot-segment and component-boundary semantics.
    this.db.function(
      "echo_path_equals_or_descends_from",
      { deterministic: true },
      (candidate: unknown, root: unknown): number =>
        typeof candidate === "string" &&
        typeof root === "string" &&
        pathEqualsOrDescendsFrom(candidate, root)
          ? 1
          : 0,
    );
    if (createsAuthority) {
      // SQLite normally derives these modes from the database, but assert the
      // authority boundary explicitly for platforms where they currently exist.
      restrictAuthorityFile(`${dbPath}-wal`);
      restrictAuthorityFile(`${dbPath}-shm`);
    }
    this.onSelectPage = options.onSelectPage;

    this.insertStmt = this.db.prepare(
      `INSERT INTO events (id, source, source_key, timestamp, content, metadata, embedding)
       VALUES (@id, @source, @source_key, @timestamp, @content, @metadata, @embedding)`,
    );
    this.dedupeInsertStmt = this.db.prepare(
      `INSERT INTO events (id, source, source_key, timestamp, content, metadata, embedding)
       VALUES (@id, @source, @source_key, @timestamp, @content, @metadata, @embedding)
       ON CONFLICT(id) DO NOTHING`,
    );
    this.eventIdExistsStmt = this.db.prepare(
      "SELECT 1 FROM events WHERE id = ?",
    );
    this.countStmt = this.db.prepare(`SELECT COUNT(*) AS n FROM events`);
    this.getCaptureCheckpointStmt = this.db.prepare(
      `SELECT ${CAPTURE_CHECKPOINT_COLUMNS}
       FROM capture_checkpoints
       WHERE extractor = @extractor AND resource = @resource AND partition = @partition`,
    );
    this.upsertCaptureCheckpointStmt = this.db.prepare(
      `INSERT INTO capture_checkpoints (
         extractor, resource, partition, position, cursor, ordinal, mtime_ms, state, updated_at
       ) VALUES (
         @extractor, @resource, @partition, @position, @cursor, @ordinal, @mtime_ms, @state, @updated_at
       )
       ON CONFLICT (extractor, resource, partition) DO UPDATE SET
         position = excluded.position,
         cursor = excluded.cursor,
         ordinal = excluded.ordinal,
         mtime_ms = excluded.mtime_ms,
         state = excluded.state,
         updated_at = excluded.updated_at`,
    );
    this.listCaptureCheckpointsStmt = this.db.prepare(
      `SELECT ${CAPTURE_CHECKPOINT_COLUMNS}
       FROM capture_checkpoints
       WHERE extractor = @extractor
       ORDER BY resource ASC, partition ASC
       LIMIT @fetch_limit`,
    );
    this.listCaptureCheckpointsAfterStmt = this.db.prepare(
      `SELECT ${CAPTURE_CHECKPOINT_COLUMNS}
       FROM capture_checkpoints
       WHERE extractor = @extractor
         AND (resource, partition) > (@after_resource, @after_partition)
       ORDER BY resource ASC, partition ASC
       LIMIT @fetch_limit`,
    );
  }

  async append(
    event: Omit<CaptureEvent, "id">,
    options?: AppendOptions,
  ): Promise<EventId> {
    const dedupe = options?.dedupeKey !== undefined;
    const id: EventId = dedupe
      ? eventIdForDedupeKey(options.dedupeKey!)
      : randomUUID();
    assertStorageDescriptorField("append", "source", event.source);
    assertStorageDescriptorField("append", "timestamp", event.timestamp);
    if (dedupe && this.eventIdExistsStmt.get(id) !== undefined) return id;
    const serializedMetadata =
      event.metadata !== undefined
        ? JSON.stringify(
            preserveUndefinedProjectIdentityForJson(event.metadata),
          )
        : null;
    if (serializedMetadata === undefined) {
      throw new TypeError("append metadata must serialize to a JSON value");
    }
    const metadata = serializedMetadata;
    const timestamp = canonicalizeTimestamp(event.timestamp);
    const storedBytes = eventStoredBytes({
      id,
      source: event.source,
      timestamp,
      content: event.content,
      metadataJson: metadata ?? null,
      embeddingBytes:
        (event.embedding?.length ?? 0) * Float32Array.BYTES_PER_ELEMENT,
    });
    if (storedBytes > STORAGE_PAYLOAD_PAGE_BYTES) {
      throw new StorageBudgetExceededError({
        code: "event_too_large",
        operation: "append",
        stored_bytes: storedBytes,
        budget_bytes: STORAGE_PAYLOAD_PAGE_BYTES,
      });
    }
    const embedding = embeddingBytes(event.embedding);
    const row: EventRow & { source_key: string | null } = {
      id,
      source: event.source,
      source_key: normalizePathLikeSource(event.source),
      timestamp,
      content: event.content,
      metadata,
      embedding,
    };
    (dedupe ? this.dedupeInsertStmt : this.insertStmt).run(row);
    // Deterministic identity is first-write-wins. Capture enrichment can
    // legitimately differ across crash replay; never rewrite the durable atom.
    return id;
  }

  private observeSelectPage(observation: StorageSelectPageObservation): void {
    this.onSelectPage?.(observation);
  }

  private assertPayloadRowFits(
    descriptor: EventDescriptor,
    operation: StoragePayloadOperation,
  ): void {
    if (descriptor.stored_bytes > STORAGE_PAYLOAD_PAGE_BYTES) {
      throw new StorageBudgetExceededError({
        code: "event_too_large",
        operation,
        stored_bytes: descriptor.stored_bytes,
        budget_bytes: STORAGE_PAYLOAD_PAGE_BYTES,
      });
    }
  }

  /** Fetch admitted event payloads in pages bounded by both rows and SQLite
   * stored bytes. Descriptor sizing happens before this method, so no rejected
   * content or metadata value crosses the native SQLite → JS boundary. */
  private fetchPayloadRows(
    descriptors: readonly EventDescriptor[],
    operation: StoragePayloadOperation,
  ): Map<EventId, EventRow> {
    const pages: EventDescriptor[][] = [];
    let page: EventDescriptor[] = [];
    let pageBytes = 0;

    const flush = (): void => {
      if (page.length === 0) return;
      pages.push(page);
      page = [];
      pageBytes = 0;
    };

    for (const descriptor of descriptors) {
      this.assertPayloadRowFits(descriptor, operation);
      if (
        page.length >= STORAGE_PAYLOAD_PAGE_ROWS ||
        (page.length > 0 &&
          pageBytes + descriptor.stored_bytes > STORAGE_PAYLOAD_PAGE_BYTES)
      ) {
        flush();
      }
      page.push(descriptor);
      pageBytes += descriptor.stored_bytes;
    }
    flush();

    const byId = new Map<EventId, EventRow>();
    pages.forEach((descriptorsInPage, pageIndex) => {
      let statement = this.payloadStmtCache.get(descriptorsInPage.length);
      if (statement === undefined) {
        const placeholders = descriptorsInPage.map(() => "?").join(",");
        statement = this.db.prepare(
          `SELECT ${EVENT_PAYLOAD_COLUMNS} FROM events WHERE id IN (${placeholders})`,
        );
        this.payloadStmtCache.set(descriptorsInPage.length, statement);
      }
      const rows = statement.all(
        ...descriptorsInPage.map((descriptor) => descriptor.id),
      ) as EventRow[];
      const storedBytes = descriptorsInPage.reduce(
        (total, descriptor) => total + descriptor.stored_bytes,
        0,
      );
      this.observeSelectPage({
        operation,
        phase: "payload",
        rows: rows.length,
        stored_bytes: storedBytes,
        page: pageIndex + 1,
      });
      for (const row of rows) byId.set(row.id, row);
    });
    return byId;
  }

  private cachedStatement(sql: string): Database.Statement {
    let statement = this.queryStmtCache.get(sql);
    if (statement === undefined) {
      statement = this.db.prepare(sql);
      this.queryStmtCache.set(sql, statement);
    }
    return statement;
  }

  async query(filter?: QueryFilter): Promise<CaptureEvent[]> {
    if (filter?.source !== undefined && filter?.source_prefix !== undefined) {
      throw new Error(
        "QueryFilter.source and source_prefix are mutually exclusive",
      );
    }
    if (filter?.before !== undefined && filter?.order === "asc") {
      throw new RangeError(
        'QueryFilter.before is defined for descending queries only; pass order: "desc" or omit it',
      );
    }
    if (filter?.after !== undefined && filter?.order !== "asc") {
      throw new RangeError(
        "QueryFilter.after is defined for ascending queries only",
      );
    }
    if (filter?.before !== undefined && filter?.after !== undefined) {
      throw new RangeError(
        "QueryFilter.before and after are mutually exclusive",
      );
    }
    if (filter?.source !== undefined) {
      assertStorageDescriptorField("query", "source", filter.source);
    }
    if (filter?.source_prefix !== undefined) {
      assertStorageDescriptorField("query", "source", filter.source_prefix);
    }
    if (
      filter?.source_family !== undefined &&
      !isSourceFamily(filter.source_family)
    ) {
      throw new RangeError(
        `QueryFilter.source_family is invalid: ${String(filter.source_family)}`,
      );
    }
    if (filter?.since !== undefined) {
      assertStorageDescriptorField("query", "timestamp", filter.since);
    }
    if (filter?.until !== undefined) {
      assertStorageDescriptorField("query", "timestamp", filter.until);
    }
    if (
      filter?.project_key === undefined &&
      filter?.legacy_project_roots !== undefined
    ) {
      throw new RangeError("QueryFilter.legacy_project_roots requires project_key");
    }
    let legacyProjectRoots: string[] = [];
    let allowIdentityLessLegacyGitSource = false;
    if (filter?.project_key !== undefined) {
      assertStorageDescriptorField("query", "source", filter.project_key);
      legacyProjectRoots = normalizeLegacyProjectRoots(
        filter.project_key,
        filter.legacy_project_roots,
      );
      for (const root of legacyProjectRoots) {
        assertStorageDescriptorField("query", "source", root);
      }
      allowIdentityLessLegacyGitSource =
        filter.source !== undefined &&
        isLegacyGitSourceForProject(filter.source, legacyProjectRoots);
    }
    assertCursorDescriptorFields("query", filter?.before);
    assertCursorDescriptorFields("query", filter?.after);
    const since =
      filter?.since !== undefined
        ? canonicalizeTimestamp(filter.since)
        : undefined;
    const until =
      filter?.until !== undefined
        ? canonicalizeTimestamp(filter.until)
        : undefined;
    const rowLimit = cappedStorageRowLimit(filter?.limit);
    const clauses: string[] = [];
    const postDescriptorSqlPredicates: string[] = [];
    const params: Record<string, unknown> = {};
    // Exact path-like sources use a persisted normalized key and composite
    // index. Explicit app families use order-compatible partial indexes as a
    // conservative candidate bound. Prefix semantics remain authoritative in
    // JS; arbitrary prefixes retain the timestamp-ordered bounded scan.
    let jsSourcePredicate: ((source: string) => boolean) | undefined;
    if (filter?.source !== undefined) {
      const source = filter.source;
      const normalizedSource = normalizePathLikeSource(source);
      if (normalizedSource === null) {
        // Non-path-like source: sourceEquals degrades to raw string
        // equality for every stored row, which SQL's BINARY `=`
        // implements exactly — keep the pure-SQL fast path.
        clauses.push("source = @source");
        params["source"] = source;
      } else {
        clauses.push("source_key = @source_key");
        params["source_key"] = normalizedSource;
      }
    }
    if (filter?.source_family !== undefined) {
      const familyBit = SOURCE_FAMILY_BITS[filter.source_family];
      // The finite, validated bit is literal so SQLite can prove the query's
      // WHERE predicate implies the corresponding partial-index predicate.
      clauses.push(`(source_family_mask & ${familyBit}) != 0`);
    }
    if (
      filter?.source_prefix !== undefined &&
      filter.source_prefix.length > 0
    ) {
      const prefix = filter.source_prefix;
      jsSourcePredicate = (source) => sourceHasPrefix(source, prefix);
    }
    if (since !== undefined) {
      clauses.push("timestamp >= @since");
      params["since"] = since;
    }
    if (until !== undefined) {
      clauses.push("timestamp < @until");
      params["until"] = until;
    }
    if (filter?.before !== undefined) {
      // SQLite ≥3.0 supports row-value comparison; this is the canonical way
      // to express "rows strictly older than (ts, id)" in the composite-key
      // ordering and matches the JS predicate in MemoryStorage exactly.
      clauses.push("(timestamp, id) < (@before_ts, @before_id)");
      params["before_ts"] = filter.before.timestamp;
      params["before_id"] = filter.before.id;
    }
    if (filter?.after !== undefined) {
      clauses.push("(timestamp, id) > (@after_ts, @after_id)");
      params["after_ts"] = filter.after.timestamp;
      params["after_id"] = filter.after.id;
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
            ].join(", ")})`,
          );
        }
      }
      // Sorted key iteration: keeps the generated SQL text deterministic
      // across call shapes that pass the same key set in different
      // orders, so the prepared-statement cache below keys cleanly.
      // Note: the cache is keyed on the FULL `sql` text, so each distinct
      // metadata_match key combination produces its own cached prepared
      // statement. That is fine in practice — the whitelist is deliberately
      // finite, so the number of possible key combinations remains bounded.
      const matchKeys = Object.keys(filter.metadata_match).sort();
      matchKeys.forEach((key, i) => {
        const placeholder = `__metadata_match_${i}`;
        postDescriptorSqlPredicates.push(
          `json_extract(e.metadata, '$.${key}') = @${placeholder}`,
        );
        params[placeholder] = filter.metadata_match![key];
      });
    }
    if (filter?.project_key !== undefined) {
      const legacyRepoRootPredicates = legacyProjectRoots.map((root, index) => {
        const rootParam = `__legacy_project_root_${index}`;
        params[rootParam] = root;
        return `echo_path_equals_or_descends_from(
                  json_extract(e.metadata, '$.repo_root'),
                  @${rootParam}
                ) = 1`;
      });
      const legacyRepoRootMatch =
        legacyRepoRootPredicates.length === 0
          ? "0"
          : `(${legacyRepoRootPredicates.join(" OR ")})`;
      postDescriptorSqlPredicates.push(
        `(CASE
           WHEN json_type(e.metadata, '$.project_key') IS NOT NULL
             THEN CASE
               WHEN typeof(json_extract(e.metadata, '$.project_key')) = 'text'
                 AND json_extract(e.metadata, '$.project_key') = @__project_key
               THEN 1 ELSE 0 END
           WHEN json_type(e.metadata, '$.canonical_root') IS NOT NULL
             THEN CASE
               WHEN typeof(json_extract(e.metadata, '$.canonical_root')) = 'text'
                 AND ('local:workspace:' || json_extract(e.metadata, '$.canonical_root')) = @__project_key
               THEN 1 ELSE 0 END
           WHEN json_type(e.metadata, '$.repo_root') IS NOT NULL
             THEN CASE
               WHEN typeof(json_extract(e.metadata, '$.repo_root')) = 'text'
                 AND length(CAST(json_extract(e.metadata, '$.repo_root') AS BLOB)) <= ${STORAGE_DESCRIPTOR_SOURCE_BYTES}
                 AND ${legacyRepoRootMatch}
               THEN 1 ELSE 0 END
           ELSE ${allowIdentityLessLegacyGitSource ? "1" : "0"}
         END) = 1`,
      );
      params["__project_key"] = filter.project_key;
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
      postDescriptorSqlPredicates.push(
        `COALESCE(json_extract(e.metadata, '$.surface'), '') NOT IN (${placeholders.join(", ")})`,
      );
    }
    if (rowLimit === 0) return [];

    const order = filter?.order ?? "desc";
    const orderSql = order === "asc" ? "ASC" : "DESC";
    const descriptors: EventDescriptor[] = [];
    const hasPostDescriptorPredicate =
      jsSourcePredicate !== undefined || postDescriptorSqlPredicates.length > 0;
    let admittedBytes = 0;
    let scanCursor: { timestamp: string; id: string } | undefined;
    let scannedRows = 0;

    for (
      let page = 1;
      page <= STORAGE_MAX_DESCRIPTOR_PAGES && descriptors.length < rowLimit;
      page += 1
    ) {
      const pageClauses = [...clauses];
      const pageParams: Record<string, unknown> = {
        ...params,
        __descriptor_limit: STORAGE_DESCRIPTOR_PAGE_ROWS,
      };
      if (scanCursor !== undefined) {
        pageClauses.push(
          order === "asc"
            ? "(timestamp, id) > (@__scan_timestamp, @__scan_id)"
            : "(timestamp, id) < (@__scan_timestamp, @__scan_id)",
        );
        pageParams["__scan_timestamp"] = scanCursor.timestamp;
        pageParams["__scan_id"] = scanCursor.id;
      }
      const where =
        pageClauses.length > 0 ? `WHERE ${pageClauses.join(" AND ")}` : "";
      const postFilterSql =
        postDescriptorSqlPredicates.length === 0
          ? "1"
          : `CASE WHEN ${postDescriptorSqlPredicates.join(" AND ")} THEN 1 ELSE 0 END`;
      // The MATERIALIZED bounded-descriptor CTE is an optimization fence: every
      // non-indexable JSON predicate runs only after the timestamp/keyset page
      // has selected at most 256 candidates. Oversized legacy descriptor text
      // is projected as NULL; payload columns stay inside SQLite and only byte
      // lengths / predicate booleans cross into JS before admission.
      const sql = `WITH candidate_rows AS MATERIALIZED (
                     SELECT rowid AS event_rowid,
                            ${EVENT_CANDIDATE_DESCRIPTOR_COLUMNS_SQL}
                     FROM events
                     ${where}
                     ORDER BY events.timestamp ${orderSql}, events.id ${orderSql}
                     LIMIT @__descriptor_limit
                   )
                   SELECT c.descriptor_id AS id, c.id_bytes,
                          c.descriptor_source AS source, c.source_bytes,
                          c.descriptor_timestamp AS timestamp, c.timestamp_bytes,
                          ${QUALIFIED_EVENT_STORED_BYTES_SQL} AS stored_bytes,
                          ${postFilterSql} AS post_filter_matches
                   FROM candidate_rows c
                   JOIN events e ON e.rowid = c.event_rowid
                   ORDER BY e.timestamp ${orderSql}, e.id ${orderSql}`;
      const pageRows = this.cachedStatement(sql).all(
        pageParams,
      ) as RawEventDescriptor[];
      scannedRows += pageRows.length;
      this.observeSelectPage({
        operation: "query",
        phase: "descriptor",
        rows: pageRows.length,
        stored_bytes: pageRows.reduce(
          (total, row) => total + row.stored_bytes,
          0,
        ),
        page,
      });
      if (pageRows.length === 0) break;

      for (const descriptor of pageRows) {
        assertDescriptorFieldsFit(descriptor, "query");
        if (
          jsSourcePredicate !== undefined &&
          !jsSourcePredicate(descriptor.source)
        )
          continue;
        if (descriptor.post_filter_matches !== 1) continue;
        this.assertPayloadRowFits(descriptor, "query");
        if (
          admittedBytes + descriptor.stored_bytes >
          STORAGE_QUERY_STORED_BYTES
        ) {
          throw new StorageBudgetExceededError({
            code: "request_too_large",
            operation: "query",
            stored_bytes: admittedBytes + descriptor.stored_bytes,
            budget_bytes: STORAGE_QUERY_STORED_BYTES,
          });
        }
        descriptors.push(descriptor);
        admittedBytes += descriptor.stored_bytes;
        if (descriptors.length >= rowLimit) break;
      }
      if (descriptors.length >= rowLimit) break;
      if (pageRows.length < STORAGE_DESCRIPTOR_PAGE_ROWS) break;
      const last = pageRows[pageRows.length - 1]!;
      assertDescriptorFieldsFit(last, "query");
      scanCursor = { timestamp: last.timestamp, id: last.id };
    }

    if (
      hasPostDescriptorPredicate &&
      descriptors.length < rowLimit &&
      scannedRows >=
        STORAGE_DESCRIPTOR_PAGE_ROWS * STORAGE_MAX_DESCRIPTOR_PAGES &&
      scanCursor !== undefined
    ) {
      throw new StorageScanBudgetExceededError({
        order,
        scanned_rows: scannedRows,
        matched_ids: descriptors.map((descriptor) => descriptor.id),
        resume_cursor: scanCursor,
      });
    }

    const payloadById = this.fetchPayloadRows(descriptors, "query");
    const events: CaptureEvent[] = [];
    for (const descriptor of descriptors) {
      const row = payloadById.get(descriptor.id);
      if (row !== undefined) events.push(rowToEvent(row));
    }
    return events;
  }

  async count(): Promise<number> {
    const row = this.countStmt.get() as { n: number };
    return row.n;
  }

  async getByIds(ids: readonly EventId[]): Promise<CaptureEvent[]> {
    if (ids.length === 0) return [];
    if (ids.length > STORAGE_GET_BY_IDS_MAX_IDS) {
      throw new RangeError(
        `getByIds accepts at most ${STORAGE_GET_BY_IDS_MAX_IDS} ids`,
      );
    }
    for (const id of ids) assertStorageDescriptorField("getByIds", "id", id);

    const uniqueIds = [...new Set(ids)];
    const placeholders = uniqueIds.map(() => "?").join(",");
    const descriptors = this.db
      .prepare(
        `SELECT ${EVENT_DESCRIPTOR_COLUMNS_SQL}, ${EVENT_STORED_BYTES_SQL} AS stored_bytes
         FROM events
         WHERE id IN (${placeholders})`,
      )
      .all(...uniqueIds) as RawEventDescriptor[];
    this.observeSelectPage({
      operation: "getByIds",
      phase: "descriptor",
      rows: descriptors.length,
      stored_bytes: descriptors.reduce(
        (total, descriptor) => total + descriptor.stored_bytes,
        0,
      ),
      page: 1,
    });
    let requestedBytes = 0;
    const admittedDescriptors: EventDescriptor[] = [];
    for (const descriptor of descriptors) {
      assertDescriptorFieldsFit(descriptor, "getByIds");
      this.assertPayloadRowFits(descriptor, "getByIds");
      requestedBytes += descriptor.stored_bytes;
      if (requestedBytes > STORAGE_QUERY_STORED_BYTES) {
        throw new StorageBudgetExceededError({
          code: "request_too_large",
          operation: "getByIds",
          stored_bytes: requestedBytes,
          budget_bytes: STORAGE_QUERY_STORED_BYTES,
        });
      }
      admittedDescriptors.push(descriptor);
    }

    const payloadById = this.fetchPayloadRows(admittedDescriptors, "getByIds");
    const eventById = new Map<EventId, CaptureEvent>();
    for (const [id, row] of payloadById) eventById.set(id, rowToEvent(row));
    const out: CaptureEvent[] = [];
    for (const id of ids) {
      const ev = eventById.get(id);
      if (ev !== undefined) out.push(ev);
    }
    return out;
  }

  async getCaptureCheckpoint(
    key: CaptureCheckpointKey,
  ): Promise<CaptureCheckpoint | null> {
    const normalized = normalizeCaptureCheckpointKey(key);
    const row = this.getCaptureCheckpointStmt.get(normalized) as
      RawCaptureCheckpointRow | undefined;
    return row === undefined ? null : rowToCaptureCheckpoint(row);
  }

  async upsertCaptureCheckpoint(
    input: CaptureCheckpointInput,
  ): Promise<CaptureCheckpoint> {
    const checkpoint = normalizeCaptureCheckpointInput(input);
    this.upsertCaptureCheckpointStmt.run({
      extractor: checkpoint.extractor,
      resource: checkpoint.resource,
      partition: checkpoint.partition,
      position: checkpoint.position ?? null,
      cursor: checkpoint.cursor ?? null,
      ordinal: checkpoint.ordinal ?? null,
      mtime_ms: checkpoint.mtime_ms ?? null,
      state: JSON.stringify(checkpoint.state),
      updated_at: checkpoint.updated_at,
    });
    return checkpoint;
  }

  async listCaptureCheckpoints(
    options: CaptureCheckpointListOptions,
  ): Promise<CaptureCheckpointPage> {
    const normalized = normalizeCaptureCheckpointListOptions(options);
    const params: Record<string, unknown> = {
      extractor: normalized.extractor,
      // One-row overfetch proves whether another bounded keyset page exists.
      fetch_limit: normalized.limit + 1,
    };
    let statement = this.listCaptureCheckpointsStmt;
    if (normalized.after !== undefined) {
      statement = this.listCaptureCheckpointsAfterStmt;
      params["after_resource"] = normalized.after.resource;
      params["after_partition"] = normalized.after.partition;
    }
    const rows = statement.all(params) as RawCaptureCheckpointRow[];
    const hasMore = rows.length > normalized.limit;
    const checkpoints = rows
      .slice(0, normalized.limit)
      .map(rowToCaptureCheckpoint);
    return {
      checkpoints,
      next_cursor:
        hasMore && checkpoints.length > 0
          ? captureCheckpointCursor(checkpoints[checkpoints.length - 1]!)
          : null,
    };
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
      params[key] = `${prefix.replace(/[\\%_]/g, "\\$&")}%`;
    });
    return `(${ors.join(" OR ")})`;
  }

  async iterateAtomsByAppendOrder(opts?: {
    sinceSeq?: number;
    sourcePrefixes?: readonly string[];
    limit?: number;
  }): Promise<AtomIterationRecord[]> {
    const sinceSeq = opts?.sinceSeq ?? 1;
    if (!Number.isSafeInteger(sinceSeq) || sinceSeq < 1) {
      throw new RangeError(
        "iterateAtomsByAppendOrder sinceSeq must be a positive safe integer",
      );
    }
    const rowLimit = cappedStorageRowLimit(opts?.limit);
    if (rowLimit === 0) return [];

    for (const prefix of opts?.sourcePrefixes ?? []) {
      assertStorageDescriptorField(
        "iterateAtomsByAppendOrder",
        "source",
        prefix,
      );
    }

    const baseParams: Record<string, unknown> = { sinceSeq };
    const clauses = ["rowid >= @sinceSeq"];
    const prefixes = opts?.sourcePrefixes;
    const hasPrefixFilter = prefixes !== undefined && prefixes.length > 0;
    const descriptors: AppendOrderEventDescriptor[] = [];
    let admittedBytes = 0;
    let lastSequence: number | undefined;
    let scannedRows = 0;

    for (
      let page = 1;
      page <= STORAGE_MAX_DESCRIPTOR_PAGES && descriptors.length < rowLimit;
      page += 1
    ) {
      const pageClauses = [...clauses];
      const pageParams: Record<string, unknown> = {
        ...baseParams,
        __descriptor_limit: STORAGE_DESCRIPTOR_PAGE_ROWS,
      };
      if (lastSequence !== undefined) {
        pageClauses.push("rowid > @__last_sequence");
        pageParams["__last_sequence"] = lastSequence;
      }
      const sql = `SELECT rowid AS sequence_id, ${EVENT_DESCRIPTOR_COLUMNS_SQL},
                          ${EVENT_STORED_BYTES_SQL} AS stored_bytes
                   FROM events
                   WHERE ${pageClauses.join(" AND ")}
                   ORDER BY rowid ASC
                   LIMIT @__descriptor_limit`;
      const pageRows = this.cachedStatement(sql).all(
        pageParams,
      ) as RawAppendOrderEventDescriptor[];
      scannedRows += pageRows.length;
      this.observeSelectPage({
        operation: "iterateAtomsByAppendOrder",
        phase: "descriptor",
        rows: pageRows.length,
        stored_bytes: pageRows.reduce(
          (total, row) => total + row.stored_bytes,
          0,
        ),
        page,
      });
      if (pageRows.length === 0) break;

      for (const descriptor of pageRows) {
        assertDescriptorFieldsFit(descriptor, "iterateAtomsByAppendOrder");
        if (
          hasPrefixFilter &&
          !prefixes!.some((prefix) => descriptor.source.startsWith(prefix))
        ) {
          continue;
        }
        this.assertPayloadRowFits(descriptor, "iterateAtomsByAppendOrder");
        if (
          admittedBytes + descriptor.stored_bytes >
          STORAGE_QUERY_STORED_BYTES
        ) {
          throw new StorageBudgetExceededError({
            code: "request_too_large",
            operation: "iterateAtomsByAppendOrder",
            stored_bytes: admittedBytes + descriptor.stored_bytes,
            budget_bytes: STORAGE_QUERY_STORED_BYTES,
          });
        }
        descriptors.push(descriptor);
        admittedBytes += descriptor.stored_bytes;
        if (descriptors.length >= rowLimit) break;
      }
      if (descriptors.length >= rowLimit) break;
      if (pageRows.length < STORAGE_DESCRIPTOR_PAGE_ROWS) break;
      lastSequence = pageRows[pageRows.length - 1]!.sequence_id;
    }

    if (
      hasPrefixFilter &&
      descriptors.length < rowLimit &&
      scannedRows >=
        STORAGE_DESCRIPTOR_PAGE_ROWS * STORAGE_MAX_DESCRIPTOR_PAGES &&
      lastSequence !== undefined
    ) {
      throw new StorageAppendScanBudgetExceededError({
        scanned_rows: scannedRows,
        matched: descriptors.map((descriptor) => ({
          id: descriptor.id,
          sequence_id: descriptor.sequence_id,
        })),
        resume_since_seq: lastSequence + 1,
      });
    }

    const payloadById = this.fetchPayloadRows(
      descriptors,
      "iterateAtomsByAppendOrder",
    );
    const records: AtomIterationRecord[] = [];
    for (const descriptor of descriptors) {
      const row = payloadById.get(descriptor.id);
      if (row === undefined) continue;
      records.push({ ...rowToEvent(row), sequence_id: descriptor.sequence_id });
    }
    return records;
  }

  async getCurrentSequence(opts?: {
    sourcePrefixes?: readonly string[];
  }): Promise<number> {
    const params: Record<string, unknown> = {};
    const prefixClause = this.buildPrefixClause(opts?.sourcePrefixes, params);
    const where = prefixClause !== null ? `WHERE ${prefixClause}` : "";
    const stmt = this.db.prepare(
      `SELECT COALESCE(MAX(rowid), 0) AS seq FROM events ${where}`,
    );
    const row = (prefixClause !== null ? stmt.get(params) : stmt.get()) as {
      seq: number;
    };
    return row.seq;
  }

  async iterateCoordAtomsByAppendOrder(opts?: {
    sinceSeq?: number;
    limit?: number;
  }): Promise<CoordAtomIterationRecord[]> {
    return this.iterateAtomsByAppendOrder({
      sinceSeq: opts?.sinceSeq,
      sourcePrefixes: ["coord:"],
      limit: opts?.limit,
    });
  }

  async getCurrentCoordSequence(): Promise<number> {
    return this.getCurrentSequence({ sourcePrefixes: ["coord:"] });
  }

  close(): void {
    if (!this.db.open) return;
    this.db.close();
  }
}
