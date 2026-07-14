import { homedir } from 'node:os';
import { basename } from 'node:path';
import { isNonEmptyString } from '../../guards.js';
import { createLogger } from '../../logging/index.js';
import type { Storage } from '../../storage/interface.js';
import { probeGitState } from '../git-state.js';
import { processCandidate } from '../pipeline.js';
import { resolveCanonicalRoot } from '../workspace-root.js';
import {
  dedupStrings,
  readJsonlTail,
  SOURCE_MARKERS,
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

const log = createLogger('capture.codex');

const HOME = homedir();
const DEFAULT_SESSIONS_PREFIX = `${HOME}/.codex/sessions/`;

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
}

export interface ExtractCodexResult {
  turns: CodexTurn[];
  newOffset: number;
  cwd?: string;
  git?: CodexGitMeta;
  codex?: CodexSessionMeta;
}

interface ParsedLine {
  kind:
    | 'message'
    | 'tool_call'
    | 'tool_output'
    | 'reasoning'
    | 'session_meta'
    | 'turn_context'
    | 'task_complete'
    | 'other';
  role?: 'user' | 'assistant';
  text?: string;
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
  // Tool / reasoning payload extras
  tool_call_name?: string;
  tool_call_args?: string;
  tool_call_id?: string;
  tool_output?: string;
  tool_is_error?: boolean;
  reasoning_text?: string;
}

function extractMessageText(content: unknown): string {
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) {
    if (typeof block !== 'object' || block === null) continue;
    const b = block as Record<string, unknown>;
    const t = b['type'];
    if ((t === 'input_text' || t === 'output_text') && typeof b['text'] === 'string') {
      parts.push(b['text']);
    }
  }
  return parts.join('');
}

