import { statSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, dirname as pathDirname } from 'node:path';
import Database from 'better-sqlite3';
import chokidar, { type FSWatcher } from 'chokidar';
import { createLogger } from '../../logging/index.js';
import { resolveRepoRootForWorkspaceId } from '../../mcp/cursor-workspace-resolver.js';
import type { Storage } from '../../storage/interface.js';
import { processCandidate } from '../pipeline.js';
import { dedupStrings } from './_shared.js';

const log = createLogger('capture.cursor');

const HOME = homedir();
const DEFAULT_GLOBAL_DB = `${HOME}/Library/Application Support/Cursor/User/globalStorage/state.vscdb`;
const DEFAULT_WORKSPACE_PREFIX = `${HOME}/Library/Application Support/Cursor/User/workspaceStorage/`;

const BUBBLE_KEY_PREFIX = 'bubbleId:';
const COMPOSER_KEY_PREFIX = 'composerData:';

// Cursor encodes bubble role as a numeric `type` in cursorDiskKV.
const TYPE_USER = 1;
const TYPE_ASSISTANT = 2;

// Periodic re-poll interval for the `state.vscdb` family (chokidar misses
// some WAL appends during sustained streaming; the poll closes the cadence
// gap). 15 s bounds capture latency to ≤ interval + DB-scan time while
// keeping the wakeup-tax low when Cursor is idle (the mtime guard
// short-circuits the scan in microseconds). Source constant; runtime
// override is `CursorExtractorOptions.repollIntervalMs`; no env var.
export const CURSOR_REPOLL_INTERVAL_MS = 15_000;

// Per-bubble text source recorded into `metadata.bubble_text_sources[]`
// when any assistant bubble in the cluster used a fallback parser. Omitted
// from metadata entirely when every assistant bubble used primary `'text'`.
export type BubbleTextSource =
  | 'text'
  | 'toolFormerData'
  | 'fileDiff'
  | 'codeBlocks'
  | 'thinkingContent';

export interface ReferencedFile {
  path: string;
  language?: string;
}

export interface CursorToolCall {
  name: string;
  args?: string;
  output?: string;
  is_error?: boolean;
}

// Tier-A context extracted from the bubble rows. Only the fields with content
// in real Cursor data are surfaced here (probed empirically against a live
// install: many bubble fields like `gitDiffs`, `toolResults`, `relevantFiles`
// were always empty and are therefore not extracted today).
export interface CursorTurnContext {
  // Files the user dragged into the chat (from user bubble's
  // attachedFileCodeChunksUris). Dedup'd, in the order they appeared.
  attached_files?: string[];
  // Files the assistant referenced or wrote code for (from each assistant
  // bubble's codeBlocks[]). Dedup'd by path. Cluster-aggregated.
  referenced_files?: ReferencedFile[];
  // Files the assistant deleted in this turn (from each assistant bubble's
  // deletedFiles[]). Dedup'd. Cluster-aggregated.
  deleted_files?: string[];
}

export interface CursorTurn {
  composer_id: string;
  user_bubble_id: string;
  // The last assistant bubble in the cluster — used as the resume checkpoint.
  assistant_bubble_id: string;
  // Every assistant bubble that followed the user, in chronological order.
  // Always at least 1; usually more (Cursor often splits a single assistant
  // response into a thinking-block bubble + answer bubble + tool-result
  // bubbles, all with type=2).
  assistant_bubble_ids: string[];
  workspace_id?: string;
  user_message: string;
  // Concatenated text of every assistant bubble in the cluster, joined by
  // a blank line. Empty bubbles are kept (they may carry richText elsewhere
  // that we don't extract today) but contribute no characters.
  assistant_message: string;
  assistant_created_at: number;
  mtime: number;
  // Aggregated structured context from the user + assistant cluster. Only
  // populated keys are present; omitted entirely if all categories are empty.
  context?: CursorTurnContext;
  // Per-assistant-bubble text source, parallel to `assistant_bubble_ids`.
  // Present only when at least one bubble used a fallback parser; omitted
  // when every bubble used primary `'text'` (the 99% no-Agent-mode case).
  bubble_text_sources?: BubbleTextSource[];
  // Set when any bubble in the assistant cluster came from a
  // `toolFormerData` frame — gives parity with CC/Codex `had_tool_use`.
  had_tool_use?: boolean;
  // One entry per `toolFormerData` bubble in the cluster, in order. Cursor's
  // toolFormerData object doesn't carry a stable tool-name field across all
  // shapes — best-effort name; raw `rawArgs`/`params` → args; `result`/`text`
  // → output. Omitted when there are no tool bubbles.
  tool_calls?: CursorToolCall[];
  // Concatenated text of every `thinkingContent` bubble in the cluster.
  // Mirrors CC/Codex `metadata.thinking`. Omitted when there are no
  // thinking bubbles. The text also stays in `assistant_message` to avoid
  // a content-shape break for existing consumers.
  thinking?: string;
  // True when this turn is a continuation of a prior atom's assistant
  // cluster for the same user message (Cursor wrote more bubbles after the
  // prior capture tick's checkpoint). Omitted (not `false`) on normal turns
  // to preserve the no-bloat property on the 99% case where this never
  // fires. See item 036 (M1-1 sub-gap D).
  is_continuation?: true;
  // The assistant bubble id that the prior atom's `assistant_bubble_id`
  // pointed at — i.e., the checkpoint value at the moment this continuation
  // was emitted. Consumer join key: `continuation_of_assistant_bubble_id`
  // here ↔ `assistant_bubble_id` on the prior atom. Always present when
  // `is_continuation: true`; always absent otherwise.
  continuation_of_assistant_bubble_id?: string;
}

interface ComposerInfo {
  composer_id: string;
  createdAt: number;
  bubbleOrder: Map<string, number>; // bubble_id → position in fullConversationHeadersOnly
}

interface BubbleContext {
  attachedFiles: string[];
  referencedFiles: ReferencedFile[];
  deletedFiles: string[];
}

interface ParsedBubble {
  composer_id: string;
  bubble_id: string;
  role: 'user' | 'assistant';
  text: string;
  // Which field on the row supplied `text`. 'text' is the 99% path (primary
  // `v.text` non-empty); other values mean the fallback chain in
  // parseBubbleRow had to derive text from a tool-call / file-diff /
  // code-block-body / thinking-content frame.
  text_source: BubbleTextSource;
  // Synthesized: composer.createdAt + bubble's position in fullConversationHeadersOnly.
  // Cursor does not store a per-bubble timestamp; the composer's createdAt + ordering
  // index gives a stable, monotonically increasing key for sort + checkpoint logic.
  createdAt: number;
  context: BubbleContext;
  // Populated only when `text_source === 'toolFormerData'`. The raw frame
  // is kept so the cluster builder can derive a structured `tool_calls[]`
  // entry without re-parsing the bubble row a second time.
  toolFormerData?: Record<string, unknown>;
}

interface CursorDiskKVRow {
  key: string;
  value: string | null;
}

const missingComposerHeaderWarnedKeys = new Set<string>();

