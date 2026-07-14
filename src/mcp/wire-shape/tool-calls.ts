// V1.5.6.1 specialised projection for `metadata.tool_calls`.
//
// V1.5.6's per-key metadata cap replaced large `tool_calls` arrays
// (typically 100-130KB on heavy turns) with a `{__elided:true,
// original_size:N}` placeholder. Budget-safe but lossy: the consumer
// loses the workflow trajectory ("git_status → Read X → Edit Y → Bash
// test → git_commit"), which is the highest-signal compact summary an AI
// client can use to infer agent intent at surface-level retrieval time.
//
// This module restores the trajectory by projecting each tool_calls entry
// to just its `.name` field. 100 tool calls × ~15 chars per name = ~1.7KB,
// fits comfortably in the per-key cap. A `tool_calls_by_name` histogram
// is added as a sibling key for aggregate views ("47 Bash, 30 Read…").
//
// Shape contract (matches `src/capture/extractors/_turn_meta.ts:ToolCall`):
//   tool_calls: Array<{ name: string, args?, output?, call_id?, ... }>
// If the value doesn't match this shape (defensively: future schema
// changes, or values that slipped through some non-extractor capture
// path), this module returns null and the standard per-key cap handles it.

interface ToolCallLike {
  name: string;
}

function isToolCallLike(v: unknown): v is ToolCallLike {
  return (
    typeof v === 'object' &&
    v !== null &&
    'name' in v &&
    typeof (v as { name: unknown }).name === 'string'
  );
}

export interface ToolCallsTrajectoryProjection {
  /** Ordered name list — preserves the workflow trajectory at surface
   *  level. e.g. ["git_status","Read","Read","Edit","Bash","git_commit"]. */
  trajectory: string[];
  /** Aggregate count by tool name. e.g. {Bash: 47, Read: 30, Edit: 12}.
   *  Useful when the trajectory itself is too long to scan; the
   *  histogram answers "what was the agent mostly doing?". */
  by_name: Record<string, number>;
  /** Bytes dropped by projection (original serialized size minus the
   *  projected serialized size). Surfaced via the match's
   *  `metadata_bytes_elided` so the consumer can size the original. */
  bytes_elided: number;
  /** Original element count, preserved for consumers that want the
   *  exact number. Distinct from trajectory.length when projection
   *  succeeds (always equal today; reserved for future "trajectory =
   *  head + tail" extension if names lists ever exceed the cap). */
  original_count: number;
}

/** Project a `metadata.tool_calls` value to its trajectory + histogram.
 *  Returns null when the value doesn't match the expected shape — caller
 *  should fall back to the standard per-key cap. */
export function projectToolCallsTrajectory(
  value: unknown,
): ToolCallsTrajectoryProjection | null {
  if (!Array.isArray(value)) return null;
  if (value.length === 0) {
    // Empty array: emit an empty trajectory, NOT null. Keeps the wire
    // shape consistent so a consumer can always assume `tool_calls` is a
    // string array on a projected response.
    return { trajectory: [], by_name: {}, bytes_elided: 0, original_count: 0 };
  }
  // All entries must be name-bearing; if any entry is shape-foreign,
  // bail to standard handling rather than emitting a partial trajectory
  // that misleads the consumer about what was in the original.
  if (!value.every(isToolCallLike)) return null;

  const trajectory = value.map((tc) => tc.name);
  const by_name: Record<string, number> = {};
  for (const name of trajectory) {
    by_name[name] = (by_name[name] ?? 0) + 1;
  }
  const original_size = JSON.stringify(value).length;
  const projected_size = JSON.stringify(trajectory).length;
  return {
    trajectory,
    by_name,
    bytes_elided: original_size - projected_size,
    original_count: value.length,
  };
}
