import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  assertAbsoluteRepoPath,
  normaliseRepoPath,
  resolveRepoPath,
} from '../../../src/mcp/util/repo-path.js';

describe('repo path utilities', () => {
  it('normalizes trailing separators without resolving the filesystem', () => {
    expect(normaliseRepoPath('/Users/zhenye/Desktop/echo-context/')).toBe(
      '/Users/zhenye/Desktop/echo-context',
    );
  });

  it('preserves the filesystem root', () => {
    expect(normaliseRepoPath('/')).toBe('/');
  });

  it('rejects relative repository paths with the tool name', () => {
    expect(() => assertAbsoluteRepoPath('search_memories', 'relative/path')).toThrow(
      'search_memories: repo_path must be absolute',
    );
  });

  it('returns a bounded canonical, real-root, and caller-path legacy alias set', async () => {
    const nestedPath = fileURLToPath(new URL('../../../src/mcp/', import.meta.url));
    const normalizedPath = normaliseRepoPath(nestedPath);

    const resolved = await resolveRepoPath(nestedPath);
    const canonicalRoot = resolved.project_key.slice('local:workspace:'.length);

    expect(resolved.normalized_path).toBe(normalizedPath);
    expect(resolved.legacy_project_roots[0]).toBe(canonicalRoot);
    expect(resolved.legacy_project_roots).toContain(normalizedPath);
    expect(resolved.legacy_project_roots.length).toBeLessThanOrEqual(3);
  });

  it('deduplicates the legacy alias when a missing path uses structural identity', async () => {
    const path = '/echo-context-tests/missing/../project/';
    const resolved = await resolveRepoPath(path);

    expect(resolved.normalized_path).toBe('/echo-context-tests/project');
    expect(resolved.project_key).toBe('local:workspace:/echo-context-tests/project');
    expect(resolved.legacy_project_roots).toEqual(['/echo-context-tests/project']);
  });
});
