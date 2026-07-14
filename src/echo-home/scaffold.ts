import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { ECHO_HOME_PATHS, type OnboardingState, type ProjectsState } from './paths.js';

export interface EnsureEchoHomeResult {
  root: string;
  created_dirs: string[];
  created_files: string[];
}

function ensureDir(path: string, createdDirs: string[]): void {
  const existed = existsSync(path);
  mkdirSync(path, { recursive: true });
  if (!existed) createdDirs.push(path);
}

function isErrnoException(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && 'code' in err;
}

function writeAbsentJson(path: string, value: unknown, createdFiles: string[]): void {
  try {
    writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
    createdFiles.push(path);
  } catch (err) {
    if (isErrnoException(err) && err.code === 'EEXIST') return;
    throw err;
  }
}

function initialOnboardingState(now: string): OnboardingState {
  return {
    schema_version: 1,
    created_at: now,
    last_updated_at: now,
    completed: false,
    agents: [],
  };
}

function initialProjectsState(now: string): ProjectsState {
  return {
    schema_version: 1,
    last_refreshed_at: now,
    default_project: null,
    projects: [],
  };
}

export function ensureEchoHome(): EnsureEchoHomeResult {
  const createdDirs: string[] = [];
  const createdFiles: string[] = [];

  ensureDir(ECHO_HOME_PATHS.root, createdDirs);
  ensureDir(ECHO_HOME_PATHS.skills, createdDirs);
  ensureDir(ECHO_HOME_PATHS.roles, createdDirs);
  ensureDir(ECHO_HOME_PATHS.workflows, createdDirs);
  ensureDir(ECHO_HOME_PATHS.adapters, createdDirs);
  ensureDir(ECHO_HOME_PATHS.state, createdDirs);

  const now = new Date().toISOString();
  writeAbsentJson(ECHO_HOME_PATHS.stateOnboarding, initialOnboardingState(now), createdFiles);
  writeAbsentJson(ECHO_HOME_PATHS.stateProjects, initialProjectsState(now), createdFiles);

  return {
    root: ECHO_HOME_PATHS.root,
    created_dirs: createdDirs,
    created_files: createdFiles,
  };
}
