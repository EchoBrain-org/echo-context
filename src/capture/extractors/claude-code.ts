import { homedir } from "node:os";
import { basename, dirname } from "node:path";
import { isNonEmptyString } from "../../guards.js";
import { createLogger } from "../../logging/index.js";
import type { Storage } from "../../storage/interface.js";
import { probeGitState, readBranch } from "../git-state.js";
import {
  captureDedupeKey,
  createExtractorFilesystemPolicy,
  processExtractorCandidate,
} from "../pipeline.js";
import { resolveCanonicalRoot } from "../workspace-root.js";
import {
  assertJsonlReadSnapshotCurrent,
  assertJsonlSourceSnapshotCurrent,
  classifyJsonlDiscontinuity,
  createBoundedResourceCache,
  dedupStrings,
  inspectJsonlCheckpointProof,
  inspectJsonlSource,
  JSONL_RAW_FRAGMENT_CONTENT_PREFIX,
  makeJsonlCheckpointSource,
  MAX_JSONL_READ_BYTES,
  readJsonlTail,
  readJsonlCheckpointSource,
  readJsonlRawFallback,
  visitJsonlRawFragments,
  withJsonlReadSnapshot,
  wireJsonlExtractor,
  type ExtractorHandle,
  type JsonlCheckpointSource,
  type JsonlRawFallback,
  JsonlSourceChangedError,
  type JsonlReadSnapshot,
  type JsonlSourceInspection,
} from "./_shared.js";
import {
  buildToolCall,
  FILE_INPUT_KEYS,
  MAX_TOOL_CALLS_PER_TURN,
  truncateThinking,
  type GitState,
  type ToolCall,
} from "./_turn_meta.js";

const log = createLogger("capture.claude-code");

const HOME = homedir();
const DEFAULT_PROJECTS_PREFIX = `${HOME}/.claude/projects/`;
export const CLAUDE_CODE_CHECKPOINT_NAMESPACE = "claude_code";

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
  /** Content-free diagnostics. Raw user prompts must never cross the logger
   *  boundary, even as a truncated preview. */
  byte_count: number;
  /** `inject` = system reminder / slash-command marker / local-command echo
   *  (high-volume noise; logged at debug). `prompt` = anything else, treated
   *  as a possibly-real user message that never got an assistant reply. */
  classification: "inject" | "prompt";
  timestamp?: string;
}

export interface ExtractClaudeCodeResult {
  turns: ClaudeCodeTurn[];
  newOffset: number;
  droppedUsers: DroppedUserLine[];
  readSnapshot?: JsonlReadSnapshot;
  firstUserOffset?: number;
}

const INJECT_TAG_PREFIXES = [
  "<system-reminder>",
  "<command-name>",
  "<command-message>",
  "<command-args>",
  "<command-stdout>",
  "<command-stderr>",
  "<local-command-stdout>",
  "<local-command-stderr>",
  "<local-command-caveat>",
] as const;

function classifyDroppedUser(text: string): "inject" | "prompt" {
  const head = text.trimStart();
  for (const tag of INJECT_TAG_PREFIXES) {
    if (head.startsWith(tag)) return "inject";
  }
  return "prompt";
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
  role: "user" | "assistant";
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
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (typeof block !== "object" || block === null) continue;
    const b = block as Record<string, unknown>;
    if (b["type"] === "text" && typeof b["text"] === "string") {
      parts.push(b["text"]);
    }
  }
  return parts.join("\n");
}

function extractContent(content: unknown): ExtractedContent {
  if (typeof content === "string") {
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
    return {
      text: "",
      hasTool: false,
      files: [],
      toolUses: [],
      toolResults: [],
      thinking: [],
    };
  }
  const parts: string[] = [];
  const files: string[] = [];
  const toolUses: ParsedToolUse[] = [];
  const toolResults: ParsedToolResult[] = [];
  const thinking: string[] = [];
  let hasTool = false;
  for (const block of content) {
    if (typeof block !== "object" || block === null) continue;
    const b = block as Record<string, unknown>;
    const blockType = b["type"];
    if (blockType === "text" && typeof b["text"] === "string") {
      parts.push(b["text"]);
    } else if (
      blockType === "thinking" &&
      typeof b["thinking"] === "string" &&
      b["thinking"].trim().length > 0
    ) {
      thinking.push(b["thinking"]);
    } else if (blockType === "tool_use") {
      hasTool = true;
      const id = b["id"];
      const name = b["name"];
      const input = b["input"];
      if (isNonEmptyString(id) && isNonEmptyString(name)) {
        toolUses.push({ id, name, input });
      }
      if (typeof input === "object" && input !== null) {
        const i = input as Record<string, unknown>;
        for (const key of FILE_INPUT_KEYS) {
          const v = i[key];
          if (isNonEmptyString(v)) files.push(v);
        }
      }
    } else if (blockType === "tool_result") {
      hasTool = true;
      const tuid = b["tool_use_id"];
      if (isNonEmptyString(tuid)) {
        toolResults.push({
          tool_use_id: tuid,
          content: stringifyToolResultContent(b["content"]),
          is_error: b["is_error"] === true,
        });
      }
    }
  }
  return {
    text: parts.join(""),
    hasTool,
    files,
    toolUses,
    toolResults,
    thinking,
  };
}

