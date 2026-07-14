import type { ArtifactRef, NormalizedContextEvent } from '../normalize/types.js';
import type { Confidence, OpenLoopHintEnriched, OpenLoopHintKind } from './types.js';

const FOLLOWUP_RE = /\b(follow up|come back to|will do later)\b/i;
const TODO_RE = /\b(TODO|FIXME)[:\s][^\n]*/;

const KIND_CONFIDENCE: Record<OpenLoopHintKind, Confidence> = {
  ends_with_question: 'high',
  unresolved_assistant_q: 'medium',
  contains_todo: 'high',
  explicit_followup: 'medium',
};

const KNOWN_KINDS: OpenLoopHintKind[] = [
  'ends_with_question',
  'unresolved_assistant_q',
  'contains_todo',
  'explicit_followup',
];

interface PendingHint {
  hintAtomIndex: number;
  atom_id: string;
  kind: OpenLoopHintKind;
  text: string;
  confidence: Confidence;
}

// `enrichHints` assumes atoms are sorted ascending by `time.occurred_at`.
// Resolution scans only forward (atoms with later index) and terminates on
// the first match. Per spec: per-rule scan is cluster-agnostic — resolution
// depends only on the input atom list.
export function enrichHints(
  atoms: NormalizedContextEvent[],
): OpenLoopHintEnriched[] {
  const pending: PendingHint[] = [];
  for (let i = 0; i < atoms.length; i++) {
    const atom = atoms[i]!;
    const hints = atom.open_loop_hints;
    if (hints === undefined || hints.length === 0) continue;
    const input = atom.action.input ?? '';
    const output = atom.action.output ?? '';
    for (const raw of hints) {
      if (!isKnownKind(raw)) continue;
      const text = extractHintText(raw, input, output);
      if (text === undefined || text.length === 0) continue;
      pending.push({
        hintAtomIndex: i,
        atom_id: atom.id,
        kind: raw,
        text,
        confidence: KIND_CONFIDENCE[raw],
      });
    }
  }

  return pending.map((p) => resolveHint(p, atoms));
}

function resolveHint(
  hint: PendingHint,
  atoms: NormalizedContextEvent[],
): OpenLoopHintEnriched {
  const base: OpenLoopHintEnriched = {
    atom_id: hint.atom_id,
    kind: hint.kind,
    text: hint.text,
    confidence: hint.confidence,
    resolved: false,
  };
  const hintAtom = atoms[hint.hintAtomIndex];
  if (hintAtom === undefined) return base;

  const resolverId = findResolver(hint.kind, hintAtom, atoms, hint.hintAtomIndex);
  if (resolverId === undefined) return base;
  return { ...base, resolved: true, resolved_by_atom_id: resolverId };
}

function findResolver(
  kind: OpenLoopHintKind,
  hintAtom: NormalizedContextEvent,
  atoms: NormalizedContextEvent[],
  hintIndex: number,
): string | undefined {
  switch (kind) {
    case 'ends_with_question':
      return findResolverQ(hintAtom, atoms, hintIndex);
    case 'unresolved_assistant_q':
      return findResolverAQ(hintAtom, atoms, hintIndex);
    case 'contains_todo':
      return findResolverTodo(hintAtom, atoms, hintIndex);
    case 'explicit_followup':
      // R1.FU is conservative — never auto-resolves in V1.
      return undefined;
  }
}

// R1.Q: a later non-question turn in the same conversation.
function findResolverQ(
  hintAtom: NormalizedContextEvent,
  atoms: NormalizedContextEvent[],
  hintIndex: number,
): string | undefined {
  const conv = conversationArtifactKey(hintAtom);
  if (conv === undefined) return undefined;
  for (let i = hintIndex + 1; i < atoms.length; i++) {
    const cand = atoms[i]!;
    if (conversationArtifactKey(cand) !== conv) continue;
    if (atomIsQuestion(cand)) continue;
    return cand.id;
  }
  return undefined;
}

