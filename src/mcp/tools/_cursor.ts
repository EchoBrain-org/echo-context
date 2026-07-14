// Composite-cursor encode/decode helpers shared across MCP retrieval tools.
// Single source of truth: callers accept the same {timestamp, id} shape so
// `next_cursor` is portable across paginating tools. Extracted from
// `search-memories.ts` per item 026 acceptance ("MUST extract them to a
// shared module ... that refactor is part of 026's scope").

import type { CaptureEvent } from '../../storage/interface.js';

export interface DecodedCursor {
  timestamp: string;
  id: string;
}

// Re-exported under the storage filter's name for ergonomic call sites:
// `const before: BeforeFilter = decodeCursor(cursor)` then
// `filter.before = before`. Kept identical to QueryFilter.before so the
// types align without a structural cast.
export type BeforeFilter = DecodedCursor;

export class CursorDecodeError extends Error {
  constructor(reason: string) {
    super(`malformed cursor: ${reason}; pass back the prior call's next_cursor verbatim`);
    this.name = 'CursorDecodeError';
  }
}

export function encodeCursor(c: DecodedCursor): string {
  return Buffer.from(JSON.stringify(c)).toString('base64');
}

export function decodeCursor(raw: string): DecodedCursor {
  let json: string;
  try {
    json = Buffer.from(raw, 'base64').toString('utf8');
  } catch {
    throw new CursorDecodeError('not valid base64');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new CursorDecodeError('decoded value is not JSON');
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new CursorDecodeError('decoded JSON is not an object');
  }
  const obj = parsed as { timestamp?: unknown; id?: unknown };
  if (typeof obj.timestamp !== 'string') {
    throw new CursorDecodeError('missing or non-string `timestamp` field');
  }
  if (typeof obj.id !== 'string') {
    throw new CursorDecodeError('missing or non-string `id` field');
  }
  return { timestamp: obj.timestamp, id: obj.id };
}

/** Slice an overfetched (limit + 1) result list and emit a next_cursor when
 *  the extra row was present. Paginating callers pass `limit + 1` to storage
 *  so a non-null cursor comes from the LAST kept row rather than the dropped
 *  overflow row. */
export function emitCursor(
  rows: CaptureEvent[],
  limitApplied: number,
): { kept: CaptureEvent[]; next_cursor: string | null } {
  if (rows.length > limitApplied) {
    const kept = rows.slice(0, limitApplied);
    const last = kept[kept.length - 1]!;
    return { kept, next_cursor: encodeCursor({ timestamp: last.timestamp, id: last.id }) };
  }
  return { kept: rows, next_cursor: null };
}
