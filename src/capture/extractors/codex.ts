import { homedir } from "node:os";
import { basename } from "node:path";
import { isNonEmptyString } from "../../guards.js";
import { createLogger } from "../../logging/index.js";
import type { Storage } from "../../storage/interface.js";
import { probeGitState } from "../git-state.js";
import {
  captureDedupeKey,
  createExtractorFilesystemPolicy,
  processExtractorCandidate,
} from "../pipeline.js";
import {
  projectKeyForCanonicalRoot,
  resolveCanonicalRoot,
} from "../../project-identity.js";
import {
  classifyCodexObservation,
  classifyContextInitiator,
  isValidCodexLogicalTurnId,
  occurredAtFromUuidV7,
  type ContextInitiator,
  type ObservationKind,
} from "../logical-identity.js";
import { CODEX_CHECKPOINT_NAMESPACE } from "../checkpoint-namespaces.js";
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
  readJsonlCheckpointSource,
  readJsonlRawFallback,
  readJsonlTail,
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

const log = createLogger("capture.codex");

const HOME = homedir();
const DEFAULT_SESSIONS_PREFIX = `${HOME}/.codex/sessions/`;
export { CODEX_CHECKPOINT_NAMESPACE } from "../checkpoint-namespaces.js";

export interface CodexGitMeta {
  sha?: string;
  branch?: string;
  origin_url?: string;
}

export interface CodexSessionMeta {
  source?: string;
  cli_version?: string;
  model_provider?: string;
  model?: string;
  reasoning_effort?: string;
  personality?: string;
  approval_policy?: string;
  sandbox_policy_type?: string;
  sandbox_network_access?: boolean;
  sandbox_writable_roots?: string[];
  sandbox_exclude_tmpdir_env_var?: boolean;
  sandbox_exclude_slash_tmp?: boolean;
  permission_profile_type?: string;
  permission_file_system_type?: string;
  permission_network?: string;
  file_system_sandbox_kind?: string;
  /** Physical Codex thread represented by this JSONL file. */
  thread_id?: string;
  /** Root founder thread. Codex carries this directly as session_id. */
  root_thread_id?: string;
  parent_thread_id?: string;
  forked_from_id?: string;
  thread_kind?: "root" | "subagent" | "unknown";
  agent_path?: string;
  agent_depth?: number;
  agent_nickname?: string;
  history_mode?: string;
  session_started_at?: string;
}

export interface CodexTurn {
  session_id: string;
  turn_index: number;
  user_message: string;
  assistant_message: string;
  cwd?: string;
  mtime: number;
  timestamp: string;
  had_tool_use: boolean;
  byte_offset: number; // file offset just past the LAST line consumed for this turn
  git?: CodexGitMeta;
  codex?: CodexSessionMeta;
  tool_calls?: ToolCall[];
  tool_call_total?: number;
  tool_calls_truncated?: boolean;
  files_referenced?: string[];
  thinking?: string;
  git_state?: GitState;
  logical_turn_id?: string;
  observed_at?: string;
  occurred_at?: string;
  observation_kind?: ObservationKind;
  initiator?: ContextInitiator;
}

export interface ExtractCodexResult {
  turns: CodexTurn[];
  newOffset: number;
  readSnapshot?: JsonlReadSnapshot;
  firstUserOffset?: number;
  firstUserCwd?: string;
  firstUserGit?: CodexGitMeta;
  firstUserCodex?: CodexSessionMeta;
  cwd?: string;
  git?: CodexGitMeta;
  codex?: CodexSessionMeta;
}

interface ParsedLine {
  kind:
    | "message"
    | "tool_call"
    | "tool_output"
    | "reasoning"
    | "session_meta"
    | "turn_context"
    | "inter_agent_metadata"
    | "task_complete"
    | "other";
  role?: "user" | "assistant" | "agent";
  text?: string;
  turn_id?: string;
  logical_identity_conflict?: boolean;
  trigger_turn?: boolean;
  recipient?: string;
  cwd?: string;
  timestamp?: string;
  git?: CodexGitMeta;
  // session_meta-derived fields (subset of CodexSessionMeta)
  source?: string;
  cli_version?: string;
  model_provider?: string;
  // turn_context-derived fields (subset of CodexSessionMeta)
  model?: string;
  reasoning_effort?: string;
  personality?: string;
  approval_policy?: string;
  sandbox_policy_type?: string;
  sandbox_network_access?: boolean;
  sandbox_writable_roots?: string[];
  sandbox_exclude_tmpdir_env_var?: boolean;
  sandbox_exclude_slash_tmp?: boolean;
  permission_profile_type?: string;
  permission_file_system_type?: string;
  permission_network?: string;
  file_system_sandbox_kind?: string;
  thread_id?: string;
  root_thread_id?: string;
  parent_thread_id?: string;
  forked_from_id?: string;
  thread_kind?: "root" | "subagent" | "unknown";
  agent_path?: string;
  agent_depth?: number;
  agent_nickname?: string;
  history_mode?: string;
  session_started_at?: string;
  // Tool / reasoning payload extras
  tool_call_name?: string;
  tool_call_args?: string;
  tool_call_id?: string;
  tool_output?: string;
  tool_is_error?: boolean;
  reasoning_text?: string;
}

function extractMessageText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (typeof block !== "object" || block === null) continue;
    const b = block as Record<string, unknown>;
    const t = b["type"];
    if (
      (t === "input_text" || t === "output_text") &&
      typeof b["text"] === "string"
    ) {
      parts.push(b["text"]);
    }
  }
  return parts.join("");
}

function turnIdFromPayload(payload: Record<string, unknown>): {
  turnId?: string;
  conflict: boolean;
} {
  const direct = payload["turn_id"];
  const passthrough = payload["internal_chat_message_metadata_passthrough"];
  const passthroughRecord =
    typeof passthrough === "object" && passthrough !== null
      ? (passthrough as Record<string, unknown>)
      : undefined;
  const passthroughTurnId =
    passthroughRecord === undefined ? undefined : passthroughRecord["turn_id"];
  const directId = isValidCodexLogicalTurnId(direct) ? direct : undefined;
  const nestedId = isValidCodexLogicalTurnId(passthroughTurnId)
    ? passthroughTurnId
    : undefined;
  const hasDirect = Object.prototype.hasOwnProperty.call(payload, "turn_id");
  const hasNested =
    passthroughRecord !== undefined &&
    Object.prototype.hasOwnProperty.call(passthroughRecord, "turn_id");
  if (
    (hasDirect && directId === undefined) ||
    (hasNested && nestedId === undefined)
  ) {
    return { conflict: true };
  }
  if (hasDirect && hasNested && directId !== nestedId) {
    return { conflict: true };
  }
  const turnId = directId ?? nestedId;
  return turnId === undefined
    ? { conflict: false }
    : { turnId, conflict: false };
}

interface StringEvidence {
  malformed: boolean;
  value?: string;
}

function stringEvidence(
  record: Record<string, unknown>,
  key: string,
): StringEvidence {
  if (!Object.prototype.hasOwnProperty.call(record, key)) {
    return { malformed: false };
  }
  const raw = record[key];
  if (!isNonEmptyString(raw) || raw.trim().length === 0) {
    return { malformed: true };
  }
  return { malformed: false, value: raw };
}

function reconcileStringEvidence(...evidence: readonly StringEvidence[]): {
  value?: string;
  conflict: boolean;
} {
  let value: string | undefined;
  for (const candidate of evidence) {
    if (candidate.malformed) return { conflict: true };
    if (candidate.value === undefined) continue;
    if (value !== undefined && value !== candidate.value) {
      return { conflict: true };
    }
    value = candidate.value;
  }
  return value === undefined ? { conflict: false } : { value, conflict: false };
}

