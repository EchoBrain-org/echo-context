import type { CaptureEvent } from '../../storage/interface.js';
import {
  conversationArtifact,
  fileArtifact,
} from '../artifacts.js';
import type {
  Adapter,
  ArtifactRef,
  ContextRef,
  NormalizedContextEvent,
} from '../types.js';
import {
  buildConversation,
  buildInitiatorActor,
  buildProjectRef,
  buildProvenance,
  extractOpenLoopHints,
  fail,
  getNumber,
  getRecord,
  getString,
  getStringArray,
  tryParseTurnPair,
} from './_shared.js';

export const CURSOR_VERSION = 'cursor@2';

export const CURSOR_SOURCE_RE = /^fs:.*\/Cursor\/User\/globalStorage\/state\.vscdb$/;

export function matchesCursor(source: string): boolean {
  return CURSOR_SOURCE_RE.test(source);
}

export const adaptCursor: Adapter = (
  event: CaptureEvent,
): NormalizedContextEvent | null => {
  // Source-prefix dispatch is coarse — see claude-code adapter for context.
  const pair = tryParseTurnPair(event.content);
  if (pair === null) return null;

  const meta = event.metadata;
  const composer_id = getString(meta, 'composer_id') ?? getString(meta, 'session_id');
  if (composer_id === undefined) {
    fail(event, 'cursor: missing metadata.composer_id');
  }

  const turn_index = getNumber(meta, 'turn_index');
  const workspace_id = getString(meta, 'workspace_id');
  const repo_root = getString(meta, 'repo_root');
  const ctxBlock = getRecord(meta, 'context');

  const artifacts: ArtifactRef[] = [conversationArtifact('cursor', composer_id)];
  const visible: string[] = [];

  if (ctxBlock !== undefined) {
    const attached = getStringArray(ctxBlock, 'attached_files');
    if (attached !== undefined) {
      for (const p of attached) visible.push(p);
    }
    const referenced = ctxBlock['referenced_files'];
    if (Array.isArray(referenced)) {
      for (const r of referenced) {
        if (typeof r === 'object' && r !== null) {
          const path = getString(r as Record<string, unknown>, 'path');
          if (path !== undefined) {
            artifacts.push(fileArtifact(null, path));
          }
        }
      }
    }
    const deleted = getStringArray(ctxBlock, 'deleted_files');
    if (deleted !== undefined) {
      for (const p of deleted) {
        artifacts.push(fileArtifact(null, p));
      }
    }
  }

  const ambient: Record<string, string> = {};
  if (workspace_id !== undefined) ambient.workspace_id = workspace_id;

  const context: ContextRef | undefined = (() => {
    if (visible.length === 0 && Object.keys(ambient).length === 0) return undefined;
    const c: ContextRef = {};
    if (visible.length > 0) c.visible = visible;
    if (Object.keys(ambient).length > 0) c.ambient = ambient;
    return c;
  })();

  const out: NormalizedContextEvent = {
    schema_version: 1,
    id: event.id,
    time: { occurred_at: event.timestamp },
    source: {
      app: 'cursor',
      surface: 'composer',
      raw_pointer: event.source,
    },
    actors: [buildInitiatorActor(meta), { role: 'assistant', provider: 'cursor' }],
    action: {
      kind: 'message',
      input: pair.user,
      output: pair.assistant,
    },
    artifacts,
    provenance: buildProvenance(event, CURSOR_VERSION),
    conversation: buildConversation(composer_id, turn_index, 'cursor', {
      ...meta,
      thread_id: getString(meta, 'thread_id') ?? composer_id,
      root_thread_id: getString(meta, 'root_thread_id') ?? composer_id,
      thread_kind: getString(meta, 'thread_kind') ?? 'root',
    }),
  };

  if (context !== undefined) out.context = context;
  const project = buildProjectRef(meta, repo_root);
  if (project !== undefined) out.project = project;
  const hints = extractOpenLoopHints(pair.user, pair.assistant);
  if (hints.length > 0) out.open_loop_hints = hints;

  return out;
};
