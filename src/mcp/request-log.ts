import { renameSync, unlinkSync, writeFileSync } from 'node:fs';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

// 067 — Graceful-shutdown forensic artifact contract.
//
// `flushRecentMcpCallLog(path, now?)` writes the current ring snapshot as
// JSONL to `path` during daemon shutdown, rewriting any still-`pending`
// entry in place to `killed_during_shutdown` with `duration_ms` measured
// from the entry's `ts` to the flush time. The write is atomic via
// tmp-then-rename (POSIX `rename(2)`): a consumer reading the path sees
// either the prior complete file or the new complete file, never a
// truncated mid-write artifact.
//
// Accepted contract gap: non-graceful death (SIGKILL, OOM, panic before
// the hook runs, host power loss) provides no execution window for the
// flush, so the dying ring is lost. A write-on-every-call shadow log is
// the only mechanism that could close that gap; deferred until ops
// evidence justifies the latency and surface area.

export type RecentMcpCallStatus = 'pending' | 'ok' | 'error' | 'killed_during_shutdown';

export interface RecentMcpCall {
  ts: number;
  tool: string;
  args_shape: Record<string, unknown>;
  result_shape: Record<string, unknown>;
  duration_ms: number | null;
  status: RecentMcpCallStatus;
}

export interface RecentMcpCallFilters {
  since?: number;
  until?: number;
  status?: RecentMcpCallStatus;
}

interface MutableRecentMcpCall extends RecentMcpCall {
  id: number;
}