// Item 037 / AC1: dedup the `cursor_repo_root_resolution_failed` warn one
// per composer_id, so a composer that legitimately can't be repo-attributed
// (binding present + folder URI missing + zero files) does not flood the
// log on every poll tick. Same shape as `missingComposerHeaderWarnedKeys`
// above (per 9d00369).
const repoRootResolutionFailedWarnedComposers = new Set<string>();

// Item 037 / AC1 Stage 2: walk upward from `filePath` looking for the
// nearest `.git` ancestor directory or file (git worktrees use a `.git`
// FILE that points at the main repo's .git dir; we treat both as
// repo-root markers). Returns the absolute parent path on hit, or null
// when we reach filesystem root without finding `.git`. Read-only — no
// new permissions beyond the existing `stat` capability the resolver
// already requires.
function findGitAncestor(filePath: string): string | null {
  if (!isAbsolute(filePath)) return null;
  let dir = pathDirname(filePath);
  // Walk up to filesystem root. `pathDirname('/')` returns '/' (and
  // `pathDirname('C:\\')` returns 'C:\\' on Windows) — bail when the
  // parent equals the current dir.
  while (true) {
    try {
      // Either a .git directory (regular repo) or a .git file (submodule /
      // worktree) marks the root. We do not distinguish: both anchor the
      // repo's working tree at this directory.
      statSync(`${dir}/.git`);
      return dir;
    } catch {
      // .git does not exist at this level — keep walking.
    }
    const parent = pathDirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

// Item 037 / AC1 Stage 2: given an array of files referenced in a turn,
// resolve to a single repo_root if (and only if) every file with a `.git`
// ancestor agrees on the same ancestor. Returns null when:
//   - the array is empty, OR
//   - no file has a `.git` ancestor, OR
//   - two or more files have distinct `.git` ancestors (ambiguous —
//     refuse to guess; the turn captures fine without repo attribution).
function resolveRepoRootFromFiles(files: readonly string[]): string | null {
  const ancestors = new Set<string>();
  for (const f of files) {
    const a = findGitAncestor(f);
    if (a !== null) ancestors.add(a);
  }
  if (ancestors.size === 1) {
    return [...ancestors][0]!;
  }
  return null;
}

// Item 037 / AC1: per-turn repo_root resolution. The decision tree (AC1 #4)
// is intentionally explicit because three prior review rounds (R1/R2/R3)
// found load-bearing ambiguity in earlier paraphrases.
//
//   a. composerToWorkspace has a workspace_id → run Stage 1.
//     a.i.  Stage 1 returns non-null → authoritative; OVERWRITE cache; return.
//     a.ii. Stage 1 returns null     → DO NOT cache; fall through to Stage 2.
//   b. no binding → check cache; hit → return cached; miss → fall through.
//   c. Stage 2 (file-walk).
//     c.i.  success → populate cache; return.
//     c.ii. failure → DO NOT cache; return undefined.
//
// Invariant: the cache only ever holds resolved absolute paths. `undefined`
// (this function's null return) and a missing cache entry are the same
// "try again next tick" signal.
//
// Warn dedup: `cursor_repo_root_resolution_failed` fires AT MOST once per
// composer_id, AND only when Stage 1 produced a definite failure (binding
// present but folder URI absent / malformed) AND Stage 2 also returned
// null. The "no binding" case is the common-and-expected pre-binding
// state and does not warn.
function resolveCursorRepoRootForTurn(
  composer_id: string,
  workspace_id: string | undefined,
  filesReferenced: readonly string[],
  workspaceStorageDir: string,
  cache: Map<string, string>,
  resolveStage1: (workspace_id: string, workspaceStorageDir: string) => string | null,
  resolveStage2: (files: readonly string[]) => string | null,
): string | undefined {
  let stage1Failed = false;
  if (workspace_id !== undefined) {
    const stage1 = resolveStage1(workspace_id, workspaceStorageDir);
    if (stage1 !== null) {
      cache.set(composer_id, stage1);
      return stage1;
    }
    // Binding present but Stage 1 could not decode the folder URI. Mark for
    // the dedup-warn below if Stage 2 also fails. Do not cache null and do
    // not return — fall through.
    stage1Failed = true;
  } else {
    const cached = cache.get(composer_id);
    if (cached !== undefined) return cached;
  }
  const stage2 = resolveStage2(filesReferenced);
  if (stage2 !== null) {
    cache.set(composer_id, stage2);
    return stage2;
  }
  // Both stages failed. Warn only when Stage 1 had a binding to work with
  // (the surprising case) — pre-binding turns hitting the file-walk fallback
  // are routine and not worth a warn.
  if (stage1Failed) {
    if (!repoRootResolutionFailedWarnedComposers.has(composer_id)) {
      repoRootResolutionFailedWarnedComposers.add(composer_id);
      log.warn('cursor_repo_root_resolution_failed', {
        composer_id,
        reason: 'workspace_binding_unresolvable_and_no_unambiguous_files',
      });
    }
  }
  return undefined;
}

function parseBubbleKey(key: string): { composer_id: string; bubble_id: string } | null {
  if (!key.startsWith(BUBBLE_KEY_PREFIX)) return null;
  const rest = key.slice(BUBBLE_KEY_PREFIX.length);
  const colon = rest.indexOf(':');
  if (colon <= 0 || colon === rest.length - 1) return null;
  return {
    composer_id: rest.slice(0, colon),
    bubble_id: rest.slice(colon + 1),
  };
}

function parseComposerKey(key: string): string | null {
  if (!key.startsWith(COMPOSER_KEY_PREFIX)) return null;
  const id = key.slice(COMPOSER_KEY_PREFIX.length);
  return id.length > 0 ? id : null;
}

function parseComposerRow(row: CursorDiskKVRow): ComposerInfo | null {
  const composer_id = parseComposerKey(row.key);
  if (composer_id === null) return null;
  if (row.value === null) return null;
  let value: unknown;
  try {
    value = JSON.parse(row.value);
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null) return null;
  const v = value as Record<string, unknown>;
  const createdAt = v['createdAt'];
  const headers = v['fullConversationHeadersOnly'];
  if (typeof createdAt !== 'number' || !Array.isArray(headers)) return null;
  const bubbleOrder = new Map<string, number>();
  for (let i = 0; i < headers.length; i += 1) {
    const h = headers[i];
    if (typeof h === 'object' && h !== null) {
      const bid = (h as Record<string, unknown>)['bubbleId'];
      if (typeof bid === 'string') {
        bubbleOrder.set(bid, i);
      }
    }
  }
  return { composer_id, createdAt, bubbleOrder };
}

function asString(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

function extractAttachedFiles(v: Record<string, unknown>): string[] {
  const out: string[] = [];
  const arr = v['attachedFileCodeChunksUris'];
  if (!Array.isArray(arr)) return out;
  for (const entry of arr) {
    if (typeof entry !== 'object' || entry === null) continue;
    const path = asString((entry as Record<string, unknown>)['path']);
    if (path !== undefined) out.push(path);
  }
  return out;
}

function extractReferencedFiles(v: Record<string, unknown>): ReferencedFile[] {
  const out: ReferencedFile[] = [];
  const arr = v['codeBlocks'];
  if (!Array.isArray(arr)) return out;
  for (const entry of arr) {
    if (typeof entry !== 'object' || entry === null) continue;
    const e = entry as Record<string, unknown>;
    const uri = e['uri'];
    if (typeof uri !== 'object' || uri === null) continue;
    const path = asString((uri as Record<string, unknown>)['path']);
    if (path === undefined) continue;
    const ref: ReferencedFile = { path };
    const language = asString(e['languageId']);
    if (language !== undefined) ref.language = language;
    out.push(ref);
  }
  return out;
}

function extractDeletedFiles(v: Record<string, unknown>): string[] {
  const out: string[] = [];
  const arr = v['deletedFiles'];
  if (!Array.isArray(arr)) return out;
  for (const entry of arr) {
    if (typeof entry !== 'object' || entry === null) continue;
    const uri = (entry as Record<string, unknown>)['uri'];
    if (typeof uri !== 'object' || uri === null) continue;
    const path = asString((uri as Record<string, unknown>)['path']);
    if (path !== undefined) out.push(path);
  }
  return out;
}

// Fallback parsers for bubbles whose primary `v.text` is missing or empty.
// Cursor's Agent/Composer modes routinely store assistant content in shape
// fields other than `text` — these parsers each return a non-empty string
// derived from one such field, or `null` if the field is absent / empty.
// Every parser treats shape mismatch as `return null`; none ever throws
// (the parser is a boundary — a throw here would crash an extractor tick).

export function tryExtractToolFormerText(v: Record<string, unknown>): string | null {
  const tfd = v['toolFormerData'];
  if (typeof tfd !== 'object' || tfd === null) return null;
  const o = tfd as Record<string, unknown>;
  const direct = o['text'];
  if (typeof direct === 'string' && direct.length > 0) return direct;
  const result = o['result'];
  if (typeof result === 'string' && result.length > 0) return result;
  const rawArgs = o['rawArgs'];
  if (typeof rawArgs === 'string' && rawArgs.length > 0) return rawArgs;
  const params = o['params'];
  // Newer Cursor tool-frames (e.g. `edit_file_v2`) store `params` as a
  // pre-stringified JSON blob, not an object. Without the string branch,
  // bubbles where every other text-bearing field is empty drop as
  // `missing_text_and_fallbacks` even though `params` carries the full
  // tool args. Empirically observed 2026-05-11.
  if (typeof params === 'string' && params.length > 0) return params;
  if (typeof params === 'object' && params !== null) {
    let s: string;
    try {
      s = JSON.stringify(params);
    } catch {
      return null;
    }
    if (s.length > 2) return s; // empty object stringifies to "{}"
  }
  return null;
}

export function tryExtractFileDiffText(v: Record<string, unknown>): string | null {
  const ahc = v['attachedHumanChanges'];
  if (typeof ahc !== 'object' || ahc === null) return null;
  const fd = (ahc as Record<string, unknown>)['fileDiff'];
  if (typeof fd === 'string' && fd.length > 0) return fd;
  if (Array.isArray(fd) && fd.length > 0) {
    let s: string;
    try {
      s = JSON.stringify(fd);
    } catch {
      return null;
    }
    if (s.length > 2) return s;
  } else if (typeof fd === 'object' && fd !== null) {
    let s: string;
    try {
      s = JSON.stringify(fd);
    } catch {
      return null;
    }
    if (s.length > 2) return s;
  }
  return null;
}

// Body guard: `codeBlocks` is also read by `extractReferencedFiles` for the
// path-only structured-context field. Reusing it for assistant prose
// naively would synthesize fake text from a list of referenced-file paths.
// This parser requires at least one entry to carry a non-empty `content`
// or `code` body — entries with only `uri.path` are rejected.
export function tryExtractCodeBlocksText(v: Record<string, unknown>): string | null {
  const arr = v['codeBlocks'];
  if (!Array.isArray(arr) || arr.length === 0) return null;
  const parts: string[] = [];
  for (const entry of arr) {
    if (typeof entry !== 'object' || entry === null) continue;
    const e = entry as Record<string, unknown>;
    const content = e['content'];
    const code = e['code'];
    let body: string | null = null;
    if (typeof content === 'string' && content.length > 0) body = content;
    else if (typeof code === 'string' && code.length > 0) body = code;
    if (body === null) continue;
    const lang = typeof e['languageId'] === 'string' ? (e['languageId'] as string) : '';
    parts.push(`\`\`\`${lang}\n${body}\n\`\`\``);
  }
  if (parts.length === 0) return null;
  return parts.join('\n\n');
}

export function tryExtractThinkingText(v: Record<string, unknown>): string | null {
  const t = v['thinkingContent'];
  if (typeof t === 'string' && t.length > 0) return t;
  if (typeof t === 'object' && t !== null) {
    const txt = (t as Record<string, unknown>)['text'];
    if (typeof txt === 'string' && txt.length > 0) return txt;
  }
  // Companion shape observed empirically on `capabilityType: 30` bubbles
  // (2026-05-11): assistant bubble has empty `text`, no `thinkingContent`,
  // but reasoning lives at `v.thinking.text` (Cursor's wrapper around the
  // Claude extended-thinking signed payload). Without this fallback,
  // thinking-only bubbles in this mode drop as `missing_text_and_fallbacks`.
  const th = v['thinking'];
  if (typeof th === 'string' && th.length > 0) return th;
  if (typeof th === 'object' && th !== null) {
    const txt = (th as Record<string, unknown>)['text'];
    if (typeof txt === 'string' && txt.length > 0) return txt;
  }
  return null;
}

// True if `value` carries anything we'd want a parser to look at: a
// non-empty string, a non-empty array, or an object with any populated
// key. Used to distinguish "real parser gap" from "empty placeholder
// bubble" in the missing-text logging path.
function hasNonEmpty(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === 'string') return value.length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') return Object.keys(value).length > 0;
  return false;
}

// Returns true if `codeBlocks` is a non-empty array, regardless of whether
// any entry carries a body. A path-only `codeBlocks` array is still a real
// content field the parser deliberately refused — that's a warn-worthy
// "parser gap" signal, not an "empty placeholder bubble" one.
function hasNonEmptyCodeBlocks(value: unknown): boolean {
  return Array.isArray(value) && value.length > 0;
}

// Cursor user input authored via the Lexical editor lands as a JSON string
// at `v.richText`. A structurally-empty tree (one empty paragraph) means
// the user opened the composer but typed nothing — not a parser gap.
function hasNonEmptyRichText(value: unknown): boolean {
  if (typeof value !== 'string' || value.length === 0) return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return value.length > 0;
  }
  if (typeof parsed !== 'object' || parsed === null) return false;
  const root = (parsed as Record<string, unknown>)['root'];
  if (typeof root !== 'object' || root === null) return false;
  const children = (root as Record<string, unknown>)['children'];
  if (!Array.isArray(children) || children.length === 0) return false;
  // Lexical's idle state: a single paragraph with an empty children array.
  // Anything richer than that is treated as real authored content.
  for (const child of children) {
    if (typeof child !== 'object' || child === null) continue;
    const c = child as Record<string, unknown>;
    if (typeof c['text'] === 'string' && (c['text'] as string).length > 0) return true;
    const inner = c['children'];
    if (Array.isArray(inner) && inner.length > 0) return true;
  }
  return false;
}

interface ParseBubbleOptions {
  // Test-only: when true, skip all fallback parsers and restore the V1
  // "missing_text → drop" behavior. Used by the AC3 parse-gap revert test
  // to prove the fallback chain is what closes the parse gap.
  disableFallbacks?: boolean;
}

function parseBubbleRow(
  row: CursorDiskKVRow,
  composers: Map<string, ComposerInfo>,
  options: ParseBubbleOptions = {},
): ParsedBubble | null {
  const parsedKey = parseBubbleKey(row.key);
  if (parsedKey === null) return null;
  if (row.value === null) {
    log.debug('empty_bubble_skipped', { key: row.key, reason: 'sql_null_value' });
    return null;
  }
  let value: unknown;
  try {
    value = JSON.parse(row.value);
  } catch {
    log.warn('unrecognized_bubble_shape', { key: row.key, reason: 'json_parse' });
    return null;
  }
  if (typeof value !== 'object' || value === null) {
    log.warn('unrecognized_bubble_shape', { key: row.key, reason: 'not_object' });
    return null;
  }
  const v = value as Record<string, unknown>;
  const type = v['type'];
  if (type !== TYPE_USER && type !== TYPE_ASSISTANT) {
    log.warn('unrecognized_bubble_shape', {
      key: row.key,
      reason: 'unknown_type',
      type: typeof type === 'number' ? type : null,
    });
    return null;
  }

  // Text-derivation chain. Primary `v.text` wins when non-empty (the 99%
  // case — preserves existing behavior for legacy chat / Composer-with-text
  // bubbles). Otherwise the fallback parsers fire in deterministic
  // precedence order; first non-empty derivation wins. Tool-call /
  // file-diff / code-block-body / thinking frames are all surfaces Cursor
  // uses in Agent + Composer modes; the V1 extractor dropped them as
  // `missing_text`, which silently lost ≥ 50% of the assistant content in
  // a live agent review (the M1-1 dogfooding gap that drove this item).
  let parsedText: string | null = null;
  let textSource: BubbleTextSource | null = null;
  const rawText = v['text'];
  if (typeof rawText === 'string' && rawText.length > 0) {
    parsedText = rawText;
    textSource = 'text';
  } else if (options.disableFallbacks !== true) {
    const tfd = tryExtractToolFormerText(v);
    if (tfd !== null) {
      parsedText = tfd;
      textSource = 'toolFormerData';
    } else {
      const fd = tryExtractFileDiffText(v);
      if (fd !== null) {
        parsedText = fd;
        textSource = 'fileDiff';
      } else {
        const cb = tryExtractCodeBlocksText(v);
        if (cb !== null) {
          parsedText = cb;
          textSource = 'codeBlocks';
        } else {
          const th = tryExtractThinkingText(v);
          if (th !== null) {
            parsedText = th;
            textSource = 'thinkingContent';
          }
        }
      }
    }
  }

  if (parsedText === null || textSource === null) {
    // Distinguish "bubble had content keys we couldn't parse" (real parser
    // gap → warn) from "bubble shipped with no content at all" (mid-stream
    // placeholder, cancelled compose, or empty richText user bubble → debug,
    // not actionable). The cheap heuristic: if every text-bearing field is
    // empty/absent, downgrade to debug.
    const hasAnyContentField =
      hasNonEmpty(v['toolFormerData']) ||
      hasNonEmpty(v['thinkingContent']) ||
      hasNonEmpty(v['thinking']) ||
      hasNonEmpty(v['attachedHumanChanges']) ||
      hasNonEmptyRichText(v['richText']) ||
      hasNonEmptyCodeBlocks(v['codeBlocks']);
    const reason =
      options.disableFallbacks === true ? 'missing_text' : 'missing_text_and_fallbacks';
    if (hasAnyContentField) {
      log.warn('unrecognized_bubble_shape', { key: row.key, reason });
    } else {
      log.debug('empty_bubble_skipped', { key: row.key, reason });
    }
    return null;
  }

  const composer = composers.get(parsedKey.composer_id);
  if (composer === undefined) {
    log.warn('unrecognized_bubble_shape', { key: row.key, reason: 'no_composer_row' });
    return null;
  }
  const order = composer.bubbleOrder.get(parsedKey.bubble_id);
  if (order === undefined) {
    if (!missingComposerHeaderWarnedKeys.has(row.key)) {
      missingComposerHeaderWarnedKeys.add(row.key);
      log.warn('unrecognized_bubble_shape', {
        key: row.key,
        reason: 'not_in_composer_headers',
      });
    } else {
      log.debug('bubble_not_in_composer_headers_skipped', {
        key: row.key,
        reason: 'not_in_composer_headers',
      });
    }
    return null;
  }
  const parsed: ParsedBubble = {
    composer_id: parsedKey.composer_id,
    bubble_id: parsedKey.bubble_id,
    role: type === TYPE_USER ? 'user' : 'assistant',
    text: parsedText,
    text_source: textSource,
    createdAt: composer.createdAt + order,
    context: {
      attachedFiles: extractAttachedFiles(v),
      referencedFiles: extractReferencedFiles(v),
      deletedFiles: extractDeletedFiles(v),
    },
  };
  if (textSource === 'toolFormerData') {
    const tfd = v['toolFormerData'];
    if (typeof tfd === 'object' && tfd !== null) {
      parsed.toolFormerData = tfd as Record<string, unknown>;
    }
  }
  return parsed;
}

// Cursor's toolFormerData frames vary across tool kinds (built-in edits,
// shell, agentic). No single field name is reliable, so we walk a short
// preference list per slot and stringify object payloads as JSON. Returns
// null only if both args AND output came up empty — i.e. nothing useful to
// surface.
function toolFormerToToolCall(tfd: Record<string, unknown>): CursorToolCall | null {
  const nameField =
    tfd['name'] ??
    tfd['toolName'] ??
    tfd['tool'] ??
    (typeof tfd['type'] === 'string' ? tfd['type'] : undefined);
  const name = typeof nameField === 'string' && nameField.length > 0 ? nameField : 'tool';

  let args: string | undefined;
  const rawArgs = tfd['rawArgs'];
  if (typeof rawArgs === 'string' && rawArgs.length > 0) {
    args = rawArgs;
  } else {
    const params = tfd['params'];
    if (typeof params === 'object' && params !== null) {
      try {
        const s = JSON.stringify(params);
        if (s.length > 2) args = s;
      } catch {
        // unstringifiable — leave args undefined
      }
    }
  }

  let output: string | undefined;
  const result = tfd['result'];
  if (typeof result === 'string' && result.length > 0) {
    output = result;
  } else if (typeof result === 'object' && result !== null) {
    try {
      const s = JSON.stringify(result);
      if (s.length > 2) output = s;
    } catch {
      // unstringifiable — fall through to text
    }
  }
  if (output === undefined) {
    const direct = tfd['text'];
    if (typeof direct === 'string' && direct.length > 0) output = direct;
  }

  let is_error: boolean | undefined;
  const err = tfd['isError'] ?? tfd['is_error'] ?? tfd['error'];
  if (typeof err === 'boolean') {
    is_error = err;
  } else if (typeof err === 'string' || (typeof err === 'object' && err !== null)) {
    is_error = true;
  }

  if (args === undefined && output === undefined && is_error === undefined) return null;

  const call: CursorToolCall = { name };
  if (args !== undefined) call.args = args;
  if (output !== undefined) call.output = output;
  if (is_error !== undefined) call.is_error = is_error;
  return call;
}

function dedupReferencedFiles(values: ReferencedFile[]): ReferencedFile[] {
  const seen = new Map<string, ReferencedFile>();
  for (const r of values) {
    const existing = seen.get(r.path);
    if (existing === undefined) {
      seen.set(r.path, r);
    } else if (existing.language === undefined && r.language !== undefined) {
      // Promote a previously-language-less entry to one with language.
      seen.set(r.path, r);
    }
  }
  return [...seen.values()];
}

function buildTurnContext(
  user: ParsedBubble,
  assistantCluster: ParsedBubble[],
): CursorTurnContext | undefined {
  const attached = dedupStrings([
    ...user.context.attachedFiles,
    ...assistantCluster.flatMap((b) => b.context.attachedFiles),
  ]);
  const referenced = dedupReferencedFiles([
    ...user.context.referencedFiles,
    ...assistantCluster.flatMap((b) => b.context.referencedFiles),
  ]);
  const deleted = dedupStrings([
    ...user.context.deletedFiles,
    ...assistantCluster.flatMap((b) => b.context.deletedFiles),
  ]);
  if (attached.length === 0 && referenced.length === 0 && deleted.length === 0) {
    return undefined;
  }
  const out: CursorTurnContext = {};
  if (attached.length > 0) out.attached_files = attached;
  if (referenced.length > 0) out.referenced_files = referenced;
  if (deleted.length > 0) out.deleted_files = deleted;
  return out;
}

function flattenContextFiles(ctx: CursorTurnContext): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (p: string): void => {
    if (!seen.has(p)) {
      seen.add(p);
      out.push(p);
    }
  };
  for (const p of ctx.attached_files ?? []) push(p);
  for (const r of ctx.referenced_files ?? []) push(r.path);
  for (const p of ctx.deleted_files ?? []) push(p);
  return out;
}

