/** Default and hard result-row ceilings for event queries and append-order scans. */
export const STORAGE_DEFAULT_ROW_LIMIT = 1_000;
export const STORAGE_MAX_ROW_LIMIT = 5_000;

/** Descriptor scans are keyset-paged and may inspect at most this finite window. */
export const STORAGE_DESCRIPTOR_PAGE_ROWS = 256;
export const STORAGE_MAX_DESCRIPTOR_PAGES = 32;
export const STORAGE_MAX_SCANNED_ROWS =
  STORAGE_DESCRIPTOR_PAGE_ROWS * STORAGE_MAX_DESCRIPTOR_PAGES;

/** Descriptor fields cross the SQLite/JS boundary before payload admission. */
export const STORAGE_DESCRIPTOR_ID_BYTES = 256;
export const STORAGE_DESCRIPTOR_SOURCE_BYTES = 16 * 1024;
export const STORAGE_DESCRIPTOR_TIMESTAMP_BYTES = 128;

/** Payload is admitted by SQLite byte lengths before content/metadata enter JS. */
export const STORAGE_PAYLOAD_PAGE_ROWS = 64;
export const STORAGE_PAYLOAD_PAGE_BYTES = 4 * 1024 * 1024;
export const STORAGE_QUERY_STORED_BYTES = 32 * 1024 * 1024;

/** Exact hydration is rejected before SQL when the caller supplies too many ids. */
export const STORAGE_GET_BY_IDS_MAX_IDS = 100;

export type StoragePayloadOperation =
  | 'append'
  | 'query'
  | 'getByIds'
  | 'iterateAtomsByAppendOrder';

export interface StorageSelectPageObservation {
  operation: StoragePayloadOperation;
  phase: 'descriptor' | 'payload';
  rows: number;
  stored_bytes: number;
  page: number;
}

export interface SqliteStorageOptions {
  /** Optional diagnostics seam used by bounded-query tests and operators. */
  onSelectPage?: (observation: StorageSelectPageObservation) => void;
}

export class StorageBudgetExceededError extends Error {
  readonly code: 'event_too_large' | 'request_too_large';
  readonly operation: StoragePayloadOperation;
  readonly stored_bytes: number;
  readonly budget_bytes: number;

  constructor(args: {
    code: 'event_too_large' | 'request_too_large';
    operation: StoragePayloadOperation;
    stored_bytes: number;
    budget_bytes: number;
  }) {
    super(
      `${args.operation}: ${args.code}; stored bytes ${args.stored_bytes} exceed budget ${args.budget_bytes}`,
    );
    this.name = 'StorageBudgetExceededError';
    this.code = args.code;
    this.operation = args.operation;
    this.stored_bytes = args.stored_bytes;
    this.budget_bytes = args.budget_bytes;
  }
}

export type StorageDescriptorField = 'id' | 'source' | 'timestamp';

export const STORAGE_DESCRIPTOR_FIELD_BUDGETS: Readonly<
  Record<StorageDescriptorField, number>
> = {
  id: STORAGE_DESCRIPTOR_ID_BYTES,
  source: STORAGE_DESCRIPTOR_SOURCE_BYTES,
  timestamp: STORAGE_DESCRIPTOR_TIMESTAMP_BYTES,
};

export class StorageDescriptorFieldExceededError extends Error {
  readonly code = 'descriptor_field_too_large';
  readonly operation: StoragePayloadOperation;
  readonly field: StorageDescriptorField;
  readonly field_bytes: number;
  readonly budget_bytes: number;

  constructor(args: {
    operation: StoragePayloadOperation;
    field: StorageDescriptorField;
    field_bytes: number;
    budget_bytes: number;
  }) {
    super(
      `${args.operation}: descriptor_field_too_large; ${args.field} bytes ${args.field_bytes} exceed budget ${args.budget_bytes}`,
    );
    this.name = 'StorageDescriptorFieldExceededError';
    this.operation = args.operation;
    this.field = args.field;
    this.field_bytes = args.field_bytes;
    this.budget_bytes = args.budget_bytes;
  }
}

