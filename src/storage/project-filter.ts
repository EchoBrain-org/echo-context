import { isAbsolute, normalize as pathNormalize } from 'node:path';

export const MAX_LEGACY_PROJECT_ROOTS = 3;

const LOCAL_WORKSPACE_PROJECT_PREFIX = 'local:workspace:';

function canonicalRootFromProjectKey(projectKey: string): string | undefined {
  if (!projectKey.startsWith(LOCAL_WORKSPACE_PROJECT_PREFIX)) return undefined;
  const root = projectKey.slice(LOCAL_WORKSPACE_PROJECT_PREFIX.length);
  return root.length > 0 ? root : undefined;
}

function normalizeAbsoluteRoot(root: string): string {
  if (!isAbsolute(root)) {
    throw new RangeError('QueryFilter.legacy_project_roots entries must be absolute paths');
  }
  const normalized = pathNormalize(root);
  return normalized.length > 1 && normalized.endsWith('/')
    ? normalized.slice(0, -1)
    : normalized;
}

/** Normalize the finite legacy alias set at the storage boundary. The
 * canonical root encoded in a local workspace project key remains an implicit
 * alias for compatibility with existing direct QueryFilter callers. */
export function normalizeLegacyProjectRoots(
  projectKey: string,
  roots: readonly string[] | undefined,
): string[] {
  if (roots !== undefined && roots.length > MAX_LEGACY_PROJECT_ROOTS) {
    throw new RangeError(
      `QueryFilter.legacy_project_roots accepts at most ${MAX_LEGACY_PROJECT_ROOTS} roots`,
    );
  }

  const normalized: string[] = [];
  const append = (root: string): void => {
    const candidate = normalizeAbsoluteRoot(root);
    if (!normalized.includes(candidate)) normalized.push(candidate);
  };

  const canonicalRoot = canonicalRootFromProjectKey(projectKey);
  if (canonicalRoot !== undefined) append(canonicalRoot);
  for (const root of roots ?? []) append(root);

  if (normalized.length > MAX_LEGACY_PROJECT_ROOTS) {
    throw new RangeError(
      'QueryFilter.legacy_project_roots must include the canonical root encoded by project_key',
    );
  }
  return normalized;
}

export function pathEqualsOrDescendsFrom(path: string, root: string): boolean {
  const normalizedRoot = pathNormalize(root);
  if (path === normalizedRoot) return true;
  const prefix = normalizedRoot.endsWith('/') ? normalizedRoot : `${normalizedRoot}/`;
  return path.startsWith(prefix);
}

/** MemoryStorage's reference implementation of authoritative project matching.
 * Presence, rather than type validity, controls precedence: malformed explicit
 * fields fail closed instead of widening into legacy repo_root matching. */
export function metadataMatchesProject(
  metadata: Record<string, unknown> | undefined,
  projectKey: string,
  legacyRoots: readonly string[],
): boolean {
  if (metadata === undefined) return false;
  if (Object.prototype.hasOwnProperty.call(metadata, 'project_key')) {
    return metadata['project_key'] === projectKey;
  }
  if (Object.prototype.hasOwnProperty.call(metadata, 'canonical_root')) {
    const canonicalRoot = metadata['canonical_root'];
    return (
      typeof canonicalRoot === 'string' &&
      `${LOCAL_WORKSPACE_PROJECT_PREFIX}${canonicalRoot}` === projectKey
    );
  }
  const repoRoot = metadata['repo_root'];
  if (typeof repoRoot !== 'string') return false;
  return legacyRoots.some((root) => pathEqualsOrDescendsFrom(repoRoot, root));
}
