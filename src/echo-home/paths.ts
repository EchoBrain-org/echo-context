import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, isAbsolute, join, normalize, resolve } from 'node:path';
import { Ajv, type AnySchema, type ValidateFunction } from 'ajv';
import { isNonEmptyString } from '../guards.js';
import { atomicWrite } from './adapters/atomic-write.js';
import { resolveEchoStatePaths, setEchoStateRoot } from './state-paths.js';

const root = resolveEchoStatePaths().root;

export interface EchoHomePaths {
  root: string;
  skills: string;
  roles: string;
  workflows: string;
  adapters: string;
  state: string;
  stateOnboarding: string;
  stateProjects: string;
  stateCaptureSources: string;
}

function resolveRoot(homeOverride?: string): string {
  return resolveEchoStatePaths(homeOverride).root;
}

export function resolveEchoHomePaths(homeOverride?: string): EchoHomePaths {
  const statePaths = resolveEchoStatePaths(resolveRoot(homeOverride));
  const resolvedRoot = statePaths.root;
  return Object.freeze({
    root: resolvedRoot,
    skills: join(resolvedRoot, 'skills'),
    roles: join(resolvedRoot, 'roles'),
    workflows: join(resolvedRoot, 'workflows'),
    adapters: join(resolvedRoot, 'adapters'),
    state: statePaths.state,
    stateOnboarding: join(resolvedRoot, 'state', 'onboarding.json'),
    stateProjects: join(resolvedRoot, 'state', 'projects.json'),
    stateCaptureSources: join(resolvedRoot, 'state', 'capture-sources.json'),
  });
}

export let ECHO_HOME_PATHS = resolveEchoHomePaths(root);

export function setEchoHomeRoot(homeOverride: string): EchoHomePaths {
  setEchoStateRoot(homeOverride);
  ECHO_HOME_PATHS = resolveEchoHomePaths(homeOverride);
  process.env['ECHO_HOME'] = ECHO_HOME_PATHS.root;
  return ECHO_HOME_PATHS;
}

export type InstallProfile = 'customer' | 'dogfood';

export interface OnboardingState {
  schema_version: 1;
  created_at: string;
  last_updated_at: string;
  completed: boolean;
  profile?: InstallProfile;
  agents: OnboardedAgentProfile[];
}

export interface OnboardedAgentProfile {
  id: 'codex' | 'claude-code' | 'cursor' | string;
  detected_at: string;
  wired_at: string | null;
  probed_at: string | null;
  capabilities: string[];
  wire_error: string | null;
}

export interface ProjectsState {
  schema_version: 1;
  last_refreshed_at: string;
  default_project: string | null;
  projects: ProjectRecord[];
}

export interface ProjectRecord {
  repo_root: string;
  last_seen: string;
  source_breakdown: Record<string, number>;
  coord_ref?: string;
  reviews_root?: string;
  reviewers?: string[];
  spec_dir?: string;
  project_config_path?: string;
}

export interface ProjectConfig {
  schema_version: 1;
  coord_ref: string;
  reviews_root: string;
  reviewers: string[];
  spec_dir: string;
}

export interface LoadProjectConfigResult {
  config: ProjectConfig;
  path: string;
  existed: boolean;
}

export const DEFAULT_PROJECT_CONFIG: ProjectConfig = Object.freeze({
  schema_version: 1,
  coord_ref: 'main',
  reviews_root: 'backlog/reviews',
  reviewers: ['codex', 'cursor'],
  spec_dir: 'backlog',
});

const onboardingStateSchema: AnySchema = {
  type: 'object',
  additionalProperties: false,
  required: ['schema_version', 'created_at', 'last_updated_at', 'completed', 'agents'],
  properties: {
    schema_version: { const: 1 },
    created_at: { type: 'string' },
    last_updated_at: { type: 'string' },
    completed: { type: 'boolean' },
    profile: { enum: ['customer', 'dogfood'] },
    agents: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'detected_at', 'wired_at', 'probed_at', 'capabilities', 'wire_error'],
        properties: {
          id: { type: 'string' },
          detected_at: { type: 'string' },
          wired_at: { type: ['string', 'null'] },
          probed_at: { type: ['string', 'null'] },
          capabilities: { type: 'array', items: { type: 'string' } },
          wire_error: { type: ['string', 'null'] },
        },
      },
    },
  },
};

