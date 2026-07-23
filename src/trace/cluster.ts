import type { ArtifactRef, NormalizedContextEvent } from '../normalize/types.js';
import { membershipOf, roleOf, type ArtifactMembership } from './role.js';
import type { ArtifactKey, Edge, Graph, RawCluster } from './types.js';

export const DEFAULT_WINDOW_HOURS = 4;
export const GRAPH_MAX_SHARED_ARTIFACTS_PER_EDGE = 32;

interface LinkCandidate {
  from: string;
  to: string;
  artifactKey: ArtifactKey;
  membership: ArtifactMembership | 'lineage';
  gapMs: number;
}

function projectKey(atom: NormalizedContextEvent): string {
  if (atom.project !== undefined) return atom.project.key;
  const scope = atom.artifacts.find(
    (artifact) => artifact.type === 'workspace' || artifact.type === 'repo',
  );
  return scope === undefined ? 'unscoped' : artifactKey(scope);
}

function lineageOwner(atom: NormalizedContextEvent): string | undefined {
  const conversation = atom.conversation;
  if (conversation === undefined) return undefined;
  const owner = [
    conversation.root_thread_id,
    conversation.thread_id,
    conversation.session_id,
  ].find((candidate): candidate is string => candidate !== undefined && candidate.length > 0);
  if (owner === undefined) return undefined;
  return `${conversation.provider}\u0000${owner}`;
}

function compareAtoms(
  left: NormalizedContextEvent,
  right: NormalizedContextEvent,
): number {
  if (left.time.occurred_at < right.time.occurred_at) return -1;
  if (left.time.occurred_at > right.time.occurred_at) return 1;
  return left.id.localeCompare(right.id);
}

function adjacentCandidates(
  key: ArtifactKey,
  atoms: readonly NormalizedContextEvent[],
  membership: LinkCandidate['membership'],
  windowMs: number,
): LinkCandidate[] {
  const sorted = [...atoms].sort(compareAtoms);
  const out: LinkCandidate[] = [];
  for (let index = 1; index < sorted.length; index += 1) {
    const left = sorted[index - 1]!;
    const right = sorted[index]!;
    const leftMs = Date.parse(left.time.occurred_at);
    const rightMs = Date.parse(right.time.occurred_at);
    const gapMs = Math.abs(rightMs - leftMs);
    if (Number.isNaN(gapMs) || gapMs > windowMs) continue;
    out.push({
      from: left.id,
      to: right.id,
      artifactKey: key,
      membership,
      gapMs,
    });
  }
  return out;
}

class MembershipForest {
  private readonly parent = new Map<string, string>();
  private readonly owners = new Map<string, Set<string>>();

  constructor(atoms: readonly NormalizedContextEvent[]) {
    for (const atom of atoms) {
      this.parent.set(atom.id, atom.id);
      const owner = lineageOwner(atom);
      this.owners.set(atom.id, owner === undefined ? new Set() : new Set([owner]));
    }
  }

  find(id: string): string {
    const direct = this.parent.get(id);
    if (direct === undefined) return id;
    if (direct === id) return id;
    const root = this.find(direct);
    this.parent.set(id, root);
    return root;
  }

  canWeaklyJoin(left: string, right: string): boolean {
    const leftOwners = this.owners.get(this.find(left)) ?? new Set<string>();
    const rightOwners = this.owners.get(this.find(right)) ?? new Set<string>();
    if (leftOwners.size === 0 || rightOwners.size === 0) return true;
    for (const owner of leftOwners) {
      if (rightOwners.has(owner)) return true;
    }
    return false;
  }

  union(left: string, right: string): boolean {
    const leftRoot = this.find(left);
    const rightRoot = this.find(right);
    if (leftRoot === rightRoot) return false;
    const [root, child] = leftRoot < rightRoot
      ? [leftRoot, rightRoot]
      : [rightRoot, leftRoot];
    this.parent.set(child, root);
    const rootOwners = this.owners.get(root) ?? new Set<string>();
    const childOwners = this.owners.get(child) ?? new Set<string>();
    for (const owner of childOwners) rootOwners.add(owner);
    this.owners.set(root, rootOwners);
    this.owners.delete(child);
    return true;
  }
}