function parseLine(line: string): ParsedLine | null {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof raw !== "object" || raw === null) return null;
  const obj = raw as Record<string, unknown>;
  const t = obj["type"];
  const ts = obj["timestamp"];
  const timestamp = typeof ts === "string" ? ts : undefined;

  if (t === "session_meta") {
    const payload = obj["payload"];
    const out: ParsedLine = { kind: "session_meta", timestamp };
    if (typeof payload === "object" && payload !== null) {
      const p = payload as Record<string, unknown>;
      const physicalThread = stringEvidence(p, "id");
      const rootThread = stringEvidence(p, "session_id");
      const topParentThread = stringEvidence(p, "parent_thread_id");
      const forkedFrom = stringEvidence(p, "forked_from_id");
      const threadSource = p["thread_source"];
      const topAgentPath = stringEvidence(p, "agent_path");
      const historyMode = p["history_mode"];
      if (isNonEmptyString(historyMode)) out.history_mode = historyMode;
      const sessionStartedAt = p["timestamp"];
      if (isNonEmptyString(sessionStartedAt))
        out.session_started_at = sessionStartedAt;
      else if (timestamp !== undefined) out.session_started_at = timestamp;
      const sourceMeta = p["source"];
      let hasSubagentSource = false;
      let nestedParentThread: StringEvidence = {
        malformed: false,
      };
      let nestedAgentPath: StringEvidence = {
        malformed: false,
      };
      if (typeof sourceMeta === "object" && sourceMeta !== null) {
        const sourceRecord = sourceMeta as Record<string, unknown>;
        const subagent = sourceRecord["subagent"];
        if (typeof subagent === "object" && subagent !== null) {
          hasSubagentSource = true;
          const subagentRecord = subagent as Record<string, unknown>;
          const spawn = subagentRecord["thread_spawn"];
          if (typeof spawn === "object" && spawn !== null) {
            const spawnMeta = spawn as Record<string, unknown>;
            nestedParentThread = stringEvidence(spawnMeta, "parent_thread_id");
            nestedAgentPath = stringEvidence(spawnMeta, "agent_path");
            const depth = spawnMeta["depth"];
            if (
              typeof depth === "number" &&
              Number.isSafeInteger(depth) &&
              depth >= 0
            ) {
              out.agent_depth = depth;
            }
            const nickname = spawnMeta["agent_nickname"];
            if (isNonEmptyString(nickname)) out.agent_nickname = nickname;
          }
        }
      }
      const parentThread = reconcileStringEvidence(
        topParentThread,
        nestedParentThread,
      );
      const agentPath = reconcileStringEvidence(topAgentPath, nestedAgentPath);
      const parentForkConflict =
        parentThread.value !== undefined &&
        forkedFrom.value !== undefined &&
        parentThread.value !== forkedFrom.value;
      const lineageConflict =
        physicalThread.malformed ||
        rootThread.malformed ||
        parentThread.conflict ||
        agentPath.conflict ||
        forkedFrom.malformed ||
        parentForkConflict;
      const hasSubagentEvidence =
        threadSource === "subagent" ||
        hasSubagentSource ||
        parentThread.value !== undefined ||
        forkedFrom.value !== undefined ||
        agentPath.value !== undefined;
      const stableSubagentIdentity =
        !lineageConflict &&
        hasSubagentEvidence &&
        (threadSource === undefined || threadSource === "subagent") &&
        physicalThread.value !== undefined &&
        rootThread.value !== undefined &&
        physicalThread.value !== rootThread.value;
      const stableRootIdentity =
        !lineageConflict &&
        !hasSubagentEvidence &&
        (threadSource === undefined ||
          threadSource === "root" ||
          threadSource === "user") &&
        physicalThread.value !== undefined &&
        (rootThread.value === undefined ||
          rootThread.value === physicalThread.value);
      if (stableSubagentIdentity) {
        out.thread_id = physicalThread.value;
        out.root_thread_id = rootThread.value;
        if (parentThread.value !== undefined) {
          out.parent_thread_id = parentThread.value;
        }
        if (forkedFrom.value !== undefined) {
          out.forked_from_id = forkedFrom.value;
        }
        if (agentPath.value !== undefined) out.agent_path = agentPath.value;
        out.thread_kind = "subagent";
      } else if (stableRootIdentity) {
        out.thread_id = physicalThread.value;
        out.root_thread_id = physicalThread.value;
        out.thread_kind = "root";
      } else {
        // Never promote incomplete, malformed, or contradictory lineage into
        // topology or recipient matching.
        out.thread_kind = "unknown";
      }
      const c = p["cwd"];
      if (isNonEmptyString(c)) out.cwd = c;
      const src = p["source"];
      if (isNonEmptyString(src)) out.source = src;
      const cv = p["cli_version"];
      if (isNonEmptyString(cv)) out.cli_version = cv;
      const mp = p["model_provider"];
      if (isNonEmptyString(mp)) out.model_provider = mp;
      const git = p["git"];
      if (typeof git === "object" && git !== null) {
        const g = git as Record<string, unknown>;
        const gm: CodexGitMeta = {};
        const sha = g["commit_hash"];
        if (isNonEmptyString(sha)) gm.sha = sha;
        const br = g["branch"];
        if (isNonEmptyString(br)) gm.branch = br;
        const url = g["repository_url"];
        if (isNonEmptyString(url)) gm.origin_url = url;
        if (Object.keys(gm).length > 0) out.git = gm;
      }
    }
    return out;
  }

  if (t === "turn_context") {
    const payload = obj["payload"];
    const out: ParsedLine = { kind: "turn_context", timestamp };
    if (typeof payload === "object" && payload !== null) {
      const p = payload as Record<string, unknown>;
      const identity = turnIdFromPayload(p);
      if (identity.turnId !== undefined) out.turn_id = identity.turnId;
      if (identity.conflict) out.logical_identity_conflict = true;
      const c = p["cwd"];
      if (isNonEmptyString(c)) out.cwd = c;
      const m = p["model"];
      if (isNonEmptyString(m)) out.model = m;
      const eff = p["effort"];
      if (isNonEmptyString(eff)) out.reasoning_effort = eff;
      const pers = p["personality"];
      if (isNonEmptyString(pers)) out.personality = pers;
      const ap = p["approval_policy"];
      if (isNonEmptyString(ap)) out.approval_policy = ap;
      const sp = p["sandbox_policy"];
      if (typeof sp === "object" && sp !== null) {
        const spr = sp as Record<string, unknown>;
        const spt = spr["type"];
        if (isNonEmptyString(spt)) out.sandbox_policy_type = spt;
        const sna = spr["network_access"];
        if (typeof sna === "boolean") out.sandbox_network_access = sna;
        const roots = spr["writable_roots"];
        if (Array.isArray(roots)) {
          out.sandbox_writable_roots = dedupStrings(
            roots.filter(isNonEmptyString),
          );
        }
        const excludeTmpdir = spr["exclude_tmpdir_env_var"];
        if (typeof excludeTmpdir === "boolean")
          out.sandbox_exclude_tmpdir_env_var = excludeTmpdir;
        const excludeSlashTmp = spr["exclude_slash_tmp"];
        if (typeof excludeSlashTmp === "boolean")
          out.sandbox_exclude_slash_tmp = excludeSlashTmp;
      }
      const pp = p["permission_profile"];
      if (typeof pp === "object" && pp !== null) {
        const ppr = pp as Record<string, unknown>;
        const ppt = ppr["type"];
        if (isNonEmptyString(ppt)) out.permission_profile_type = ppt;
        const fs = ppr["file_system"];
        if (typeof fs === "object" && fs !== null) {
          const fst = (fs as Record<string, unknown>)["type"];
          if (isNonEmptyString(fst)) out.permission_file_system_type = fst;
        }
        const pn = ppr["network"];
        if (isNonEmptyString(pn)) out.permission_network = pn;
      }
      const fssp = p["file_system_sandbox_policy"];
      if (typeof fssp === "object" && fssp !== null) {
        const kind = (fssp as Record<string, unknown>)["kind"];
        if (isNonEmptyString(kind)) out.file_system_sandbox_kind = kind;
      }
    }
    return out;
  }

  if (t === "event_msg") {
    const payload = obj["payload"];
    if (typeof payload === "object" && payload !== null) {
      const p = payload as Record<string, unknown>;
      if (p["type"] === "task_complete") {
        return { kind: "task_complete", timestamp };
      }
    }
    return { kind: "other", timestamp };
  }

  if (t === "inter_agent_communication_metadata") {
    const payload = obj["payload"];
    const triggerTurn =
      typeof payload === "object" && payload !== null
        ? (payload as Record<string, unknown>)["trigger_turn"]
        : undefined;
    return {
      kind: "inter_agent_metadata",
      timestamp,
      ...(typeof triggerTurn === "boolean"
        ? { trigger_turn: triggerTurn }
        : {}),
    };
  }

  if (t !== "response_item") return { kind: "other", timestamp };
  const payload = obj["payload"];
  if (typeof payload !== "object" || payload === null)
    return { kind: "other", timestamp };
  const p = payload as Record<string, unknown>;
  const ptype = p["type"];

  if (ptype === "agent_message") {
    const recipient = p["recipient"];
    const identity = turnIdFromPayload(p);
    return {
      kind: "message",
      role: "agent",
      text: extractMessageText(p["content"]),
      timestamp,
      ...(identity.turnId !== undefined ? { turn_id: identity.turnId } : {}),
      ...(identity.conflict ? { logical_identity_conflict: true } : {}),
      ...(isNonEmptyString(recipient) ? { recipient } : {}),
    };
  }

  if (ptype === "reasoning") {
    const out: ParsedLine = { kind: "reasoning", timestamp };
    const summary = p["summary"];
    if (Array.isArray(summary)) {
      const parts: string[] = [];
      for (const s of summary) {
        if (typeof s === "object" && s !== null) {
          const sb = s as Record<string, unknown>;
          if (typeof sb["text"] === "string") parts.push(sb["text"]);
        } else if (typeof s === "string") {
          parts.push(s);
        }
      }
      if (parts.length > 0) out.reasoning_text = parts.join("\n");
    } else if (typeof p["text"] === "string") {
      out.reasoning_text = p["text"];
    }
    return out;
  }

  if (ptype === "function_call" || ptype === "custom_tool_call") {
    const out: ParsedLine = { kind: "tool_call", timestamp };
    if (isNonEmptyString(p["name"])) out.tool_call_name = p["name"];
    const args = p["arguments"];
    if (typeof args === "string") out.tool_call_args = args;
    else if (args !== undefined && args !== null)
      out.tool_call_args = JSON.stringify(args);
    if (isNonEmptyString(p["call_id"])) out.tool_call_id = p["call_id"];
    return out;
  }

  if (ptype === "function_call_output" || ptype === "custom_tool_call_output") {
    const out: ParsedLine = { kind: "tool_output", timestamp };
    if (isNonEmptyString(p["call_id"])) out.tool_call_id = p["call_id"];
    const o = p["output"];
    if (typeof o === "string") {
      out.tool_output = o;
    } else if (typeof o === "object" && o !== null) {
      const od = o as Record<string, unknown>;
      if (typeof od["content"] === "string") out.tool_output = od["content"];
      else if (typeof od["text"] === "string") out.tool_output = od["text"];
      const md = od["metadata"];
      if (typeof md === "object" && md !== null) {
        const ec = (md as Record<string, unknown>)["exit_code"];
        if (typeof ec === "number" && ec !== 0) out.tool_is_error = true;
      }
    }
    if (
      out.tool_output !== undefined &&
      /Process exited with code (?!0\b)\d+/.test(out.tool_output)
    ) {
      out.tool_is_error = true;
    }
    return out;
  }

  if (ptype !== "message") return { kind: "other", timestamp };
  const role = p["role"];
  if (role !== "user" && role !== "assistant")
    return { kind: "other", timestamp };
  const identity = turnIdFromPayload(p);
  return {
    kind: "message",
    role,
    text: extractMessageText(p["content"]),
    timestamp,
    ...(identity.turnId !== undefined ? { turn_id: identity.turnId } : {}),
    ...(identity.conflict ? { logical_identity_conflict: true } : {}),
  };
}

