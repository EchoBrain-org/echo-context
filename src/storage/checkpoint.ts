import type {
  CaptureCheckpoint,
  CaptureCheckpointInput,
  CaptureCheckpointKey,
  CaptureCheckpointListCursor,
  CaptureCheckpointListOptions,
} from "./interface.js";
import { canonicalizeTimestamp } from "../util/timestamp.js";

/** Hard storage-seam cap: checkpoint scans can never request an unbounded page. */
export const MAX_CAPTURE_CHECKPOINT_PAGE_SIZE = 100;

export const CAPTURE_CHECKPOINT_EXTRACTOR_BYTES = 128;
export const CAPTURE_CHECKPOINT_RESOURCE_BYTES = 16 * 1024;
export const CAPTURE_CHECKPOINT_PARTITION_BYTES = 1024;
export const CAPTURE_CHECKPOINT_CURSOR_BYTES = 4 * 1024;
export const CAPTURE_CHECKPOINT_STATE_BYTES = 128 * 1024;
export const CAPTURE_CHECKPOINT_UPDATED_AT_BYTES = 128;

export type CaptureCheckpointField =
  "extractor" | "resource" | "partition" | "cursor" | "state" | "updated_at";

export const CAPTURE_CHECKPOINT_FIELD_BUDGETS: Readonly<
  Record<CaptureCheckpointField, number>
> = {
  extractor: CAPTURE_CHECKPOINT_EXTRACTOR_BYTES,
  resource: CAPTURE_CHECKPOINT_RESOURCE_BYTES,
  partition: CAPTURE_CHECKPOINT_PARTITION_BYTES,
  cursor: CAPTURE_CHECKPOINT_CURSOR_BYTES,
  state: CAPTURE_CHECKPOINT_STATE_BYTES,
  updated_at: CAPTURE_CHECKPOINT_UPDATED_AT_BYTES,
};

export class CaptureCheckpointFieldExceededError extends Error {
  readonly code = "checkpoint_field_too_large";
  readonly field: CaptureCheckpointField;
  readonly field_bytes: number;
  readonly budget_bytes: number;

  constructor(args: {
    field: CaptureCheckpointField;
    field_bytes: number;
    budget_bytes: number;
  }) {
    super(
      `capture checkpoint: checkpoint_field_too_large; ${args.field} bytes ${args.field_bytes} exceed budget ${args.budget_bytes}`,
    );
    this.name = "CaptureCheckpointFieldExceededError";
    this.field = args.field;
    this.field_bytes = args.field_bytes;
    this.budget_bytes = args.budget_bytes;
  }
}

/** Reject checkpoint values before they cross a storage boundary. SQLite
 * legacy-row reads enforce the same budgets with length-only projections. */
export function assertCaptureCheckpointField(
  field: CaptureCheckpointField,
  value: string,
): void {
  const fieldBytes = Buffer.byteLength(value);
  const budgetBytes = CAPTURE_CHECKPOINT_FIELD_BUDGETS[field];
  if (fieldBytes > budgetBytes) {
    throw new CaptureCheckpointFieldExceededError({
      field,
      field_bytes: fieldBytes,
      budget_bytes: budgetBytes,
    });
  }
}

export interface NormalizedCaptureCheckpointKey {
  extractor: string;
  resource: string;
  partition: string;
}

export interface NormalizedCaptureCheckpointListOptions {
  extractor: string;
  limit: number;
  after?: CaptureCheckpointListCursor;
}

function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(
      `capture checkpoint ${field} must be a non-empty string`,
    );
  }
  return value;
}

function requirePartition(value: unknown): string {
  if (value === undefined) return "";
  if (typeof value !== "string") {
    throw new TypeError("capture checkpoint partition must be a string");
  }
  return value;
}

function optionalSafeInteger(
  value: unknown,
  field: string,
): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new RangeError(
      `capture checkpoint ${field} must be a non-negative safe integer`,
    );
  }
  return value as number;
}

function optionalFiniteNumber(
  value: unknown,
  field: string,
): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new RangeError(
      `capture checkpoint ${field} must be a finite non-negative number`,
    );
  }
  return value;
}