function parseLine(line: string, byteOffset: number): ParsedLine | null {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    log.warn("parse_failed", {
      byte_offset: byteOffset,
      byte_count: Buffer.byteLength(line),
      classification: "malformed_json",
    });
    return null;
  }
  if (typeof raw !== "object" || raw === null) return null;
  const obj = raw as Record<string, unknown>;
  const message = obj["message"];
  if (typeof message !== "object" || message === null) return null;
  const msg = message as Record<string, unknown>;
  const role = msg["role"];
  if (role !== "user" && role !== "assistant") return null;
  const ec = extractContent(msg["content"]);
  const ts = obj["timestamp"];
  const cwd = obj["cwd"];
  const gitBranch = obj["gitBranch"];
  const permissionMode = obj["permissionMode"];
  const version = obj["version"];
  const model = msg["model"];
  const isEndTurn = role === "assistant" && msg["stop_reason"] === "end_turn";
  return {
    role,
    text: ec.text,
    hasTool: ec.hasTool,
    isEndTurn,
    timestamp: typeof ts === "string" ? ts : undefined,
    cwd: isNonEmptyString(cwd) ? cwd : undefined,
    gitBranch: isNonEmptyString(gitBranch) ? gitBranch : undefined,
    permissionMode: isNonEmptyString(permissionMode)
      ? permissionMode
      : undefined,
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
  return base.endsWith(".jsonl") ? base.slice(0, -".jsonl".length) : base;
}

function deriveProject(jsonlPath: string): string {
  return basename(dirname(jsonlPath));
}