export function artifactKey(a: ArtifactRef): ArtifactKey {
  return `${a.provider}:${a.type}:${a.id}`;
}

// An ArtifactKey is `${provider}:${type}:${id}`. The id itself may contain
// colons (e.g. `local_fs:file:r::a.ts`), so split into at most three parts and
// return the second token as the artifact type.
function typeFromArtifactKey(key: ArtifactKey): string {
  const first = key.indexOf(':');
  if (first < 0) return '';
  const second = key.indexOf(':', first + 1);
  if (second < 0) return key.slice(first + 1);
  return key.slice(first + 1, second);
}

// Drop edges whose every artifact_id resolves to a role in {scope, session}.
// Keep edges that include at least one work-role or unknown-role artifact —
// `unknown: keep` is the V1.5 generalizability default. Edge artifact_ids are
// not trimmed; either an edge is retained whole or dropped whole.
export function filterRedundantEdges(edges: Edge[]): Edge[] {
  return edges.filter((e) => {
    if (e.artifact_ids.length === 0) return true;
    for (const key of e.artifact_ids) {
      const role = roleOf(typeFromArtifactKey(key));
      if (role !== 'scope' && role !== 'session') return true;
    }
    return false;
  });
}

export function buildGraph(
  atoms: NormalizedContextEvent[],
  windowHours: number = DEFAULT_WINDOW_HOURS,
): Graph {
  const nodes: string[] = atoms.map((a) => a.id);
  const windowMs = windowHours * 60 * 60 * 1000;
  const projects = new Map<string, NormalizedContextEvent[]>();
  for (const atom of atoms) {
    const key = projectKey(atom);
    const bucket = projects.get(key);
    if (bucket === undefined) projects.set(key, [atom]);
    else bucket.push(atom);
  }

  const forest = new MembershipForest(atoms);
  const edges: Edge[] = [];
  const edgeByPair = new Map<string, Edge>();

  const applyCandidate = (candidate: LinkCandidate): void => {
    if (
      candidate.membership === 'weak' &&
      !forest.canWeaklyJoin(candidate.from, candidate.to)
    ) {
      return;
    }
    const from = candidate.from < candidate.to ? candidate.from : candidate.to;
    const to = candidate.from < candidate.to ? candidate.to : candidate.from;
    const pairKey = `${from}\u0000${to}`;
    const existing = edgeByPair.get(pairKey);
    if (existing !== undefined) {
      if (
        candidate.membership !== 'lineage' &&
        existing.artifact_ids.length < GRAPH_MAX_SHARED_ARTIFACTS_PER_EDGE &&
        !existing.artifact_ids.includes(candidate.artifactKey)
      ) {
        existing.artifact_ids.push(candidate.artifactKey);
        existing.artifact_ids.sort();
      }
      return;
    }
    if (!forest.union(from, to)) return;
    const edge: Edge = {
      from,
      to,
      kind: 'shared_artifact',
      artifact_ids: [candidate.artifactKey],
      confidence: 'high',
    };
    edgeByPair.set(pairKey, edge);
    edges.push(edge);
  };

  for (const [project, projectAtoms] of [...projects.entries()].sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    const strongBuckets = new Map<ArtifactKey, NormalizedContextEvent[]>();
    const weakBuckets = new Map<ArtifactKey, NormalizedContextEvent[]>();
    const lineageBuckets = new Map<string, NormalizedContextEvent[]>();
    for (const atom of projectAtoms) {
      const owner = lineageOwner(atom);
      if (owner !== undefined) {
        const bucket = lineageBuckets.get(owner);
        if (bucket === undefined) lineageBuckets.set(owner, [atom]);
        else bucket.push(atom);
      }
      const seen = new Set<ArtifactKey>();
      for (const artifact of atom.artifacts) {
        const membership = membershipOf(artifact.type);
        if (membership === 'none') continue;
        const key = artifactKey(artifact);
        if (seen.has(key)) continue;
        seen.add(key);
        const buckets = membership === 'strong' ? strongBuckets : weakBuckets;
        const bucket = buckets.get(key);
        if (bucket === undefined) buckets.set(key, [atom]);
        else bucket.push(atom);
      }
    }

    const candidatesFor = (
      buckets: ReadonlyMap<ArtifactKey, NormalizedContextEvent[]>,
      membership: ArtifactMembership,
    ): LinkCandidate[] => {
      const candidates: LinkCandidate[] = [];
      for (const [key, bucket] of buckets) {
        candidates.push(...adjacentCandidates(key, bucket, membership, windowMs));
      }
      candidates.sort((left, right) => {
        if (left.gapMs !== right.gapMs) return left.gapMs - right.gapMs;
        if (left.artifactKey !== right.artifactKey) {
          return left.artifactKey.localeCompare(right.artifactKey);
        }
        if (left.from !== right.from) return left.from.localeCompare(right.from);
        return left.to.localeCompare(right.to);
      });
      return candidates;
    };

    for (const candidate of candidatesFor(strongBuckets, 'strong')) {
      applyCandidate(candidate);
    }
    for (const candidate of candidatesFor(weakBuckets, 'weak')) {
      applyCandidate(candidate);
    }
    for (const [owner, bucket] of [...lineageBuckets.entries()].sort(([a], [b]) =>
      a.localeCompare(b),
    )) {
      for (const candidate of adjacentCandidates(
        `echo:thread:${project}:${owner}`,
        bucket,
        'lineage',
        windowMs,
      )) {
        applyCandidate(candidate);
      }
    }
  }

  // stable order for determinism
  edges.sort((x, y) => {
    if (x.from < y.from) return -1;
    if (x.from > y.from) return 1;
    if (x.to < y.to) return -1;
    if (x.to > y.to) return 1;
    return 0;
  });

  return { nodes, edges };
}

