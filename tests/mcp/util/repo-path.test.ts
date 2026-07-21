import { describe, expect, it } from 'vitest';
import {
  assertAbsoluteRepoPath,
  normaliseRepoPath,
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
});
