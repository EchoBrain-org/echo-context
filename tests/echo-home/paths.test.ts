import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type PathsModule = typeof import('../../src/echo-home/paths.js');

let originalEchoHome: string | undefined;
let cleanupDirs: string[];

async function loadPaths(): Promise<PathsModule> {
  return import('../../src/echo-home/paths.js');
}

describe('ECHO home paths', () => {
  beforeEach(() => {
    originalEchoHome = process.env.ECHO_HOME;
    cleanupDirs = [];
    vi.resetModules();
  });

  afterEach(() => {
    if (originalEchoHome === undefined) {
      delete process.env.ECHO_HOME;
    } else {
      process.env.ECHO_HOME = originalEchoHome;
    }
    for (const dir of cleanupDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
    vi.resetModules();
  });

  it('defaults to ~/.echo when ECHO_HOME is unset', async () => {
    delete process.env.ECHO_HOME;

    const { ECHO_HOME_PATHS } = await loadPaths();

    expect(ECHO_HOME_PATHS.root).toBe(join(homedir(), '.echo'));
    expect(ECHO_HOME_PATHS.root.endsWith(`${sep}.echo`)).toBe(true);
    expect(ECHO_HOME_PATHS.skills).toBe(join(ECHO_HOME_PATHS.root, 'skills'));
    expect(ECHO_HOME_PATHS.roles).toBe(join(ECHO_HOME_PATHS.root, 'roles'));
    expect(ECHO_HOME_PATHS.adapters).toBe(join(ECHO_HOME_PATHS.root, 'adapters'));
    expect(ECHO_HOME_PATHS.state).toBe(join(ECHO_HOME_PATHS.root, 'state'));
    expect(ECHO_HOME_PATHS.stateOnboarding).toBe(
      join(ECHO_HOME_PATHS.root, 'state', 'onboarding.json'),
    );
    expect(ECHO_HOME_PATHS.stateProjects).toBe(
      join(ECHO_HOME_PATHS.root, 'state', 'projects.json'),
    );
    expect(ECHO_HOME_PATHS.stateCaptureSources).toBe(
      join(ECHO_HOME_PATHS.root, 'state', 'capture-sources.json'),
    );
  });

  it('honors ECHO_HOME at module load', async () => {
    const base = mkdtempSync(join(tmpdir(), 'echo-home-paths-'));
    cleanupDirs.push(base);
    const override = join(base, 'custom-home');
    process.env.ECHO_HOME = override;

    const { ECHO_HOME_PATHS } = await loadPaths();

    expect(ECHO_HOME_PATHS.root).toBe(resolve(override));
    expect(ECHO_HOME_PATHS.stateOnboarding).toBe(
      join(resolve(override), 'state', 'onboarding.json'),
    );
  });

  it('validates initial state shapes and rejects missing schema_version', async () => {
    const { validateOnboardingState, validateProjectsState } = await loadPaths();
    const now = new Date().toISOString();

    expect(
      validateOnboardingState({
        schema_version: 1,
        created_at: now,
        last_updated_at: now,
        completed: false,
        agents: [],
      }),
    ).toBe(true);
    expect(
      validateOnboardingState({
        created_at: now,
        last_updated_at: now,
        completed: false,
        agents: [],
      }),
    ).toBe(false);

    expect(
      validateProjectsState({
        schema_version: 1,
        last_refreshed_at: now,
        default_project: null,
        projects: [
          {
            repo_root: '/tmp/repo',
            last_seen: now,
            source_breakdown: {},
            coord_ref: 'refs/heads/echo/coord',
            reviews_root: 'coord/reviews',
            reviewers: ['codex'],
            spec_dir: 'specs',
            project_config_path: '/tmp/repo/.echo/project.json',
          },
        ],
      }),
    ).toBe(true);
    expect(
      validateProjectsState({
        last_refreshed_at: now,
        default_project: null,
        projects: [],
      }),
    ).toBe(false);
  });

  it('loads Project_echo-compatible defaults when .echo/project.json is absent', async () => {
    const base = mkdtempSync(join(tmpdir(), 'echo-project-config-'));
    cleanupDirs.push(base);
    const repo = join(base, 'repo');
    mkdirSync(repo, { recursive: true });
    const { loadProjectConfig } = await loadPaths();

    const loaded = loadProjectConfig(repo);

    expect(loaded.existed).toBe(false);
    expect(loaded.config).toEqual({
      schema_version: 1,
      coord_ref: 'main',
      reviews_root: 'backlog/reviews',
      reviewers: ['codex', 'cursor'],
      spec_dir: 'backlog',
    });
  });

  it('writes and reloads .echo/project.json with custom orchestration config', async () => {
    const base = mkdtempSync(join(tmpdir(), 'echo-project-config-'));
    cleanupDirs.push(base);
    const repo = join(base, 'repo');
    mkdirSync(repo, { recursive: true });
    const { loadProjectConfig, writeProjectConfig } = await loadPaths();

    const written = writeProjectConfig(repo, {
      schema_version: 1,
      coord_ref: 'refs/heads/echo/coord',
      reviews_root: 'coord/reviews',
      reviewers: ['codex', 'codex-ops'],
      spec_dir: 'specs',
    });

    expect(written.path).toBe(join(repo, '.echo/project.json'));
    expect(loadProjectConfig(repo).config).toEqual(written.config);
  });

  it('upserts projects.json atomically without duplicate project records', async () => {
    const base = mkdtempSync(join(tmpdir(), 'echo-project-registry-'));
    cleanupDirs.push(base);
    const home = join(base, 'home');
    const repo = join(base, 'repo');
    mkdirSync(repo, { recursive: true });
    const { DEFAULT_PROJECT_CONFIG, readProjectsState, upsertProjectRegistration } =
      await loadPaths();

    upsertProjectRegistration({
      repoRoot: repo,
      config: DEFAULT_PROJECT_CONFIG,
      homeOverride: home,
      now: new Date('2026-06-13T10:00:00.000Z'),
    });
    upsertProjectRegistration({
      repoRoot: `${repo}/`,
      config: { ...DEFAULT_PROJECT_CONFIG, coord_ref: 'refs/heads/echo/coord' },
      homeOverride: home,
      now: new Date('2026-06-13T10:01:00.000Z'),
    });

    const state = readProjectsState(home);
    expect(state.projects).toHaveLength(1);
    expect(state.projects[0]).toMatchObject({
      repo_root: resolve(repo),
      coord_ref: 'refs/heads/echo/coord',
      reviews_root: 'backlog/reviews',
      reviewers: ['codex', 'cursor'],
      spec_dir: 'backlog',
    });
  });

  it('surfaces a lock error without truncating an existing projects.json', async () => {
    const base = mkdtempSync(join(tmpdir(), 'echo-project-lock-'));
    cleanupDirs.push(base);
    const home = join(base, 'home');
    const repo = join(base, 'repo');
    mkdirSync(join(home, 'state/projects.json.lock'), { recursive: true });
    mkdirSync(repo, { recursive: true });
    const { DEFAULT_PROJECT_CONFIG, upsertProjectRegistration } = await loadPaths();

    expect(() =>
      upsertProjectRegistration({
        repoRoot: repo,
        config: DEFAULT_PROJECT_CONFIG,
        homeOverride: home,
        lockTimeoutMs: 1,
      }),
    ).toThrow(/projects\.json lock timed out/);
    expect(existsSync(join(home, 'state/projects.json'))).toBe(false);
  });
});
