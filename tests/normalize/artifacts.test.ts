import { describe, expect, it } from 'vitest';
import {
  branchArtifact,
  commitArtifact,
  conversationArtifact,
  fileArtifact,
  normalizeRemoteUrl,
  repoArtifact,
} from '../../src/normalize/index.js';

describe('artifact identity', () => {
  describe('normalizeRemoteUrl', () => {
    it('lowercases hosts, strips .git, normalizes git@host:owner/repo to https', () => {
      expect(normalizeRemoteUrl('git@GitHub.com:Owner/Repo.git')).toBe(
        'https://github.com/Owner/Repo',
      );
    });

    it('lowercases the host of an https url but keeps the path case', () => {
      expect(normalizeRemoteUrl('https://GitHub.com/Owner/Repo.git')).toBe(
        'https://github.com/Owner/Repo',
      );
    });

    it('strips trailing slashes', () => {
      expect(normalizeRemoteUrl('https://github.com/owner/repo/')).toBe(
        'https://github.com/owner/repo',
      );
    });
  });

  describe('repoArtifact', () => {
    it('uses normalized remote URL as id when remote is provided', () => {
      const a = repoArtifact('git@github.com:foo/bar.git', '/Users/x/Desktop/bar');
      expect(a.id).toBe('https://github.com/foo/bar');
      expect(a.provider).toBe('github');
      expect(a.locator).toBe('/Users/x/Desktop/bar');
    });

    it('falls back to local:<root> when there is no remote (no-remote repo edge case)', () => {
      const a = repoArtifact(null, '/Users/x/Desktop/no-remote-repo');
      expect(a.id).toBe('local:/Users/x/Desktop/no-remote-repo');
      expect(a.provider).toBe('local');
    });

    it('two clones of the same remote produce the same repo id (joins across clones)', () => {
      const a = repoArtifact('https://github.com/foo/bar', '/Users/x/clone-a');
      const b = repoArtifact('https://github.com/foo/bar.git', '/tmp/clone-b');
      expect(a.id).toBe(b.id);
    });

    it('classifies only exact provider hosts and their explicit subdomains', () => {
      expect(repoArtifact('https://github.com/foo/bar', '/repo').provider).toBe('github');
      expect(repoArtifact('https://git.github.com/foo/bar', '/repo').provider).toBe('github');
      expect(repoArtifact('https://evilgithub.com/foo/bar', '/repo').provider).toBe('git');
      expect(repoArtifact('https://github.com.evil.test/foo/bar', '/repo').provider).toBe('git');
      expect(repoArtifact('https://evilgitlab.com/foo/bar', '/repo').provider).toBe('git');
      expect(repoArtifact('https://evilbitbucket.org/foo/bar', '/repo').provider).toBe('git');
    });

    it('uses the parsed hostname rather than credentials or port text', () => {
      expect(repoArtifact('https://github.com:443/foo/bar', '/repo').provider).toBe('github');
      expect(repoArtifact('https://github.com@evil.test/foo/bar', '/repo').provider).toBe('git');
    });
  });

  describe('fileArtifact', () => {
    it('produces <repo_id>::<rel_path> for files inside a repo', () => {
      const a = fileArtifact(
        'https://github.com/foo/bar',
        '/Users/x/Desktop/bar/src/main.ts',
        '/Users/x/Desktop/bar',
      );
      expect(a.id).toBe('https://github.com/foo/bar::src/main.ts');
      expect(a.locator).toBe('/Users/x/Desktop/bar/src/main.ts');
      expect(a.provider).toBe('local_fs');
    });

    it('falls back to abs:<path> for files outside any repo', () => {
      const a = fileArtifact(null, '/tmp/scratch.md');
      expect(a.id).toBe('abs:/tmp/scratch.md');
    });

    it('falls back to abs:<path> when path is not inside the supplied repoRoot', () => {
      const a = fileArtifact(
        'https://github.com/foo/bar',
        '/tmp/outside.md',
        '/Users/x/Desktop/bar',
      );
      expect(a.id).toBe('abs:/tmp/outside.md');
    });

    it('two file refs at the same rel path under the same remote join to the same id (cross-clone)', () => {
      const a = fileArtifact(
        'https://github.com/foo/bar',
        '/Users/x/clone-a/src/main.ts',
        '/Users/x/clone-a',
      );
      const b = fileArtifact(
        'https://github.com/foo/bar',
        '/tmp/clone-b/src/main.ts',
        '/tmp/clone-b',
      );
      expect(a.id).toBe(b.id);
    });

    it('rename within a repo produces different artifact ids (V1 limitation, no lineage)', () => {
      const before = fileArtifact(
        'https://github.com/foo/bar',
        '/x/bar/src/x.ts',
        '/x/bar',
      );
      const after = fileArtifact(
        'https://github.com/foo/bar',
        '/x/bar/src/y.ts',
        '/x/bar',
      );
      expect(before.id).not.toBe(after.id);
    });
  });

  describe('branchArtifact / commitArtifact / conversationArtifact', () => {
    it('branchArtifact uses <repo_id>::<branch>', () => {
      expect(
        branchArtifact('https://github.com/foo/bar', 'main').id,
      ).toBe('https://github.com/foo/bar::main');
    });

    it('commitArtifact uses <repo_id>::<sha>', () => {
      expect(
        commitArtifact('local:/x', 'abcdef1234567890').id,
      ).toBe('local:/x::abcdef1234567890');
    });

    it('conversationArtifact uses <provider>:<session_id>', () => {
      expect(
        conversationArtifact('claude_code', 'sess-1').id,
      ).toBe('claude_code:sess-1');
    });
  });
});
