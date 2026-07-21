import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ECHO_STATE_PATHS, setEchoStateRoot } from '../../src/echo-home/state-paths.js';
import {
  CAPTURED_SOURCES,
  DEFAULT_GIT_REPOS,
  _isAllowedAppIn,
  _isAllowedApiIn,
  _isAllowedDomainIn,
  _isAllowedPathIn,
  loadGitReposFromCaptureConfig,
  isAllowedApp,
  isAllowedApi,
  isAllowedDomain,
  isAllowedPath,
} from '../../src/capture/sources.js';

const malformed: unknown[] = [null, undefined, 42, '', {}, [], true, false];

describe('CAPTURED_SOURCES', () => {
  it('initializes empty for apps/domains and allowlists the Granola API', () => {
    expect(Object.keys(CAPTURED_SOURCES.apps)).toHaveLength(0);
    expect(Object.keys(CAPTURED_SOURCES.domains)).toHaveLength(0);
    expect(CAPTURED_SOURCES.apis).toEqual(['granola']);
  });

  it('declares only the live founder coding-session FS prefixes', () => {
    expect(CAPTURED_SOURCES.fs_paths).toEqual([
      '~/.claude/projects/',
      '~/.codex/sessions/',
    ]);
  });

  it('has no implicit git repository when capture config is absent', () => {
    const dir = mkdtempSync(join(tmpdir(), 'echo-capture-sources-'));
    try {
      expect(DEFAULT_GIT_REPOS).toEqual([]);
      expect(loadGitReposFromCaptureConfig(join(dir, 'missing.json'))).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('loads only explicitly persisted git repositories', () => {
    const dir = mkdtempSync(join(tmpdir(), 'echo-capture-sources-'));
    const configPath = join(dir, 'capture-sources.json');
    try {
      writeFileSync(
        configPath,
        `${JSON.stringify(
          {
            schema_version: 1,
            updated_at: '2026-05-28T00:00:00.000Z',
            git_repos: ['/tmp/customer-repo', '/tmp/customer-repo/'],
          },
          null,
          2,
        )}\n`,
      );

      expect(loadGitReposFromCaptureConfig(configPath)).toEqual(['/tmp/customer-repo']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('resolves the default config from the lean context state root', () => {
    const dir = mkdtempSync(join(tmpdir(), 'echo-capture-state-root-'));
    const previousRoot = ECHO_STATE_PATHS.root;
    try {
      mkdirSync(join(dir, 'state'), { recursive: true });
      writeFileSync(
        join(dir, 'state', 'capture-sources.json'),
        `${JSON.stringify({
          schema_version: 1,
          updated_at: '2026-07-20T00:00:00.000Z',
          git_repos: ['/tmp/explicit-repo'],
        })}\n`,
      );
      setEchoStateRoot(dir);

      expect(loadGitReposFromCaptureConfig()).toEqual(['/tmp/explicit-repo']);
    } finally {
      setEchoStateRoot(previousRoot);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('isAllowedApp (against empty allowlist)', () => {
  it('returns false for any plausible bundle id', () => {
    expect(isAllowedApp('com.todesktop.230313mzl4w4u92')).toBe(false);
    expect(isAllowedApp('com.apple.finder')).toBe(false);
  });

  it('returns false for malformed inputs', () => {
    for (const v of malformed) {
      expect(_isAllowedAppIn(v, CAPTURED_SOURCES.apps)).toBe(false);
    }
  });
});

describe('isAllowedDomain (against empty allowlist)', () => {
  it('returns false for any plausible host', () => {
    expect(isAllowedDomain('app.slack.com')).toBe(false);
    expect(isAllowedDomain('claude.ai')).toBe(false);
  });

  it('returns false for malformed inputs', () => {
    for (const v of malformed) {
      expect(_isAllowedDomainIn(v, CAPTURED_SOURCES.domains)).toBe(false);
    }
  });
});

describe('isAllowedPath (against empty allowlist)', () => {
  it('returns false for any plausible path', () => {
    expect(isAllowedPath('/Users/foo/Documents')).toBe(false);
    expect(isAllowedPath('~/Library/Application Support/Cursor')).toBe(false);
  });

  it('returns false for malformed inputs', () => {
    for (const v of malformed) {
      expect(_isAllowedPathIn(v, CAPTURED_SOURCES.fs_paths)).toBe(false);
    }
  });
});

describe('isAllowedApi (Granola-only allowlist)', () => {
  it('returns true for Granola and false for other plausible api names', () => {
    expect(isAllowedApi('granola')).toBe(true);
    expect(isAllowedApi('github')).toBe(false);
    expect(isAllowedApi('slack')).toBe(false);
  });

  it('returns false for malformed inputs', () => {
    for (const v of malformed) {
      expect(_isAllowedApiIn(v, CAPTURED_SOURCES.apis)).toBe(false);
    }
  });
});

describe('predicate logic with fixture allowlist', () => {
  const fixtureApps = {
    'com.todesktop.230313mzl4w4u92': { name: 'Cursor', surfaces: ['native', 'fs'] },
  };
  const fixtureDomains = {
    'app.slack.com': { surfaces: ['extension'] },
  };
  const fixtureFsPaths: ReadonlyArray<string> = [
    '~/Library/Application Support/Cursor/User/workspaceStorage/',
    '/var/log/echo/',
  ];
  const fixtureApis: ReadonlyArray<string> = ['github', 'slack'];

  it('isAllowedApp returns true for an exact bundle-id match', () => {
    expect(_isAllowedAppIn('com.todesktop.230313mzl4w4u92', fixtureApps)).toBe(true);
  });

  it('isAllowedApp returns false for a non-matching bundle id', () => {
    expect(_isAllowedAppIn('com.apple.finder', fixtureApps)).toBe(false);
  });

  it('isAllowedDomain returns true for an exact host match', () => {
    expect(_isAllowedDomainIn('app.slack.com', fixtureDomains)).toBe(true);
  });

  it('isAllowedDomain returns false for a subdomain (no wildcarding)', () => {
    expect(_isAllowedDomainIn('foo.app.slack.com', fixtureDomains)).toBe(false);
    expect(_isAllowedDomainIn('slack.com', fixtureDomains)).toBe(false);
  });

  it('isAllowedPath returns true when input prefix-matches an entry (~ expansion on input)', () => {
    expect(
      _isAllowedPathIn(
        '~/Library/Application Support/Cursor/User/workspaceStorage/foo.db',
        fixtureFsPaths,
      ),
    ).toBe(true);
    expect(_isAllowedPathIn('/var/log/echo/access.log', fixtureFsPaths)).toBe(true);
  });

  it('isAllowedPath returns true when input is fully expanded but entry has ~', () => {
    const expanded = `${homedir()}/Library/Application Support/Cursor/User/workspaceStorage/x.json`;
    expect(_isAllowedPathIn(expanded, fixtureFsPaths)).toBe(true);
  });

  it('isAllowedPath returns false when input does not prefix-match', () => {
    expect(_isAllowedPathIn('/etc/passwd', fixtureFsPaths)).toBe(false);
    expect(_isAllowedPathIn('~/Documents/secret.txt', fixtureFsPaths)).toBe(false);
  });

  it('isAllowedPath handles bare ~', () => {
    expect(_isAllowedPathIn('~', [homedir()])).toBe(true);
  });

  it('isAllowedApi returns true for an entry in the list', () => {
    expect(_isAllowedApiIn('github', fixtureApis)).toBe(true);
    expect(_isAllowedApiIn('slack', fixtureApis)).toBe(true);
  });

  it('isAllowedApi returns false for a name not in the list', () => {
    expect(_isAllowedApiIn('linear', fixtureApis)).toBe(false);
  });
});

describe('Source type derivation (type-only assertion via fixture)', () => {
  it("a fixture with 'as const' yields literal-key types", () => {
    const fixture = {
      apps: {
        'com.example.foo': { name: 'Foo', surfaces: ['native'] },
      },
      domains: {
        'example.com': { surfaces: ['extension'] },
      },
      fs_paths: ['/tmp/'] as const,
      apis: ['example'] as const,
    } as const;

    type FixtureSource =
      | { kind: 'app'; bundleId: keyof typeof fixture.apps }
      | { kind: 'domain'; host: keyof typeof fixture.domains }
      | { kind: 'fs'; path: string }
      | { kind: 'api'; name: string };

    const ok: FixtureSource = { kind: 'app', bundleId: 'com.example.foo' };
    expect(ok.kind).toBe('app');
    expect(Object.keys(fixture.apps)).toContain(ok.bundleId);

    const okDomain: FixtureSource = { kind: 'domain', host: 'example.com' };
    expect(okDomain.host).toBe('example.com');
    expect(Object.keys(fixture.domains)).toContain(okDomain.host);
  });
});
