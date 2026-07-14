import { homedir } from 'node:os';
import { basename, dirname } from 'node:path';
import { isNonEmptyString } from '../../guards.js';
import { createLogger } from '../../logging/index.js';
import type { Storage } from '../../storage/interface.js';
import { probeGitState, readBranch } from '../git-state.js';
import { processCandidate } from '../pipeline.js';
import { resolveCanonicalRoot } from '../workspace-root.js';
import {
  dedupStrings,
  readJsonlTail,
  wireJsonlExtractor,
  type ExtractorHandle,
} from './_shared.js';
import {
  buildToolCall,
  FILE_INPUT_KEYS,
  MAX_TOOL_CALLS_PER_TURN,
  truncateThinking,
  type GitState,
  type ToolCall,
} from './_turn_meta.js';

const log = createLogger('capture.claude-code');

const HOME = homedir();
const DEFAULT_PROJECTS_PREFIX = `${HOME}/.claude/projects/`;

export interface ClaudeCodeTurn {
  project: string;
  session_id: string;
  turn_index: number;
  user_message: string;
  assistant_message: string;
  mtime: number;
  timestamp: string;
  had_tool_use: boolean;
  byte_offset: number;
  repo_root?: string;
  files_referenced?: string[];
  tool_calls?: ToolCall[];
  /** Total raw tool_use blocks observed in the cluster, before any truncation
   *  to MAX_TOOL_CALLS_PER_TURN. Lets consumers detect overflow without re-
   *  parsing the JSONL. Omitted when zero. */
  tool_call_total?: number;
  /** True iff total > MAX_TOOL_CALLS_PER_TURN and tool_calls was truncated. */
  tool_calls_truncated?: boolean;
  thinking?: string;
  git_state?: GitState;
  /** Branch as the CC client recorded it on the JSONL line itself (per-turn,
   *  written at turn time). Authoritative — strictly better than reading
   *  .git/HEAD at extraction time. */
  git_branch_jsonl?: string;
  /** CC session permissionMode (e.g. "auto", "default"). Sourced from the
   *  user line's top-level field. */
  permission_mode?: string;
  /** Claude Code CLI version (e.g. "2.1.119"). */
  cli_version?: string;
  /** Model id from the assistant message (e.g. "claude-opus-4-7"). */
  model?: string;
}

/** A text-bearing user line that was discarded because a later user line
 *  arrived before any assistant reply. Surfaced to the dispatcher so it can
 *  warn once per byte_offset (instead of every JSONL re-read). */
export interface DroppedUserLine {
  /** Byte offset of the start of the dropped line within the JSONL. Used as
   *  the dedup key — re-reads observe the same offset and must not re-warn. */
  byte_offset: number;
  /** First ~120 chars of the dropped user text, for diagnosis. */
  preview: string;
  /** `inject` = system reminder / slash-command marker / local-command echo
   *  (high-volume noise; logged at debug). `prompt` = anything else, treated
   *  as a possibly-real user message that never got an assistant reply. */
  classification: 'inject' | 'prompt';
  timestamp?: string;
}

export interface ExtractClaudeCodeResult {
  turns: ClaudeCodeTurn[];
  newOffset: number;
  droppedUsers: DroppedUserLine[];
}

const INJECT_TAG_PREFIXES = [
  '<system-reminder>',
  '<command-name>',
  '<command-message>',
  '<command-args>',
  '<command-stdout>',
  '<command-stderr>',
  '<local-command-stdout>',
  '<local-command-stderr>',
  '<local-command-caveat>',
] as const;

function classifyDroppedUser(text: string): 'inject' | 'prompt' {
  const head = text.trimStart();
  for (const tag of INJECT_TAG_PREFIXES) {
    if (head.startsWith(tag)) return 'inject';
  }
  return 'prompt';
}

interface ParsedToolUse {
  id: string;
  name: string;
  input: unknown;
}

interface ParsedToolResult {
  tool_use_id: string;
  content: string;
  is_error: boolean;
}

interface ExtractedContent {
  text: string;
  hasTool: boolean;
  files: string[];
  toolUses: ParsedToolUse[];
  toolResults: ParsedToolResult[];
  thinking: string[];
}