function parseLine(line: string): ParsedLine | null {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof raw !== 'object' || raw === null) return null;
  const obj = raw as Record<string, unknown>;
  const t = obj['type'];
  const ts = obj['timestamp'];
  const timestamp = typeof ts === 'string' ? ts : undefined;

  if (t === 'session_meta') {
    const payload = obj['payload'];
    const out: ParsedLine = { kind: 'session_meta', timestamp };
    if (typeof payload === 'object' && payload !== null) {
      const p = payload as Record<string, unknown>;
      const c = p['cwd'];
      if (isNonEmptyString(c)) out.cwd = c;
      const src = p['source'];
      if (isNonEmptyString(src)) out.source = src;
      const cv = p['cli_version'];
      if (isNonEmptyString(cv)) out.cli_version = cv;
      const mp = p['model_provider'];
      if (isNonEmptyString(mp)) out.model_provider = mp;
      const git = p['git'];
      if (typeof git === 'object' && git !== null) {
        const g = git as Record<string, unknown>;
        const gm: CodexGitMeta = {};
        const sha = g['commit_hash'];
        if (isNonEmptyString(sha)) gm.sha = sha;
        const br = g['branch'];
        if (isNonEmptyString(br)) gm.branch = br;
        const url = g['repository_url'];
        if (isNonEmptyString(url)) gm.origin_url = url;
        if (Object.keys(gm).length > 0) out.git = gm;
      }
    }
    return out;
  }

  if (t === 'turn_context') {
    const payload = obj['payload'];
    const out: ParsedLine = { kind: 'turn_context', timestamp };
    if (typeof payload === 'object' && payload !== null) {
      const p = payload as Record<string, unknown>;
      const c = p['cwd'];
      if (isNonEmptyString(c)) out.cwd = c;
      const m = p['model'];
      if (isNonEmptyString(m)) out.model = m;
      const eff = p['effort'];
      if (isNonEmptyString(eff)) out.reasoning_effort = eff;
      const pers = p['personality'];
      if (isNonEmptyString(pers)) out.personality = pers;
      const ap = p['approval_policy'];
      if (isNonEmptyString(ap)) out.approval_policy = ap;
      const sp = p['sandbox_policy'];
      if (typeof sp === 'object' && sp !== null) {
        const spr = sp as Record<string, unknown>;
        const spt = spr['type'];
        if (isNonEmptyString(spt)) out.sandbox_policy_type = spt;
        const sna = spr['network_access'];
        if (typeof sna === 'boolean') out.sandbox_network_access = sna;
        const roots = spr['writable_roots'];
        if (Array.isArray(roots)) {
          out.sandbox_writable_roots = dedupStrings(roots.filter(isNonEmptyString));
        }
        const excludeTmpdir = spr['exclude_tmpdir_env_var'];
        if (typeof excludeTmpdir === 'boolean') out.sandbox_exclude_tmpdir_env_var = excludeTmpdir;
        const excludeSlashTmp = spr['exclude_slash_tmp'];
        if (typeof excludeSlashTmp === 'boolean') out.sandbox_exclude_slash_tmp = excludeSlashTmp;
      }
      const pp = p['permission_profile'];
      if (typeof pp === 'object' && pp !== null) {
        const ppr = pp as Record<string, unknown>;
        const ppt = ppr['type'];
        if (isNonEmptyString(ppt)) out.permission_profile_type = ppt;
        const fs = ppr['file_system'];
        if (typeof fs === 'object' && fs !== null) {
          const fst = (fs as Record<string, unknown>)['type'];
          if (isNonEmptyString(fst)) out.permission_file_system_type = fst;
        }
        const pn = ppr['network'];
        if (isNonEmptyString(pn)) out.permission_network = pn;
      }
      const fssp = p['file_system_sandbox_policy'];
      if (typeof fssp === 'object' && fssp !== null) {
        const kind = (fssp as Record<string, unknown>)['kind'];
        if (isNonEmptyString(kind)) out.file_system_sandbox_kind = kind;
      }
    }
    return out;
  }

  if (t === 'event_msg') {
    const payload = obj['payload'];
    if (typeof payload === 'object' && payload !== null) {
      const p = payload as Record<string, unknown>;
      if (p['type'] === 'task_complete') {
        return { kind: 'task_complete', timestamp };
      }
    }
    return { kind: 'other', timestamp };
  }

  if (t !== 'response_item') return { kind: 'other', timestamp };
  const payload = obj['payload'];
  if (typeof payload !== 'object' || payload === null) return { kind: 'other', timestamp };
  const p = payload as Record<string, unknown>;
  const ptype = p['type'];

  if (ptype === 'reasoning') {
    const out: ParsedLine = { kind: 'reasoning', timestamp };
    const summary = p['summary'];
    if (Array.isArray(summary)) {
      const parts: string[] = [];
      for (const s of summary) {
        if (typeof s === 'object' && s !== null) {
          const sb = s as Record<string, unknown>;
          if (typeof sb['text'] === 'string') parts.push(sb['text']);
        } else if (typeof s === 'string') {
          parts.push(s);
        }
      }
      if (parts.length > 0) out.reasoning_text = parts.join('\n');
    } else if (typeof p['text'] === 'string') {
      out.reasoning_text = p['text'];
    }
    return out;
  }

  if (ptype === 'function_call' || ptype === 'custom_tool_call') {
    const out: ParsedLine = { kind: 'tool_call', timestamp };
    if (isNonEmptyString(p['name'])) out.tool_call_name = p['name'];
    const args = p['arguments'];
    if (typeof args === 'string') out.tool_call_args = args;
    else if (args !== undefined && args !== null) out.tool_call_args = JSON.stringify(args);
    if (isNonEmptyString(p['call_id'])) out.tool_call_id = p['call_id'];
    return out;
  }

  if (ptype === 'function_call_output' || ptype === 'custom_tool_call_output') {
    const out: ParsedLine = { kind: 'tool_output', timestamp };
    if (isNonEmptyString(p['call_id'])) out.tool_call_id = p['call_id'];
    const o = p['output'];
    if (typeof o === 'string') {
      out.tool_output = o;
    } else if (typeof o === 'object' && o !== null) {
      const od = o as Record<string, unknown>;
      if (typeof od['content'] === 'string') out.tool_output = od['content'];
      else if (typeof od['text'] === 'string') out.tool_output = od['text'];
      const md = od['metadata'];
      if (typeof md === 'object' && md !== null) {
        const ec = (md as Record<string, unknown>)['exit_code'];
        if (typeof ec === 'number' && ec !== 0) out.tool_is_error = true;
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

  if (ptype !== 'message') return { kind: 'other', timestamp };
  const role = p['role'];
  if (role !== 'user' && role !== 'assistant') return { kind: 'other', timestamp };
  return {
    kind: 'message',
    role,
    text: extractMessageText(p['content']),
    timestamp,
  };
}

function deriveSessionId(jsonlPath: string): string {
  const base = basename(jsonlPath);
  // rollout-<ISO>-<uuid>.jsonl  → take the trailing UUID, fall back to filename
  const m = base.match(
    /^rollout-.*-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/,
  );
  if (m && m[1] !== undefined) return m[1];
  return base.endsWith('.jsonl') ? base.slice(0, -'.jsonl'.length) : base;
}

interface PendingToolCall {
  name: string;
  args?: string;
  call_id?: string;
  output?: string;
  is_error?: boolean;
}

interface PendingCluster {
  userText: string;
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
  if (typeof value === 'string') {
    out.push(...collectPatchFileRefs(value));
    return;
  }
  if (Array.isArray(value)) {
    for (const v of value) collectStructuredFileRefs(v, out);
    return;
  }
  if (typeof value !== 'object' || value === null) return;
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (
      (FILE_INPUT_KEYS as readonly string[]).includes(k) &&
      typeof v === 'string' &&
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

type CodexMetaValue = string | boolean | string[] | undefined;

function sameStringArray(a: string[] | undefined, b: string[]): boolean {
  return a !== undefined && a.length === b.length && a.every((v, i) => v === b[i]);
}

function mergeCodexMeta(
  base: CodexSessionMeta | undefined,
  patch: Partial<CodexSessionMeta>,
): CodexSessionMeta | undefined {
  const next: CodexSessionMeta = { ...(base ?? {}) };
  let changed = false;
  const mutableNext = next as Record<keyof CodexSessionMeta, CodexMetaValue>;
  for (const [k, raw] of Object.entries(patch) as [keyof CodexSessionMeta, CodexMetaValue][]) {
    let v: CodexMetaValue = raw;
    if (typeof v === 'string' && !isNonEmptyString(v)) continue;
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

function gitStateFromCodexGit(
  git: CodexGitMeta | undefined,
  timestamp: string,
): GitState | undefined {
  if (git === undefined) return undefined;
  const state: GitState = { captured_at: timestamp, fresh: false };
  if (isNonEmptyString(git.sha)) state.head_sha = git.sha;
  if (isNonEmptyString(git.branch)) state.branch = git.branch;
  if (state.head_sha === undefined && state.branch === undefined) return undefined;
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
  const { lines, mtimeMs: fileMtime } = tail;
  if (lines.length === 0) return { turns: [], newOffset: lastByteOffset };
  const session_id = deriveSessionId(jsonlPath);

  const turns: CodexTurn[] = [];
  let pending: PendingCluster | null = null;
  let cwd: string | undefined = input.lastKnownCwd;
  let git: CodexGitMeta | undefined = input.lastKnownGit;
  let codexMeta: CodexSessionMeta | undefined = input.lastKnownCodex;
  let lineStartOffset = lastByteOffset;
  // Tracks the END of the last line that contributed to an EMITTED turn.
  // Pending-cluster lines (user + assistants without a closing next-user) are
  // intentionally NOT past confirmedThroughOffset, so the next pass re-reads
  // them and rebuilds the pending cluster from scratch.
  let confirmedThroughOffset = lastByteOffset;

  function emitPendingIfComplete(): void {
    if (pending === null) return;
    if (pending.assistantTexts.length === 0) return;
    const turn: CodexTurn = {
      session_id,
      turn_index: turns.length,
      user_message: pending.userText,
      assistant_message: pending.assistantTexts.join('\n\n'),
      mtime: fileMtime,
      timestamp: pending.timestamp,
      had_tool_use: pending.hadTool,
      byte_offset: pending.assistantLastLineEndOffset,
    };
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
      const t = truncateThinking(pending.thinking.join('\n\n'));
      turn.thinking = t.value;
    }
    turns.push(turn);
    confirmedThroughOffset = pending.assistantLastLineEndOffset;
  }

  for (const line of lines) {
    const lineEndOffset = lineStartOffset + Buffer.byteLength(line, 'utf8') + 1; // +1 for \n
    const parsed = parseLine(line);
    if (parsed === null) {
      lineStartOffset = lineEndOffset;
      continue;
    }

    if (parsed.kind === 'session_meta') {
      if (parsed.cwd !== undefined) cwd = parsed.cwd;
      if (parsed.git !== undefined) git = { ...(git ?? {}), ...parsed.git };
      codexMeta = mergeCodexMeta(codexMeta, {
        source: parsed.source,
        cli_version: parsed.cli_version,
        model_provider: parsed.model_provider,
      });
      lineStartOffset = lineEndOffset;
      continue;
    }

    if (parsed.kind === 'turn_context') {
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
      lineStartOffset = lineEndOffset;
      continue;
    }

    if (parsed.kind === 'tool_call') {
      if (pending !== null) {
        pending.hadTool = true;
        pending.toolCallTotal += 1;
        if (parsed.tool_call_args !== undefined) {
          pending.files.push(...extractFileRefsFromToolArgs(parsed.tool_call_args));
        }
        if (pending.toolCalls.length < MAX_TOOL_CALLS_PER_TURN) {
          const tc: PendingToolCall = { name: parsed.tool_call_name ?? '?' };
          if (parsed.tool_call_args !== undefined) tc.args = parsed.tool_call_args;
          if (parsed.tool_call_id !== undefined) tc.call_id = parsed.tool_call_id;
          pending.toolCalls.push(tc);
        }
      }
      lineStartOffset = lineEndOffset;
      continue;
    }

    if (parsed.kind === 'tool_output') {
      if (pending !== null) {
        pending.hadTool = true;
        // Match to the most recent tool_call with the same call_id (or, lacking
        // an id, the most recent un-resolved call). Single forward scan.
        for (let i = pending.toolCalls.length - 1; i >= 0; i--) {
          const tc = pending.toolCalls[i]!;
          if (tc.output !== undefined) continue;
          if (parsed.tool_call_id !== undefined && tc.call_id !== parsed.tool_call_id) continue;
          if (parsed.tool_output !== undefined) tc.output = parsed.tool_output;
          if (parsed.tool_is_error === true) tc.is_error = true;
          break;
        }
      }
      lineStartOffset = lineEndOffset;
      continue;
    }

    if (parsed.kind === 'reasoning') {
      if (pending !== null && parsed.reasoning_text !== undefined) {
        pending.thinking.push(parsed.reasoning_text);
      }
      lineStartOffset = lineEndOffset;
      continue;
    }

    if (parsed.kind === 'task_complete') {
      // Emitted after the assistant's final message lands in the file, so it's
      // safe to close the cluster without waiting for a next-user line.
      if (pending !== null && pending.assistantTexts.length > 0) {
        pending.assistantLastLineEndOffset = lineEndOffset;
        emitPendingIfComplete();
        pending = null;
      }
      lineStartOffset = lineEndOffset;
      continue;
    }

    if (parsed.kind === 'other') {
      lineStartOffset = lineEndOffset;
      continue;
    }

    // kind === 'message'
    if (parsed.role === 'user') {
      // A new user closes any prior cluster.
      if (pending !== null) {
        if (pending.assistantTexts.length > 0) {
          emitPendingIfComplete();
        } else {
          log.warn('user_with_no_assistant', { session_id });
        }
      }
      pending = {
        userText: parsed.text ?? '',
        assistantTexts: [],
        assistantLastLineEndOffset: lineEndOffset,
        hadTool: false,
        timestamp: parsed.timestamp ?? new Date(fileMtime).toISOString(),
        toolCalls: [],
        toolCallTotal: 0,
        files: [],
        thinking: [],
      };
      if (cwd !== undefined) pending.cwd = cwd;
      if (git !== undefined) pending.git = git;
      if (codexMeta !== undefined) pending.codex = codexMeta;
    } else {
      if (pending === null) {
        log.warn('orphan_assistant', { session_id });
      } else if ((parsed.text ?? '').length > 0) {
        pending.assistantTexts.push(parsed.text!);
        pending.assistantLastLineEndOffset = lineEndOffset;
        if (parsed.timestamp !== undefined) pending.timestamp = parsed.timestamp;
      }
    }

    lineStartOffset = lineEndOffset;
  }

  // Intentionally do NOT emit the pending cluster here. A cluster only counts
  // as closed when the next user line appears (or the file is otherwise known
  // to be complete). Emitting on EOF risks duplicate turns when the next pass
  // sees more assistant lines arrive.
  const result: ExtractCodexResult = { turns, newOffset: confirmedThroughOffset };
  if (cwd !== undefined) result.cwd = cwd;
  if (git !== undefined) result.git = git;
  if (codexMeta !== undefined) result.codex = codexMeta;
  return result;
}

interface OffsetEntry {
  offset: number;
  turn_index: number;
  cwd?: string;
  git?: CodexGitMeta;
  codex?: CodexSessionMeta;
}

function readGitMetaFromMd(md: Record<string, unknown>): CodexGitMeta | undefined {
  const raw = md['git'];
  if (typeof raw !== 'object' || raw === null) return undefined;
  const r = raw as Record<string, unknown>;
  const out: CodexGitMeta = {};
  if (typeof r['sha'] === 'string') out.sha = r['sha'] as string;
  if (typeof r['branch'] === 'string') out.branch = r['branch'] as string;
  if (typeof r['origin_url'] === 'string') out.origin_url = r['origin_url'] as string;
  return Object.keys(out).length > 0 ? out : undefined;
}

function readCodexMetaFromMd(md: Record<string, unknown>): CodexSessionMeta | undefined {
  const raw = md['codex'];
  if (typeof raw !== 'object' || raw === null) return undefined;
  const r = raw as Record<string, unknown>;
  const out: CodexSessionMeta = {};
  for (const k of [
    'source',
    'cli_version',
    'model_provider',
    'model',
    'reasoning_effort',
    'personality',
    'approval_policy',
    'sandbox_policy_type',
    'permission_profile_type',
    'permission_file_system_type',
    'permission_network',
    'file_system_sandbox_kind',
  ] as const) {
    const v = r[k];
    if (isNonEmptyString(v)) out[k] = v;
  }
  for (const k of [
    'sandbox_network_access',
    'sandbox_exclude_tmpdir_env_var',
    'sandbox_exclude_slash_tmp',
  ] as const) {
    const v = r[k];
    if (typeof v === 'boolean') out[k] = v;
  }
  const roots = r['sandbox_writable_roots'];
  if (Array.isArray(roots)) {
    const writableRoots = dedupStrings(roots.filter(isNonEmptyString));
    if (writableRoots.length > 0) out.sandbox_writable_roots = writableRoots;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

async function backfillOffsetMap(storage: Storage): Promise<Map<string, OffsetEntry>> {
  const map = new Map<string, OffsetEntry>();
  const events = await storage.query({ source_prefix: 'fs:' });
  for (const evt of events) {
    if (!evt.source.endsWith('.jsonl')) continue;
    if (!evt.source.includes(SOURCE_MARKERS.codex)) continue;
    const md = evt.metadata;
    if (md === undefined) continue;
    const offset = md['byte_offset'];
    const turn_index = md['turn_index'];
    if (typeof offset !== 'number' || typeof turn_index !== 'number') continue;
    const path = evt.source.slice('fs:'.length);
    const cwdVal = md['cwd'];
    const cwd = typeof cwdVal === 'string' ? cwdVal : undefined;
    const git = readGitMetaFromMd(md);
    const codex = readCodexMetaFromMd(md);
    const cur = map.get(path);
    if (cur === undefined || offset > cur.offset) {
      // Older events may lack cwd/git/codex; carry forward what we've already
      // learned from earlier turns in the same file.
      const entry: OffsetEntry = { offset, turn_index };
      entry.cwd = cwd ?? cur?.cwd;
      entry.git = git ?? cur?.git;
      entry.codex = codex ?? cur?.codex;
      if (entry.cwd === undefined) delete entry.cwd;
      if (entry.git === undefined) delete entry.git;
      if (entry.codex === undefined) delete entry.codex;
      map.set(path, entry);
    } else {
      // Older event from same file: enrich a sparse current entry if helpful.
      const merged: OffsetEntry = { ...cur };
      if (merged.cwd === undefined && cwd !== undefined) merged.cwd = cwd;
      if (merged.git === undefined && git !== undefined) merged.git = git;
      if (merged.codex === undefined && codex !== undefined) merged.codex = codex;
      map.set(path, merged);
    }
  }
  return map;
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
  const offsetMap = await backfillOffsetMap(storage);

  async function handleJsonlChange(path: string): Promise<void> {
    const cur = offsetMap.get(path) ?? { offset: 0, turn_index: -1 };
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
    } = await extractCodexTurns(path, cur.offset, extractInput);
    let nextTurnIndex = cur.turn_index + 1;
    for (const turn of turns) {
      const metadata: Record<string, unknown> = {
        session_id: turn.session_id,
        turn_index: nextTurnIndex,
        mtime: turn.mtime,
        byte_offset: turn.byte_offset,
      };
      if (turn.had_tool_use) metadata['had_tool_use'] = true;
      if (turn.cwd !== undefined) {
        metadata['cwd'] = turn.cwd;
        metadata['repo_root'] = turn.cwd;
        metadata['canonical_root'] = await resolveCanonicalRoot(turn.cwd);
      }
      if (turn.git !== undefined) metadata['git'] = turn.git;
      if (turn.codex !== undefined) metadata['codex'] = turn.codex;
      if (turn.tool_calls !== undefined) metadata['tool_calls'] = turn.tool_calls;
      if (turn.tool_call_total !== undefined) metadata['tool_call_total'] = turn.tool_call_total;
      if (turn.tool_calls_truncated !== undefined)
        metadata['tool_calls_truncated'] = turn.tool_calls_truncated;
      if (turn.files_referenced !== undefined) metadata['files_referenced'] = turn.files_referenced;
      if (turn.thinking !== undefined) metadata['thinking'] = turn.thinking;
      const gitState =
        (await probeGitState(turn.cwd, turn.timestamp)) ??
        gitStateFromCodexGit(turn.git, turn.timestamp);
      if (gitState !== undefined) metadata['git_state'] = gitState;
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
      const checkpoint: OffsetEntry = { offset: turn.byte_offset, turn_index: nextTurnIndex - 1 };
      const cpCwd = turn.cwd ?? cur.cwd;
      const cpGit = turn.git ?? cur.git;
      const cpCodex = turn.codex ?? cur.codex;
      if (cpCwd !== undefined) checkpoint.cwd = cpCwd;
      if (cpGit !== undefined) checkpoint.git = cpGit;
      if (cpCodex !== undefined) checkpoint.codex = cpCodex;
      offsetMap.set(path, checkpoint);
    }
    const nextCwd = passCwd ?? cur.cwd;
    const nextGit = passGit ?? cur.git;
    const nextCodex = passCodex ?? cur.codex;
    const next: OffsetEntry = { offset: newOffset, turn_index: nextTurnIndex - 1 };
    if (nextCwd !== undefined) next.cwd = nextCwd;
    if (nextGit !== undefined) next.git = nextGit;
    if (nextCodex !== undefined) next.codex = nextCodex;
    offsetMap.set(path, next);
  }

  const handle = await wireJsonlExtractor({
    prefix: sessionsPrefix,
    offsetMap,
    handle: handleJsonlChange,
    log,
  });
  log.info('started', { sessionsPrefix });
  return {
    stop: async () => {
      await handle.stop();
      log.info('stopped', {});
    },
    probeFreshness: handle.probeFreshness,
  };
}