function cloneJsonState(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("capture checkpoint state must be a JSON object");
  }
  let encoded: string;
  try {
    encoded = JSON.stringify(value, (_key, item: unknown) => {
      if (
        item === undefined ||
        typeof item === "bigint" ||
        typeof item === "function" ||
        typeof item === "symbol" ||
        (typeof item === "number" && !Number.isFinite(item))
      ) {
        throw new TypeError(
          "capture checkpoint state must contain only finite JSON values",
        );
      }
      return item;
    });
  } catch (error) {
    if (error instanceof TypeError) throw error;
    throw new TypeError("capture checkpoint state must be JSON-serializable");
  }
  assertCaptureCheckpointField("state", encoded);
  const decoded = JSON.parse(encoded) as unknown;
  if (
    typeof decoded !== "object" ||
    decoded === null ||
    Array.isArray(decoded)
  ) {
    throw new TypeError("capture checkpoint state must be a JSON object");
  }
  return decoded as Record<string, unknown>;
}

export function normalizeCaptureCheckpointKey(
  key: CaptureCheckpointKey,
): NormalizedCaptureCheckpointKey {
  const extractor = requireNonEmptyString(key.extractor, "extractor");
  const resource = requireNonEmptyString(key.resource, "resource");
  const partition = requirePartition(key.partition);
  assertCaptureCheckpointField("extractor", extractor);
  assertCaptureCheckpointField("resource", resource);
  assertCaptureCheckpointField("partition", partition);
  return {
    extractor,
    resource,
    partition,
  };
}

export function normalizeCaptureCheckpointInput(
  input: CaptureCheckpointInput,
): CaptureCheckpoint {
  const key = normalizeCaptureCheckpointKey(input);
  const cursor = input.cursor;
  if (
    cursor !== undefined &&
    (typeof cursor !== "string" || cursor.length === 0)
  ) {
    throw new TypeError(
      "capture checkpoint cursor must be a non-empty string when present",
    );
  }
  if (cursor !== undefined) assertCaptureCheckpointField("cursor", cursor);
  const updatedAt = requireNonEmptyString(input.updated_at, "updated_at");
  assertCaptureCheckpointField("updated_at", updatedAt);
  const canonicalUpdatedAt = canonicalizeTimestamp(updatedAt);
  assertCaptureCheckpointField("updated_at", canonicalUpdatedAt);
  const checkpoint: CaptureCheckpoint = {
    ...key,
    state: cloneJsonState(input.state ?? {}),
    updated_at: canonicalUpdatedAt,
  };
  const position = optionalSafeInteger(input.position, "position");
  const ordinal = optionalSafeInteger(input.ordinal, "ordinal");
  const mtimeMs = optionalFiniteNumber(input.mtime_ms, "mtime_ms");
  if (position !== undefined) checkpoint.position = position;
  if (cursor !== undefined) checkpoint.cursor = cursor;
  if (ordinal !== undefined) checkpoint.ordinal = ordinal;
  if (mtimeMs !== undefined) checkpoint.mtime_ms = mtimeMs;
  return checkpoint;
}

export function cloneCaptureCheckpoint(
  checkpoint: CaptureCheckpoint,
): CaptureCheckpoint {
  return normalizeCaptureCheckpointInput(checkpoint);
}

export function normalizeCaptureCheckpointListOptions(
  options: CaptureCheckpointListOptions,
): NormalizedCaptureCheckpointListOptions {
  const extractor = requireNonEmptyString(options.extractor, "extractor");
  assertCaptureCheckpointField("extractor", extractor);
  if (!Number.isInteger(options.limit) || options.limit < 1) {
    throw new RangeError(
      "capture checkpoint list limit must be a positive integer",
    );
  }
  if (options.limit > MAX_CAPTURE_CHECKPOINT_PAGE_SIZE) {
    throw new RangeError(
      `capture checkpoint list limit must be <= ${MAX_CAPTURE_CHECKPOINT_PAGE_SIZE}`,
    );
  }
  if (options.after === undefined) return { extractor, limit: options.limit };

  const after = normalizeCaptureCheckpointKey(options.after);
  if (after.extractor !== extractor) {
    throw new RangeError(
      "capture checkpoint list cursor extractor must match the requested extractor",
    );
  }
  return { extractor, limit: options.limit, after };
}

export function captureCheckpointCursor(
  checkpoint: CaptureCheckpoint,
): CaptureCheckpointListCursor {
  return {
    extractor: checkpoint.extractor,
    resource: checkpoint.resource,
    partition: checkpoint.partition,
  };
}

/** Compare with SQLite's default BINARY UTF-8 collation. */
export function compareCaptureCheckpointKeys(
  left: CaptureCheckpointListCursor,
  right: CaptureCheckpointListCursor,
): number {
  for (const field of ["extractor", "resource", "partition"] as const) {
    const compared = Buffer.compare(
      Buffer.from(left[field]),
      Buffer.from(right[field]),
    );
    if (compared !== 0) return compared;
  }
  return 0;
}
