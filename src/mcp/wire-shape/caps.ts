// Declarative caps for every wire-shape decision across the MCP retrieval
// tools (search_memories, get_recent_work_context, get_atoms, etc.).
// Single source of truth — every retrieval tool that surfaces atoms over the
// wire imports from here, so a future addition / tightening only needs to
// touch one number.
//
// Historical regression chain that motivated each cap is logged in
// raw/internal/dogfooding/mcp-interactions-journal.md (entries 13:27 PDT
// onward 2026-05-08).
//
// Cap values are chosen so 10 matches × match_content + 10 matches ×
// per-key-clipped metadata + envelope/marker overhead fits in the 25k
// consumer tool-result budget with headroom.
export const WIRE_SHAPE_CAPS = {
  /** Per-match `content` clip (search_memories, get_atoms). Surfaced by
   *  Bug A1 (2026-05-08 15:54 PDT) — single Codex turn JSONL is ~100KB;
   *  without this cap, three matches blew the budget by 12.7×. 1KB head +
   *  1KB tail leaves room for marker + envelope. */
  match_content: 2_000,

  /** Per-metadata-VALUE clip (search_memories, get_atoms). Surfaced by
   *  Bug A2 (2026-05-08 16:14 PDT) — codex extractor stores raw tool_calls
   *  payloads in metadata at 120-130KB per atom, so Bug A1's content cap
   *  alone left envelopes at 305k. Capping per-key (not per total
   *  metadata) lets small structured fields (git_state, session_id,
   *  byte_offset) pass through verbatim while large variadic ones
   *  (tool_calls, files_referenced, thinking) get clipped. */
  metadata_value: 1_000,

  /** Total serialized metadata retained on one projected atom. Per-value
   *  clipping alone is insufficient when an adapter emits thousands of
   *  individually-small keys. The key count is bounded independently so
   *  object traversal and trust-signal arrays stay predictable. */
  metadata_total: 4_000,
  metadata_keys: 32,

  /** Minimal-mode `action.input` / `action.output` clip
   *  (get_recent_work_context). Pre-existing as `MINIMAL_CONTENT_CAP` from
   *  item 025; surfaced here so all three tools share one caps table. */
  minimal_action: 500,

  /** Skeleton-mode `action.summary` head-clip (get_recent_work_context).
   *  Pre-existing as `SKELETON_SUMMARY_CAP` from item 028; surfaced here
   *  so all skeleton-shape decisions live in one place. */
  skeleton_summary: 200,
} as const;
