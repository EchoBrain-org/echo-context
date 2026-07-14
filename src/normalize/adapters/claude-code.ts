import type { CaptureEvent } from '../../storage/interface.js';
import {
  conversationArtifact,
  fileArtifact,
  normalizeRemoteUrl,
  workspaceArtifact,
} from '../artifacts.js';
import type { Adapter, ArtifactRef, ContextRef, NormalizedContextEvent } from '../types.js';
import {
  buildAssistant,
  buildConversation,
  buildProvenance,
  buildRepoArtifact,
  extractOpenLoopHints,
  fail,
  getBoolean,
  getNumber,
  getRecord,
  getString,
  getStringArray,
  tryParseTurnPair,
} from './_shared.js';

export const CLAUDE_CODE_VERSION = 'claude-code@1';

export const CLAUDE_CODE_SOURCE_RE = /^fs:.*\/\.claude\/projects\/.*\.jsonl$/;

export function matchesClaudeCode(source: string): boolean {
  return CLAUDE_CODE_SOURCE_RE.test(source);
}

export const adaptClaudeCode: Adapter = (event: CaptureEvent): NormalizedContextEvent | null => {
  // The source-prefix dispatch is intentionally coarse: a `fs:.../.claude/projects/.../*.jsonl`
  // event might be a turn-pair from the claude-code-extractor OR a generic stat-change event
  // from the fs-watcher (same path observed by two surfaces). Only the former is ours.
  const pair = tryParseTurnPair(event.content);
  if (pair === null) return null;

  const meta = event.metadata;
  const session_id = getString(meta, 'session_id');
  if (session_id === undefined) {
    fail(event, 'claude-code: missing metadata.session_id');
  }

  const turn_index = getNumber(meta, 'turn_index');
  const had_tool_use = getBoolean(meta, 'had_tool_use') === true;
  const repo_root = getString(meta, 'repo_root');
  const filesReferenced = getStringArray(meta, 'files_referenced');
  const model = getString(meta, 'model');
  const branch = getString(meta, 'branch');
  const canonicalRoot = getString(meta, 'canonical_root');

  const gitState = getRecord(meta, 'git_state');
  const originUrl = gitState !== undefined ? getString(gitState, 'origin_url') : undefined;
  const workspace = canonicalRoot !== undefined ? workspaceArtifact(canonicalRoot) : null;
  const repo = workspace === null ? buildRepoArtifact(repo_root, originUrl) : null;
  const scopeId = workspace !== null ? `workspace:${workspace.id}` : (repo?.id ?? null);
  const fileRoot = workspace !== null ? canonicalRoot : repo_root;
  const artifacts: ArtifactRef[] = [conversationArtifact('claude_code', session_id)];
  if (workspace !== null) artifacts.push(workspace);
  else if (repo !== null) artifacts.push(repo.artifact);

  if (filesReferenced !== undefined) {
    for (const path of filesReferenced) {
      artifacts.push(fileArtifact(scopeId, path, fileRoot));
    }
  }

  const ambient: Record<string, string> = {};
  if (had_tool_use) ambient.had_tool_use = 'true';
  if (branch !== undefined) ambient.branch = branch;
  const cli_version = getString(meta, 'cli_version');
  if (cli_version !== undefined) ambient.cli_version = cli_version;
  const permission_mode = getString(meta, 'permission_mode');
  if (permission_mode !== undefined) ambient.permission_mode = permission_mode;
  if (originUrl !== undefined) ambient.git_alias = normalizeRemoteUrl(originUrl);

  const context: ContextRef | undefined = Object.keys(ambient).length > 0 ? { ambient } : undefined;

  const out: NormalizedContextEvent = {
    schema_version: 1,
    id: event.id,
    time: { occurred_at: event.timestamp },
    source: {
      app: 'claude_code',
      surface: 'jsonl',
      raw_pointer: event.source,
    },
    actors: [{ role: 'user' }, buildAssistant(model, 'anthropic')],
    action: {
      kind: 'message',
      input: pair.user,
      output: pair.assistant,
    },
    artifacts,
    provenance: buildProvenance(event, CLAUDE_CODE_VERSION),
    conversation: buildConversation(session_id, turn_index, 'claude_code'),
  };

  if (context !== undefined) out.context = context;
  const hints = extractOpenLoopHints(pair.user, pair.assistant);
  if (hints.length > 0) out.open_loop_hints = hints;

  return out;
};
