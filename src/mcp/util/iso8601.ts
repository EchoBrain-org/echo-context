// Shared ISO-8601 timezone-marker check for the MCP retrieval tools.
//
// Originally lived in `src/mcp/tools/recent-work-context.ts` (exported as
// `hasTzMarker`), where it backed a single warning emitted when a caller
// passed a TZ-less ISO string. Lifted here so `search_memories` (and any
// future since/until-bearing tool) emits the same warning under the same
// rule. Surfaced by Gap 6 of the 2026-05-08 17:01 PDT v1.5-livetest:
// `search_memories` accepted `2026-05-06T00:00:00` (no Z) silently while
// `get_recent_work_context` warned. Inconsistent contract per tool is a
// foot-gun for clients on a non-UTC machine — the founder is PDT, so
// silent local-time parse drops or expands the window by 7 hours.

import { z } from 'zod';

// Accepts all four legal ISO 8601 TZ forms: Z, ±HH:MM, ±HHMM, ±HH.
const TZ_MARKER_RE = /Z$|[+-]\d{2}(?::?\d{2})?$/;

export function hasTzMarker(s: string): boolean {
  return TZ_MARKER_RE.test(s);
}

/** Returns the canonical warning string when an ISO timestamp lacks a TZ
 *  marker. Tools call this after schema validation but before the storage
 *  query, and push the result into their `warnings` array. Single string
 *  literal so consumers can grep for it across a multi-tool trace.
 *
 *  V1.5.7 polish (2026-05-09): prefixed with `[TZ]` so the warning is
 *  visually distinguishable from truncation/cap warnings when a busy
 *  response stacks several into `warnings[]`. The morning's resume call
 *  surfaced 3 warnings simultaneously (limit-dropped-clusters,
 *  storage-cap-hit, TZ-naive) and the TZ one was easy to miss. */
export const TZ_NAIVE_WARNING =
  '[TZ] input.since or input.until lacks a TZ specifier and was parsed as ' +
  'local time; pass an explicit Z or +HH:MM to avoid ambiguity';

// Basic ISO 8601 structural check: YYYY-MM-DDTHH:MM:SS(.sss)?(Z|±HH:MM)?
// Intentionally permissive on the TZ marker — `hasTzMarker` runs after
// schema validation to surface the TZ-naive warning rather than reject.
export const ISO8601_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;

export const isoString = z
  .string()
  .regex(ISO8601_RE, 'expected ISO 8601 timestamp like 2026-04-30T12:00:00.000Z');

// B3 (0.1.0-beta.5 audit): `wait_for_new_turns` requires the offset instead
// of warning. Its documented `since = next_since` feed-back loop turns a
// single local-time misparse into a future watermark that hides every new
// turn on all subsequent calls, so that one tool fails closed at the schema
// boundary; the sibling tools keep the permissive pattern + [TZ] warning.
// Same four TZ forms as `hasTzMarker`: Z, ±HH:MM, ±HHMM, ±HH.
export const ISO8601_TZ_REQUIRED_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}(?::?\d{2})?)$/;

export const isoStringWithOffset = z
  .string()
  .regex(
    ISO8601_TZ_REQUIRED_RE,
    'expected ISO 8601 timestamp with an explicit offset like 2026-04-30T12:00:00.000Z or 2026-04-30T05:00:00-07:00',
  );