interface ParsedLine {
  role: 'user' | 'assistant';
  text: string;
  hasTool: boolean;
  /** True for assistant messages with `stop_reason: end_turn` — signals the
   *  assistant has finished and the cluster can be closed without waiting
   *  for the next user line. */
  isEndTurn: boolean;
  timestamp: string | undefined;
  cwd: string | undefined;
  /** Per-line CC top-level fields. All optional — different line types
   *  carry different subsets (e.g. permissionMode is only on user lines,
   *  message.model is only on assistant lines). */
  gitBranch: string | undefined;
  permissionMode: string | undefined;
  version: string | undefined;
  model: string | undefined;
  files: string[];
  toolUses: ParsedToolUse[];
  toolResults: ParsedToolResult[];
  thinking: string[];
}

function stringifyToolResultContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) {
    if (typeof block !== 'object' || block === null) continue;
    const b = block as Record<string, unknown>;
    if (b['type'] === 'text' && typeof b['text'] === 'string') {
      parts.push(b['text']);
    }
  }
  return parts.join('\n');
}

function extractContent(content: unknown): ExtractedContent {
  if (typeof content === 'string') {
    return {
      text: content,
      hasTool: false,
      files: [],
      toolUses: [],
      toolResults: [],
      thinking: [],
    };
  }
  if (!Array.isArray(content)) {
    return { text: '', hasTool: false, files: [], toolUses: [], toolResults: [], thinking: [] };
  }
  const parts: string[] = [];
  const files: string[] = [];
  const toolUses: ParsedToolUse[] = [];
  const toolResults: ParsedToolResult[] = [];
  const thinking: string[] = [];
  let hasTool = false;
  for (const block of content) {
    if (typeof block !== 'object' || block === null) continue;
    const b = block as Record<string, unknown>;
    const blockType = b['type'];
    if (blockType === 'text' && typeof b['text'] === 'string') {
      parts.push(b['text']);
    } else if (
      blockType === 'thinking' &&
      typeof b['thinking'] === 'string' &&
      b['thinking'].trim().length > 0
    ) {
      thinking.push(b['thinking']);
    } else if (blockType === 'tool_use') {
      hasTool = true;
      const id = b['id'];
      const name = b['name'];
      const input = b['input'];
      if (isNonEmptyString(id) && isNonEmptyString(name)) {
        toolUses.push({ id, name, input });
      }
      if (typeof input === 'object' && input !== null) {
        const i = input as Record<string, unknown>;
        for (const key of FILE_INPUT_KEYS) {
          const v = i[key];
          if (isNonEmptyString(v)) files.push(v);
        }
      }
    } else if (blockType === 'tool_result') {
      hasTool = true;
      const tuid = b['tool_use_id'];
      if (isNonEmptyString(tuid)) {
        toolResults.push({
          tool_use_id: tuid,
          content: stringifyToolResultContent(b['content']),
          is_error: b['is_error'] === true,
        });
      }
    }
  }
  return { text: parts.join(''), hasTool, files, toolUses, toolResults, thinking };
}

function parseLine(line: string): ParsedLine | null {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch (err) {
    log.warn('parse_failed', {
      preview: line.slice(0, 120),
      message: (err as Error).message,
    });
    return null;
  }
  if (typeof raw !== 'object' || raw === null) return null;
  const obj = raw as Record<string, unknown>;
  const message = obj['message'];
  if (typeof message !== 'object' || message === null) return null;
  const msg = message as Record<string, unknown>;
  const role = msg['role'];
  if (role !== 'user' && role !== 'assistant') return null;
  const ec = extractContent(msg['content']);
  const ts = obj['timestamp'];
  const cwd = obj['cwd'];
  const gitBranch = obj['gitBranch'];
  const permissionMode = obj['permissionMode'];
  const version = obj['version'];
  const model = msg['model'];
  const isEndTurn = role === 'assistant' && msg['stop_reason'] === 'end_turn';
  return {
    role,
    text: ec.text,
    hasTool: ec.hasTool,
    isEndTurn,
    timestamp: typeof ts === 'string' ? ts : undefined,
    cwd: isNonEmptyString(cwd) ? cwd : undefined,
    gitBranch: isNonEmptyString(gitBranch) ? gitBranch : undefined,
    permissionMode: isNonEmptyString(permissionMode) ? permissionMode : undefined,
    version: isNonEmptyString(version) ? version : undefined,
    model: isNonEmptyString(model) ? model : undefined,
    files: ec.files,
    toolUses: ec.toolUses,
    toolResults: ec.toolResults,
    thinking: ec.thinking,
  };
}