function deriveSessionId(jsonlPath: string): string {
  const rolloutThreadId = deriveRolloutPhysicalThreadId(jsonlPath);
  if (rolloutThreadId !== undefined) return rolloutThreadId;
  const base = basename(jsonlPath);
  return base.endsWith(".jsonl") ? base.slice(0, -".jsonl".length) : base;
}

function deriveRolloutPhysicalThreadId(jsonlPath: string): string | undefined {
  const base = basename(jsonlPath);
  // rollout-<ISO>-<uuid>.jsonl → take the trailing UUID. Generic fixture and
  // imported filenames intentionally retain header-only identity fallback.
  const m = base.match(
    /^rollout-.*-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/,
  );
  return m?.[1];
}

interface PendingToolCall {
  name: string;
  args?: string;
  call_id?: string;
  output?: string;
  is_error?: boolean;
}

interface PendingCluster {
  clusterStartOffset: number;
  userText: string;
  userTimestamp: string;
  assistantTexts: string[];
  assistantLastLineEndOffset: number;
  hadTool: boolean;
  timestamp: string;
  cwd?: string;
  git?: CodexGitMeta;
  codex?: CodexSessionMeta;
  toolCalls: PendingToolCall[];
  toolCallTotal: number;
  files: string[];
  thinking: string[];
  contextTurnId?: string;
  userTurnId?: string;
  assistantTurnId?: string;
  logicalIdentityConflict: boolean;
  initiator: ContextInitiator;
  localTrigger: boolean;
}

interface QueuedTurnIdentity {
  startOffset: number;
  turnId?: string;
  conflict: boolean;
}

function mergeQueuedTurnIdentity(
  current: QueuedTurnIdentity | undefined,
  input: { startOffset: number; turnId?: string; conflict: boolean },
): QueuedTurnIdentity {
  const turnId = current?.turnId ?? input.turnId;
  const conflict =
    current?.conflict === true ||
    input.conflict ||
    (current?.turnId !== undefined &&
      input.turnId !== undefined &&
      current.turnId !== input.turnId);
  return {
    startOffset: Math.min(
      current?.startOffset ?? input.startOffset,
      input.startOffset,
    ),
    ...(turnId !== undefined ? { turnId } : {}),
    conflict,
  };
}

const PATCH_FILE_RE = /^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm;
const PATCH_MOVE_RE = /^\*\*\* Move to: (.+)$/gm;

function collectPatchFileRefs(s: string): string[] {
  const out: string[] = [];
  for (const re of [PATCH_FILE_RE, PATCH_MOVE_RE]) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(s)) !== null) {
      const path = m[1]?.trim();
      if (path !== undefined && path.length > 0) out.push(path);
    }
  }
  return out;
}

function collectStructuredFileRefs(value: unknown, out: string[]): void {
  if (typeof value === "string") {
    out.push(...collectPatchFileRefs(value));
    return;
  }
  if (Array.isArray(value)) {
    for (const v of value) collectStructuredFileRefs(v, out);
    return;
  }
  if (typeof value !== "object" || value === null) return;
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (
      (FILE_INPUT_KEYS as readonly string[]).includes(k) &&
      typeof v === "string" &&
      v.length > 0
    ) {
      out.push(v);
    }
    collectStructuredFileRefs(v, out);
  }
}

function extractFileRefsFromToolArgs(argsRaw: string | undefined): string[] {
  if (argsRaw === undefined || argsRaw.length === 0) return [];
  const refs = collectPatchFileRefs(argsRaw);
  try {
    collectStructuredFileRefs(JSON.parse(argsRaw), refs);
  } catch {
    // Non-JSON custom tool payloads are common; patch headers above still apply.
  }
  return dedupStrings(refs);
}

type CodexMetaValue = string | number | boolean | string[] | undefined;

function sameStringArray(a: string[] | undefined, b: string[]): boolean {
  return (
    a !== undefined && a.length === b.length && a.every((v, i) => v === b[i])
  );
}

function mergeCodexMeta(
  base: CodexSessionMeta | undefined,
  patch: Partial<CodexSessionMeta>,
): CodexSessionMeta | undefined {
  const next: CodexSessionMeta = { ...(base ?? {}) };
  let changed = false;
  const mutableNext = next as Record<keyof CodexSessionMeta, CodexMetaValue>;
  for (const [k, raw] of Object.entries(patch) as [
    keyof CodexSessionMeta,
    CodexMetaValue,
  ][]) {
    let v: CodexMetaValue = raw;
    if (typeof v === "string" && !isNonEmptyString(v)) continue;
    if (Array.isArray(v)) {
      v = dedupStrings(v.filter(isNonEmptyString));
      if (v.length === 0) continue;
      if (sameStringArray(next[k] as string[] | undefined, v)) continue;
    } else if (v === undefined || next[k] === v) {
      continue;
    }
    mutableNext[k] = v;
    changed = true;
  }
  if (!changed && base !== undefined) return base;
  return Object.keys(next).length > 0 ? next : undefined;
}

function codexMetaPatch(parsed: ParsedLine): Partial<CodexSessionMeta> {
  return {
    source: parsed.source,
    cli_version: parsed.cli_version,
    model_provider: parsed.model_provider,
    thread_id: parsed.thread_id,
    root_thread_id: parsed.root_thread_id,
    parent_thread_id: parsed.parent_thread_id,
    forked_from_id: parsed.forked_from_id,
    thread_kind: parsed.thread_kind,
    agent_path: parsed.agent_path,
    agent_depth: parsed.agent_depth,
    agent_nickname: parsed.agent_nickname,
    history_mode: parsed.history_mode,
    session_started_at: parsed.session_started_at,
  };
}

interface CodexSessionHeader {
  cwd?: string;
  git?: CodexGitMeta;
  codex?: CodexSessionMeta;
}

/** Recover only the first session_meta record through the extractor's proven,
 * 4 MiB-bounded reader. This upgrades old nonzero checkpoints without
 * replaying historical turns or introducing a second filesystem reader. */
async function readCodexSessionHeader(
  jsonlPath: string,
): Promise<CodexSessionHeader | null> {
  const head = await readJsonlTail(jsonlPath, 0, log);
  if (head === null) return null;
  if (head.snapshot !== undefined) {
    await assertJsonlReadSnapshotCurrent(jsonlPath, head.snapshot);
  }
  const firstLine = head.lines[0];
  const parsed = firstLine === undefined ? null : parseLine(firstLine);
  if (parsed === null || parsed.kind !== "session_meta") {
    return { codex: { thread_kind: "unknown" } };
  }
  const header: CodexSessionHeader = {
    codex: reconcileCodexPhysicalSession(
      mergeCodexMeta(undefined, codexMetaPatch(parsed)),
      deriveRolloutPhysicalThreadId(jsonlPath),
    ),
  };
  if (parsed.cwd !== undefined) header.cwd = parsed.cwd;
  if (parsed.git !== undefined) header.git = parsed.git;
  return header;
}

