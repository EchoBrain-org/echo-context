import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type PathsModule = typeof import('../../src/echo-home/paths.js');
type ScaffoldModule = typeof import('../../src/echo-home/scaffold.js');

let originalEchoHome: string | undefined;
let tmpRoot: string;
let echoHome: string;

async function loadScaffold(): Promise<ScaffoldModule> {
  return import('../../src/echo-home/scaffold.js');
}

async function loadPaths(): Promise<PathsModule> {
  return import('../../src/echo-home/paths.js');
}

describe('ensureEchoHome', () => {
  beforeEach(() => {
    originalEchoHome = process.env.ECHO_HOME;
    tmpRoot = mkdtempSync(join(tmpdir(), 'echo-home-scaffold-'));
    echoHome = join(tmpRoot, 'echo-home');
    process.env.ECHO_HOME = echoHome;
    vi.resetModules();
  });

  afterEach(() => {
    if (originalEchoHome === undefined) {
      delete process.env.ECHO_HOME;
    } else {
      process.env.ECHO_HOME = originalEchoHome;
    }
    rmSync(tmpRoot, { recursive: true, force: true });
    vi.resetModules();
  });

  it('creates the directory tree and initial state files in a fresh ECHO_HOME', async () => {
    const { ensureEchoHome } = await loadScaffold();
    const { ECHO_HOME_PATHS, validateOnboardingState, validateProjectsState } = await loadPaths();

    const result = ensureEchoHome();

    expect(result.root).toBe(resolve(echoHome));
    expect(result.created_dirs).toEqual([
      ECHO_HOME_PATHS.root,
      ECHO_HOME_PATHS.skills,
      ECHO_HOME_PATHS.roles,
      ECHO_HOME_PATHS.workflows,
      ECHO_HOME_PATHS.adapters,
      ECHO_HOME_PATHS.state,
    ]);
    expect(result.created_dirs).toHaveLength(6);
    expect(result.created_files).toEqual([
      ECHO_HOME_PATHS.stateOnboarding,
      ECHO_HOME_PATHS.stateProjects,
    ]);
    expect(result.created_files).toHaveLength(2);

    for (const dir of result.created_dirs) {
      expect(existsSync(dir)).toBe(true);
    }
    expect(existsSync(ECHO_HOME_PATHS.stateOnboarding)).toBe(true);
    expect(existsSync(ECHO_HOME_PATHS.stateProjects)).toBe(true);
    expect(
      validateOnboardingState(JSON.parse(readFileSync(ECHO_HOME_PATHS.stateOnboarding, 'utf8'))),
    ).toBe(true);
    expect(
      validateProjectsState(JSON.parse(readFileSync(ECHO_HOME_PATHS.stateProjects, 'utf8'))),
    ).toBe(true);
  });

  it('is idempotent and does not rewrite existing state files', async () => {
    const { ensureEchoHome } = await loadScaffold();
    const { ECHO_HOME_PATHS } = await loadPaths();

    ensureEchoHome();
    const firstRaw = readFileSync(ECHO_HOME_PATHS.stateOnboarding, 'utf8');
    const firstCreatedAt = (JSON.parse(firstRaw) as { created_at: string }).created_at;
    const firstMtime = statSync(ECHO_HOME_PATHS.stateOnboarding).mtimeMs;

    const second = ensureEchoHome();
    const secondRaw = readFileSync(ECHO_HOME_PATHS.stateOnboarding, 'utf8');
    const secondCreatedAt = (JSON.parse(secondRaw) as { created_at: string }).created_at;
    const secondMtime = statSync(ECHO_HOME_PATHS.stateOnboarding).mtimeMs;

    expect(second.created_dirs).toEqual([]);
    expect(second.created_files).toEqual([]);
    expect(secondCreatedAt).toBe(firstCreatedAt);
    expect(secondRaw).toBe(firstRaw);
    expect(secondMtime).toBe(firstMtime);
  });

  it('keeps existing state files byte-for-byte while creating missing files', async () => {
    const stateDir = join(echoHome, 'state');
    mkdirSync(stateDir, { recursive: true });
    const handEdited = '{"hand_edited": true}';
    const onboardingPath = join(stateDir, 'onboarding.json');
    writeFileSync(onboardingPath, handEdited);

    const { ensureEchoHome } = await loadScaffold();
    const { ECHO_HOME_PATHS, validateProjectsState } = await loadPaths();

    const result = ensureEchoHome();

    expect(readFileSync(onboardingPath, 'utf8')).toBe(handEdited);
    expect(result.created_dirs).toEqual([
      ECHO_HOME_PATHS.skills,
      ECHO_HOME_PATHS.roles,
      ECHO_HOME_PATHS.workflows,
      ECHO_HOME_PATHS.adapters,
    ]);
    expect(result.created_files).toEqual([ECHO_HOME_PATHS.stateProjects]);
    expect(existsSync(ECHO_HOME_PATHS.stateProjects)).toBe(true);
    expect(
      validateProjectsState(JSON.parse(readFileSync(ECHO_HOME_PATHS.stateProjects, 'utf8'))),
    ).toBe(true);
  });
});
