import type { ArtifactRef, NormalizedContextEvent } from '../normalize/types.js';
import { artifactKey } from './cluster.js';

const VERB_MAP: Record<string, string> = {
  message: 'discussion about',
  commit: 'work on',
  edit: 'edits to',
  edits: 'edits to',
  apply_patch: 'edits to',
  read: 'reading',
  write: 'edits to',
  search: 'search in',
  run: 'commands in',
  open: 'open',
};

export function heuristicLabel(
  atoms: NormalizedContextEvent[],
): string | undefined {
  if (atoms.length === 0) return undefined;

  const counts = new Map<string, { count: number; ref: ArtifactRef }>();
  for (const atom of atoms) {
    const seenInAtom = new Set<string>();
    for (const art of atom.artifacts) {
      const key = artifactKey(art);
      if (seenInAtom.has(key)) continue;
      seenInAtom.add(key);
      const cur = counts.get(key);
      if (cur === undefined) counts.set(key, { count: 1, ref: art });
      else cur.count += 1;
    }
  }

  let dominant: { count: number; ref: ArtifactRef } | undefined;
  // tie-break: prefer non-conversation, then higher count, then lexical key
  const entries = Array.from(counts.entries());
  entries.sort((a, b) => {
    if (b[1].count !== a[1].count) return b[1].count - a[1].count;
    const aConv = a[1].ref.type === 'conversation' ? 1 : 0;
    const bConv = b[1].ref.type === 'conversation' ? 1 : 0;
    if (aConv !== bConv) return aConv - bConv;
    if (a[0] < b[0]) return -1;
    if (a[0] > b[0]) return 1;
    return 0;
  });
  if (entries.length > 0) dominant = entries[0]?.[1];

  if (dominant === undefined || dominant.count < 2) return undefined;

  // Verb mode across atoms (action.verb || action.kind)
  const verbCount = new Map<string, number>();
  for (const atom of atoms) {
    const v = atom.action.verb ?? atom.action.kind;
    if (typeof v !== 'string' || v.length === 0) continue;
    verbCount.set(v, (verbCount.get(v) ?? 0) + 1);
  }
  let verbRaw: string | undefined;
  let best = 0;
  for (const [v, c] of verbCount) {
    if (c > best) {
      best = c;
      verbRaw = v;
    }
  }

  const label = labelFromArtifact(dominant.ref);
  if (label === undefined) return undefined;

  const verb = humanizeVerb(verbRaw);
  return `${verb} ${label}`;
}

function labelFromArtifact(art: ArtifactRef): string | undefined {
  if (art.label !== undefined && art.label.length > 0) return art.label;
  const tail = idTail(art.id);
  if (tail === undefined || tail.length === 0) return undefined;
  if (art.type === 'conversation') {
    // conversation with no label and only an opaque id is not user-meaningful
    return undefined;
  }
  return tail;
}

function idTail(id: string): string | undefined {
  // After the last "::" or "/" or ":"
  const sepCandidates = ['::', '/', ':'];
  let tail = id;
  for (const sep of sepCandidates) {
    const idx = tail.lastIndexOf(sep);
    if (idx >= 0) tail = tail.slice(idx + sep.length);
  }
  return tail.length > 0 ? tail : undefined;
}

function humanizeVerb(verbRaw: string | undefined): string {
  if (verbRaw === undefined) return 'work on';
  const lc = verbRaw.toLowerCase();
  return VERB_MAP[lc] ?? 'work on';
}