async function safeMtimeMs(path: string): Promise<number> {
  try {
    const s = await stat(path);
    return s.mtimeMs;
  } catch {
    return Date.now();
  }
}

// Read the MAX mtime across the global DB family (`state.vscdb`, -wal,
// -shm). SQLite WAL mode advances the -wal file's mtime on each commit
// while the main DB's mtime stays stale until the next checkpoint (which
// can be minutes away under sustained writes). Reading only the main DB's
// mtime would make the periodic-poll mtime guard miss the exact writes
// it's meant to recover. Missing files are skipped (no WAL yet → no
// mtime); the returned value is 0 only if none of the three exist.
export async function maxGlobalDbFamilyMtime(globalDbPath: string): Promise<number> {
  const paths = [globalDbPath, `${globalDbPath}-wal`, `${globalDbPath}-shm`];
  let max = 0;
  for (const p of paths) {
    try {
      const s = await stat(p);
      if (s.mtimeMs > max) max = s.mtimeMs;
    } catch {
      // File may not exist yet (e.g., -wal absent before first WAL write).
    }
  }
  return max;
}

export interface ExtractCursorTurnsOptions {
  // Test-only: when true, skip parseBubbleRow's fallback chain so the AC3
  // parse-gap revert test can prove the chain is what closes the parse gap.
  disableFallbacks?: boolean;
}

