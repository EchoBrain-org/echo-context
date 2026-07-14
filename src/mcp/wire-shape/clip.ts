// Shared clipping helpers for the wire-shape projectors. Two operations:
//
//  - clipString: head + elision-marker + tail; returns the byte count that
//    was dropped. Used wherever a single string field needs to be capped
//    (atom content, action.input/output, future extensions).
//
//  - clipMetadataValues: per-KEY clip for metadata. Iterates the
//    metadata-bag entries and replaces any single value whose serialized
//    form exceeds the cap with `{__elided: true, original_size: N}`.
//    Tracks total bytes dropped + which keys were touched. Surfaced by
//    Bug A2 (2026-05-08 16:14 PDT): the codex extractor's `tool_calls`
//    array is the dominant byte source on heavy turns, but small
//    structured neighbours (git_state, session_id) should pass through
//    verbatim — per-key beats total-metadata for that reason.

/** Standard elision marker. Recognisable to both human and programmatic
 *  readers; the `bytes_elided` field on the projected shape is the
 *  canonical machine reading. */
function marker(elidedChars: number): string {
  return `\n…[${elidedChars} chars elided]…\n`;
}

export interface ClipResult {
  value: string;
  /** Original bytes dropped. Zero when the input was within the cap. */
  bytes_elided: number;
}

/** Head + tail clip with explicit elision marker. Returns the original
 *  string verbatim when within the cap (no marker, bytes_elided=0). */
export function clipString(s: string, cap: number): ClipResult {
  if (s.length <= cap) return { value: s, bytes_elided: 0 };
  const headChars = Math.floor(cap / 2);
  const tailChars = cap - headChars;
  const head = s.slice(0, headChars);
  const tail = s.slice(s.length - tailChars);
  const bytes_elided = s.length - headChars - tailChars;
  return { value: head + marker(bytes_elided) + tail, bytes_elided };
}

export interface ClippedMetadata {
  metadata: Record<string, unknown>;
  /** Sum of per-key bytes dropped (after subtracting the placeholder size). */
  bytes_elided: number;
  /** Names of keys whose values exceeded the cap and were replaced. */
  keys_elided: string[];
}

/** Per-key clip: any metadata value whose JSON-stringified form exceeds the
 *  cap is replaced by `{__elided: true, original_size: N}`. Tracks total
 *  bytes dropped + which keys were touched so consumers can hydrate via a
 *  follow-up call if needed. Values that fail to serialize (functions,
 *  cycles) are dropped quietly — they should not reach this layer in
 *  practice but the projector is the wrong place to throw. */
export function clipMetadataValues(
  metadata: Record<string, unknown> | undefined,
  cap: number,
): ClippedMetadata {
  if (metadata === undefined) return { metadata: {}, bytes_elided: 0, keys_elided: [] };
  const out: Record<string, unknown> = {};
  let total_elided = 0;
  const keys_elided: string[] = [];
  for (const [k, v] of Object.entries(metadata)) {
    const serialized = JSON.stringify(v);
    if (serialized === undefined) continue;
    if (serialized.length <= cap) {
      out[k] = v;
      continue;
    }
    const placeholder = { __elided: true, original_size: serialized.length };
    out[k] = placeholder;
    const placeholderSize = JSON.stringify(placeholder).length;
    total_elided += serialized.length - placeholderSize;
    keys_elided.push(k);
  }
  return { metadata: out, bytes_elided: total_elided, keys_elided };
}
