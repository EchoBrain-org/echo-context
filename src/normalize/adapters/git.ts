import type { CaptureEvent } from '../../storage/interface.js';
import {
  branchArtifact,
  commitArtifact,
  fileArtifact,
  normalizeRemoteUrl,
  repoArtifact,
  workspaceArtifact,
} from '../artifacts.js';
import type { Adapter, ArtifactRef, ContextRef, NormalizedContextEvent } from '../types.js';
import { buildProvenance, fail, getNumber, getString, getStringArray } from './_shared.js';

export const GIT_VERSION = 'git@1';

export const GIT_SOURCE_RE = /^git:/;

export function matchesGit(source: string): boolean {
  return GIT_SOURCE_RE.test(source);
}

const COMMIT_RE = /^COMMIT [^:]+: (.*?)\n\n([\s\S]*?)--- DIFF ---\n([\s\S]*)$/;

export const adaptGit: Adapter = (event: CaptureEvent): NormalizedContextEvent => {
  const meta = event.metadata;
  const sha = getString(meta, 'sha');
  if (sha === undefined) {
    fail(event, 'git: missing metadata.sha');
  }
  const author = getString(meta, 'author') ?? '';
  const repoRoot = getString(meta, 'repo_root') ?? extractRepoFromSource(event.source);
  if (repoRoot === undefined) {
    fail(event, 'git: missing repo_root and unparseable source');
  }
  const filesReferenced = getStringArray(meta, 'files_referenced') ?? [];
  const additions = getNumber(meta, 'additions');
  const deletions = getNumber(meta, 'deletions');
  const filesChanged = getNumber(meta, 'files_changed');
  const branch = getString(meta, 'branch');
  const parentSha = getString(meta, 'parent_sha');
  const originUrl = getString(meta, 'origin_url');
  const canonicalRoot = getString(meta, 'canonical_root');

  const workspace = canonicalRoot !== undefined ? workspaceArtifact(canonicalRoot) : null;
  const repo = repoArtifact(originUrl ?? null, repoRoot);
  const scopeId = workspace !== null ? `workspace:${workspace.id}` : repo.id;
  const fileRoot = workspace !== null ? canonicalRoot : repoRoot;
  const artifacts: ArtifactRef[] = [workspace ?? repo, commitArtifact(scopeId, sha)];
  if (branch !== undefined) artifacts.push(branchArtifact(scopeId, branch));
  for (const path of filesReferenced) {
    artifacts.push(fileArtifact(scopeId, path, fileRoot));
  }

  const parsed = parseCommitContent(event.content);
  const subject = parsed?.subject ?? '';
  const body = parsed?.body ?? '';
  const diff = parsed?.diff ?? '';
  const messageInput = body.length > 0 ? `${subject}\n\n${body}` : subject;

  const ambient: Record<string, string> = {};
  if (parentSha !== undefined) ambient.parent_sha = parentSha;
  if (filesChanged !== undefined) ambient.files_changed = String(filesChanged);
  if (additions !== undefined) ambient.additions = String(additions);
  if (deletions !== undefined) ambient.deletions = String(deletions);
  if (originUrl !== undefined) ambient.git_alias = normalizeRemoteUrl(originUrl);

  const context: ContextRef | undefined = Object.keys(ambient).length > 0 ? { ambient } : undefined;

  const summaryParts: string[] = [];
  if (filesChanged !== undefined) summaryParts.push(`${filesChanged} files changed`);
  if (additions !== undefined) summaryParts.push(`+${additions}`);
  if (deletions !== undefined) summaryParts.push(`-${deletions}`);
  const summary = summaryParts.join(', ');

  const out: NormalizedContextEvent = {
    schema_version: 1,
    id: event.id,
    time: { occurred_at: event.timestamp },
    source: {
      app: 'git',
      surface: 'commit',
      raw_pointer: event.source,
    },
    actors: [{ role: 'user', name: author }],
    action: {
      kind: 'commit',
      verb: 'committed',
      input: messageInput,
      output: diff,
    },
    artifacts,
    state: {
      delta: {
        artifact_id: `${scopeId}::${sha}`,
        kind: 'commit',
        ...(summary.length > 0 ? { detail: summary } : {}),
      },
    },
    provenance: buildProvenance(event, GIT_VERSION),
  };

  if (context !== undefined) out.context = context;

  return out;
};

function extractRepoFromSource(source: string): string | undefined {
  if (!source.startsWith('git:')) return undefined;
  return source.slice('git:'.length);
}

function parseCommitContent(
  content: string,
): { subject: string; body: string; diff: string } | null {
  const m = COMMIT_RE.exec(content);
  if (m === null) return null;
  const subject = m[1] as string;
  const bodyRaw = m[2] as string;
  const diff = m[3] as string;
  const body = bodyRaw.replace(/\n+$/, '');
  return { subject, body, diff };
}