export async function extractCursorTurns(
  globalDbPath: string,
  lastSeenBubbleIdPerComposer: Map<string, string>,
  options: ExtractCursorTurnsOptions = {},
): Promise<CursorTurn[]> {
  let db: Database.Database;
  try {
    db = new Database(globalDbPath, { readonly: true, fileMustExist: true });
  } catch (err) {
    log.warn('open_failed', { path: globalDbPath, message: (err as Error).message });
    return [];
  }

  let bubbleRows: CursorDiskKVRow[];
  let composerRows: CursorDiskKVRow[];
  try {
    const tableExists = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='cursorDiskKV'")
      .get();
    if (tableExists === undefined) {
      log.warn('schema_unrecognized', { path: globalDbPath, reason: 'no_cursorDiskKV_table' });
      db.close();
      return [];
    }
    composerRows = db
      .prepare("SELECT key, value FROM cursorDiskKV WHERE key LIKE 'composerData:%'")
      .all() as CursorDiskKVRow[];
    bubbleRows = db
      .prepare("SELECT key, value FROM cursorDiskKV WHERE key LIKE 'bubbleId:%'")
      .all() as CursorDiskKVRow[];
  } catch (err) {
    log.warn('query_failed', { path: globalDbPath, message: (err as Error).message });
    db.close();
    return [];
  }
  db.close();

  const composers = new Map<string, ComposerInfo>();
  for (const row of composerRows) {
    const info = parseComposerRow(row);
    if (info !== null) composers.set(info.composer_id, info);
  }

  if (bubbleRows.length === 0) {
    log.warn('no_bubble_keys', { path: globalDbPath });
    return [];
  }

  const mtime = await safeMtimeMs(globalDbPath);

  const byComposer = new Map<string, ParsedBubble[]>();
  for (const row of bubbleRows) {
    const parsed = parseBubbleRow(row, composers, {
      disableFallbacks: options.disableFallbacks === true,
    });
    if (parsed === null) continue;
    let arr = byComposer.get(parsed.composer_id);
    if (arr === undefined) {
      arr = [];
      byComposer.set(parsed.composer_id, arr);
    }
    arr.push(parsed);
  }

  const turns: CursorTurn[] = [];
  for (const [composer_id, bubbles] of byComposer) {
    bubbles.sort((a, b) => a.createdAt - b.createdAt);

    let startIdx = 0;
    const checkpoint = lastSeenBubbleIdPerComposer.get(composer_id);
    if (checkpoint !== undefined) {
      const ix = bubbles.findIndex((b) => b.bubble_id === checkpoint);
      if (ix < 0) {
        log.warn('checkpoint_not_found', { composer_id, checkpoint });
        continue;
      }
      startIdx = ix + 1;
    }

    // M1-1 sub-gap D (item 036): when the checkpoint lands on an assistant
    // bubble (Cursor streamed more assistant bubbles into a turn ECHO
    // already captured at an earlier partial state), emit a continuation
    // turn for the new bubbles instead of silently skipping them. The
    // continuation turn carries `is_continuation: true` and
    // `continuation_of_assistant_bubble_id: <checkpoint>` as the join key
    // back to the prior atom. The `user_message` text is the original user
    // bubble's text (walked back through `bubbles[]` for this composer) so
    // a query for the user's question matches both the prior and the
    // continuation atoms — consumers that want a deduped logical-turn view
    // group on `metadata.user_bubble_id`. Pre-036 (V1.5.7): silent
    // fast-forward dropped these bubbles entirely; agent-mode runs lost
    // 15+ post-checkpoint bubbles per cluster, including the verdict turn.
    // `agentKv:blob:` remains content-addressed dedupe storage, not a
    // chat-schema replacement (per 2026-05-09 diagnosis correction in
    // raw/internal/decisions/2026-05-09-cursor-capture-diagnosis-correction.md);
    // chat turns remain in `bubbleId:` / `composerData:`.
    let i = startIdx;
    if (checkpoint !== undefined && i < bubbles.length && bubbles[i]!.role === 'assistant') {
      const continuationStart = i;
      const continuationCluster: ParsedBubble[] = [];
      while (i < bubbles.length && bubbles[i]!.role === 'assistant') {
        continuationCluster.push(bubbles[i]!);
        i += 1;
      }
      // continuationCluster.length ≥ 1 by the entry condition above.
      let userBubble: ParsedBubble | undefined;
      for (let k = continuationStart - 1; k >= 0; k -= 1) {
        if (bubbles[k]!.role === 'user') {
          userBubble = bubbles[k]!;
          break;
        }
      }
      if (userBubble === undefined) {
        // Defensive guard — would mean every prior bubble in the composer
        // is also assistant, which doesn't match any observed Cursor flow.
        // Falls back to the prior silent-skip behavior (i is already past
        // the cluster).
        log.warn('continuation_no_preceding_user', { composer_id, checkpoint });
      } else {
        const last = continuationCluster[continuationCluster.length - 1]!;
        const sources = continuationCluster.map((b) => b.text_source);
        log.info('continuation_atom', {
          composer_id,
          continuation_of_assistant_bubble_id: checkpoint,
          n_new_bubbles: continuationCluster.length,
        });
        const turn: CursorTurn = {
          composer_id,
          user_bubble_id: userBubble.bubble_id,
          assistant_bubble_id: last.bubble_id,
          assistant_bubble_ids: continuationCluster.map((b) => b.bubble_id),
          user_message: userBubble.text,
          assistant_message: continuationCluster.map((b) => b.text).join('\n\n'),
          assistant_created_at: last.createdAt,
          mtime,
          is_continuation: true,
          continuation_of_assistant_bubble_id: checkpoint,
        };
        const context = buildTurnContext(userBubble, continuationCluster);
        if (context !== undefined) turn.context = context;
        if (sources.some((s) => s !== 'text')) {
          turn.bubble_text_sources = sources;
        }
        const toolCalls: CursorToolCall[] = [];
        const thinkingParts: string[] = [];
        for (const b of continuationCluster) {
          if (b.text_source === 'toolFormerData' && b.toolFormerData !== undefined) {
            const call = toolFormerToToolCall(b.toolFormerData);
            if (call !== null) toolCalls.push(call);
          } else if (b.text_source === 'thinkingContent' && b.text.length > 0) {
            thinkingParts.push(b.text);
          }
        }
        if (toolCalls.length > 0) {
          turn.tool_calls = toolCalls;
          turn.had_tool_use = true;
        } else if (sources.some((s) => s === 'toolFormerData')) {
          turn.had_tool_use = true;
        }
        if (thinkingParts.length > 0) {
          turn.thinking = thinkingParts.join('\n\n');
        }
        turns.push(turn);
      }
      // `i` is already past the continuation cluster — fall through to the
      // main user→assistant loop below in case more turns arrive in the
      // same bubbles[] (rare: a third user message landing in the same
      // tick).
    }
    while (i < bubbles.length) {
      const cur = bubbles[i]!;
      if (cur.role === 'assistant') {
        // True orphan — no preceding user AND no checkpoint that would
        // explain the assistant as a streaming continuation. Cursor
        // sometimes writes these for system / synthesized bubbles. Drop
        // with a warn rather than pairing into a malformed turn.
        log.warn('orphan_assistant_bubble', { composer_id, bubble_id: cur.bubble_id });
        i += 1;
        continue;
      }
      // cur is user. Collect every consecutive assistant bubble until we hit
      // the next user bubble (or end of array). Cursor splits a single
      // logical assistant response into multiple type=2 bubbles in many
      // flows — pairing only the first would silently drop the rest.
      const assistantCluster: ParsedBubble[] = [];
      let j = i + 1;
      while (j < bubbles.length && bubbles[j]!.role === 'assistant') {
        assistantCluster.push(bubbles[j]!);
        j += 1;
      }
      if (assistantCluster.length === 0) {
        // User bubble with no assistant response yet — incomplete turn.
        // Leave it for the next pass once Cursor finishes writing.
        break;
      }
      const last = assistantCluster[assistantCluster.length - 1]!;
      const sources = assistantCluster.map((b) => b.text_source);
      const turn: CursorTurn = {
        composer_id,
        user_bubble_id: cur.bubble_id,
        assistant_bubble_id: last.bubble_id,
        assistant_bubble_ids: assistantCluster.map((b) => b.bubble_id),
        user_message: cur.text,
        assistant_message: assistantCluster.map((b) => b.text).join('\n\n'),
        assistant_created_at: last.createdAt,
        mtime,
      };
      const context = buildTurnContext(cur, assistantCluster);
      if (context !== undefined) turn.context = context;
      if (sources.some((s) => s !== 'text')) {
        turn.bubble_text_sources = sources;
      }
      const toolCalls: CursorToolCall[] = [];
      const thinkingParts: string[] = [];
      for (const b of assistantCluster) {
        if (b.text_source === 'toolFormerData' && b.toolFormerData !== undefined) {
          const call = toolFormerToToolCall(b.toolFormerData);
          if (call !== null) toolCalls.push(call);
        } else if (b.text_source === 'thinkingContent' && b.text.length > 0) {
          thinkingParts.push(b.text);
        }
      }
      if (toolCalls.length > 0) {
        turn.tool_calls = toolCalls;
        turn.had_tool_use = true;
      } else if (sources.some((s) => s === 'toolFormerData')) {
        // A toolFormerData bubble existed but produced no derivable structured
        // call (rare — usually a malformed frame). Still flag the turn.
        turn.had_tool_use = true;
      }
      if (thinkingParts.length > 0) {
        turn.thinking = thinkingParts.join('\n\n');
      }
      turns.push(turn);
      i = j;
    }
  }

  turns.sort((a, b) => a.assistant_created_at - b.assistant_created_at);
  return turns;
}