export async function extractClaudeCodeTurns(
  jsonlPath: string,
  lastByteOffset: number,
): Promise<ExtractClaudeCodeResult> {
  const tail = await readJsonlTail(jsonlPath, lastByteOffset, log);
  if (tail === null)
    return { turns: [], newOffset: lastByteOffset, droppedUsers: [] };
  const {
    lines,
    lineEndOffsets,
    firstLineOffset,
    mtimeMs: fileMtime,
    snapshot: readSnapshot,
  } = tail;
  if (lines.length === 0)
    return {
      turns: [],
      newOffset: lastByteOffset,
      droppedUsers: [],
      ...(readSnapshot !== undefined ? { readSnapshot } : {}),
    };
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
  let betweenStartOffset: number | null = null;
  let lineStartOffset = firstLineOffset;
  // Tracks the END of the last line that contributed to an EMITTED turn.
  // Pending-cluster lines (user + assistants without a closing next-user) are
  // intentionally NOT past confirmedThroughOffset, so the next pass re-reads
  // them and rebuilds the pending cluster from scratch (idempotent).
  let confirmedThroughOffset = lastByteOffset;
  let currentCwd: string | undefined;
  let firstUserOffset: number | undefined;

  function hasBetweenState(): boolean {
    return (
      hadToolBetween ||
      filesBetween.length > 0 ||
      toolUsesBetween.length > 0 ||
      toolResultsBetween.length > 0 ||
      thinkingBetween.length > 0
    );
  }

  function markSafeThrough(offset: number): void {
    if (
      pending === null &&
      !hasBetweenState() &&
      offset > confirmedThroughOffset
    ) {
      confirmedThroughOffset = offset;
    }
  }

  function emitPendingIfComplete(): void {
    if (pending === null) return;
    if (pending.assistantTexts.length === 0) return;
    const allFiles = dedupStrings(pending.files);
    const turn: ClaudeCodeTurn = {
      project,
      session_id,
      turn_index: turns.length,
      user_message: pending.userText,
      assistant_message: pending.assistantTexts.join("\n\n"),
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
      const t = truncateThinking(pending.thinking.join("\n\n"));
      turn.thinking = t.value;
    }
    if (pending.gitBranch !== undefined)
      turn.git_branch_jsonl = pending.gitBranch;
    if (pending.permissionMode !== undefined)
      turn.permission_mode = pending.permissionMode;
    if (pending.version !== undefined) turn.cli_version = pending.version;
    if (pending.model !== undefined) turn.model = pending.model;
    turns.push(turn);
    confirmedThroughOffset = pending.assistantLastLineEndOffset;
  }

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex]!;
    const lineEndOffset = lineEndOffsets[lineIndex]!;
    const parsed = parseLine(line, lineStartOffset);
    if (parsed === null) {
      markSafeThrough(lineEndOffset);
      lineStartOffset = lineEndOffset;
      continue;
    }
    if (parsed.cwd !== undefined) currentCwd = parsed.cwd;

    if (parsed.text === "") {
      // Side-effects (tool_use, tool_result, thinking blocks) accumulate into
      // the open cluster if there is one; otherwise into the "between" buffers
      // so they fold into whatever cluster opens next.
      if (pending !== null) {
        if (parsed.hasTool) pending.hadTool = true;
        if (parsed.files.length > 0) pending.files.push(...parsed.files);
        if (parsed.toolUses.length > 0)
          pending.toolUses.push(...parsed.toolUses);
        if (parsed.toolResults.length > 0)
          pending.toolResults.push(...parsed.toolResults);
        if (parsed.thinking.length > 0)
          pending.thinking.push(...parsed.thinking);
      } else {
        const carriesBetweenState =
          parsed.hasTool ||
          parsed.files.length > 0 ||
          parsed.toolUses.length > 0 ||
          parsed.toolResults.length > 0 ||
          parsed.thinking.length > 0;
        if (carriesBetweenState && !hasBetweenState()) {
          betweenStartOffset = lineStartOffset;
        }
        if (parsed.hasTool) hadToolBetween = true;
        if (parsed.files.length > 0) filesBetween.push(...parsed.files);
        if (parsed.toolUses.length > 0)
          toolUsesBetween.push(...parsed.toolUses);
        if (parsed.toolResults.length > 0)
          toolResultsBetween.push(...parsed.toolResults);
        if (parsed.thinking.length > 0)
          thinkingBetween.push(...parsed.thinking);
      }
      markSafeThrough(lineEndOffset);
      lineStartOffset = lineEndOffset;
      continue;
    }

    if (parsed.role === "user") {
      if (firstUserOffset === undefined) firstUserOffset = lineStartOffset;
      // A new text-bearing user line closes any prior cluster.
      if (pending !== null) {
        if (pending.assistantTexts.length > 0) {
          emitPendingIfComplete();
        } else {
          const dropped: DroppedUserLine = {
            byte_offset: pending.userByteOffset,
            byte_count: Buffer.byteLength(pending.userText),
            classification: classifyDroppedUser(pending.userText),
          };
          if (pending.timestamp !== undefined)
            dropped.timestamp = pending.timestamp;
          droppedUsers.push(dropped);
        }
      }
      const safePendingStart = betweenStartOffset ?? lineStartOffset;
      if (safePendingStart > confirmedThroughOffset) {
        confirmedThroughOffset = safePendingStart;
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
      if (parsed.permissionMode !== undefined)
        pending.permissionMode = parsed.permissionMode;
      if (parsed.version !== undefined) pending.version = parsed.version;
      hadToolBetween = false;
      filesBetween = [];
      toolUsesBetween = [];
      toolResultsBetween = [];
      thinkingBetween = [];
      betweenStartOffset = null;
    } else {
      // text-bearing assistant
      if (pending === null) {
        log.warn("orphan_assistant", { session_id });
        markSafeThrough(lineEndOffset);
      } else {
        pending.assistantTexts.push(parsed.text);
        pending.assistantLastLineEndOffset = lineEndOffset;
        if (parsed.timestamp !== undefined)
          pending.timestamp = parsed.timestamp;
        if (parsed.hasTool) pending.hadTool = true;
        if (parsed.files.length > 0) pending.files.push(...parsed.files);
        if (parsed.toolUses.length > 0)
          pending.toolUses.push(...parsed.toolUses);
        if (parsed.toolResults.length > 0)
          pending.toolResults.push(...parsed.toolResults);
        if (parsed.thinking.length > 0)
          pending.thinking.push(...parsed.thinking);
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
          markSafeThrough(lineEndOffset);
        }
      }
    }
    lineStartOffset = lineEndOffset;
  }

  // Intentionally do NOT emit pending here. A cluster only counts as closed
  // when the next user line appears; emitting at EOF risks double-emission
  // when the next pass sees more assistant lines arrive (for active sessions)
  // or losing-then-recapturing content as orphans.
  return {
    turns,
    newOffset: confirmedThroughOffset,
    droppedUsers,
    ...(readSnapshot !== undefined ? { readSnapshot } : {}),
    ...(firstUserOffset !== undefined ? { firstUserOffset } : {}),
  };
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
      argsRaw = typeof u.input === "string" ? u.input : JSON.stringify(u.input);
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

export interface ClaudeCodeExtractorOptions {
  projectsPrefix?: string;
}

interface ClaudeCodeOffsetEntry {
  offset: number;
  turn_index: number;
  source?: JsonlCheckpointSource;
  inflight_source?: JsonlCheckpointSource;
  page_start?: ClaudeCodePageStart;
  raw_fallback?: JsonlRawFallback;
}

interface ClaudeCodePageStart {
  offset: number;
  turn_index: number;
  raw_fallback?: JsonlRawFallback;
}

function readClaudeCodePageStart(
  state: Record<string, unknown> | undefined,
): ClaudeCodePageStart | undefined {
  const raw = state?.["jsonl_page_start"];
  if (raw === undefined) return undefined;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new TypeError("capture checkpoint jsonl_page_start state is invalid");
  }
  const value = raw as Record<string, unknown>;
  const offset = value["offset"];
  const turnIndex = value["turn_index"];
  if (
    !Number.isSafeInteger(offset) ||
    (offset as number) < 0 ||
    !Number.isSafeInteger(turnIndex) ||
    (turnIndex as number) < -1
  ) {
    throw new TypeError("capture checkpoint jsonl_page_start state is invalid");
  }
  const pageStart: ClaudeCodePageStart = {
    offset: offset as number,
    turn_index: turnIndex as number,
  };
  const rawFallback = readJsonlRawFallback(value, "raw_fallback");
  if (
    rawFallback !== undefined &&
    (rawFallback.cluster_start_offset >= pageStart.offset ||
      rawFallback.next_fragment === 0)
  ) {
    throw new TypeError(
      "capture checkpoint jsonl_page_start raw fallback is invalid",
    );
  }
  if (rawFallback !== undefined) pageStart.raw_fallback = rawFallback;
  return pageStart;
}

