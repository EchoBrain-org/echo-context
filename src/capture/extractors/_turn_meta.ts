// Shared metadata shapes for per-turn enrichment across extractors.
//
// These types are emitted into CaptureEvent.metadata under stable keys so
// downstream consumers (mcp-search-memories, render-trace, reasoning/causal)
// can treat CC and Codex turns the same.

export interface ToolCall {
  /** Tool name as the agent saw it (e.g. "Bash", "Read", "exec_command"). */
  name: string;
  /** Stringified, truncated JSON of the tool's input/arguments. */
  args?: string;
  /** Whether the args field was truncated. */
  args_truncated?: boolean;
  /** Stringified, truncated tool output. */
  output?: string;
  /** Whether the output field was truncated. */
  output_truncated?: boolean;
  /** True iff the tool reported failure (CC `is_error`, Codex non-zero exit). */
  is_error?: boolean;
  /** The tool-call linkage id from the underlying JSONL (CC `tool_use.id` /
   *  Codex `function_call.call_id`). Useful for cross-event joins. */
  call_id?: string;
}

export interface GitState {
  /** Current HEAD commit hash at the time this turn was processed by ECHO. */
  head_sha?: string;
  /** Branch ref name (`HEAD` if detached). */
  branch?: string;
  /** Repo remote (origin) URL captured at probe time, with URL userinfo stripped. */
  origin_url?: string;
  /** Number of files with uncommitted changes (porcelain count). */
  dirty_count?: number;
  /** When ECHO sampled `git`. May be later than the turn timestamp for
   *  historical / boot-scanned turns. Consumers decide whether to trust. */
  captured_at: string;
  /** True iff `captured_at - turn_timestamp` was within the freshness window
   *  (≤ 30s); only fresh samples should be treated as authoritative. */
  fresh: boolean;
}

const ARGS_LIMIT = 2_000;
const OUTPUT_LIMIT = 4_000;
const THINKING_LIMIT = 8_000;

export function truncate(s: string, limit: number): { value: string; truncated: boolean } {
  if (s.length <= limit) return { value: s, truncated: false };
  const dropped = s.length - limit;
  return {
    value: s.slice(0, limit) + `\n[…truncated; ${dropped} chars dropped]`,
    truncated: true,
  };
}

export function truncateArgs(s: string): { value: string; truncated: boolean } {
  return truncate(s, ARGS_LIMIT);
}

export function truncateOutput(s: string): { value: string; truncated: boolean } {
  return truncate(s, OUTPUT_LIMIT);
}

export function truncateThinking(s: string): { value: string; truncated: boolean } {
  return truncate(s, THINKING_LIMIT);
}

export const MAX_TOOL_CALLS_PER_TURN = 50;

/** Tool-input keys whose values are file paths. Used to surface
 *  metadata.files_referenced from CC's tool_use.input and to drive
 *  cross-source file-touch matching in src/reasoning/causal.ts. */
export const FILE_INPUT_KEYS = ['file_path', 'path', 'notebook_path'] as const;

/** Regex that pulls file-path-style values out of a stringified args blob.
 *  Mirrors FILE_INPUT_KEYS so the two stay in lock-step. */
export const FILE_INPUT_REGEX = new RegExp(
  `"(?:${FILE_INPUT_KEYS.join('|')})"\\s*:\\s*"([^"]+)"`,
  'g',
);

/** Build a ToolCall with consistent truncation flags applied to args/output.
 *  Both extractors call this rather than rolling their own truncation. */
export function buildToolCall(opts: {
  name: string;
  call_id?: string;
  argsRaw?: string;
  outputRaw?: string;
  is_error?: boolean;
}): ToolCall {
  const tc: ToolCall = { name: opts.name };
  if (opts.call_id !== undefined) tc.call_id = opts.call_id;
  if (opts.argsRaw !== undefined) {
    const t = truncateArgs(opts.argsRaw);
    tc.args = t.value;
    if (t.truncated) tc.args_truncated = true;
  }
  if (opts.outputRaw !== undefined) {
    const t = truncateOutput(opts.outputRaw);
    tc.output = t.value;
    if (t.truncated) tc.output_truncated = true;
  }
  if (opts.is_error === true) tc.is_error = true;
  return tc;
}
