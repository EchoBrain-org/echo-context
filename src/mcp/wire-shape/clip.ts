// Shared clipping helpers for the wire-shape projectors. Two operations:
//
//  - clipString: head + elision-marker + tail; returns the byte count that
//    was dropped. Used wherever a single string field needs to be capped
//    (atom content, action.input/output, future extensions).
//
//  - clipMetadataValues: per-KEY and whole-object caps for metadata. It
//    replaces an oversized value with `{__elided: true, original_size: N}`,
//    then retains a deterministic bounded key set. Tracks bytes dropped and
//    aggregate omitted-key count. Surfaced by
//    Bug A2 (2026-05-08 16:14 PDT): the codex extractor's `tool_calls`
//    array is the dominant byte source on heavy turns, but small
//    structured neighbours (git_state, session_id) should pass through
//    verbatim — per-key beats total-metadata for that reason.

import { jsonByteLength, utf8ByteLength } from './bytes.js';

const METADATA_PRIORITY = new Map(
  [
    'surface',
    'session_id',
    'repo_root',
    'cwd',
    'turn_index',
    'canonical_subject',
    'signal_type',
    'note_id',
    'files_referenced',
    'git_state',
    'model',
    'tool_calls',
    'tool_calls_by_name',
  ].map((key, index) => [key, index]),
);

function compareMetadataKeys(a: string, b: string): number {
  const aPriority = METADATA_PRIORITY.get(a) ?? Number.POSITIVE_INFINITY;
  const bPriority = METADATA_PRIORITY.get(b) ?? Number.POSITIVE_INFINITY;
  if (aPriority !== bPriority) return aPriority - bPriority;
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Standard elision marker. Recognisable to both human and programmatic
 *  readers; the `bytes_elided` field on the projected shape is the
 *  canonical machine reading. */
function marker(elidedBytes: number): string {
  return `\n…[${elidedBytes} bytes elided]…\n`;
}

export interface ClipResult {
  value: string;
  /** Original bytes dropped. Zero when the input was within the cap. */
  bytes_elided: number;
}

function takeUtf8Prefix(value: string, byteBudget: number): string {
  let used = 0;
  let out = '';
  for (const char of value) {
    const bytes = utf8ByteLength(char);
    if (used + bytes > byteBudget) break;
    out += char;
    used += bytes;
  }
  return out;
}

function takeUtf8Suffix(value: string, byteBudget: number): string {
  const chars = Array.from(value);
  let used = 0;
  let out = '';
  for (let i = chars.length - 1; i >= 0; i -= 1) {
    const char = chars[i]!;
    const bytes = utf8ByteLength(char);
    if (used + bytes > byteBudget) break;
    out = char + out;
    used += bytes;
  }
  return out;
}

/** Head + tail UTF-8 clip with an explicit elision marker. `cap` applies
 *  to retained source bytes; the small marker is additive. Code points are
 *  never split. Returns the original string verbatim when it fits. */
export function clipString(s: string, cap: number): ClipResult {
  const originalBytes = utf8ByteLength(s);
  if (originalBytes <= cap) return { value: s, bytes_elided: 0 };
  const head = takeUtf8Prefix(s, Math.floor(cap / 2));
  const tail = takeUtf8Suffix(s, cap - utf8ByteLength(head));
  const bytes_elided = originalBytes - utf8ByteLength(head) - utf8ByteLength(tail);
  return { value: head + marker(bytes_elided) + tail, bytes_elided };
}

export interface ClippedMetadata {
  metadata: Record<string, unknown>;
  /** Sum of per-key bytes dropped (after subtracting the placeholder size). */
  bytes_elided: number;
  /** Names of keys whose values exceeded the cap and were replaced. */
  keys_elided: string[];
  /** Number of keys omitted by the whole-object/key-count budget. Names are
   *  deliberately not returned: an omitted-name list could recreate the
   *  same unbounded response. */
  keys_omitted: number;
}

/** Per-key plus whole-object clip. Keys are considered lexicographically so
 *  the retained subset is deterministic even if adapter insertion order
 *  changes. Values that fail to serialize are counted as omitted. */
export function clipMetadataValues(
  metadata: Record<string, unknown> | undefined,
  valueCap: number,
  totalCap: number,
  keyCap: number,
): ClippedMetadata {
  if (metadata === undefined) {
    return { metadata: {}, bytes_elided: 0, keys_elided: [], keys_omitted: 0 };
  }
  const out: Record<string, unknown> = {};
  let total_elided = 0;
  const keys_elided: string[] = [];
  let keys_omitted = 0;
  for (const [k, v] of Object.entries(metadata).sort(([a], [b]) =>
    compareMetadataKeys(a, b),
  )) {
    const serialized = JSON.stringify(v);
    if (serialized === undefined) {
      keys_omitted += 1;
      continue;
    }
    const serializedBytes = utf8ByteLength(serialized);
    let projectedValue = v;
    let valueWasElided = false;
    if (serializedBytes > valueCap) {
      projectedValue = { __elided: true, original_size: serializedBytes };
      valueWasElided = true;
    }
    const projectedBytes = jsonByteLength({ [k]: projectedValue }) - 2;
    const candidate = { ...out, [k]: projectedValue };
    if (Object.keys(out).length >= keyCap || jsonByteLength(candidate) > totalCap) {
      keys_omitted += 1;
      total_elided += Math.max(0, jsonByteLength({ [k]: v }) - 2);
      continue;
    }
    out[k] = projectedValue;
    if (valueWasElided) {
      total_elided += Math.max(0, serializedBytes - projectedBytes);
      keys_elided.push(k);
    }
  }
  return { metadata: out, bytes_elided: total_elided, keys_elided, keys_omitted };
}