interface ToolResultLike {
  content?: { type?: string; text?: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

const MAX_CALLS = 1000;

let nextCallId = 1;
const calls: MutableRecentMcpCall[] = [];

export function instrumentMcpServer(server: McpServer): void {
  const target = server as unknown as {
    registerTool: (
      name: string,
      config: unknown,
      cb: (...args: unknown[]) => CallToolResult | Promise<CallToolResult>,
    ) => unknown;
  };
  const originalRegisterTool = target.registerTool.bind(target);

  target.registerTool = (
    name: string,
    config: unknown,
    cb: (...args: unknown[]) => CallToolResult | Promise<CallToolResult>,
  ): unknown =>
    originalRegisterTool(name, config, async (...callbackArgs: unknown[]) => {
      const callId = beginRecentMcpCall(name, callbackArgs[0]);
      try {
        const result = await cb(...callbackArgs);
        finishRecentMcpCall(callId, name, result);
        return result;
      } catch (err) {
        failRecentMcpCall(callId, name, err);
        throw err;
      }
    });
}

export function beginRecentMcpCall(tool: string, args: unknown, now = Date.now()): number {
  const id = nextCallId++;
  calls.push({
    id,
    ts: now,
    tool,
    args_shape: projectArgs(tool, args),
    result_shape: {},
    duration_ms: null,
    status: 'pending',
  });
  while (calls.length > MAX_CALLS) calls.shift();
  return id;
}

export function finishRecentMcpCall(
  id: number,
  tool: string,
  result: unknown,
  now = Date.now(),
): void {
  const entry = calls.find((call) => call.id === id);
  if (entry === undefined) return;
  const status: RecentMcpCallStatus = isToolErrorEnvelope(result) ? 'error' : 'ok';
  entry.status = status;
  entry.duration_ms = Math.max(0, now - entry.ts);
  entry.result_shape =
    status === 'error'
      ? projectErrorResult(result)
      : projectResult(tool, result);
}

export function failRecentMcpCall(id: number, tool: string, err: unknown, now = Date.now()): void {
  const entry = calls.find((call) => call.id === id);
  if (entry === undefined) return;
  entry.status = 'error';
  entry.duration_ms = Math.max(0, now - entry.ts);
  entry.result_shape = projectThrownError(err);
  void tool;
}

export function readRecentMcpCalls(filters: RecentMcpCallFilters = {}): RecentMcpCall[] {
  const since = filters.since ?? 0;
  const until = filters.until ?? Number.POSITIVE_INFINITY;
  return calls
    .filter((entry) => entry.ts >= since)
    .filter((entry) => entry.ts <= until)
    .filter((entry) => filters.status === undefined || entry.status === filters.status)
    .map(publicClone);
}

export function resetRecentMcpCallLogForTests(): void {
  calls.length = 0;
  nextCallId = 1;
}

export function flushRecentMcpCallLog(path: string, now = Date.now()): void {
  for (const entry of calls) {
    if (entry.status !== 'pending') continue;
    entry.status = 'killed_during_shutdown';
    entry.duration_ms = Math.max(0, now - entry.ts);
  }
  const body =
    calls.length === 0
      ? ''
      : calls.map((entry) => JSON.stringify(publicClone(entry))).join('\n') + '\n';
  // writeFileSync is intentional: shutdown may drain the event loop the
  // instant the hook returns, so an async write could be aborted mid-flight.
  // Atomicity is via tmp-then-rename: POSIX rename(2) is atomic, so any
  // consumer reading `path` sees either the prior complete file or the new
  // complete file, never a truncated mid-write artifact.
  const tmp = path + '.tmp';
  try {
    writeFileSync(tmp, body);
    renameSync(tmp, path);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      // Best-effort cleanup: leaking the tmp file is acceptable, destroying
      // the prior breadcrumb is not. ENOENT here is expected when the
      // failure happened before tmp was created.
    }
    throw err;
  }
}

function publicClone(entry: MutableRecentMcpCall): RecentMcpCall {
  return {
    ts: entry.ts,
    tool: entry.tool,
    args_shape: cloneShape(entry.args_shape),
    result_shape: cloneShape(entry.result_shape),
    duration_ms: entry.duration_ms,
    status: entry.status,
  };
}

function cloneShape(shape: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(JSON.stringify(shape)) as Record<string, unknown>;
}

function projectArgs(tool: string, args: unknown): Record<string, unknown> {
  const obj = objectOrEmpty(args);
  const base: Record<string, unknown> = { arg_keys: Object.keys(obj).sort() };

  switch (tool) {
    case 'search_memories':
      return {
        ...base,
        query_length: stringLength(obj['query']),
        source_app: stringValue(obj['source_app']),
        source_present: isPresent(obj['source']),
        source_prefix_present: isPresent(obj['source_prefix']),
        since: stringValue(obj['since']),
        until: stringValue(obj['until']),
        limit: numberValue(obj['limit']),
        cursor_present: isPresent(obj['cursor']),
        repo_path_present: isPresent(obj['repo_path']),
        metadata_match_key_count: keyCount(obj['metadata_match']),
      };
    case 'find_clusters':
      return {
        ...base,
        since: stringValue(obj['since']),
        until: stringValue(obj['until']),
        window_hours: numberValue(obj['window_hours']),
        format: stringValue(obj['format']),
        repo_path_present: isPresent(obj['repo_path']),
        group_by: stringValue(obj['group_by']),
        page_size: numberValue(obj['page_size']),
        representative_limit: numberValue(obj['representative_limit']),
        cursor_present: isPresent(obj['cursor']),
      };
    case 'get_atoms':
      return {
        ...base,
        atom_ids_count: arrayLength(obj['atom_ids']),
        fields_count: arrayLength(obj['fields']),
        format: stringValue(obj['format']),
        prefer: stringValue(obj['prefer']),
        cursor_present: isPresent(obj['cursor']),
      };
    case 'get_atom':
      return { ...base, id_present: isPresent(obj['id']) };
    case 'echo_ping':
      return { ...base, message_length: stringLength(obj['message']) };
    case 'wait_for_new_turns':
      return {
        ...base,
        sources_count: arrayLength(obj['sources']),
        source_prefix_present: isPresent(obj['source_prefix']),
        since: stringValue(obj['since']),
        timeout: numberValue(obj['timeout']),
        repo_path_present: isPresent(obj['repo_path']),
      };
    case 'echo_resolve_mru':
      return {
        ...base,
        sources_count: arrayLength(obj['sources']),
        repo_path_present: isPresent(obj['repo_path']),
      };
    case 'get_role_state':
      return {
        ...base,
        task_id_present: isPresent(obj['task_id']),
        role: stringValue(obj['role']),
        ref_present: isPresent(obj['ref']),
      };
    case 'list_task_states':
      return {
        ...base,
        role: stringValue(obj['role']),
        binding_present: isPresent(obj['binding']),
        stage: stringValue(obj['stage']),
        ref_present: isPresent(obj['ref']),
      };
    case 'coord_emit':
      return {
        ...base,
        event_type: stringValue(obj['event_type']),
        schema_version: numberValue(obj['schema_version']),
        subject_role: stringValue(obj['subject_role']),
        correlation_id_present: isPresent(obj['correlation_id']),
        tick_run_id_present: isPresent(obj['tick_run_id']),
        expected_by_present: isPresent(obj['expected_by']),
        payload_key_count: keyCount(obj['payload']),
      };
    case 'coord_status':
      return base;
    case 'coord_invoke':
      return {
        ...base,
        role: stringValue(obj['role']),
        request_path_present: isPresent(obj['request_path']),
        correlation_id_present: isPresent(obj['correlation_id']),
      };
    default:
      return base;
  }
}

function projectResult(tool: string, result: unknown): Record<string, unknown> {
  const envelope = result as ToolResultLike | undefined;
  const structured = objectOrEmpty(envelope?.structuredContent ?? parseTextJson(envelope));
  const contentTextLength = contentTextLengthOf(result);

  switch (tool) {
    case 'search_memories':
      return {
        result_type: 'search_memories',
        match_count: arrayLength(structured['matches']),
        total_returned: numberValue(structured['total_returned']),
        limit_applied: numberValue(structured['limit_applied']),
        warnings_count: arrayLength(structured['warnings']),
        next_cursor_present: isPresent(structured['next_cursor']),
        content_text_length: contentTextLength,
      };
    case 'find_clusters':
      return {
        result_type: 'find_clusters',
        cluster_count: arrayLength(structured['clusters']),
        group_count: arrayLength(structured['groups']),
        atom_id_count: nestedArrayTotal(structured['clusters'], 'atom_ids'),
        representative_atom_id_count: nestedArrayTotal(
          structured['groups'],
          'representative_atom_ids',
        ),
        member_atom_id_count: arrayLength(
          objectOrEmpty(structured['membership_page'])['atom_ids'],
        ),
        next_cursor_present: isPresent(structured['next_cursor']),
        warnings_count: arrayLength(structured['warnings']),
        content_text_length: contentTextLength,
      };
    case 'get_atoms':
      return {
        result_type: 'get_atoms',
        atom_count: arrayLength(structured['atoms']),
        atoms_dropped: numberValue(structured['atoms_dropped']),
        atoms_missing: numberValue(structured['atoms_missing']),
        atoms_deferred: numberValue(structured['atoms_deferred']),
        atom_ids_count: arrayLength(structured['atoms_dropped_ids']),
        next_cursor_present: isPresent(structured['next_cursor']),
        warnings_count: arrayLength(structured['warnings']),
        content_text_length: contentTextLength,
      };
    case 'get_atom':
      return {
        result_type: 'get_atom',
        atom_present: isPresent(structured['atom']),
        atom_size_bytes: numberValue(structured['atom_size_bytes']),
        error_code: stringValue(structured['error_code']),
        warnings_count: arrayLength(structured['warnings']),
        content_text_length: contentTextLength,
      };
    case 'echo_ping':
      return {
        result_type: 'echo_ping',
        pong_present: isPresent(structured['pong']),
        received_present: isPresent(structured['received']),
        content_text_length: contentTextLength,
      };
    case 'wait_for_new_turns':
      return {
        result_type: 'wait_for_new_turns',
        atom_ids_count: arrayLength(structured['turn_ids']),
        timed_out: booleanValue(structured['timed_out']),
        warnings_count: arrayLength(structured['warnings']),
        content_text_length: contentTextLength,
      };
    case 'echo_resolve_mru':
      return {
        result_type: 'echo_resolve_mru',
        source_count: objectKeyCount(structured['sources']),
        repo_path_present: isPresent(structured['repo_path']),
        warnings_count: arrayLength(structured['warnings']),
        content_text_length: contentTextLength,
      };
    case 'get_role_state':
      return {
        result_type: 'get_role_state',
        content_text_length: stringLength(structured['content']),
        source_path_present: isPresent(structured['source_path']),
        line_count: numberValue(structured['line_count']),
        ref_present: isPresent(structured['ref']),
      };
    case 'list_task_states':
      return {
        result_type: 'list_task_states',
        task_state_count: arrayLength(structured['task_states']),
        ref_present: isPresent(structured['ref']),
        content_text_length: contentTextLength,
      };
    case 'coord_emit':
      return {
        result_type: 'coord_emit',
        atom_id_present: isPresent(structured['atom_id']),
        content_text_length: contentTextLength,
      };
    case 'coord_status':
      return {
        result_type: 'coord_status',
        role_count: objectKeyCount(structured['roles']),
        open_deadline_count: arrayLength(structured['open_deadlines']),
        content_text_length: contentTextLength,
      };
    case 'coord_invoke':
      return {
        result_type: 'coord_invoke',
        reviewer_invoked_id_present: isPresent(structured['reviewer_invoked_id']),
        wrapper_path_present: isPresent(structured['wrapper_path']),
        content_text_length: contentTextLength,
      };
    default:
      return {
        result_type: 'mcp_tool_result',
        content_text_length: contentTextLength,
        structured_key_count: Object.keys(structured).length,
      };
  }
}

function projectErrorResult(result: unknown): Record<string, unknown> {
  return {
    is_error: true,
    content_text_length: contentTextLengthOf(result),
  };
}

function projectThrownError(err: unknown): Record<string, unknown> {
  const message = err instanceof Error ? err.message : String(err);
  return {
    is_error: true,
    content_text_length: message.length,
  };
}

function isToolErrorEnvelope(result: unknown): boolean {
  return objectOrEmpty(result)['isError'] === true;
}

function parseTextJson(envelope: ToolResultLike | undefined): unknown {
  const text = envelope?.content?.find((entry) => entry.type === 'text')?.text;
  if (text === undefined) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function objectOrEmpty(value: unknown): Record<string, unknown> {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function booleanValue(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

function numberValue(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function stringLength(value: unknown): number | null {
  return typeof value === 'string' ? value.length : null;
}

function arrayLength(value: unknown): number | null {
  return Array.isArray(value) ? value.length : null;
}

function keyCount(value: unknown): number | null {
  return objectKeyCount(value);
}

function objectKeyCount(value: unknown): number | null {
  const obj = objectOrEmpty(value);
  return Object.keys(obj).length;
}

function nestedArrayTotal(value: unknown, key: string): number | null {
  if (!Array.isArray(value)) return null;
  let count = 0;
  for (const item of value) {
    const arr = objectOrEmpty(item)[key];
    if (Array.isArray(arr)) count += arr.length;
  }
  return count;
}

function isPresent(value: unknown): boolean {
  return value !== undefined && value !== null;
}

function contentTextLengthOf(result: unknown): number {
  const envelope = result as ToolResultLike | undefined;
  const content = envelope?.content;
  if (!Array.isArray(content)) return 0;
  return content.reduce((sum, entry) => {
    if (entry.type !== 'text' || typeof entry.text !== 'string') return sum;
    return sum + entry.text.length;
  }, 0);
}