async function backfillLastSeenMap(
  storage: Storage,
  globalDbPath: string,
): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  const events = await storage.query({ source: `fs:${globalDbPath}` });
  events.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  for (const evt of events) {
    const md = evt.metadata;
    if (md === undefined) continue;
    const composer_id = md['composer_id'];
    const assistant_bubble_id = md['assistant_bubble_id'];
    if (typeof composer_id === 'string' && typeof assistant_bubble_id === 'string') {
      map.set(composer_id, assistant_bubble_id);
    }
  }
  return map;
}

function workspaceHashFromPath(dbPath: string, prefix: string): string | undefined {
  if (!dbPath.startsWith(prefix)) return undefined;
  const rest = dbPath.slice(prefix.length);
  const slash = rest.indexOf('/');
  if (slash <= 0) return undefined;
  return rest.slice(0, slash);
}

function refreshComposerWorkspaceMap(
  workspaceDbPath: string,
  workspacePrefix: string,
  map: Map<string, string>,
): void {
  const workspaceId = workspaceHashFromPath(workspaceDbPath, workspacePrefix);
  if (workspaceId === undefined) return;

  let db: Database.Database;
  try {
    db = new Database(workspaceDbPath, { readonly: true, fileMustExist: true });
  } catch (err) {
    log.warn('workspace_db_open_failed', {
      path: workspaceDbPath,
      message: (err as Error).message,
    });
    return;
  }
  try {
    const tableExists = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='ItemTable'")
      .get();
    if (tableExists === undefined) return;
    const row = db
      .prepare("SELECT value FROM ItemTable WHERE key = 'composer.composerData'")
      .get() as { value: string } | undefined;
    if (row === undefined) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(row.value);
    } catch {
      return;
    }
    if (typeof parsed !== 'object' || parsed === null) return;
    // Cursor's workspace composer registry has two shapes (see
    // src/mcp/cursor-workspace-resolver.ts:listComposerIdsForWorkspace for
    // the same union pattern + the empirical 2026-05-11 finding that drove
    // both code paths to handle the post-migration shape). Legacy:
    // `allComposers[].composerId`. Current: `selectedComposerIds[]` +
    // `lastFocusedComposerIds[]` (with `hasMigratedMultipleComposers: true`).
    // Pre-fix this code only read the legacy shape, so every migrated
    // workspace's atoms shipped without `metadata.workspace_id` populated
    // — which is the deeper cause of the R1 reliability concern that drove
    // item 035 to derive composer_id from Cursor's storage directly rather
    // than from captured-atom metadata.
    const allComposers = (parsed as Record<string, unknown>)['allComposers'];
    if (Array.isArray(allComposers)) {
      for (const c of allComposers) {
        if (typeof c === 'object' && c !== null) {
          const id = (c as Record<string, unknown>)['composerId'];
          if (typeof id === 'string') {
            map.set(id, workspaceId);
          }
        }
      }
    }
    for (const key of ['selectedComposerIds', 'lastFocusedComposerIds'] as const) {
      const arr = (parsed as Record<string, unknown>)[key];
      if (Array.isArray(arr)) {
        for (const id of arr) {
          if (typeof id === 'string') {
            map.set(id, workspaceId);
          }
        }
      }
    }
  } catch (err) {
    log.warn('workspace_inference_failed', {
      path: workspaceDbPath,
      message: (err as Error).message,
    });
  } finally {
    db.close();
  }
}