function codexLineagePatch(
  meta: CodexSessionMeta | undefined,
): Partial<CodexSessionMeta> {
  if (meta === undefined) return {};
  return {
    thread_id: meta.thread_id,
    root_thread_id: meta.root_thread_id,
    parent_thread_id: meta.parent_thread_id,
    forked_from_id: meta.forked_from_id,
    thread_kind: meta.thread_kind,
    agent_path: meta.agent_path,
    agent_depth: meta.agent_depth,
    agent_nickname: meta.agent_nickname,
    history_mode: meta.history_mode,
    session_started_at: meta.session_started_at,
  };
}

const CODEX_LINEAGE_KEYS = [
  "thread_id",
  "root_thread_id",
  "parent_thread_id",
  "forked_from_id",
  "thread_kind",
  "agent_path",
  "agent_depth",
  "agent_nickname",
  "history_mode",
  "session_started_at",
] as const satisfies readonly (keyof CodexSessionMeta)[];

/** Lineage is one trust unit. Replacing it field-by-field can combine a new
 * classification with identifiers left behind by older contradictory
 * evidence, so clear the entire unit before accepting one source. */
function replaceCodexLineage(
  base: CodexSessionMeta | undefined,
  source: CodexSessionMeta | Partial<CodexSessionMeta> | undefined,
): CodexSessionMeta | undefined {
  const next: CodexSessionMeta = { ...(base ?? {}) };
  const mutableNext = next as Record<keyof CodexSessionMeta, CodexMetaValue>;
  for (const key of CODEX_LINEAGE_KEYS) delete mutableNext[key];
  if (source !== undefined) {
    for (const key of CODEX_LINEAGE_KEYS) {
      const value = source[key];
      if (value !== undefined) mutableNext[key] = value;
    }
  }
  return Object.keys(next).length > 0 ? next : undefined;
}

/** A canonical rollout filename and its first physical session header are two
 * independent observations of the same Codex thread. Never promote lineage
 * when they disagree. Generic/imported filenames intentionally retain the
 * header-only fallback used by supported capture imports. */
function reconcileCodexPhysicalSession(
  meta: CodexSessionMeta | undefined,
  expectedThreadId: string | undefined,
): CodexSessionMeta | undefined {
  if (meta === undefined || expectedThreadId === undefined) return meta;
  if (meta.thread_kind === "unknown") {
    const hasStaleLineage = CODEX_LINEAGE_KEYS.some(
      (key) => key !== "thread_kind" && meta[key] !== undefined,
    );
    return hasStaleLineage
      ? replaceCodexLineage(meta, { thread_kind: "unknown" })
      : meta;
  }
  if (meta.thread_id === undefined) {
    return meta.thread_kind === "root" || meta.thread_kind === "subagent"
      ? replaceCodexLineage(meta, { thread_kind: "unknown" })
      : meta;
  }
  if (meta.thread_id.toLowerCase() === expectedThreadId.toLowerCase()) {
    return meta;
  }
  return replaceCodexLineage(meta, { thread_kind: "unknown" });
}

function samePhysicalCodexSession(
  current: Partial<CodexSessionMeta>,
  incoming: Partial<CodexSessionMeta>,
): boolean {
  return (
    (current.thread_kind === "root" || current.thread_kind === "subagent") &&
    current.thread_kind === incoming.thread_kind &&
    current.thread_id !== undefined &&
    current.thread_id === incoming.thread_id &&
    current.root_thread_id !== undefined &&
    current.root_thread_id === incoming.root_thread_id
  );
}

function hasCodexLineageConflict(
  current: Partial<CodexSessionMeta>,
  incoming: Partial<CodexSessionMeta>,
): boolean {
  return CODEX_LINEAGE_KEYS.some((key) => {
    const before = current[key];
    const after = incoming[key];
    return before !== undefined && after !== undefined && before !== after;
  });
}

/** A subagent JSONL starts with its physical child header, then may contain
 * copied session_meta records from inherited ancestry. Those records are
 * history and must not replace the identity of the file being captured. */
function isCopiedCodexAncestor(
  current: Partial<CodexSessionMeta>,
  incoming: Partial<CodexSessionMeta>,
): boolean {
  if (
    current.thread_kind !== "subagent" ||
    current.root_thread_id === undefined
  ) {
    return false;
  }
  if (incoming.thread_kind === "root") {
    return (
      incoming.thread_id === current.root_thread_id &&
      incoming.root_thread_id === current.root_thread_id
    );
  }
  if (
    incoming.thread_kind !== "subagent" ||
    incoming.root_thread_id !== current.root_thread_id ||
    incoming.thread_id === undefined
  ) {
    return false;
  }
  return (
    incoming.thread_id === current.parent_thread_id ||
    incoming.thread_id === current.forked_from_id
  );
}

function mergeCodexSessionMeta(
  current: CodexSessionMeta | undefined,
  incoming: Partial<CodexSessionMeta>,
  expectedPhysicalThreadId: string | undefined,
): CodexSessionMeta | undefined {
  const merged = mergeCodexMeta(current, incoming);
  const currentLineage = codexLineagePatch(current);
  const incomingLineage = codexLineagePatch(incoming);

  if (currentLineage.thread_kind === undefined) {
    return reconcileCodexPhysicalSession(
      replaceCodexLineage(merged, incomingLineage),
      expectedPhysicalThreadId,
    );
  }
  if (
    currentLineage.thread_kind === "unknown" ||
    incomingLineage.thread_kind === undefined ||
    incomingLineage.thread_kind === "unknown"
  ) {
    return replaceCodexLineage(merged, { thread_kind: "unknown" });
  }
  if (isCopiedCodexAncestor(currentLineage, incomingLineage)) {
    return replaceCodexLineage(merged, currentLineage);
  }
  if (
    samePhysicalCodexSession(currentLineage, incomingLineage) &&
    !hasCodexLineageConflict(currentLineage, incomingLineage)
  ) {
    return replaceCodexLineage(merged, currentLineage);
  }
  return replaceCodexLineage(merged, { thread_kind: "unknown" });
}

function gitStateFromCodexGit(
  git: CodexGitMeta | undefined,
  timestamp: string,
): GitState | undefined {
  if (git === undefined) return undefined;
  const state: GitState = { captured_at: timestamp, fresh: false };
  if (isNonEmptyString(git.sha)) state.head_sha = git.sha;
  if (isNonEmptyString(git.branch)) state.branch = git.branch;
  if (state.head_sha === undefined && state.branch === undefined)
    return undefined;
  return state;
}

export interface ExtractCodexInput {
  lastKnownCwd?: string;
  lastKnownGit?: CodexGitMeta;
  lastKnownCodex?: CodexSessionMeta;
}