function deriveSessionId(jsonlPath: string): string {
  const base = basename(jsonlPath);
  return base.endsWith('.jsonl') ? base.slice(0, -'.jsonl'.length) : base;
}

function deriveProject(jsonlPath: string): string {
  return basename(dirname(jsonlPath));
}

export async function extractClaudeCodeTurns(
  jsonlPath: string,
  lastByteOffset: number,
): Promise<ExtractClaudeCodeResult> {
  const tail = await readJsonlTail(jsonlPath, lastByteOffset, log);
  if (tail === null) return { turns: [], newOffset: lastByteOffset, droppedUsers: [] };
  const { lines, mtimeMs: fileMtime } = tail;
  if (lines.length === 0) return { turns: [], newOffset: lastByteOffset, droppedUsers: [] };
  const session_id = deriveSessionId(jsonlPath);
  const project = deriveProject(jsonlPath);

  const turns: ClaudeCodeTurn[] = [];
  interface PendingCluster {
    userText: string;
    userByteOffset: number;
    timestamp: string;
    assistantTexts: string[];
    assistantLastLineEndOffset: number;
    hadTool: boolean;
    files: string[];
    toolUses: ParsedToolUse[];
    toolResults: ParsedToolResult[];
    thinking: string[];
    repo_root?: string;
    gitBranch?: string;
    permissionMode?: string;
    version?: string;
    model?: string;
  }
  let pending: PendingCluster | null = null;
  const droppedUsers: DroppedUserLine[] = [];
  // "Between" buffers accumulate side-effects from lines that arrive when no
  // cluster is open (e.g., orphan tool_results before any user line). They
  // get folded into the next cluster's pending state at user-line time.
  let hadToolBetween = false;
  let filesBetween: string[] = [];
  let toolUsesBetween: ParsedToolUse[] = [];
  let toolResultsBetween: ParsedToolResult[] = [];
  let thinkingBetween: string[] = [];
  let lineStartOffset = lastByteOffset;
  // Tracks the END of the last line that contributed to an EMITTED turn.
  // Pending-cluster lines (user + assistants without a closing next-user) are
  // intentionally NOT past confirmedThroughOffset, so the next pass re-reads
  // them and rebuilds the pending cluster from scratch (idempotent).
  let confirmedThroughOffset = lastByteOffset;
  let currentCwd: string | undefined;

  function emitPendingIfComplete(): void {
    if (pending === null) return;
    if (pending.assistantTexts.length === 0) return;
    const allFiles = dedupStrings(pending.files);
    const turn: ClaudeCodeTurn = {
      project,
      session_id,
      turn_index: turns.length,
      user_message: pending.userText,
      assistant_message: pending.assistantTexts.join('\n\n'),
      mtime: fileMtime,
      timestamp: pending.timestamp,
      had_tool_use: pending.hadTool,
      byte_offset: pending.assistantLastLineEndOffset,
    };
    if (pending.repo_root !== undefined) turn.repo_root = pending.repo_root;
    if (allFiles.length > 0) turn.files_referenced = allFiles;
    const tc = matchToolCalls(pending.toolUses, pending.toolResults);
    if (tc.calls.length > 0) {
      turn.tool_calls = tc.calls;
      turn.tool_call_total = tc.total;
      if (tc.truncated) turn.tool_calls_truncated = true;
    }
    if (pending.thinking.length > 0) {
      const t = truncateThinking(pending.thinking.join('\n\n'));
      turn.thinking = t.value;
    }
    if (pending.gitBranch !== undefined) turn.git_branch_jsonl = pending.gitBranch;
    if (pending.permissionMode !== undefined) turn.permission_mode = pending.permissionMode;
    if (pending.version !== undefined) turn.cli_version = pending.version;
    if (pending.model !== undefined) turn.model = pending.model;
    turns.push(turn);
    confirmedThroughOffset = pending.assistantLastLineEndOffset;
  }

  for (const line of lines) {
    const lineEndOffset = lineStartOffset + Buffer.byteLength(line, 'utf8') + 1;
    const parsed = parseLine(line);
    if (parsed === null) {
      lineStartOffset = lineEndOffset;
      continue;
    }
    if (parsed.cwd !== undefined) currentCwd = parsed.cwd;

    if (parsed.text === '') {
      // Side-effects (tool_use, tool_result, thinking blocks) accumulate into
      // the open cluster if there is one; otherwise into the "between" buffers
      // so they fold into whatever cluster opens next.
      if (pending !== null) {
        if (parsed.hasTool) pending.hadTool = true;
        if (parsed.files.length > 0) pending.files.push(...parsed.files);
        if (parsed.toolUses.length > 0) pending.toolUses.push(...parsed.toolUses);
        if (parsed.toolResults.length > 0) pending.toolResults.push(...parsed.toolResults);
        if (parsed.thinking.length > 0) pending.thinking.push(...parsed.thinking);
      } else {
        if (parsed.hasTool) hadToolBetween = true;
        if (parsed.files.length > 0) filesBetween.push(...parsed.files);
        if (parsed.toolUses.length > 0) toolUsesBetween.push(...parsed.toolUses);
        if (parsed.toolResults.length > 0) toolResultsBetween.push(...parsed.toolResults);
        if (parsed.thinking.length > 0) thinkingBetween.push(...parsed.thinking);
      }
      lineStartOffset = lineEndOffset;
      continue;
    }

    if (parsed.role === 'user') {
      // A new text-bearing user line closes any prior cluster.
      if (pending !== null) {
        if (pending.assistantTexts.length > 0) {
          emitPendingIfComplete();
        } else {
          const dropped: DroppedUserLine = {
            byte_offset: pending.userByteOffset,
            preview: pending.userText.slice(0, 120),
            classification: classifyDroppedUser(pending.userText),
          };
          if (pending.timestamp !== undefined) dropped.timestamp = pending.timestamp;
          droppedUsers.push(dropped);
        }
      }
      pending = {
        userText: parsed.text,
        userByteOffset: lineStartOffset,
        timestamp: parsed.timestamp ?? new Date(fileMtime).toISOString(),
        assistantTexts: [],
        assistantLastLineEndOffset: lineEndOffset,
        hadTool: hadToolBetween || parsed.hasTool,
        files: [...filesBetween, ...parsed.files],
        toolUses: [...toolUsesBetween, ...parsed.toolUses],
        toolResults: [...toolResultsBetween, ...parsed.toolResults],
        thinking: [...thinkingBetween, ...parsed.thinking],
      };
      if (currentCwd !== undefined) pending.repo_root = currentCwd;
      if (parsed.gitBranch !== undefined) pending.gitBranch = parsed.gitBranch;
      if (parsed.permissionMode !== undefined) pending.permissionMode = parsed.permissionMode;
      if (parsed.version !== undefined) pending.version = parsed.version;
      hadToolBetween = false;
      filesBetween = [];
      toolUsesBetween = [];
      toolResultsBetween = [];
      thinkingBetween = [];
    } else {
      // text-bearing assistant
      if (pending === null) {
        log.warn('orphan_assistant', { session_id });
      } else {
        pending.assistantTexts.push(parsed.text);
        pending.assistantLastLineEndOffset = lineEndOffset;
        if (parsed.timestamp !== undefined) pending.timestamp = parsed.timestamp;
        if (parsed.hasTool) pending.hadTool = true;
        if (parsed.files.length > 0) pending.files.push(...parsed.files);
        if (parsed.toolUses.length > 0) pending.toolUses.push(...parsed.toolUses);
        if (parsed.toolResults.length > 0) pending.toolResults.push(...parsed.toolResults);
        if (parsed.thinking.length > 0) pending.thinking.push(...parsed.thinking);
        if (parsed.model !== undefined) pending.model = parsed.model;
        if (pending.gitBranch === undefined && parsed.gitBranch !== undefined) {
          pending.gitBranch = parsed.gitBranch;
        }
        if (pending.version === undefined && parsed.version !== undefined) {
          pending.version = parsed.version;
        }
        if (parsed.isEndTurn) {
          // stop_reason=end_turn — assistant is done; close the cluster now.
          emitPendingIfComplete();
          pending = null;
        }
      }
    }
    lineStartOffset = lineEndOffset;
  }

  // Intentionally do NOT emit pending here. A cluster only counts as closed
  // when the next user line appears; emitting at EOF risks double-emission
  // when the next pass sees more assistant lines arrive (for active sessions)
  // or losing-then-recapturing content as orphans.
  return { turns, newOffset: confirmedThroughOffset, droppedUsers };
}