export function connectedComponents(graph: Graph): RawCluster[] {
  const parent = new Map<string, string>();
  for (const n of graph.nodes) parent.set(n, n);

  function find(x: string): string {
    let cur = x;
    while (parent.get(cur) !== cur) {
      const p = parent.get(cur) as string;
      const gp = parent.get(p) as string;
      parent.set(cur, gp);
      cur = gp;
    }
    return cur;
  }
  function union(a: string, b: string): void {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  }

  for (const e of graph.edges) {
    if (parent.has(e.from) && parent.has(e.to)) union(e.from, e.to);
  }

  const groups = new Map<string, string[]>();
  for (const n of graph.nodes) {
    const root = find(n);
    let bucket = groups.get(root);
    if (bucket === undefined) {
      bucket = [];
      groups.set(root, bucket);
    }
    bucket.push(n);
  }

  const edgesByRoot = new Map<string, Edge[]>();
  for (const edge of graph.edges) {
    const root = find(edge.from);
    const bucket = edgesByRoot.get(root);
    if (bucket === undefined) edgesByRoot.set(root, [edge]);
    else bucket.push(edge);
  }
  const result: RawCluster[] = [];
  for (const ids of groups.values()) {
    const sortedIds = [...ids].sort();
    const clusterEdges = edgesByRoot.get(find(sortedIds[0]!)) ?? [];
    result.push({ atom_ids: sortedIds, edges: clusterEdges });
  }
  // deterministic ordering: by min atom_id
  result.sort((a, b) => {
    const aMin = a.atom_ids[0] ?? '';
    const bMin = b.atom_ids[0] ?? '';
    if (aMin < bMin) return -1;
    if (aMin > bMin) return 1;
    return 0;
  });
  return result;
}