/** Reject caller-provided descriptor values before they reach SQLite (or a
 * full-memory adapter scan). Legacy database rows use the same budgets via
 * length-only SQL projections in SqliteStorage. */
export function assertStorageDescriptorField(
  operation: StoragePayloadOperation,
  field: StorageDescriptorField,
  value: string,
): void {
  const fieldBytes = Buffer.byteLength(value);
  const budgetBytes = STORAGE_DESCRIPTOR_FIELD_BUDGETS[field];
  if (fieldBytes > budgetBytes) {
    throw new StorageDescriptorFieldExceededError({
      operation,
      field,
      field_bytes: fieldBytes,
      budget_bytes: budgetBytes,
    });
  }
}

export interface StorageScanCursor {
  timestamp: string;
  id: string;
}

/** A source-prefix query inspected its complete bounded timestamp window
 * before satisfying the requested row limit. `matched_ids` plus
 * `resume_cursor` form a lossless continuation: hydrate those ids, then retry
 * with `before` (desc) or `after` (asc). */
export class StorageScanBudgetExceededError extends Error {
  readonly code = 'scan_budget_exceeded';
  readonly operation = 'query';
  readonly order: 'asc' | 'desc';
  readonly scanned_rows: number;
  readonly matched_ids: readonly string[];
  readonly resume_cursor: StorageScanCursor;

  constructor(args: {
    order: 'asc' | 'desc';
    scanned_rows: number;
    matched_ids: readonly string[];
    resume_cursor: StorageScanCursor;
  }) {
    super(
      `query: scan_budget_exceeded after ${args.scanned_rows} rows; resume with ${args.order === 'asc' ? 'after' : 'before'}=${JSON.stringify(args.resume_cursor)}`,
    );
    this.name = 'StorageScanBudgetExceededError';
    this.order = args.order;
    this.scanned_rows = args.scanned_rows;
    this.matched_ids = [...args.matched_ids];
    this.resume_cursor = args.resume_cursor;
  }
}

export class StorageAppendScanBudgetExceededError extends Error {
  readonly code = 'scan_budget_exceeded';
  readonly operation = 'iterateAtomsByAppendOrder';
  readonly scanned_rows: number;
  readonly matched: readonly { id: string; sequence_id: number }[];
  readonly resume_since_seq: number;

  constructor(args: {
    scanned_rows: number;
    matched: readonly { id: string; sequence_id: number }[];
    resume_since_seq: number;
  }) {
    super(
      `iterateAtomsByAppendOrder: scan_budget_exceeded after ${args.scanned_rows} rows; resume with sinceSeq=${args.resume_since_seq}`,
    );
    this.name = 'StorageAppendScanBudgetExceededError';
    this.scanned_rows = args.scanned_rows;
    this.matched = [...args.matched];
    this.resume_since_seq = args.resume_since_seq;
  }
}

export function cappedStorageRowLimit(requested: number | undefined): number {
  if (requested === undefined) return STORAGE_DEFAULT_ROW_LIMIT;
  if (!Number.isInteger(requested) || requested < 0) {
    throw new RangeError('storage row limit must be a non-negative integer');
  }
  return Math.min(requested, STORAGE_MAX_ROW_LIMIT);
}

export function eventStoredBytes(args: {
  id: string;
  source: string;
  timestamp: string;
  content: string;
  metadataJson: string | null;
  embeddingBytes: number;
}): number {
  return (
    Buffer.byteLength(args.id) +
    Buffer.byteLength(args.source) +
    Buffer.byteLength(args.timestamp) +
    Buffer.byteLength(args.content) +
    (args.metadataJson === null ? 0 : Buffer.byteLength(args.metadataJson)) +
    args.embeddingBytes
  );
}