const projectsStateSchema: AnySchema = {
  type: 'object',
  additionalProperties: false,
  required: ['schema_version', 'last_refreshed_at', 'default_project', 'projects'],
  properties: {
    schema_version: { const: 1 },
    last_refreshed_at: { type: 'string' },
    default_project: { type: ['string', 'null'] },
    projects: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['repo_root', 'last_seen', 'source_breakdown'],
        properties: {
          repo_root: { type: 'string' },
          last_seen: { type: 'string' },
          source_breakdown: {
            type: 'object',
            additionalProperties: { type: 'number' },
          },
          coord_ref: { type: 'string' },
          reviews_root: { type: 'string' },
          reviewers: { type: 'array', items: { type: 'string' } },
          spec_dir: { type: 'string' },
          project_config_path: { type: 'string' },
        },
      },
    },
  },
};

const projectConfigSchema: AnySchema = {
  type: 'object',
  additionalProperties: false,
  required: ['schema_version', 'coord_ref', 'reviews_root', 'reviewers', 'spec_dir'],
  properties: {
    schema_version: { const: 1 },
    coord_ref: { type: 'string', minLength: 1 },
    reviews_root: { type: 'string', minLength: 1 },
    reviewers: {
      type: 'array',
      minItems: 1,
      uniqueItems: true,
      items: { type: 'string', pattern: '^[a-z][a-z0-9-]*$' },
    },
    spec_dir: { type: 'string', minLength: 1 },
  },
};

const ajv = new Ajv({ allErrors: true, strict: false });

export const validateOnboardingState: ValidateFunction<OnboardingState> =
  ajv.compile<OnboardingState>(onboardingStateSchema);

export const validateProjectsState: ValidateFunction<ProjectsState> =
  ajv.compile<ProjectsState>(projectsStateSchema);

export const validateProjectConfig: ValidateFunction<ProjectConfig> =
  ajv.compile<ProjectConfig>(projectConfigSchema);

function projectConfigPath(repoRoot: string): string {
  return join(resolve(repoRoot), '.echo', 'project.json');
}

function assertConfigRelativePath(field: 'reviews_root' | 'spec_dir', value: string): void {
  if (!isNonEmptyString(value)) {
    throw new Error(`invalid .echo/project.json ${field}: expected non-empty relative path`);
  }
  if (isAbsolute(value)) {
    throw new Error(`invalid .echo/project.json ${field}: absolute paths are not allowed`);
  }
  const normalized = normalize(value);
  if (
    normalized === '.' ||
    normalized === '..' ||
    normalized.startsWith('../') ||
    normalized.split(/[/\\]+/).includes('..') ||
    value.includes('\\')
  ) {
    throw new Error(
      `invalid .echo/project.json ${field}: path must stay inside the project and use forward slashes`,
    );
  }
}

function assertCoordRef(value: string): void {
  if (!isNonEmptyString(value) || /\s/.test(value) || value.startsWith('-')) {
    throw new Error('invalid .echo/project.json coord_ref: expected git ref name');
  }
}

function normalizeProjectConfig(raw: unknown, source: string): ProjectConfig {
  if (!validateProjectConfig(raw)) {
    const detail = ajv.errorsText(validateProjectConfig.errors);
    throw new Error(`${source}: invalid .echo/project.json: ${detail}`);
  }
  const cfg = raw as ProjectConfig;
  assertCoordRef(cfg.coord_ref);
  assertConfigRelativePath('reviews_root', cfg.reviews_root);
  assertConfigRelativePath('spec_dir', cfg.spec_dir);
  return {
    schema_version: 1,
    coord_ref: cfg.coord_ref,
    reviews_root: normalize(cfg.reviews_root).replaceAll('\\', '/'),
    reviewers: [...cfg.reviewers],
    spec_dir: normalize(cfg.spec_dir).replaceAll('\\', '/'),
  };
}