export interface CursorExtractorOptions {
  globalDbPath?: string;
  workspacePrefix?: string;
  // Override the periodic re-poll interval (default
  // `CURSOR_REPOLL_INTERVAL_MS`). No environment variable is read — the
  // source constant and this option are the only knobs.
  repollIntervalMs?: number;
  // Run one full scan synchronously at startup, before resolving the
  // handle. Without this, the extractor sets `lastSeenScanMtime` to the
  // current DB mtime and waits for chokidar/repoll to detect a change —
  // which means an empty-storage caller (like `serve-trace`) sees zero
  // Cursor turns until the user types into Cursor again. Mirrors the
  // CC/Codex JSONL extractors' boot-scan semantics. Production daemons
  // can stay default-off (they keep checkpoint state in storage) but
  // dev-time live viewers should set this true.
  scanOnStart?: boolean;
  // Test-only: populate `CursorExtractorHandle.__testHooks`. Production
  // callers leave this unset; the hooks field stays `undefined`.
  exposeTestHooks?: true;
  // Test-only: skip parseBubbleRow's fallback chain so the AC3 parse-gap
  // revert test can prove the chain is what closes the parse gap.
  __disableToolCallFallbacks?: boolean;
  // Item 037 / AC1 test-only injection seams. Tests pass spies to count
  // resolver invocations (proving the cache prevents re-walks on repeat
  // composers). Production callers leave both unset and the defaults run.
  __resolveRepoRootForWorkspaceId?: (
    workspace_id: string,
    workspaceStorageDir: string,
  ) => string | null;
  __resolveRepoRootFromFiles?: (files: readonly string[]) => string | null;
}