export async function extractCodexTurns(
  jsonlPath: string,
  lastByteOffset: number,
  input: ExtractCodexInput = {},
): Promise<ExtractCodexResult> {
  const tail = await readJsonlTail(jsonlPath, lastByteOffset, log);
  if (tail === null) return { turns: [], newOffset: lastByteOffset };
  const {
    lines,
    lineEndOffsets,
    firstLineOffset,
    mtimeMs: fileMtime,
    snapshot: readSnapshot,
  } = tail;
  if (lines.length === 0) {
    return {
      turns: [],
      newOffset: lastByteOffset,
      ...(readSnapshot !== undefined ? { readSnapshot } : {}),
    };
  }
  const session_id = deriveSessionId(jsonlPath);
  const expectedPhysicalThreadId = deriveRolloutPhysicalThreadId(jsonlPath);

  const turns: CodexTurn[] = [];
  let pending: PendingCluster | null = null;
  let queuedTurnIdentity: QueuedTurnIdentity | undefined;
  let queuedTurnIdentityIsAgentAssociated = false;
  let nextAgentMessageTriggersTurn = false;
  let triggerMarkerStartOffset: number | undefined;
  let cwd: string | undefined = input.lastKnownCwd;
  let git: CodexGitMeta | undefined = input.lastKnownGit;
  let codexMeta: CodexSessionMeta | undefined = reconcileCodexPhysicalSession(
    input.lastKnownCodex,
    expectedPhysicalThreadId,
  );
  // Tracks the END of the last line that contributed to an EMITTED turn.
  // Pending-cluster lines (user + assistants without a closing next-user) are
  // intentionally NOT past confirmedThroughOffset, so the next pass re-reads
  // them and rebuilds the pending cluster from scratch.
  let confirmedThroughOffset = lastByteOffset;
  let firstUserOffset: number | undefined;
  let firstUserCwd: string | undefined;
  let firstUserGit: CodexGitMeta | undefined;
  let firstUserCodex: CodexSessionMeta | undefined;

  function markSafeThrough(offset: number): void {
    if (
      pending === null &&
      queuedTurnIdentity === undefined &&
      !nextAgentMessageTriggersTurn &&
      offset > confirmedThroughOffset
    ) {
      confirmedThroughOffset = offset;
    }
  }

  function clearPendingAgentTrigger(): void {
    nextAgentMessageTriggersTurn = false;
    triggerMarkerStartOffset = undefined;
  }

  function invalidatePendingAgentTrigger(): void {
    clearPendingAgentTrigger();
    if (queuedTurnIdentityIsAgentAssociated) {
      queuedTurnIdentity = undefined;
      queuedTurnIdentityIsAgentAssociated = false;
    }
  }

  function emitPendingIfComplete(): void {
    if (pending === null) return;
    if (pending.assistantTexts.length === 0) return;
    const turn: CodexTurn = {
      session_id,
      turn_index: turns.length,
      user_message: pending.userText,
      assistant_message: pending.assistantTexts.join("\n\n"),
      mtime: fileMtime,
      timestamp: pending.timestamp,
      had_tool_use: pending.hadTool,
      byte_offset: pending.assistantLastLineEndOffset,
    };
    const logicalIds = [
      pending.contextTurnId,
      pending.userTurnId,
      pending.assistantTurnId,
    ].filter((id): id is string => id !== undefined);
    const logicalIdentityConflict =
      pending.logicalIdentityConflict || new Set(logicalIds).size > 1;
    const logicalTurnId = logicalIdentityConflict
      ? undefined
      : (pending.assistantTurnId ??
        pending.userTurnId ??
        pending.contextTurnId);
    if (logicalTurnId !== undefined) {
      turn.logical_turn_id = logicalTurnId;
      const occurredAt = occurredAtFromUuidV7(logicalTurnId);
      if (occurredAt !== undefined) turn.occurred_at = occurredAt;
    }
    if (turn.occurred_at === undefined)
      turn.occurred_at = pending.userTimestamp;
    turn.observed_at = pending.timestamp;
    turn.initiator = pending.initiator;
    turn.observation_kind = classifyCodexObservation({
      threadKind: pending.codex?.thread_kind,
      sessionStartedAt: pending.codex?.session_started_at,
      logicalTurnId,
      userTurnId: pending.userTurnId,
      assistantTurnId: pending.assistantTurnId,
      localTrigger: pending.localTrigger,
      logicalIdentityConflict,
    });
    if (pending.cwd !== undefined) turn.cwd = pending.cwd;
    if (pending.git !== undefined) turn.git = pending.git;
    if (pending.codex !== undefined) turn.codex = pending.codex;
    if (pending.toolCalls.length > 0) {
      turn.tool_calls = pending.toolCalls.map((p) =>
        buildToolCall({
          name: p.name,
          call_id: p.call_id,
          argsRaw: p.args,
          outputRaw: p.output,
          is_error: p.is_error,
        }),
      );
    }
    if (pending.toolCallTotal > 0) {
      turn.tool_call_total = pending.toolCallTotal;
      if (pending.toolCallTotal > pending.toolCalls.length) {
        turn.tool_calls_truncated = true;
      }
    }
    const files = dedupStrings(pending.files);
    if (files.length > 0) turn.files_referenced = files;
    if (pending.thinking.length > 0) {
      const t = truncateThinking(pending.thinking.join("\n\n"));
      turn.thinking = t.value;
    }
    turns.push(turn);
    confirmedThroughOffset = pending.assistantLastLineEndOffset;
  }

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex]!;
    const lineEndOffset = lineEndOffsets[lineIndex]!;
    const lineStartOffset =
      lineIndex === 0 ? firstLineOffset : lineEndOffsets[lineIndex - 1]!;
    const parsed = parseLine(line);
    if (parsed === null) {
      invalidatePendingAgentTrigger();
      markSafeThrough(lineEndOffset);
      continue;
    }

    if (parsed.kind === "session_meta") {
      if (parsed.cwd !== undefined) cwd = parsed.cwd;
      if (parsed.git !== undefined) git = { ...(git ?? {}), ...parsed.git };
      codexMeta = mergeCodexSessionMeta(
        codexMeta,
        codexMetaPatch(parsed),
        expectedPhysicalThreadId,
      );
      markSafeThrough(lineEndOffset);
      continue;
    }

    if (parsed.kind === "inter_agent_metadata") {
      if (parsed.trigger_turn === true) {
        nextAgentMessageTriggersTurn = true;
        triggerMarkerStartOffset = lineStartOffset;
        if (queuedTurnIdentity !== undefined) {
          queuedTurnIdentityIsAgentAssociated = true;
        }
      } else {
        invalidatePendingAgentTrigger();
      }
      // A true marker changes the meaning of the immediately following
      // agent_message. Keep both records behind the durable boundary until
      // that turn closes so a restart cannot lose the trigger.
      if (!nextAgentMessageTriggersTurn) markSafeThrough(lineEndOffset);
      continue;
    }

    if (parsed.kind === "turn_context") {
      if (parsed.cwd !== undefined) cwd = parsed.cwd;
      codexMeta = mergeCodexMeta(codexMeta, {
        model: parsed.model,
        reasoning_effort: parsed.reasoning_effort,
        personality: parsed.personality,
        approval_policy: parsed.approval_policy,
        sandbox_policy_type: parsed.sandbox_policy_type,
        sandbox_network_access: parsed.sandbox_network_access,
        sandbox_writable_roots: parsed.sandbox_writable_roots,
        sandbox_exclude_tmpdir_env_var: parsed.sandbox_exclude_tmpdir_env_var,
        sandbox_exclude_slash_tmp: parsed.sandbox_exclude_slash_tmp,
        permission_profile_type: parsed.permission_profile_type,
        permission_file_system_type: parsed.permission_file_system_type,
        permission_network: parsed.permission_network,
        file_system_sandbox_kind: parsed.file_system_sandbox_kind,
      });
      if (
        parsed.turn_id !== undefined ||
        parsed.logical_identity_conflict === true
      ) {
        const identity = {
          startOffset: lineStartOffset,
          ...(parsed.turn_id !== undefined ? { turnId: parsed.turn_id } : {}),
          conflict: parsed.logical_identity_conflict === true,
        };
        if (pending !== null && pending.assistantTexts.length === 0) {
          if (
            pending.contextTurnId !== undefined &&
            identity.turnId !== undefined &&
            pending.contextTurnId !== identity.turnId
          ) {
            pending.logicalIdentityConflict = true;
          }
          if (
            pending.contextTurnId === undefined &&
            identity.turnId !== undefined
          ) {
            pending.contextTurnId = identity.turnId;
          }
          if (identity.conflict) pending.logicalIdentityConflict = true;
        } else {
          queuedTurnIdentity = mergeQueuedTurnIdentity(
            queuedTurnIdentity,
            identity,
          );
          if (nextAgentMessageTriggersTurn) {
            queuedTurnIdentityIsAgentAssociated = true;
          }
        }
      }
      markSafeThrough(lineEndOffset);
      continue;
    }

    // A true marker targets the next agent_message only. Configuration may be
    // interposed across a read boundary, but any other record begins or
    // continues incompatible work and must make the marker impossible to
    // consume later.
    if (parsed.kind !== "message" || parsed.role !== "agent") {
      invalidatePendingAgentTrigger();
    }

    if (parsed.kind === "tool_call") {
      if (pending !== null) {
        pending.hadTool = true;
        pending.toolCallTotal += 1;
        if (parsed.tool_call_args !== undefined) {
          pending.files.push(
            ...extractFileRefsFromToolArgs(parsed.tool_call_args),
          );
        }
        if (pending.toolCalls.length < MAX_TOOL_CALLS_PER_TURN) {
          const tc: PendingToolCall = { name: parsed.tool_call_name ?? "?" };
          if (parsed.tool_call_args !== undefined)
            tc.args = parsed.tool_call_args;
          if (parsed.tool_call_id !== undefined)
            tc.call_id = parsed.tool_call_id;
          pending.toolCalls.push(tc);
        }
      }
      markSafeThrough(lineEndOffset);
      continue;
    }

    if (parsed.kind === "tool_output") {
      if (pending !== null) {
        pending.hadTool = true;
        // Match to the most recent tool_call with the same call_id (or, lacking
        // an id, the most recent un-resolved call). Single forward scan.
        for (let i = pending.toolCalls.length - 1; i >= 0; i--) {
          const tc = pending.toolCalls[i]!;
          if (tc.output !== undefined) continue;
          if (
            parsed.tool_call_id !== undefined &&
            tc.call_id !== parsed.tool_call_id
          )
            continue;
          if (parsed.tool_output !== undefined) tc.output = parsed.tool_output;
          if (parsed.tool_is_error === true) tc.is_error = true;
          break;
        }
      }
      markSafeThrough(lineEndOffset);
      continue;
    }

    if (parsed.kind === "reasoning") {
      if (pending !== null && parsed.reasoning_text !== undefined) {
        pending.thinking.push(parsed.reasoning_text);
      }
      markSafeThrough(lineEndOffset);
      continue;
    }

    if (parsed.kind === "task_complete") {
      // Emitted after the assistant's final message lands in the file, so it's
      // safe to close the cluster without waiting for a next-user line.
      if (pending !== null && pending.assistantTexts.length > 0) {
        pending.assistantLastLineEndOffset = lineEndOffset;
        emitPendingIfComplete();
        pending = null;
      }
      markSafeThrough(lineEndOffset);
      continue;
    }

    if (parsed.kind === "other") {
      markSafeThrough(lineEndOffset);
      continue;
    }

    // kind === 'message'. Triggering agent messages are user-side task input;
    // non-trigger agent messages are coordination observations, not turns.
    const isTriggeredAgentInput =
      parsed.role === "agent" &&
      nextAgentMessageTriggersTurn &&
      codexMeta?.thread_kind === "subagent" &&
      parsed.recipient !== undefined &&
      parsed.recipient === codexMeta?.agent_path;
    const inputStartOffset = Math.min(
      lineStartOffset,
      ...(isTriggeredAgentInput && triggerMarkerStartOffset !== undefined
        ? [triggerMarkerStartOffset]
        : []),
      ...(queuedTurnIdentity !== undefined
        ? [queuedTurnIdentity.startOffset]
        : []),
    );
    if (parsed.role === "agent") {
      clearPendingAgentTrigger();
    }
    if (parsed.role === "agent" && !isTriggeredAgentInput) {
      // A targeted-turn marker/context followed by an ineligible agent message
      // belongs to that rejected input, not to a later human turn.
      queuedTurnIdentity = undefined;
      queuedTurnIdentityIsAgentAssociated = false;
      markSafeThrough(lineEndOffset);
      continue;
    }
    if (parsed.role === "user" || isTriggeredAgentInput) {
      const fallbackInitiator: Exclude<ContextInitiator, "system"> =
        isTriggeredAgentInput
          ? "agent"
          : codexMeta?.thread_kind === "subagent"
            ? "unknown"
            : "human";
      const initiator = classifyContextInitiator(
        parsed.text ?? "",
        fallbackInitiator,
      );
      if (firstUserOffset === undefined) {
        firstUserOffset = inputStartOffset;
        firstUserCwd = cwd;
        firstUserGit = git;
        firstUserCodex = codexMeta;
      }
      // Bootstrap/system injections may follow a substantive agent task. Keep
      // them as raw JSONL evidence, but do not let them replace the task that
      // the assistant is about to answer.
      if (
        pending !== null &&
        pending.assistantTexts.length === 0 &&
        pending.initiator !== "system" &&
        initiator === "system"
      ) {
        continue;
      }
      let contextIdentity = queuedTurnIdentity;
      queuedTurnIdentity = undefined;
      queuedTurnIdentityIsAgentAssociated = false;
      // A new user closes any prior cluster.
      if (pending !== null) {
        if (pending.assistantTexts.length > 0) {
          emitPendingIfComplete();
        } else {
          log.warn("user_with_no_assistant", { session_id });
          if (pending.initiator === "system") {
            contextIdentity = mergeQueuedTurnIdentity(contextIdentity, {
              startOffset: pending.clusterStartOffset,
              ...(pending.contextTurnId !== undefined
                ? { turnId: pending.contextTurnId }
                : {}),
              conflict: pending.logicalIdentityConflict,
            });
          }
        }
      }
      const clusterStartOffset = Math.min(
        inputStartOffset,
        contextIdentity?.startOffset ?? inputStartOffset,
      );
      // Everything before the context/trigger/user cluster is durable. Keep
      // its earliest identity-bearing line unread until the turn closes so a
      // restart can rebuild the same logical identity.
      if (clusterStartOffset > confirmedThroughOffset) {
        confirmedThroughOffset = clusterStartOffset;
      }
      pending = {
        clusterStartOffset,
        userText: parsed.text ?? "",
        userTimestamp: parsed.timestamp ?? new Date(fileMtime).toISOString(),
        assistantTexts: [],
        assistantLastLineEndOffset: lineEndOffset,
        hadTool: false,
        timestamp: parsed.timestamp ?? new Date(fileMtime).toISOString(),
        toolCalls: [],
        toolCallTotal: 0,
        files: [],
        thinking: [],
        logicalIdentityConflict:
          parsed.logical_identity_conflict === true ||
          contextIdentity?.conflict === true ||
          (contextIdentity?.turnId !== undefined &&
            parsed.turn_id !== undefined &&
            contextIdentity.turnId !== parsed.turn_id),
        initiator,
        localTrigger: isTriggeredAgentInput,
      };
      if (contextIdentity?.turnId !== undefined) {
        pending.contextTurnId = contextIdentity.turnId;
      }
      if (parsed.turn_id !== undefined) pending.userTurnId = parsed.turn_id;
      if (cwd !== undefined) pending.cwd = cwd;
      if (git !== undefined) pending.git = git;
      if (codexMeta !== undefined) pending.codex = codexMeta;
    } else {
      if (pending === null) {
        log.warn("orphan_assistant", { session_id });
        markSafeThrough(lineEndOffset);
      } else if ((parsed.text ?? "").length > 0) {
        pending.assistantTexts.push(parsed.text!);
        pending.assistantLastLineEndOffset = lineEndOffset;
        if (parsed.timestamp !== undefined)
          pending.timestamp = parsed.timestamp;
        if (
          parsed.logical_identity_conflict === true ||
          (parsed.turn_id !== undefined &&
            pending.assistantTurnId !== undefined &&
            parsed.turn_id !== pending.assistantTurnId)
        ) {
          pending.logicalIdentityConflict = true;
        }
        if (parsed.turn_id !== undefined)
          pending.assistantTurnId = parsed.turn_id;
      }
    }
  }

  // Intentionally do NOT emit the pending cluster here. A cluster only counts
  // as closed when the next user line appears (or the file is otherwise known
  // to be complete). Emitting on EOF risks duplicate turns when the next pass
  // sees more assistant lines arrive.
  const result: ExtractCodexResult = {
    turns,
    newOffset: confirmedThroughOffset,
  };
  if (readSnapshot !== undefined) result.readSnapshot = readSnapshot;
  if (firstUserOffset !== undefined) result.firstUserOffset = firstUserOffset;
  if (firstUserCwd !== undefined) result.firstUserCwd = firstUserCwd;
  if (firstUserGit !== undefined) result.firstUserGit = firstUserGit;
  if (firstUserCodex !== undefined) result.firstUserCodex = firstUserCodex;
  if (cwd !== undefined) result.cwd = cwd;
  if (git !== undefined) result.git = git;
  if (codexMeta !== undefined) result.codex = codexMeta;
  return result;
}