export function loadProjectConfig(repoRoot: string): LoadProjectConfigResult {
  const path = projectConfigPath(repoRoot);
  if (!existsSync(path)) {
    return {
      config: { ...DEFAULT_PROJECT_CONFIG, reviewers: [...DEFAULT_PROJECT_CONFIG.reviewers] },
      path,
      existed: false,
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new Error(`${path}: cannot read .echo/project.json: ${(err as Error).message}`);
  }
  return { config: normalizeProjectConfig(parsed, path), path, existed: true };
}

export function writeProjectConfig(
  repoRoot: string,
  config: ProjectConfig = DEFAULT_PROJECT_CONFIG,
): LoadProjectConfigResult {
  const path = projectConfigPath(repoRoot);
  const normalized = normalizeProjectConfig(config, path);
  mkdirSync(dirname(path), { recursive: true });
  atomicWrite({
    filePath: path,
    content: `${JSON.stringify(normalized, null, 2)}\n`,
    secretSensitive: false,
  });
  return { config: normalized, path, existed: true };
}

function emptyProjectsState(now: Date): ProjectsState {
  return {
    schema_version: 1,
    last_refreshed_at: now.toISOString(),
    default_project: null,
    projects: [],
  };
}

export function readProjectsState(homeOverride?: string): ProjectsState {
  const paths = resolveEchoHomePaths(homeOverride);
  if (!existsSync(paths.stateProjects)) return emptyProjectsState(new Date(0));
  const parsed = JSON.parse(readFileSync(paths.stateProjects, 'utf8')) as unknown;
  if (!validateProjectsState(parsed)) {
    throw new Error(
      `${paths.stateProjects}: invalid projects.json: ${ajv.errorsText(validateProjectsState.errors)}`,
    );
  }
  return parsed as ProjectsState;
}

function sleepMs(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function acquireProjectsLock(lockDir: string, timeoutMs: number): () => void {
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown;
  while (Date.now() <= deadline) {
    try {
      mkdirSync(lockDir, { mode: 0o700 });
      return () => rmSync(lockDir, { recursive: true, force: true });
    } catch (err) {
      const code = err instanceof Error && 'code' in err ? (err as NodeJS.ErrnoException).code : '';
      if (code !== 'EEXIST') {
        throw new Error(`projects.json lock failed: ${(err as Error).message}`);
      }
      lastErr = err;
      sleepMs(25);
    }
  }
  throw new Error(
    `projects.json lock timed out at ${lockDir}: ${(lastErr as Error | undefined)?.message ?? 'lock busy'}`,
  );
}

export interface UpsertProjectRegistrationOptions {
  repoRoot: string;
  config: ProjectConfig;
  homeOverride?: string;
  now?: Date;
  lockTimeoutMs?: number;
}

export function upsertProjectRegistration(opts: UpsertProjectRegistrationOptions): ProjectsState {
  const paths = resolveEchoHomePaths(opts.homeOverride);
  const now = opts.now ?? new Date();
  mkdirSync(paths.state, { recursive: true });
  const release = acquireProjectsLock(`${paths.stateProjects}.lock`, opts.lockTimeoutMs ?? 2000);
  try {
    const state = readProjectsState(paths.root);
    state.schema_version = 1;
    state.last_refreshed_at = now.toISOString();
    if (state.default_project === null) state.default_project = resolve(opts.repoRoot);
    const normalizedRoot = resolve(opts.repoRoot);
    const idx = state.projects.findIndex((p) => resolve(p.repo_root) === normalizedRoot);
    const existing = idx >= 0 ? state.projects[idx] : undefined;
    const record: ProjectRecord = {
      repo_root: normalizedRoot,
      last_seen: now.toISOString(),
      source_breakdown: existing?.source_breakdown ?? {},
      coord_ref: opts.config.coord_ref,
      reviews_root: opts.config.reviews_root,
      reviewers: [...opts.config.reviewers],
      spec_dir: opts.config.spec_dir,
      project_config_path: projectConfigPath(normalizedRoot),
    };
    if (idx >= 0) state.projects[idx] = record;
    else state.projects.push(record);
    state.projects.sort((a, b) => a.repo_root.localeCompare(b.repo_root));
    if (!validateProjectsState(state)) {
      throw new Error(
        `cannot write invalid projects.json: ${ajv.errorsText(validateProjectsState.errors)}`,
      );
    }
    atomicWrite({
      filePath: paths.stateProjects,
      content: `${JSON.stringify(state, null, 2)}\n`,
      secretSensitive: false,
    });
    return state;
  } finally {
    release();
  }
}