function matchToolCalls(
  uses: ParsedToolUse[],
  results: ParsedToolResult[],
): { calls: ToolCall[]; total: number; truncated: boolean } {
  const resultById = new Map<string, ParsedToolResult>();
  for (const r of results) resultById.set(r.tool_use_id, r);
  const total = uses.length;
  const truncated = total > MAX_TOOL_CALLS_PER_TURN;
  const cap = truncated ? MAX_TOOL_CALLS_PER_TURN : total;
  const calls: ToolCall[] = [];
  for (let i = 0; i < cap; i++) {
    const u = uses[i]!;
    const r = resultById.get(u.id);
    let argsRaw: string | undefined;
    if (u.input != null) {
      argsRaw = typeof u.input === 'string' ? u.input : JSON.stringify(u.input);
    }
    calls.push(
      buildToolCall({
        name: u.name,
        call_id: u.id,
        argsRaw,
        outputRaw: r?.content,
        is_error: r?.is_error,
      }),
    );
  }
  return { calls, total, truncated };
}

async function backfillOffsetMap(
  storage: Storage,
): Promise<Map<string, { offset: number; turn_index: number }>> {
  const map = new Map<string, { offset: number; turn_index: number }>();
  const events = await storage.query({ source_prefix: 'fs:' });
  for (const evt of events) {
    if (!evt.source.endsWith('.jsonl')) continue;
    const md = evt.metadata;
    if (md === undefined) continue;
    const offset = md['byte_offset'];
    const turn_index = md['turn_index'];
    if (typeof offset !== 'number' || typeof turn_index !== 'number') continue;
    const path = evt.source.slice('fs:'.length);
    const cur = map.get(path);
    if (cur === undefined || offset > cur.offset) {
      map.set(path, { offset, turn_index });
    }
  }
  return map;
}