interface OffsetEntry {
  offset: number;
  turn_index: number;
  source?: JsonlCheckpointSource;
  inflight_source?: JsonlCheckpointSource;
  cwd?: string;
  git?: CodexGitMeta;
  codex?: CodexSessionMeta;
  page_start?: CodexPageStart;
  raw_fallback?: JsonlRawFallback;
}

interface CodexPageStart {
  offset: number;
  turn_index: number;
  cwd?: string;
  git?: CodexGitMeta;
  codex?: CodexSessionMeta;
  raw_fallback?: JsonlRawFallback;
}

function readGitMetaFromMd(
  md: Record<string, unknown>,
): CodexGitMeta | undefined {
  const raw = md["git"];
  if (typeof raw !== "object" || raw === null) return undefined;
  const r = raw as Record<string, unknown>;
  const out: CodexGitMeta = {};
  if (typeof r["sha"] === "string") out.sha = r["sha"] as string;
  if (typeof r["branch"] === "string") out.branch = r["branch"] as string;
  if (typeof r["origin_url"] === "string")
    out.origin_url = r["origin_url"] as string;
  return Object.keys(out).length > 0 ? out : undefined;
}

function readCodexMetaFromMd(
  md: Record<string, unknown>,
): CodexSessionMeta | undefined {
  const raw = md["codex"];
  if (typeof raw !== "object" || raw === null) return undefined;
  const r = raw as Record<string, unknown>;
  const out: CodexSessionMeta = {};
  for (const k of [
    "source",
    "cli_version",
    "model_provider",
    "model",
    "reasoning_effort",
    "personality",
    "approval_policy",
    "sandbox_policy_type",
    "permission_profile_type",
    "permission_file_system_type",
    "permission_network",
    "file_system_sandbox_kind",
    "thread_id",
    "root_thread_id",
    "parent_thread_id",
    "forked_from_id",
    "agent_path",
    "agent_nickname",
    "history_mode",
    "session_started_at",
  ] as const) {
    const v = r[k];
    if (isNonEmptyString(v)) out[k] = v;
  }
  const threadKind = r["thread_kind"];
  if (
    threadKind === "root" ||
    threadKind === "subagent" ||
    threadKind === "unknown"
  ) {
    out.thread_kind = threadKind;
  }
  for (const k of [
    "sandbox_network_access",
    "sandbox_exclude_tmpdir_env_var",
    "sandbox_exclude_slash_tmp",
  ] as const) {
    const v = r[k];
    if (typeof v === "boolean") out[k] = v;
  }
  const roots = r["sandbox_writable_roots"];
  if (Array.isArray(roots)) {
    const writableRoots = dedupStrings(roots.filter(isNonEmptyString));
    if (writableRoots.length > 0) out.sandbox_writable_roots = writableRoots;
  }
  const agentDepth = r["agent_depth"];
  if (
    typeof agentDepth === "number" &&
    Number.isSafeInteger(agentDepth) &&
    agentDepth >= 0
  ) {
    out.agent_depth = agentDepth;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function readCodexPageStart(
  state: Record<string, unknown> | undefined,
): CodexPageStart | undefined {
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
  const pageStart: CodexPageStart = {
    offset: offset as number,
    turn_index: turnIndex as number,
  };
  const cwd = value["cwd"];
  if (typeof cwd === "string") pageStart.cwd = cwd;
  const git = readGitMetaFromMd(value);
  const codex = readCodexMetaFromMd(value);
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
  if (git !== undefined) pageStart.git = git;
  if (codex !== undefined) pageStart.codex = codex;
  if (rawFallback !== undefined) pageStart.raw_fallback = rawFallback;
  return pageStart;
}

function codexPageStart(entry: OffsetEntry): CodexPageStart {
  const pageStart: CodexPageStart = {
    offset: entry.offset,
    turn_index: entry.turn_index,
  };
  if (entry.cwd !== undefined) pageStart.cwd = entry.cwd;
  if (entry.git !== undefined) pageStart.git = entry.git;
  if (entry.codex !== undefined) pageStart.codex = entry.codex;
  if (entry.raw_fallback !== undefined) {
    pageStart.raw_fallback = entry.raw_fallback;
  }
  return pageStart;
}

async function backfillLegacyCodexLineage(
  path: string,
  entry: OffsetEntry,
): Promise<OffsetEntry> {
  const expectedPhysicalThreadId = deriveRolloutPhysicalThreadId(path);
  const reconciledCodex = reconcileCodexPhysicalSession(
    entry.codex,
    expectedPhysicalThreadId,
  );
  const reconciledPageStartCodex = reconcileCodexPhysicalSession(
    entry.page_start?.codex,
    expectedPhysicalThreadId,
  );
  const codexChanged = reconciledCodex !== entry.codex;
  const pageStartCodexChanged =
    reconciledPageStartCodex !== entry.page_start?.codex;
  let enriched: OffsetEntry =
    codexChanged || pageStartCodexChanged ? { ...entry } : entry;
  if (codexChanged) {
    if (reconciledCodex === undefined) delete enriched.codex;
    else enriched.codex = reconciledCodex;
  }
  if (pageStartCodexChanged && enriched.page_start !== undefined) {
    enriched.page_start = { ...enriched.page_start };
    if (reconciledPageStartCodex === undefined) {
      delete enriched.page_start.codex;
    } else {
      enriched.page_start.codex = reconciledPageStartCodex;
    }
    // A contradictory rewind snapshot is part of the same checkpoint proof.
    // Do not let a later header backfill silently repair only the hot entry.
    if (enriched.codex?.thread_kind === undefined) {
      enriched.codex = replaceCodexLineage(enriched.codex, {
        thread_kind: "unknown",
      });
    }
  }
  if (enriched.offset <= 0 || enriched.codex?.thread_kind !== undefined) {
    return enriched;
  }
  const header = await readCodexSessionHeader(path);
  if (header === null) return enriched;

  if (enriched === entry) enriched = { ...entry };
  if (enriched.cwd === undefined && header.cwd !== undefined) {
    enriched.cwd = header.cwd;
  }
  if (header.git !== undefined) {
    enriched.git = { ...header.git, ...(enriched.git ?? {}) };
  }
  enriched.codex = replaceCodexLineage(
    mergeCodexMeta(header.codex, enriched.codex ?? {}),
    codexLineagePatch(header.codex),
  );
  if (enriched.page_start !== undefined) {
    const pageStartCodex = replaceCodexLineage(
      enriched.page_start.codex,
      codexLineagePatch(header.codex),
    );
    enriched.page_start = {
      ...enriched.page_start,
      ...(pageStartCodex !== undefined ? { codex: pageStartCodex } : {}),
    };
  }
  return enriched;
}

export interface CodexExtractorOptions {
  sessionsPrefix?: string;
}

export type CodexExtractorHandle = ExtractorHandle;

export async function startCodexExtractor(
  storage: Storage,
  options: CodexExtractorOptions = {},
): Promise<CodexExtractorHandle> {
  const sessionsPrefix = options.sessionsPrefix ?? DEFAULT_SESSIONS_PREFIX;
  const capturePolicy = createExtractorFilesystemPolicy({
    roots: [sessionsPrefix],
  });
  // The map is a hot cache only. Durable startup progress comes from the
  // compact checkpoint table one resource at a time; no event-history replay.
  const offsetMap = createBoundedResourceCache<OffsetEntry>();

  async function loadCheckpoint(path: string): Promise<OffsetEntry> {
    const cached = offsetMap.get(path);
    if (cached !== undefined) return cached;
    const persisted = await storage.getCaptureCheckpoint({
      extractor: CODEX_CHECKPOINT_NAMESPACE,
      resource: path,
    });
    const entry: OffsetEntry = {
      offset: persisted?.position ?? 0,
      turn_index: persisted?.ordinal ?? -1,
    };
    const state = persisted?.state;
    const source = readJsonlCheckpointSource(state);
    if (source !== undefined) {
      if (source.boundary_offset !== entry.offset) {
        throw new TypeError(
          "capture checkpoint jsonl_source does not match its position",
        );
      }
      entry.source = source;
    }
    const inflightSource = readJsonlCheckpointSource(
      state,
      "jsonl_inflight_source",
    );
    if (inflightSource !== undefined) entry.inflight_source = inflightSource;
    const cwd = state?.["cwd"];
    if (typeof cwd === "string") entry.cwd = cwd;
    if (state !== undefined) {
      const git = readGitMetaFromMd(state);
      const codex = readCodexMetaFromMd(state);
      if (git !== undefined) entry.git = git;
      if (codex !== undefined) entry.codex = codex;
    }
    const pageStart = readCodexPageStart(state);
    if (pageStart !== undefined) {
      if (
        source?.page_start_offset !== pageStart.offset ||
        pageStart.offset > entry.offset ||
        pageStart.turn_index > entry.turn_index ||
        (pageStart.raw_fallback !== undefined &&
          (source === undefined ||
            pageStart.raw_fallback.group_generation > source.generation))
      ) {
        throw new TypeError(
          "capture checkpoint jsonl_page_start does not match its page proof",
        );
      }
      entry.page_start = pageStart;
    }
    const rawFallback = readJsonlRawFallback(state);
    if (
      rawFallback !== undefined &&
      (rawFallback.cluster_start_offset >= entry.offset ||
        rawFallback.next_fragment === 0 ||
        source === undefined ||
        rawFallback.group_generation > source.generation)
    ) {
      throw new TypeError(
        "capture checkpoint jsonl_raw_fallback state is invalid",
      );
    }
    if (rawFallback !== undefined) entry.raw_fallback = rawFallback;
    if (
      inflightSource !== undefined &&
      (source === undefined ||
        pageStart === undefined ||
        inflightSource.page_start_offset !== pageStart.offset ||
        inflightSource.boundary_offset !== pageStart.offset ||
        inflightSource.page_through_offset === undefined ||
        inflightSource.page_sha256 === undefined ||
        inflightSource.identity !== source.identity ||
        inflightSource.generation !== source.generation ||
        (source.page_through_offset !== undefined &&
          inflightSource.page_through_offset < source.page_through_offset))
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
    entry: OffsetEntry,
    inspection: JsonlSourceInspection,
    pageStart?: CodexPageStart,
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
    const state: Record<string, unknown> = {};
    state["jsonl_source"] = source;
    if (inflightSource !== undefined)
      state["jsonl_inflight_source"] = inflightSource;
    if (entry.cwd !== undefined) state["cwd"] = entry.cwd;
    if (entry.git !== undefined) state["git"] = entry.git;
    if (entry.codex !== undefined) state["codex"] = entry.codex;
    if (pageStart !== undefined) state["jsonl_page_start"] = pageStart;
    if (entry.raw_fallback !== undefined) {
      state["jsonl_raw_fallback"] = entry.raw_fallback;
    }
    await storage.upsertCaptureCheckpoint({
      extractor: CODEX_CHECKPOINT_NAMESPACE,
      resource: path,
      position: entry.offset,
      ...(entry.turn_index >= 0 ? { ordinal: entry.turn_index } : {}),
      state,
      updated_at: new Date().toISOString(),
    });
    const cached: OffsetEntry = { ...entry, source };
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
              extractor: CODEX_CHECKPOINT_NAMESPACE,
              encoding: "base64",
              source_generation: generation,
              group_generation: fallback.group_generation,
              fragment_group: captureDedupeKey("codex", [
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
            dedupe_key: captureDedupeKey("codex", [
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

  async function rewindChangedRead(
    path: string,
    durableEntry: OffsetEntry,
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
    const retry: OffsetEntry = {
      offset: retryOffset,
      turn_index: retryAtDurableBoundary
        ? durableEntry.turn_index
        : (boundedPageStart?.turn_index ?? durableEntry.turn_index),
      source: makeJsonlCheckpointSource(current, generation),
    };
    const retryMetadata = retryAtDurableBoundary
      ? durableEntry
      : boundedPageStart;
    if (retryMetadata?.cwd !== undefined) retry.cwd = retryMetadata.cwd;
    if (retryMetadata?.git !== undefined) retry.git = retryMetadata.git;
    if (retryMetadata?.codex !== undefined) {
      retry.codex = retryMetadata.codex;
    }
    if (retryMetadata?.raw_fallback !== undefined) {
      retry.raw_fallback = retryMetadata.raw_fallback;
    }
    await saveCheckpoint(path, retry, current);
    log.warn("jsonl_read_retry", {
      path,
      retry_offset: retryOffset,
      generation,
      classification: discontinuity,
      durable_boundary: retryAtDurableBoundary,
    });
  }

  async function handleJsonlChange(path: string): Promise<void> {
    const projectIdentityCache = createBoundedResourceCache<{
      canonicalRoot: string;
      projectKey: string;
    }>();
    const projectIdentityFor = async (observedRoot: string) => {
      const cached = projectIdentityCache.get(observedRoot);
      if (cached !== undefined) return cached;
      const canonicalRoot = await resolveCanonicalRoot(observedRoot);
      const resolved = {
        canonicalRoot,
        projectKey: projectKeyForCanonicalRoot(canonicalRoot),
      };
      projectIdentityCache.set(observedRoot, resolved);
      return resolved;
    };
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
      const reset: OffsetEntry = {
        offset: resetOffset,
        turn_index: retryAtDurable
          ? cur.turn_index
          : (boundedPageStart?.turn_index ?? cur.turn_index),
        source: makeJsonlCheckpointSource(sourceAtResume, generation),
      };
      const resetMetadata = retryAtDurable ? cur : boundedPageStart;
      if (resetMetadata?.cwd !== undefined) reset.cwd = resetMetadata.cwd;
      if (resetMetadata?.git !== undefined) reset.git = resetMetadata.git;
      if (resetMetadata?.codex !== undefined) reset.codex = resetMetadata.codex;
      if (resetMetadata?.raw_fallback !== undefined) {
        reset.raw_fallback = resetMetadata.raw_fallback;
      }
      cur = reset;
      // A replaced/truncated source rewinds to zero. A mismatch confined to
      // the persisted bounded page rewinds only to that page's durable start.
      await saveCheckpoint(path, cur, sourceAtResume);
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
    cur = await backfillLegacyCodexLineage(path, cur);
    // Keep the catch path aligned with the checkpoint that actually reached
    // storage. A snapshot wrapper can reject during its post-operation check
    // after saveCheckpoint has already committed, so `cur` is not necessarily
    // the latest durable boundary by the time control reaches the catch.
    let latestDurableEntry = cur;
    let latestDurableInspection = sourceAtResume;
    const extractInput: ExtractCodexInput = {};
    if (cur.cwd !== undefined) extractInput.lastKnownCwd = cur.cwd;
    if (cur.git !== undefined) extractInput.lastKnownGit = cur.git;
    if (cur.codex !== undefined) extractInput.lastKnownCodex = cur.codex;
    const {
      turns,
      newOffset,
      cwd: passCwd,
      git: passGit,
      codex: passCodex,
      readSnapshot,
      firstUserOffset,
      firstUserCwd,
      firstUserGit,
      firstUserCodex,
    } = await extractCodexTurns(path, cur.offset, extractInput);
    try {
      await assertJsonlSourceSnapshotCurrent(path, sourceAtResume);
      const pageStart =
        readSnapshot === undefined ? cur.page_start : codexPageStart(cur);
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
        const resumed: OffsetEntry = { ...cur };
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
            const rawCheckpoint: OffsetEntry = {
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
            const boundaryCwd = resumesAtUser ? firstUserCwd : passCwd;
            const boundaryGit = resumesAtUser ? firstUserGit : passGit;
            const boundaryCodex = resumesAtUser ? firstUserCodex : passCodex;
            if (boundaryCwd !== undefined) rawCheckpoint.cwd = boundaryCwd;
            if (boundaryGit !== undefined) rawCheckpoint.git = boundaryGit;
            if (boundaryCodex !== undefined) {
              rawCheckpoint.codex = boundaryCodex;
            }
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
      let nextTurnIndex = cur.turn_index + 1;
      for (const turn of turns) {
        const turnSnapshot = readSnapshot?.rangeAt(
          readSnapshot.first_offset,
          turn.byte_offset,
        );
        const metadata: Record<string, unknown> = {
          session_id: turn.session_id,
          turn_index: nextTurnIndex,
          mtime: turn.mtime,
          byte_offset: turn.byte_offset,
        };
        if (turn.logical_turn_id !== undefined)
          metadata["logical_turn_id"] = turn.logical_turn_id;
        if (turn.occurred_at !== undefined)
          metadata["occurred_at"] = turn.occurred_at;
        if (turn.observed_at !== undefined)
          metadata["observed_at"] = turn.observed_at;
        if (turn.observation_kind !== undefined)
          metadata["observation_kind"] = turn.observation_kind;
        if (turn.initiator !== undefined)
          metadata["initiator"] = turn.initiator;
        if (turn.had_tool_use) metadata["had_tool_use"] = true;
        if (turn.cwd !== undefined) {
          metadata["cwd"] = turn.cwd;
          metadata["repo_root"] = turn.cwd;
          const projectIdentity = await projectIdentityFor(turn.cwd);
          metadata["canonical_root"] = projectIdentity.canonicalRoot;
          metadata["project_key"] = projectIdentity.projectKey;
        }
        if (turn.git !== undefined) metadata["git"] = turn.git;
        if (turn.codex !== undefined) {
          metadata["codex"] = turn.codex;
          for (const key of [
            "thread_id",
            "root_thread_id",
            "parent_thread_id",
            "forked_from_id",
            "thread_kind",
            "agent_path",
            "agent_depth",
            "agent_nickname",
            "history_mode",
          ] as const) {
            const value = turn.codex[key];
            if (value !== undefined) metadata[key] = value;
          }
        }
        if (turn.tool_calls !== undefined)
          metadata["tool_calls"] = turn.tool_calls;
        if (turn.tool_call_total !== undefined)
          metadata["tool_call_total"] = turn.tool_call_total;
        if (turn.tool_calls_truncated !== undefined)
          metadata["tool_calls_truncated"] = turn.tool_calls_truncated;
        if (turn.files_referenced !== undefined)
          metadata["files_referenced"] = turn.files_referenced;
        if (turn.thinking !== undefined) metadata["thinking"] = turn.thinking;
        const gitState =
          (await probeGitState(turn.cwd, turn.timestamp)) ??
          gitStateFromCodexGit(turn.git, turn.timestamp);
        if (gitState !== undefined) metadata["git_state"] = gitState;
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
          dedupe_key: captureDedupeKey("codex", dedupeParts),
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
        // Checkpoint each processed turn so a later mid-batch failure resumes
        // after durable work instead of replaying the whole batch.
        const checkpoint: OffsetEntry = {
          offset: turn.byte_offset,
          turn_index: nextTurnIndex - 1,
        };
        if (cur.source !== undefined) checkpoint.source = cur.source;
        const cpCwd = turn.cwd ?? cur.cwd;
        const cpGit = turn.git ?? cur.git;
        const cpCodex = turn.codex ?? cur.codex;
        if (cpCwd !== undefined) checkpoint.cwd = cpCwd;
        if (cpGit !== undefined) checkpoint.git = cpGit;
        if (cpCodex !== undefined) checkpoint.codex = cpCodex;
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
      const nextCwd = passCwd ?? cur.cwd;
      const nextGit = passGit ?? cur.git;
      const nextCodex = passCodex ?? cur.codex;
      const next: OffsetEntry = {
        offset: newOffset,
        turn_index: nextTurnIndex - 1,
      };
      if (cur.source !== undefined) next.source = cur.source;
      if (nextCwd !== undefined) next.cwd = nextCwd;
      if (nextGit !== undefined) next.git = nextGit;
      if (nextCodex !== undefined) next.codex = nextCodex;
      if (cur.raw_fallback !== undefined) {
        next.raw_fallback = cur.raw_fallback;
      }
      await assertJsonlSourceSnapshotCurrent(path, sourceAtResume);
      const pageInspection =
        readSnapshot?.sourceAt(newOffset) ?? sourceAtResume;
      const persistPage = async () => {
        await saveCheckpoint(path, next, pageInspection, pageStart);
        latestDurableEntry = offsetMap.get(path) ?? next;
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
    prefix: sessionsPrefix,
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
  log.info("started", { sessionsPrefix });
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
