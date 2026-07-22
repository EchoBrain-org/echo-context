// Single wire-shape projection point for the atom-shape MCP retrieval
// tools (search_memories, get_atoms). Callers go through `projectMatch` so
// that adding a new cap, a new elided field, or a new metadata convention
// touches one file. Closes Bug A1, Bug A2, and the content-cap reach-gap
// surfaced 2026-05-08.
//
// Why a separate projector for matches (vs the cluster-shape projector
// inside recent-work-context.ts): the trace tool returns
// NormalizedContextEvent atoms (post-`normalizeEvent`) inside cluster
// envelopes; the atom-shape tools return raw CaptureEvent rows directly.
// Different shapes, different surface area, different lifecycle stage.
// Sharing a caps table (./caps.ts) is the right unit of reuse; sharing a
// projector function is not.

import type { CaptureEvent } from '../../storage/interface.js';
import { WIRE_SHAPE_CAPS } from './caps.js';
import { clipMetadataValues, clipString } from './clip.js';
import { projectToolCallsTrajectory } from './tool-calls.js';

export interface ProjectedMatch {
  id: string;
  source: string;
  timestamp: string;
  /** Capped at WIRE_SHAPE_CAPS.match_content. When clipped, the format is
   *  head + elision marker + tail; `bytes_elided` carries the dropped count. */
  content: string;
  /** Set only when `content` was clipped. Original size reconstruction:
   *  retained-content-bytes - marker-bytes + bytes_elided. */
  bytes_elided?: number;
  /** Per-key clipped: any individual metadata value whose JSON-stringified
   *  form exceeds WIRE_SHAPE_CAPS.metadata_value is replaced by
   *  `{__elided: true, original_size: N}`. Other keys pass through verbatim.
   *  Specialised projection: `metadata.tool_calls` is reshaped to a
   *  string array (the workflow trajectory) by V1.5.6.1 — see
   *  `tool-calls.ts`. The reshape is signalled via
   *  `metadata_keys_projected` (NOT `metadata_keys_elided`); a sibling
   *  `metadata.tool_calls_by_name` count map is added when present. */
  metadata?: Record<string, unknown>;
  /** Sum of bytes dropped across (a) per-key elision placeholders and
   *  (b) specialised projections like tool_calls trajectory. Surfaced as
   *  one number because consumers care about "how much context did I
   *  lose?" — distinguishing elision-style vs projection-style modifies
   *  is for the keys_elided / keys_projected fields. */
  metadata_bytes_elided?: number;
  /** Keys whose value was REPLACED by `{__elided:true, original_size:N}`
   *  because their serialized form exceeded the per-key cap. The original
   *  shape is opaque on a projected response — consumers wanting to drill
   *  in must hydrate via a follow-up call (V1.6 `get_atom` tool). */
  metadata_keys_elided?: string[];
  /** Number of metadata keys omitted by the bounded whole-object projection.
   *  Names are intentionally not enumerated so the signal stays bounded. */
  metadata_keys_omitted?: number;
  /** Keys whose value was RESHAPED to a smaller useful representation
   *  (not opaqued out). Today this is `["tool_calls"]` when the original
   *  array was projected to its name trajectory. The consumer can read
   *  the projected value at face value (e.g., the trajectory array is
   *  legitimate data, not a placeholder). */
  metadata_keys_projected?: string[];
  /** V1.6 (item 030) — additive trust signal that unifies BOTH per-field
   *  caps AND projector reshapes in one place. Always present (possibly
   *  empty `[]` when nothing was clipped or reshaped) so consumers can do
   *  `m.truncations.length === 0` without optional-chaining.
   *
   *  Vocabulary:
   *    - `"content"` — content body was clipped to `match_content` cap.
   *    - `"metadata.<key>"` — per-key byte cap fired on `<key>`; the value
   *      is opaqued out (`{__elided:true, original_size:N}`). LOSSY.
   *    - `"metadata.<key>:projected"` — projector reshaped `<key>` to a
   *      smaller useful representation (e.g. tool_calls → trajectory). The
   *      value is REFORMATTED, not clipped — semantically distinct from a
   *      cap. Consumer needing the original raw value reads the source
   *      file. (Today only `tool_calls` is projected; new projectors
   *      add new `:projected` markers.)
   *
   *  The legacy `bytes_elided` / `metadata_keys_elided` /
   *  `metadata_keys_projected` fields stay for back-compat; `truncations`
   *  is additive AND distinguishes "this got clipped" from "this got
   *  rewritten by a known projector with a documented schema." */
  truncations: string[];
}