function claudeCodePageStart(
  entry: ClaudeCodeOffsetEntry,
): ClaudeCodePageStart {
  const pageStart: ClaudeCodePageStart = {
    offset: entry.offset,
    turn_index: entry.turn_index,
  };
  if (entry.raw_fallback !== undefined) {
    pageStart.raw_fallback = entry.raw_fallback;
  }
  return pageStart;
}

export type ClaudeCodeExtractorHandle = ExtractorHandle;

export async function startClaudeCodeExtractor(
  storage: Storage,
  options: ClaudeCodeExtractorOptions = {},
): Promise<ClaudeCodeExtractorHandle> {
  const projectsPrefix = options.projectsPrefix ?? DEFAULT_PROJECTS_PREFIX;
  const capturePolicy = createExtractorFilesystemPolicy({
    roots: [projectsPrefix],
  });
  const offsetMap = createBoundedResourceCache<ClaudeCodeOffsetEntry>();

  async function loadCheckpoint(path: string): Promise<ClaudeCodeOffsetEntry> {
    const cached = offsetMap.get(path);
    if (cached !== undefined) return cached;
    const persisted = await storage.getCaptureCheckpoint({
      extractor: CLAUDE_CODE_CHECKPOINT_NAMESPACE,
      resource: path,
    });
    const entry: ClaudeCodeOffsetEntry = {
      offset: persisted?.position ?? 0,
      turn_index: persisted?.ordinal ?? -1,
      source: readJsonlCheckpointSource(persisted?.state),
    };
    if (
      entry.source !== undefined &&
      entry.source.boundary_offset !== entry.offset
    ) {
      throw new TypeError(
        "capture checkpoint jsonl_source does not match its position",
      );
    }
    const inflightSource = readJsonlCheckpointSource(
      persisted?.state,
      "jsonl_inflight_source",
    );
    if (inflightSource !== undefined) entry.inflight_source = inflightSource;
    const pageStart = readClaudeCodePageStart(persisted?.state);
    if (pageStart !== undefined) {
      if (
        entry.source?.page_start_offset !== pageStart.offset ||
        pageStart.offset > entry.offset ||
        pageStart.turn_index > entry.turn_index ||
        (pageStart.raw_fallback !== undefined &&
          (entry.source === undefined ||
            pageStart.raw_fallback.group_generation > entry.source.generation))
      ) {
        throw new TypeError(
          "capture checkpoint jsonl_page_start does not match its page proof",
        );
      }
      entry.page_start = pageStart;
    }
    const rawFallback = readJsonlRawFallback(persisted?.state);
    if (
      rawFallback !== undefined &&
      (rawFallback.cluster_start_offset >= entry.offset ||
        rawFallback.next_fragment === 0 ||
        entry.source === undefined ||
        rawFallback.group_generation > entry.source.generation)
    ) {
      throw new TypeError(
        "capture checkpoint jsonl_raw_fallback state is invalid",
      );
    }
    if (rawFallback !== undefined) entry.raw_fallback = rawFallback;
    if (
      inflightSource !== undefined &&
      (entry.source === undefined ||
        pageStart === undefined ||
        inflightSource.page_start_offset !== pageStart.offset ||
        inflightSource.boundary_offset !== pageStart.offset ||
        inflightSource.page_through_offset === undefined ||
        inflightSource.page_sha256 === undefined ||
        inflightSource.identity !== entry.source.identity ||
        inflightSource.generation !== entry.source.generation ||
        (entry.source.page_through_offset !== undefined &&
          inflightSource.page_through_offset <
            entry.source.page_through_offset))
    ) {
      throw new TypeError(
        "capture checkpoint jsonl_inflight_source state is invalid",
      );
    }
    offsetMap.set(path, entry);
    return entry;
  }

  async function saveCheckpoint(
    path: string,
    entry: ClaudeCodeOffsetEntry,
    inspection: JsonlSourceInspection,
    pageStart?: ClaudeCodePageStart,
    inflightInspection?: JsonlSourceInspection,
  ): Promise<void> {
    if (inspection.boundary_offset !== entry.offset) {
      throw new RangeError(
        "JSONL checkpoint proof offset does not match entry",
      );
    }
    const source = makeJsonlCheckpointSource(
      inspection,
      entry.source?.generation ?? 0,
    );
    const inflightSource =
      inflightInspection === undefined
        ? undefined
        : makeJsonlCheckpointSource(
            inflightInspection,
            entry.source?.generation ?? 0,
          );
    await storage.upsertCaptureCheckpoint({
      extractor: CLAUDE_CODE_CHECKPOINT_NAMESPACE,
      resource: path,
      position: entry.offset,
      ...(entry.turn_index >= 0 ? { ordinal: entry.turn_index } : {}),
      state: {
        jsonl_source: source,
        ...(inflightSource !== undefined
          ? { jsonl_inflight_source: inflightSource }
          : {}),
        ...(pageStart !== undefined ? { jsonl_page_start: pageStart } : {}),
        ...(entry.raw_fallback !== undefined
          ? { jsonl_raw_fallback: entry.raw_fallback }
          : {}),
      },
      updated_at: new Date().toISOString(),
    });
    const cached: ClaudeCodeOffsetEntry = { ...entry, source };
    if (pageStart !== undefined) cached.page_start = pageStart;
    else delete cached.page_start;
    if (inflightSource !== undefined) cached.inflight_source = inflightSource;
    else delete cached.inflight_source;
    offsetMap.set(path, cached);
  }

  async function appendRawFallbackFragments(
    path: string,
    snapshot: JsonlReadSnapshot,
    throughOffset: number,
    fallback: JsonlRawFallback,
    generation: number,
  ): Promise<number> {
    return visitJsonlRawFragments(
      path,
      snapshot,
      throughOffset,
      fallback.next_fragment,
      async (fragment, fragmentIndex) => {
        const result = await processExtractorCandidate(
          {
            source: `fs:${path}`,
            timestamp: new Date().toISOString(),
            content: JSONL_RAW_FRAGMENT_CONTENT_PREFIX + fragment.base64,
            metadata: {
              capture_fragment: "oversized_jsonl_cluster",
              fragment_schema: "jsonl_raw_v1",
              extractor: CLAUDE_CODE_CHECKPOINT_NAMESPACE,
              encoding: "base64",
              source_generation: generation,
              group_generation: fallback.group_generation,
              fragment_group: captureDedupeKey("claude-code", [
                "raw-jsonl-fragment-group-v1",
                path,
                fallback.group_generation,
                fallback.cluster_start_offset,
              ]),
              cluster_start_offset: fallback.cluster_start_offset,
              fragment_index: fragmentIndex,
              byte_start: fragment.start_offset,
              byte_through: fragment.through_offset,
              byte_count: fragment.bytes,
              sha256: fragment.sha256,
            },
            dedupe_key: captureDedupeKey("claude-code", [
              "raw-jsonl-fragment-v1",
              path,
              generation,
              fragment.start_offset,
              fragment.through_offset,
              fragment.sha256,
            ]),
          },
          storage,
          capturePolicy,
        );
        if (!result.accepted) {
          throw new Error(`raw JSONL fragment rejected: ${result.reason}`);
        }
      },
    );
  }

  // Per-file watermark: the highest byte_offset of a dropped-user line we've
  // already logged. Without this, every chokidar `change` event re-walks the
  // unconfirmed tail and re-detects the same drops, spamming warnings.
  const dropWatermark = createBoundedResourceCache<number>();

  async function rewindChangedRead(
    path: string,
    durableEntry: ClaudeCodeOffsetEntry,
    sourceAtDurableEntry: JsonlSourceInspection,
    discontinuity: Exclude<ReturnType<typeof classifyJsonlDiscontinuity>, null>,
    changedInspection: JsonlSourceInspection,
    retryAtDurableBoundary: boolean,
  ): Promise<void> {
    if (sourceAtDurableEntry.boundary_offset !== durableEntry.offset) {
      throw new Error("latest durable JSONL proof does not match its entry");
    }
    const boundedPageStart =
      !retryAtDurableBoundary &&
      discontinuity === "page_rewritten" &&
      durableEntry.page_start !== undefined &&
      changedInspection.size >= durableEntry.page_start.offset
        ? durableEntry.page_start
        : undefined;
    const retryOffset = retryAtDurableBoundary
      ? durableEntry.offset
      : (boundedPageStart?.offset ?? 0);
    const current = retryAtDurableBoundary
      ? changedInspection
      : await inspectJsonlSource(path, retryOffset);
    if (current.boundary_offset !== retryOffset) {
      throw new Error("JSONL recovery proof does not match its retry offset");
    }
    const generation = (durableEntry.source?.generation ?? 0) + 1;
    if (!Number.isSafeInteger(generation)) {
      throw new RangeError(
        "JSONL source generation exceeds safe integer range",
      );
    }
    const retry: ClaudeCodeOffsetEntry = {
      offset: retryOffset,
      turn_index: retryAtDurableBoundary
        ? durableEntry.turn_index
        : (boundedPageStart?.turn_index ?? durableEntry.turn_index),
      source: makeJsonlCheckpointSource(current, generation),
    };
    const retryMetadata = retryAtDurableBoundary
      ? durableEntry
      : boundedPageStart;
    if (retryMetadata?.raw_fallback !== undefined) {
      retry.raw_fallback = retryMetadata.raw_fallback;
    }
    await saveCheckpoint(path, retry, current);
    dropWatermark.delete(path);
    log.warn("jsonl_read_retry", {
      path,
      retry_offset: retryOffset,
      generation,
      classification: discontinuity,
      durable_boundary: retryAtDurableBoundary,
    });
  }

  async function handleJsonlChange(path: string): Promise<void> {
    let cur = await loadCheckpoint(path);
    const previousOffset = cur.offset;
    const resumeProof = await inspectJsonlCheckpointProof(
      path,
      cur.offset,
      cur.source,
      cur.inflight_source,
    );
    if (resumeProof.status === "unstable") {
      throw new JsonlSourceChangedError(path);
    }
    let sourceAtResume = resumeProof.inspection;
    if (resumeProof.status === "changed") {
      const { discontinuity, retry_at_durable_boundary: retryAtDurable } =
        resumeProof;
      const generation = (cur.source?.generation ?? 0) + 1;
      const boundedPageStart =
        !retryAtDurable &&
        discontinuity === "page_rewritten" &&
        cur.page_start !== undefined &&
        sourceAtResume.size >= cur.page_start.offset
          ? cur.page_start
          : undefined;
      const resetOffset = retryAtDurable
        ? cur.offset
        : (boundedPageStart?.offset ?? 0);
      sourceAtResume = retryAtDurable
        ? resumeProof.inspection
        : await inspectJsonlSource(path, resetOffset);
      const reset: ClaudeCodeOffsetEntry = {
        offset: resetOffset,
        turn_index: retryAtDurable
          ? cur.turn_index
          : (boundedPageStart?.turn_index ?? cur.turn_index),
        source: makeJsonlCheckpointSource(sourceAtResume, generation),
      };
      const resetMetadata = retryAtDurable ? cur : boundedPageStart;
      if (resetMetadata?.raw_fallback !== undefined) {
        reset.raw_fallback = resetMetadata.raw_fallback;
      }
      cur = reset;
      // Persist the new generation before emitting anything. If this pass is
      // interrupted, replay uses the same deterministic generation key.
      await saveCheckpoint(path, cur, sourceAtResume);
      dropWatermark.delete(path);
      log.warn("jsonl_source_reset", {
        path,
        classification: discontinuity,
        previous_offset: previousOffset,
        current_size: sourceAtResume.size,
        reset_offset: resetOffset,
        generation,
        durable_boundary: retryAtDurable,
      });
    }
    // Keep the catch path aligned with the checkpoint that actually reached
    // storage. A snapshot wrapper can reject during its post-operation check
    // after saveCheckpoint has already committed, so `cur` is not necessarily
    // the latest durable boundary by the time control reaches the catch.
    let latestDurableEntry = cur;
    let latestDurableInspection = sourceAtResume;
    const { turns, newOffset, droppedUsers, readSnapshot, firstUserOffset } =
      await extractClaudeCodeTurns(path, cur.offset);
    try {
      await assertJsonlSourceSnapshotCurrent(path, sourceAtResume);
      const pageStart: ClaudeCodePageStart | undefined =
        readSnapshot === undefined ? cur.page_start : claudeCodePageStart(cur);
      const inflightInspection =
        readSnapshot === undefined
          ? undefined
          : readSnapshot.sourceAt(cur.offset, readSnapshot.through_offset);
      const durableStartInspection =
        readSnapshot === undefined
          ? undefined
          : readSnapshot.sourceAt(cur.offset);
      if (readSnapshot !== undefined) {
        await assertJsonlReadSnapshotCurrent(path, readSnapshot);
        await withJsonlReadSnapshot(path, readSnapshot, async () => {
          await saveCheckpoint(
            path,
            cur,
            durableStartInspection!,
            pageStart,
            inflightInspection,
          );
          latestDurableEntry = offsetMap.get(path) ?? cur;
          latestDurableInspection = durableStartInspection!;
        });
      }
      let rawFallback = cur.raw_fallback;
      if (
        rawFallback !== undefined &&
        readSnapshot !== undefined &&
        firstUserOffset === cur.offset
      ) {
        const resumed: ClaudeCodeOffsetEntry = { ...cur };
        delete resumed.raw_fallback;
        const resumedInspection = readSnapshot.sourceAt(cur.offset);
        await withJsonlReadSnapshot(path, readSnapshot, async () => {
          await saveCheckpoint(
            path,
            resumed,
            resumedInspection,
            pageStart,
            inflightInspection,
          );
        });
        cur = resumed;
        latestDurableEntry = offsetMap.get(path) ?? resumed;
        latestDurableInspection = resumedInspection;
        rawFallback = undefined;
      }
      const startsRawFallback =
        rawFallback === undefined &&
        readSnapshot !== undefined &&
        newOffset === cur.offset &&
        readSnapshot.size - cur.offset > MAX_JSONL_READ_BYTES;
      if (
        readSnapshot !== undefined &&
        (rawFallback !== undefined || startsRawFallback)
      ) {
        const activeFallback = rawFallback ?? {
          cluster_start_offset: cur.offset,
          next_fragment: 0,
          group_generation: cur.source?.generation ?? 0,
        };
        const resumesAtUser =
          rawFallback !== undefined &&
          firstUserOffset !== undefined &&
          firstUserOffset > cur.offset;
        const throughOffset = resumesAtUser
          ? firstUserOffset
          : readSnapshot.through_offset;
        if (throughOffset > cur.offset) {
          const rawInspection = readSnapshot.sourceAt(throughOffset);
          const rawProof = readSnapshot.rangeAt(
            readSnapshot.first_offset,
            throughOffset,
          );
          let nextFragment = activeFallback.next_fragment;
          await withJsonlReadSnapshot(path, rawProof, async () => {
            nextFragment = await appendRawFallbackFragments(
              path,
              readSnapshot,
              throughOffset,
              activeFallback,
              cur.source?.generation ?? 0,
            );
            const rawCheckpoint: ClaudeCodeOffsetEntry = {
              ...cur,
              offset: throughOffset,
              ...(resumesAtUser
                ? {}
                : {
                    raw_fallback: {
                      cluster_start_offset: activeFallback.cluster_start_offset,
                      next_fragment: nextFragment,
                      group_generation: activeFallback.group_generation,
                    },
                  }),
            };
            if (resumesAtUser) delete rawCheckpoint.raw_fallback;
            await saveCheckpoint(path, rawCheckpoint, rawInspection, pageStart);
            latestDurableEntry = offsetMap.get(path) ?? rawCheckpoint;
            latestDurableInspection = rawInspection;
          });
          log.warn("oversized_cluster_fragmented", {
            path,
            cluster_start_offset: activeFallback.cluster_start_offset,
            through_offset: throughOffset,
            fragments_written: nextFragment - activeFallback.next_fragment,
            resumed_at_user: resumesAtUser,
          });
          return;
        }
      }
      const wm = dropWatermark.get(path) ?? -1;
      const fresh = droppedUsers.filter((d) => d.byte_offset > wm);
      if (fresh.length > 0) {
        const session_id = deriveSessionId(path);
        const prompts = fresh.filter((d) => d.classification === "prompt");
        const injects = fresh.filter((d) => d.classification === "inject");
        if (prompts.length > 0) {
          log.warn("user_prompt_dropped_without_assistant_reply", {
            session_id,
            count: prompts.length,
            classification: "prompt",
            total_bytes: prompts.reduce((sum, d) => sum + d.byte_count, 0),
            first_byte_offset: prompts[0]!.byte_offset,
            last_byte_offset: prompts[prompts.length - 1]!.byte_offset,
          });
        }
        if (injects.length > 0) {
          log.debug("user_inject_dropped", {
            session_id,
            count: injects.length,
            classification: "inject",
            total_bytes: injects.reduce((sum, d) => sum + d.byte_count, 0),
            first_byte_offset: injects[0]!.byte_offset,
            last_byte_offset: injects[injects.length - 1]!.byte_offset,
          });
        }
        let maxOffset = wm;
        for (const d of fresh)
          if (d.byte_offset > maxOffset) maxOffset = d.byte_offset;
        dropWatermark.set(path, maxOffset);
      }
      let nextTurnIndex = cur.turn_index + 1;
      for (const turn of turns) {
        const turnSnapshot = readSnapshot?.rangeAt(
          readSnapshot.first_offset,
          turn.byte_offset,
        );
        const metadata: Record<string, unknown> = {
          project: turn.project,
          session_id: turn.session_id,
          turn_index: nextTurnIndex,
          mtime: turn.mtime,
          byte_offset: turn.byte_offset,
        };
        if (turn.had_tool_use) metadata["had_tool_use"] = true;
        if (turn.repo_root !== undefined)
          metadata["repo_root"] = turn.repo_root;
        if (turn.repo_root !== undefined) {
          metadata["canonical_root"] = await resolveCanonicalRoot(
            turn.repo_root,
          );
        }
        if (turn.files_referenced !== undefined)
          metadata["files_referenced"] = turn.files_referenced;
        if (turn.tool_calls !== undefined)
          metadata["tool_calls"] = turn.tool_calls;
        if (turn.tool_call_total !== undefined)
          metadata["tool_call_total"] = turn.tool_call_total;
        if (turn.tool_calls_truncated === true)
          metadata["tool_calls_truncated"] = true;
        if (turn.thinking !== undefined) metadata["thinking"] = turn.thinking;
        if (turn.permission_mode !== undefined)
          metadata["permission_mode"] = turn.permission_mode;
        if (turn.cli_version !== undefined)
          metadata["cli_version"] = turn.cli_version;
        if (turn.model !== undefined) metadata["model"] = turn.model;
        const gitState = await probeGitState(turn.repo_root, turn.timestamp);
        if (gitState !== undefined) {
          metadata["git_state"] = gitState;
        } else if (turn.git_branch_jsonl !== undefined) {
          // Stale (boot-scanned) turn: probe refused, but JSONL gitBranch is
          // the branch the CC client recorded at turn time — strictly better
          // provenance than nothing. Emit a partial GitState with fresh:false
          // so consumers see a uniform shape with Codex's session_meta
          // backfill. head_sha + dirty_count remain unrecoverable: CC JSONL
          // doesn't record commit sha, and dirty status is point-in-time only.
          metadata["git_state"] = {
            captured_at: turn.timestamp,
            fresh: false,
            branch: turn.git_branch_jsonl,
          };
        }
        const branch =
          turn.git_branch_jsonl ?? (await readBranch(turn.repo_root));
        if (branch !== undefined) metadata["branch"] = branch;
        const dedupeParts: (string | number)[] = [
          path,
          turn.session_id,
          turn.byte_offset,
        ];
        if ((cur.source?.generation ?? 0) > 0) {
          dedupeParts.push(`source-generation:${cur.source!.generation}`);
        }
        const candidate = {
          source: `fs:${path}`,
          timestamp: turn.timestamp,
          content: `USER: ${turn.user_message}\n\nASSISTANT: ${turn.assistant_message}`,
          metadata,
          dedupe_key: captureDedupeKey("claude-code", dedupeParts),
        };
        log.info("candidate", {
          session_id: turn.session_id,
          turn_index: nextTurnIndex,
        });
        const appendCandidate = () =>
          processExtractorCandidate(candidate, storage, capturePolicy);
        const result =
          turnSnapshot === undefined
            ? await appendCandidate()
            : await withJsonlReadSnapshot(path, turnSnapshot, appendCandidate);
        if (result.accepted) {
          nextTurnIndex += 1;
        } else {
          log.warn("candidate_rejected", { reason: result.reason, path });
        }
        // Checkpoint per processed turn (cursor.ts's per-turn lastSeenMap.set is
        // the in-tree precedent): a mid-batch throw on a later turn then resumes
        // AFTER this one instead of durably re-appending it on every poll tick.
        const checkpoint: ClaudeCodeOffsetEntry = {
          offset: turn.byte_offset,
          turn_index: nextTurnIndex - 1,
          source: cur.source,
        };
        const turnInspection =
          readSnapshot?.sourceAt(turn.byte_offset) ?? sourceAtResume;
        const persistTurn = async () => {
          await saveCheckpoint(
            path,
            checkpoint,
            turnInspection,
            pageStart,
            inflightInspection,
          );
          latestDurableEntry = offsetMap.get(path) ?? checkpoint;
          latestDurableInspection = turnInspection;
        };
        if (turnSnapshot === undefined) {
          await persistTurn();
        } else {
          await withJsonlReadSnapshot(path, turnSnapshot, persistTurn);
        }
      }
      await assertJsonlSourceSnapshotCurrent(path, sourceAtResume);
      const pageCheckpoint: ClaudeCodeOffsetEntry = {
        offset: newOffset,
        turn_index: nextTurnIndex - 1,
        source: cur.source,
      };
      if (cur.raw_fallback !== undefined) {
        pageCheckpoint.raw_fallback = cur.raw_fallback;
      }
      const pageInspection =
        readSnapshot?.sourceAt(newOffset) ?? sourceAtResume;
      const persistPage = async () => {
        await saveCheckpoint(path, pageCheckpoint, pageInspection, pageStart);
        latestDurableEntry = offsetMap.get(path) ?? pageCheckpoint;
        latestDurableInspection = pageInspection;
      };
      if (readSnapshot === undefined) {
        await persistPage();
      } else {
        await withJsonlReadSnapshot(path, readSnapshot, persistPage);
      }
      await assertJsonlSourceSnapshotCurrent(path, sourceAtResume);
    } catch (err) {
      if (!(err instanceof JsonlSourceChangedError)) throw err;
      const recoveryProof = await inspectJsonlCheckpointProof(
        path,
        latestDurableEntry.offset,
        latestDurableEntry.source,
        latestDurableEntry.inflight_source,
      );
      // A settled append beyond the page is current, while a proof that raced
      // a writer is unstable. Neither may mutate the generation/checkpoint;
      // the serialized queue will retry under the existing deterministic key.
      if (recoveryProof.status !== "changed") throw err;
      await rewindChangedRead(
        path,
        latestDurableEntry,
        latestDurableInspection,
        recoveryProof.discontinuity,
        recoveryProof.inspection,
        recoveryProof.retry_at_durable_boundary,
      );
      throw err;
    }
  }

  const handle = await wireJsonlExtractor({
    prefix: projectsPrefix,
    offsetMap,
    handle: handleJsonlChange,
    getPersistedOffset: async (path) => (await loadCheckpoint(path)).offset,
    isCheckpointCurrent: async (path) => {
      const checkpoint = await loadCheckpoint(path);
      if (checkpoint.source === undefined) return false;
      const proof = await inspectJsonlCheckpointProof(
        path,
        checkpoint.offset,
        checkpoint.source,
        checkpoint.inflight_source,
      );
      return proof.status === "current";
    },
    log,
  });
  log.info("started", { projectsPrefix });
  return {
    initialCatchUp: handle.initialCatchUp,
    getHealth: handle.getHealth,
    stop: async () => {
      await handle.stop();
      log.info("stopped", {});
    },
    probeFreshness: handle.probeFreshness,
  };
}