// R1.AQ: a later user-role turn in the same conversation, non-empty after trim.
function findResolverAQ(
  hintAtom: NormalizedContextEvent,
  atoms: NormalizedContextEvent[],
  hintIndex: number,
): string | undefined {
  const conv = conversationArtifactKey(hintAtom);
  if (conv === undefined) return undefined;
  for (let i = hintIndex + 1; i < atoms.length; i++) {
    const cand = atoms[i]!;
    if (conversationArtifactKey(cand) !== conv) continue;
    if (!hasUserActor(cand)) continue;
    if (!hasNonEmptyContent(cand)) continue;
    return cand.id;
  }
  return undefined;
}

// R1.TODO: a later atom whose state.delta.artifact_id matches a file artifact
// id on the hint atom.
function findResolverTodo(
  hintAtom: NormalizedContextEvent,
  atoms: NormalizedContextEvent[],
  hintIndex: number,
): string | undefined {
  const fileIds = new Set(
    hintAtom.artifacts
      .filter((a) => a.type === 'file')
      .map((a) => a.id),
  );
  if (fileIds.size === 0) return undefined;
  for (let i = hintIndex + 1; i < atoms.length; i++) {
    const cand = atoms[i]!;
    const state = cand.state;
    if (state === undefined) continue;
    const delta = (state as { delta?: { artifact_id: string } }).delta;
    if (delta === undefined) continue;
    if (!fileIds.has(delta.artifact_id)) continue;
    return cand.id;
  }
  return undefined;
}

// Same conversation iff both atoms carry the same `type === 'conversation'`
// artifact, matched by provider:type:id. Atoms without such an artifact
// produce `undefined` and are unresolvable by conversation-scoped rules.
function conversationArtifactKey(
  atom: NormalizedContextEvent,
): string | undefined {
  const conv = atom.artifacts.find(
    (a: ArtifactRef) => a.type === 'conversation',
  );
  if (conv === undefined) return undefined;
  return `${conv.provider}:${conv.type}:${conv.id}`;
}

function atomIsQuestion(atom: NormalizedContextEvent): boolean {
  const input = (atom.action.input ?? '').trim();
  const output = (atom.action.output ?? '').trim();
  if (input.length > 0 && input.endsWith('?')) return true;
  if (output.length > 0 && output.endsWith('?')) return true;
  return false;
}

function hasUserActor(atom: NormalizedContextEvent): boolean {
  return atom.actors.some((a) => a.role === 'user');
}

function hasNonEmptyContent(atom: NormalizedContextEvent): boolean {
  const input = (atom.action.input ?? '').trim();
  if (input.length >= 1) return true;
  const output = (atom.action.output ?? '').trim();
  return output.length >= 1;
}

function isKnownKind(s: string): s is OpenLoopHintKind {
  return (KNOWN_KINDS as string[]).includes(s);
}

function extractHintText(
  kind: OpenLoopHintKind,
  input: string,
  output: string,
): string | undefined {
  switch (kind) {
    case 'ends_with_question':
      return lastQuestion(input);
    case 'unresolved_assistant_q':
      return lastQuestion(output);
    case 'contains_todo': {
      const m = TODO_RE.exec(`${input}\n${output}`);
      return m === null ? undefined : (m[0] as string).trim();
    }
    case 'explicit_followup': {
      const combined = `${input}\n${output}`;
      const m = FOLLOWUP_RE.exec(combined);
      if (m === null) return undefined;
      return surroundingPhrase(combined, m.index, (m[0] as string).length);
    }
  }
}

function lastQuestion(text: string): string | undefined {
  const trimmed = text.trim();
  if (trimmed.length === 0) return undefined;
  if (!trimmed.endsWith('?')) return undefined;
  const sentences = trimmed.split(/(?<=[.?!])\s+/);
  const last = sentences[sentences.length - 1];
  if (last === undefined) return undefined;
  return last.trim();
}

function surroundingPhrase(
  source: string,
  matchStart: number,
  matchLen: number,
): string {
  // Take the line containing the match, trimmed
  const before = source.lastIndexOf('\n', matchStart - 1);
  const after = source.indexOf('\n', matchStart + matchLen);
  const start = before === -1 ? 0 : before + 1;
  const end = after === -1 ? source.length : after;
  return source.slice(start, end).trim();
}