/** Project a raw CaptureEvent (storage row) onto the consumer-budget-safe
 *  wire shape. Caller-agnostic: every atom-shape retrieval tool calls this
 *  to enforce the same envelope discipline. */
export function projectMatch(e: CaptureEvent): ProjectedMatch {
  const content = clipString(e.content, WIRE_SHAPE_CAPS.match_content);
  const truncations: string[] = [];
  const m: ProjectedMatch = {
    id: e.id,
    source: e.source,
    timestamp: e.timestamp,
    content: content.value,
    // Filled in below; kept always-present (possibly []) so consumers can
    // do `m.truncations.length === 0` without optional-chaining.
    truncations,
  };
  if (content.bytes_elided > 0) {
    m.bytes_elided = content.bytes_elided;
    truncations.push('content');
  }
  if (e.metadata !== undefined) {
    // Step 1: specialised pre-projection. tool_calls (and any future
    // shape-aware projections) get a useful summary instead of being
    // opaqued out by the standard per-key cap. Run BEFORE
    // clipMetadataValues so the reshaped value is what the cap sees.
    const preprocessed: Record<string, unknown> = { ...e.metadata };
    let projectedBytes = 0;
    const projectedKeys: string[] = [];

    const tcRaw = preprocessed['tool_calls'];
    if (tcRaw !== undefined) {
      const tcProj = projectToolCallsTrajectory(tcRaw);
      if (tcProj !== null && tcProj.bytes_elided > 0) {
        preprocessed['tool_calls'] = tcProj.trajectory;
        // Sibling histogram for aggregate views — only when there are
        // calls to count, to avoid noise on empty/missing turns.
        if (Object.keys(tcProj.by_name).length > 0) {
          preprocessed['tool_calls_by_name'] = tcProj.by_name;
        }
        projectedBytes += tcProj.bytes_elided;
        projectedKeys.push('tool_calls');
      }
    }

    // Step 2: standard per-key cap on what remains. Small values pass
    // verbatim; oversize values get the {__elided:true} placeholder.
    const md = clipMetadataValues(
      preprocessed,
      WIRE_SHAPE_CAPS.metadata_value,
      WIRE_SHAPE_CAPS.metadata_total,
      WIRE_SHAPE_CAPS.metadata_keys,
    );
    m.metadata = md.metadata;

    const totalElided = projectedBytes + md.bytes_elided;
    if (totalElided > 0) m.metadata_bytes_elided = totalElided;
    if (md.keys_elided.length > 0) m.metadata_keys_elided = md.keys_elided;
    if (md.keys_omitted > 0) m.metadata_keys_omitted = md.keys_omitted;
    const retainedProjectedKeys = projectedKeys.filter((key) =>
      Object.prototype.hasOwnProperty.call(md.metadata, key),
    );
    if (retainedProjectedKeys.length > 0) m.metadata_keys_projected = retainedProjectedKeys;

    // V1.6 truncations vocabulary: emit one entry per per-key event.
    // Cap-elision keys are LOSSY (`metadata.<k>`); projector keys are
    // REFORMATTED (`metadata.<k>:projected`). Distinct so consumers can
    // tell "the body got clipped" from "the body got rewritten by a
    // known projector with a documented schema."
    for (const k of md.keys_elided) truncations.push(`metadata.${k}`);
    if (md.keys_omitted > 0) truncations.push('metadata');
    for (const k of retainedProjectedKeys) truncations.push(`metadata.${k}:projected`);
  }
  return m;
}