export interface ClaudeCodeExtractorOptions {
  projectsPrefix?: string;
}

export type ClaudeCodeExtractorHandle = ExtractorHandle;

export async function startClaudeCodeExtractor(
  storage: Storage,
  options: ClaudeCodeExtractorOptions = {},
): Promise<ClaudeCodeExtractorHandle> {
  const projectsPrefix = options.projectsPrefix ?? DEFAULT_PROJECTS_PREFIX;
  const offsetMap = await backfillOffsetMap(storage);

  // Per-file watermark: the highest byte_offset of a dropped-user line we've
  // already logged. Without this, every chokidar `change` event re-walks the
  // unconfirmed tail and re-detects the same drops, spamming warnings.
  const dropWatermark = new Map<string, number>();

  async function handleJsonlChange(path: string): Promise<void> {
    const cur = offsetMap.get(path) ?? { offset: 0, turn_index: -1 };
    const { turns, newOffset, droppedUsers } = await extractClaudeCodeTurns(path, cur.offset);
    const wm = dropWatermark.get(path) ?? -1;
    const fresh = droppedUsers.filter((d) => d.byte_offset > wm);
    if (fresh.length > 0) {
      const session_id = deriveSessionId(path);
      const prompts = fresh.filter((d) => d.classification === 'prompt');
      const injects = fresh.filter((d) => d.classification === 'inject');
      if (prompts.length > 0) {
        log.warn('user_prompt_dropped_without_assistant_reply', {
          session_id,
          count: prompts.length,
          previews: prompts.map((d) => d.preview),
        });
      }
      if (injects.length > 0) {
        log.debug('user_inject_dropped', { session_id, count: injects.length });
      }
      let maxOffset = wm;
      for (const d of fresh) if (d.byte_offset > maxOffset) maxOffset = d.byte_offset;
      dropWatermark.set(path, maxOffset);
    }
    let nextTurnIndex = cur.turn_index + 1;
    for (const turn of turns) {
      const metadata: Record<string, unknown> = {
        project: turn.project,
        session_id: turn.session_id,
        turn_index: nextTurnIndex,
        mtime: turn.mtime,
        byte_offset: turn.byte_offset,
      };
      if (turn.had_tool_use) metadata['had_tool_use'] = true;
      if (turn.repo_root !== undefined) metadata['repo_root'] = turn.repo_root;
      if (turn.repo_root !== undefined) {
        metadata['canonical_root'] = await resolveCanonicalRoot(turn.repo_root);
      }
      if (turn.files_referenced !== undefined) metadata['files_referenced'] = turn.files_referenced;
      if (turn.tool_calls !== undefined) metadata['tool_calls'] = turn.tool_calls;
      if (turn.tool_call_total !== undefined) metadata['tool_call_total'] = turn.tool_call_total;
      if (turn.tool_calls_truncated === true) metadata['tool_calls_truncated'] = true;
      if (turn.thinking !== undefined) metadata['thinking'] = turn.thinking;
      if (turn.permission_mode !== undefined) metadata['permission_mode'] = turn.permission_mode;
      if (turn.cli_version !== undefined) metadata['cli_version'] = turn.cli_version;
      if (turn.model !== undefined) metadata['model'] = turn.model;
      const gitState = await probeGitState(turn.repo_root, turn.timestamp);
      if (gitState !== undefined) {
        metadata['git_state'] = gitState;
      } else if (turn.git_branch_jsonl !== undefined) {
        // Stale (boot-scanned) turn: probe refused, but JSONL gitBranch is
        // the branch the CC client recorded at turn time — strictly better
        // provenance than nothing. Emit a partial GitState with fresh:false
        // so consumers see a uniform shape with Codex's session_meta
        // backfill. head_sha + dirty_count remain unrecoverable: CC JSONL
        // doesn't record commit sha, and dirty status is point-in-time only.
        metadata['git_state'] = {
          captured_at: turn.timestamp,
          fresh: false,
          branch: turn.git_branch_jsonl,
        };
      }
      const branch = turn.git_branch_jsonl ?? (await readBranch(turn.repo_root));
      if (branch !== undefined) metadata['branch'] = branch;
      const candidate = {
        source: `fs:${path}`,
        timestamp: turn.timestamp,
        content: `USER: ${turn.user_message}\n\nASSISTANT: ${turn.assistant_message}`,
        metadata,
      };
      log.info('candidate', { session_id: turn.session_id, turn_index: nextTurnIndex });
      const result = await processCandidate(candidate, storage);
      if (result.accepted) {
        nextTurnIndex += 1;
      } else {
        log.warn('candidate_rejected', { reason: result.reason, path });
      }
      // Checkpoint per processed turn (cursor.ts's per-turn lastSeenMap.set is
      // the in-tree precedent): a mid-batch throw on a later turn then resumes
      // AFTER this one instead of durably re-appending it on every poll tick.
      offsetMap.set(path, { offset: turn.byte_offset, turn_index: nextTurnIndex - 1 });
    }
    offsetMap.set(path, { offset: newOffset, turn_index: nextTurnIndex - 1 });
  }

  const handle = await wireJsonlExtractor({
    prefix: projectsPrefix,
    offsetMap,
    handle: handleJsonlChange,
    log,
  });
  log.info('started', { projectsPrefix });
  return {
    stop: async () => {
      await handle.stop();
      log.info('stopped', {});
    },
    probeFreshness: handle.probeFreshness,
  };
}
