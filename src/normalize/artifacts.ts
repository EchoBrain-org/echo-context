import { basename as pathBasename, isAbsolute, normalize, relative, sep } from 'node:path';
import type { ArtifactRef } from './types.js';

const GIT_SSH_RE = /^git@([^:]+):(.+?)(?:\.git)?\/?$/i;
const SCHEME_RE = /^[a-z][a-z0-9+\-.]*:\/\//i;

export function normalizeRemoteUrl(remote: string): string {
  const trimmed = remote.trim();
  if (trimmed.length === 0) return trimmed;
  const ssh = GIT_SSH_RE.exec(trimmed);
  if (ssh !== null) {
    const host = (ssh[1] as string).toLowerCase();
    const path = (ssh[2] as string).replace(/\/+$/, '');
    return `https://${host}/${path}`.replace(/\.git$/i, '');
  }
  let url = trimmed;
  url = url.replace(/\.git$/i, '');
  url = url.replace(/\/+$/, '');
  if (SCHEME_RE.test(url)) {
    const colonIdx = url.indexOf('://');
    const scheme = url.slice(0, colonIdx).toLowerCase();
    const rest = url.slice(colonIdx + 3);
    const slashIdx = rest.indexOf('/');
    if (slashIdx === -1) {
      return `${scheme}://${rest.toLowerCase()}`;
    }
    const host = rest.slice(0, slashIdx).toLowerCase();
    const path = rest.slice(slashIdx);
    return `${scheme}://${host}${path}`;
  }
  return url;
}

export function repoArtifact(remoteUrl: string | null, localRoot: string): ArtifactRef {
  if (remoteUrl !== null && remoteUrl.length > 0) {
    const id = normalizeRemoteUrl(remoteUrl);
    return {
      type: 'repo',
      provider: deriveRemoteProvider(id),
      id,
      label: deriveRepoLabel(id),
      locator: localRoot,
    };
  }
  return {
    type: 'repo',
    provider: 'local',
    id: `local:${localRoot}`,
    label: deriveLocalRepoLabel(localRoot),
    locator: localRoot,
  };
}

export function workspaceArtifact(canonicalRoot: string): ArtifactRef {
  return {
    type: 'workspace',
    provider: 'local',
    id: canonicalRoot,
    label: deriveLocalRepoLabel(canonicalRoot),
    locator: canonicalRoot,
  };
}

function deriveRemoteProvider(normalizedUrl: string): string {
  const host = hostOf(normalizedUrl);
  if (host === null) return 'git';
  if (host === 'github.com' || host.endsWith('.github.com')) return 'github';
  if (host === 'gitlab.com' || host.endsWith('.gitlab.com')) return 'gitlab';
  if (host === 'bitbucket.org' || host.endsWith('.bitbucket.org')) return 'bitbucket';
  return 'git';
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function deriveRepoLabel(normalizedUrl: string): string {
  const m = /\/([^/]+)$/.exec(normalizedUrl);
  return m === null ? normalizedUrl : (m[1] as string);
}

function deriveLocalRepoLabel(localRoot: string): string {
  const m = /\/([^/]+)\/?$/.exec(localRoot);
  return m === null ? localRoot : (m[1] as string);
}

export function fileArtifact(
  repoId: string | null,
  absPath: string,
  repoRoot?: string,
): ArtifactRef {
  const normalizedAbsPath = normalize(absPath);
  if (repoId !== null && repoRoot !== undefined) {
    const rel = relativeInsideRoot(normalizedAbsPath, repoRoot);
    if (rel !== null) {
      return {
        type: 'file',
        provider: 'local_fs',
        id: `${repoId}::${rel}`,
        label: rel,
        locator: absPath,
      };
    }
  }
  return {
    type: 'file',
    provider: 'local_fs',
    id: `abs:${normalizedAbsPath}`,
    label: basename(normalizedAbsPath),
    locator: absPath,
  };
}

function relativeInsideRoot(absPath: string, root: string): string | null {
  const normalizedRoot = normalize(root);
  const rel = relative(normalizedRoot, absPath);
  if (rel === '') return '';
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return null;
  return rel;
}

function basename(p: string): string {
  const base = pathBasename(p);
  return base.length > 0 ? base : p;
}

export function branchArtifact(repoId: string, branch: string): ArtifactRef {
  return {
    type: 'branch',
    provider: 'git',
    id: `${repoId}::${branch}`,
    label: branch,
  };
}

export function commitArtifact(repoId: string, sha: string): ArtifactRef {
  return {
    type: 'commit',
    provider: 'git',
    id: `${repoId}::${sha}`,
    label: sha.slice(0, 7),
    locator: sha,
  };
}

export function conversationArtifact(provider: string, sessionId: string): ArtifactRef {
  return {
    type: 'conversation',
    provider,
    id: `${provider}:${sessionId}`,
    label: sessionId,
  };
}
