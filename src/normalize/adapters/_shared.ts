import { createHash } from 'node:crypto';
import type { CaptureEvent } from '../../storage/interface.js';
import { repoArtifact } from '../artifacts.js';
import { NormalizationError } from '../errors.js';
import { isValidLogicalTurnId } from '../logical-turn-id.js';
import type {
  ActorRef,
  ArtifactRef,
  NormalizedContextEvent,
  ProjectRef,
  ProvenanceRef,
} from '../types.js';

const TURN_PAIR_RE = /^USER: ([\s\S]*?)\n\nASSISTANT: ([\s\S]*)$/;

export function parseTurnPair(content: string): { user: string; assistant: string } {
  const m = TURN_PAIR_RE.exec(content);
  if (m === null) {
    throw new Error('content does not match USER: ... \\n\\nASSISTANT: ... envelope');
  }
  return { user: m[1] as string, assistant: m[2] as string };
}

export function tryParseTurnPair(content: string): { user: string; assistant: string } | null {
  const m = TURN_PAIR_RE.exec(content);
  if (m === null) return null;
  return { user: m[1] as string, assistant: m[2] as string };
}

export function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

export function buildProvenance(
  event: CaptureEvent,
  extractorVersion: string,
): ProvenanceRef {
  return {
    source_event_id: event.id,
    raw_payload_hash: sha256Hex(event.content),
    extractor_version: extractorVersion,
  };
}

export function fail(event: CaptureEvent, message: string): never {
  throw new NormalizationError(message, event);
}

export function getString(
  meta: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  if (meta === undefined) return undefined;
  const v = meta[key];
  return typeof v === 'string' ? v : undefined;
}

export function getNumber(
  meta: Record<string, unknown> | undefined,
  key: string,
): number | undefined {
  if (meta === undefined) return undefined;
  const v = meta[key];
  return typeof v === 'number' ? v : undefined;
}

export function getBoolean(
  meta: Record<string, unknown> | undefined,
  key: string,
): boolean | undefined {
  if (meta === undefined) return undefined;
  const v = meta[key];
  return typeof v === 'boolean' ? v : undefined;
}

export function getStringArray(
  meta: Record<string, unknown> | undefined,
  key: string,
): string[] | undefined {
  if (meta === undefined) return undefined;
  const v = meta[key];
  if (!Array.isArray(v)) return undefined;
  const out: string[] = [];
  for (const item of v) {
    if (typeof item === 'string') out.push(item);
  }
  return out;
}

export function getRecord(
  meta: Record<string, unknown> | undefined,
  key: string,
): Record<string, unknown> | undefined {
  if (meta === undefined) return undefined;
  const v = meta[key];
  if (typeof v === 'object' && v !== null && !Array.isArray(v)) {
    return v as Record<string, unknown>;
  }
  return undefined;
}

export function buildAssistant(
  model: string | undefined,
  provider: string,
): NormalizedContextEvent['actors'][number] {
  const a: NormalizedContextEvent['actors'][number] = { role: 'assistant', provider };
  if (model !== undefined) a.model = model;
  return a;
}

export function buildConversation(
  session_id: string,
  turn_index: number | undefined,
  provider: string,
  metadata?: Record<string, unknown>,
): NormalizedContextEvent['conversation'] {
  const conv: NonNullable<NormalizedContextEvent['conversation']> = { provider, session_id };
  if (turn_index !== undefined) conv.turn_index = turn_index;
  const stringFields = [
    'thread_id',
    'root_thread_id',
    'parent_thread_id',
    'agent_path',
  ] as const;
  for (const field of stringFields) {
    const value = getString(metadata, field);
    if (value !== undefined) {
      (conv as unknown as Record<string, unknown>)[field] = value;
    }
  }
  for (const field of ['logical_turn_id', 'parent_logical_turn_id'] as const) {
    const value = getString(metadata, field);
    if (isValidLogicalTurnId(value)) {
      (conv as unknown as Record<string, unknown>)[field] = value;
    }
  }
  const threadKind = getString(metadata, 'thread_kind');
  if (threadKind === 'root' || threadKind === 'subagent' || threadKind === 'unknown') {
    conv.thread_kind = threadKind;
  }
  const initiator = getString(metadata, 'initiator');
  if (
    initiator === 'human' ||
    initiator === 'agent' ||
    initiator === 'system' ||
    initiator === 'unknown'
  ) {
    conv.initiator = initiator;
  }
  const observationKind = getString(metadata, 'observation_kind');
  if (
    observationKind === 'original' ||
    observationKind === 'inherited' ||
    observationKind === 'unknown'
  ) {
    conv.observation_kind = observationKind;
  }
  const agentDepth = getNumber(metadata, 'agent_depth');
  if (agentDepth !== undefined && Number.isInteger(agentDepth) && agentDepth >= 0) {
    conv.agent_depth = agentDepth;
  }
  if (conv.root_thread_id === undefined && conv.thread_kind === 'root') {
    conv.root_thread_id = conv.thread_id ?? session_id;
  }
  return conv;
}

export function buildInitiatorActor(
  metadata: Record<string, unknown> | undefined,
): ActorRef {
  const initiator = getString(metadata, 'initiator');
  if (
    initiator === 'agent' ||
    initiator === 'system' ||
    initiator === 'unknown'
  ) {
    return { role: initiator };
  }
  return { role: 'user' };
}

export function buildProjectRef(
  metadata: Record<string, unknown> | undefined,
  observedRoot: string | undefined,
): ProjectRef | undefined {
  const canonicalRoot = getString(metadata, 'canonical_root');
  const explicitKey = getString(metadata, 'project_key');
  const key =
    explicitKey ??
    (canonicalRoot !== undefined
      ? `local:workspace:${canonicalRoot}`
      : observedRoot !== undefined
        ? `local:workspace:${observedRoot}`
        : undefined);
  if (key === undefined) return undefined;
  const project: ProjectRef = { key };
  if (canonicalRoot !== undefined) project.canonical_root = canonicalRoot;
  if (observedRoot !== undefined) project.observed_root = observedRoot;
  return project;
}

/** Caller passes `origin_url` extracted from its own metadata shape
 *  (claude-code: `meta.git_state.origin_url`; codex: `git.origin_url`).
 *  Centralizes the `repo_root === undefined → null` early return and the
 *  `repoArtifact` call so adapters don't reimplement either. */
export function buildRepoArtifact(
  repo_root: string | undefined,
  origin_url: string | undefined,
): { artifact: ArtifactRef; id: string } | null {
  if (repo_root === undefined) return null;
  const artifact = repoArtifact(origin_url ?? null, repo_root);
  return { artifact, id: artifact.id };
}

export function extractOpenLoopHints(input: string, output: string): string[] {
  const hints: string[] = [];
  const userTrim = input.trim();
  if (userTrim.length > 0 && userTrim.endsWith('?')) hints.push('ends_with_question');
  if (/\b(TODO|FIXME)\b/.test(`${input}\n${output}`)) hints.push('contains_todo');
  const assistantTrim = output.trim();
  if (assistantTrim.length > 0 && assistantTrim.endsWith('?')) {
    hints.push('unresolved_assistant_q');
  }
  if (/\b(follow up|will do later|come back to)\b/i.test(`${input}\n${output}`)) {
    hints.push('explicit_followup');
  }
  return hints;
}