export interface CursorExtractorTestHooks {
  // Invoke the repoll entry path once. Resolves after the scheduled
  // extraction completes.
  triggerRepoll(): Promise<void>;
  // Read the current mtime checkpoint (for assertions).
  getLastSeenScanMtime(): number;
  // Override the mtime checkpoint. Tests use this to bypass the
  // auto-init-at-start so the FIRST repoll tick can fire against a
  // pre-seeded fixture.
  setLastSeenScanMtime(value: number): void;
  // Item 037 / AC1: synchronously invoke the workspace-map refresh path
  // that chokidar normally drives. Tests use this to bind a composer →
  // workspace_id without depending on macOS FSEvents timing (which can
  // miss a utimes touch within the test's 200-300ms wait budget on a
  // busy machine). Production callers never invoke this hook.
  refreshWorkspaceMap(workspaceDbPath: string): Promise<void>;
}

export interface CursorExtractorHandle {
  stop: () => Promise<void>;
  // Populated only when `CursorExtractorOptions.exposeTestHooks: true`.
  // The double-underscore prefix marks the field as test-only.
  __testHooks?: CursorExtractorTestHooks;
}

export async function startCursorExtractor(
  storage: Storage,
  options: CursorExtractorOptions = {},
): Promise<CursorExtractorHandle> {
  const globalDbPath = options.globalDbPath ?? DEFAULT_GLOBAL_DB;
  const workspacePrefix = options.workspacePrefix ?? DEFAULT_WORKSPACE_PREFIX;
  const repollIntervalMs = options.repollIntervalMs ?? CURSOR_REPOLL_INTERVAL_MS;
  const disableFallbacks = options.__disableToolCallFallbacks === true;

  const lastSeenMap = await backfillLastSeenMap(storage, globalDbPath);
  const composerToWorkspace = new Map<string, string>();
  // Item 037 / AC1: positive-only repo_root cache keyed by composer_id.
  // Cache discipline (R3 decision tree, AC1 #4):
  //   - registry binding present → ALWAYS run Stage 1 (writes overwrite the
  //     cache; Stage 1 null does NOT cache anything and falls through to
  //     Stage 2)
  //   - no binding → cache hit short-circuits (avoids re-walking files on
  //     repeat composers); cache miss falls through to Stage 2
  //   - Stage 2 success → populate cache; failure → leave cache as-is so
  //     the next tick retries
  // The cache is per-extractor instance (not module-level) so test setups
  // don't leak state across vitest workers. Production behavior is
  // identical to a module-level cache: a single long-running extractor
  // instance owns capture for the lifetime of the daemon process.
  const repoRootCache = new Map<string, string>();
  const resolveRepoRootForWs =
    options.__resolveRepoRootForWorkspaceId ?? resolveRepoRootForWorkspaceId;
  const resolveRepoRootFromFilesInj =
    options.__resolveRepoRootFromFiles ?? resolveRepoRootFromFiles;

  let processing: Promise<void> = Promise.resolve();
  let stopped = false;
  let debounceTimer: NodeJS.Timeout | null = null;
  const DEBOUNCE_MS = 300;

  // mtime checkpoint for the periodic re-poll path. Initialized to the
  // current family-max mtime so the first interval tick is not a spurious
  // scan against unchanged data; tests can override via the test hooks.
  let lastSeenScanMtime = await maxGlobalDbFamilyMtime(globalDbPath);

  function isGlobalDbFamily(p: string): boolean {
    return p === globalDbPath || p === `${globalDbPath}-wal` || p === `${globalDbPath}-shm`;
  }

  function isWorkspaceDb(p: string): boolean {
    return p.startsWith(workspacePrefix) && p.endsWith('state.vscdb');
  }

  async function handleGlobalChange(reason: 'repoll' | 'chokidar'): Promise<void> {
    log.debug('tick', { reason });
    const turns = await extractCursorTurns(globalDbPath, lastSeenMap, {
      disableFallbacks,
    });
    for (const turn of turns) {
      const ws = composerToWorkspace.get(turn.composer_id);
      const metadata: Record<string, unknown> = {
        composer_id: turn.composer_id,
        session_id: turn.composer_id,
        user_bubble_id: turn.user_bubble_id,
        assistant_bubble_id: turn.assistant_bubble_id,
        assistant_bubble_ids: turn.assistant_bubble_ids,
        mtime: turn.mtime,
      };
      if (ws !== undefined) metadata['workspace_id'] = ws;
      // Item 037 / AC1: compute filesReferenced before repo_root resolution
      // because Stage 2's file-walk fallback needs the same list. The
      // metadata['files_referenced'] write below stays on `turn.context`
      // guard so we don't mint an empty array on context-less turns.
      let filesReferenced: string[] = [];
      if (turn.context !== undefined) {
        metadata['context'] = turn.context;
        filesReferenced = flattenContextFiles(turn.context);
        if (filesReferenced.length > 0) metadata['files_referenced'] = filesReferenced;
      }
      // Item 037 / AC1: two-stage repo_root resolution.
      //   Stage 1 (preferred): registry binding via composerToWorkspace +
      //     resolveRepoRootForWorkspaceId. Reads workspace.json directly so
      //     fresh composers don't need a separate composer↔workspace
      //     round-trip at retrieval time.
      //   Stage 2 (fallback): file-walk for .git ancestor on
      //     `files_referenced`. Closes the 035 freshness gap for composers
      //     whose chokidar binding hasn't fired yet.
      // See AC1 #4 for the full decision tree.
      const repoRoot = resolveCursorRepoRootForTurn(
        turn.composer_id,
        ws,
        filesReferenced,
        workspacePrefix,
        repoRootCache,
        resolveRepoRootForWs,
        resolveRepoRootFromFilesInj,
      );
      if (repoRoot !== undefined) metadata['repo_root'] = repoRoot;
      if (turn.bubble_text_sources !== undefined) {
        metadata['bubble_text_sources'] = turn.bubble_text_sources;
      }
      if (turn.had_tool_use === true) metadata['had_tool_use'] = true;
      if (turn.tool_calls !== undefined) metadata['tool_calls'] = turn.tool_calls;
      if (turn.thinking !== undefined) metadata['thinking'] = turn.thinking;
      if (turn.is_continuation === true) {
        metadata['is_continuation'] = true;
        if (turn.continuation_of_assistant_bubble_id !== undefined) {
          metadata['continuation_of_assistant_bubble_id'] =
            turn.continuation_of_assistant_bubble_id;
        }
      }
      const candidate = {
        source: `fs:${globalDbPath}`,
        timestamp: new Date(turn.assistant_created_at).toISOString(),
        content: `USER: ${turn.user_message}\n\nASSISTANT: ${turn.assistant_message}`,
        metadata,
      };
      log.info('candidate', { composer_id: turn.composer_id });
      const result = await processCandidate(candidate, storage);
      if (result.accepted) {
        lastSeenMap.set(turn.composer_id, turn.assistant_bubble_id);
      } else {
        log.warn('candidate_rejected', {
          reason: result.reason,
          composer_id: turn.composer_id,
        });
      }
    }
  }

  function handleWorkspaceChange(path: string): void {
    refreshComposerWorkspaceMap(path, workspacePrefix, composerToWorkspace);
  }

  function schedule(work: () => Promise<void> | void): void {
    if (stopped) return;
    processing = processing.then(async () => {
      if (stopped) return;
      try {
        await work();
      } catch (err) {
        log.error('handler_error', { message: (err as Error).message });
      }
    });
  }

  function scheduleGlobalChange(): void {
    if (debounceTimer !== null) return;
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      schedule(() => handleGlobalChange('chokidar'));
    }, DEBOUNCE_MS);
  }

  // Periodic re-poll entry path (NEW, separate from chokidar). Reads the
  // family-max mtime; short-circuits if it has not advanced beyond the
  // checkpoint; otherwise schedules a NEW extraction tick directly via
  // `schedule()` — bypassing `scheduleGlobalChange`'s debounce guard
  // (which is correct for coalescing chokidar bursts but would silently
  // drop poll ticks that race with a pending debounce). Updates the
  // checkpoint AFTER `schedule()` enqueues (not after extraction
  // completes — the `processing` chain guarantees serialization).
  async function triggerRepollExtraction(): Promise<void> {
    if (stopped) return;
    const current = await maxGlobalDbFamilyMtime(globalDbPath);
    if (current <= lastSeenScanMtime) return;
    schedule(() => handleGlobalChange('repoll'));
    lastSeenScanMtime = current;
    await processing;
  }

  const repollTimer: NodeJS.Timeout = setInterval(() => {
    void triggerRepollExtraction();
  }, repollIntervalMs);
  // Don't keep the Node event loop alive solely on the repoll interval —
  // the chokidar watcher already owns liveness for the extractor's
  // lifecycle, and tests can finish without waiting on a held interval.
  if (typeof repollTimer.unref === 'function') repollTimer.unref();

  const globalDbDir = dirname(globalDbPath);
  const watcher: FSWatcher = chokidar.watch([globalDbDir, workspacePrefix], {
    ignoreInitial: true,
    persistent: true,
    awaitWriteFinish: false,
  });

  function dispatch(p: string): void {
    if (isGlobalDbFamily(p)) {
      scheduleGlobalChange();
    } else if (isWorkspaceDb(p)) {
      schedule(() => handleWorkspaceChange(p));
    }
  }

  watcher.on('add', dispatch);
  watcher.on('change', dispatch);
  watcher.on('error', (err: unknown) => {
    log.error('watcher_error', { message: (err as Error).message });
  });

  await new Promise<void>((resolve) => {
    watcher.once('ready', () => resolve());
  });

  if (options.scanOnStart === true) {
    schedule(() => handleGlobalChange('repoll'));
    await processing;
  }

  log.info('started', { globalDbPath, workspacePrefix, repollIntervalMs });

  const handle: CursorExtractorHandle = {
    stop: async () => {
      stopped = true;
      clearInterval(repollTimer);
      if (debounceTimer !== null) {
        clearTimeout(debounceTimer);
        debounceTimer = null;
      }
      await watcher.close();
      await processing;
      log.info('stopped', {});
    },
  };
  if (options.exposeTestHooks === true) {
    handle.__testHooks = {
      triggerRepoll: () => triggerRepollExtraction(),
      getLastSeenScanMtime: () => lastSeenScanMtime,
      setLastSeenScanMtime: (value: number) => {
        lastSeenScanMtime = value;
      },
      refreshWorkspaceMap: async (workspaceDbPath: string): Promise<void> => {
        schedule(() => handleWorkspaceChange(workspaceDbPath));
        await processing;
      },
    };
  }
  return handle;
}
