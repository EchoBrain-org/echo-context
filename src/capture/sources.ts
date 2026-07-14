import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isNonEmptyString } from '../guards.js';
import { ECHO_HOME_PATHS } from '../echo-home/paths.js';
import { parseJson } from '../util/json.js';

export const DEFAULT_GIT_REPOS = ['~/Desktop/Project_echo/'] as const;

export const CAPTURED_SOURCES = {
  apps: {},
  domains: {},
  fs_paths: [
    '~/Library/Application Support/Cursor/User/workspaceStorage/',
    '~/Library/Application Support/Cursor/User/globalStorage/',
    '~/.claude/projects/',
    '~/.codex/sessions/',
  ],
  apis: ['granola'],
  derived: ['granola-signals', 'granola-signals-index', 'team-decisions'],
  git_repos: [...DEFAULT_GIT_REPOS],
} as const;

// ~/.echo/state/capture-sources.json schema:
// {
//   "schema_version": 1,
//   "updated_at": "2026-05-28T00:00:00.000Z",
//   "git_repos": ["/absolute/path/to/git/repo"]
// }
// The file stores user-managed capture repos. The daemon merges them with
// DEFAULT_GIT_REPOS at boot for backward compatibility.
export interface CaptureSourcesConfig {
  schema_version: 1;
  updated_at: string;
  git_repos: string[];
}

export type Source =
  | { kind: 'app'; bundleId: keyof typeof CAPTURED_SOURCES.apps }
  | { kind: 'domain'; host: keyof typeof CAPTURED_SOURCES.domains }
  | { kind: 'fs'; path: string }
  | { kind: 'api'; name: string }
  | { kind: 'git'; repo: string };

const HOME = homedir();

function isErrnoException(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && 'code' in err;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function invalidCaptureConfig(filePath: string, message: string): never {
  throw new Error(`${filePath}: invalid capture-sources config: ${message}`);
}

export function expandTilde(p: string): string {
  if (p === '~') return HOME;
  if (p.startsWith('~/')) return HOME + p.slice(1);
  return p;
}

export function _isAllowedAppIn(
  bundleId: unknown,
  apps: Readonly<Record<string, unknown>>,
): boolean {
  if (!isNonEmptyString(bundleId)) return false;
  return Object.prototype.hasOwnProperty.call(apps, bundleId);
}

export function _isAllowedDomainIn(
  host: unknown,
  domains: Readonly<Record<string, unknown>>,
): boolean {
  if (!isNonEmptyString(host)) return false;
  return Object.prototype.hasOwnProperty.call(domains, host);
}

export function _isAllowedPathIn(path: unknown, fsPaths: ReadonlyArray<string>): boolean {
  if (!isNonEmptyString(path)) return false;
  return fsPaths.some((entry) => pathContainsOrEquals(path, entry));
}

export function _isAllowedApiIn(name: unknown, apis: ReadonlyArray<string>): boolean {
  if (!isNonEmptyString(name)) return false;
  return apis.includes(name);
}

export function _isAllowedDerivedIn(name: unknown, derived: ReadonlyArray<string>): boolean {
  if (!isNonEmptyString(name)) return false;
  return derived.includes(name);
}

function stripTrailingSlash(p: string): string {
  let out = p;
  while (out.length > 1 && out.endsWith('/')) out = out.slice(0, -1);
  return out;
}

function isWindowsPathLike(p: string): boolean {
  return /^[A-Za-z]:(?:\/|$)/.test(p) || p.startsWith('//');
}

function normalizePathForCompare(p: string): string {
  const normalized = stripTrailingSlash(expandTilde(p).replace(/\\/g, '/'));
  return process.platform === 'win32' || isWindowsPathLike(normalized)
    ? normalized.toLowerCase()
    : normalized;
}

function pathContainsOrEquals(path: string, prefix: string): boolean {
  const normalizedPath = normalizePathForCompare(path);
  const normalizedPrefix = normalizePathForCompare(prefix);
  if (normalizedPath === normalizedPrefix) return true;
  return normalizedPath.startsWith(
    normalizedPrefix.endsWith('/') ? normalizedPrefix : `${normalizedPrefix}/`,
  );
}

export function normalizeRepoPath(p: string): string {
  return normalizePathForCompare(p);
}

export function mergeGitRepos(
  defaults: ReadonlyArray<string>,
  configured: ReadonlyArray<string>,
): string[] {
  const repos: string[] = [];
  const seen = new Set<string>();
  for (const repo of [...defaults, ...configured]) {
    const normalized = normalizeRepoPath(repo);
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    repos.push(repo);
  }
  return repos;
}

export function readCaptureSourcesConfig(
  filePath = ECHO_HOME_PATHS.stateCaptureSources,
): CaptureSourcesConfig | null {
  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf8');
  } catch (err) {
    if (isErrnoException(err) && err.code === 'ENOENT') return null;
    throw err;
  }

  let parsed: unknown;
  try {
    parsed = parseJson(raw);
  } catch (err) {
    invalidCaptureConfig(filePath, `invalid JSON: ${(err as Error).message}`);
  }

  if (!isPlainObject(parsed)) invalidCaptureConfig(filePath, 'expected object');
  const allowedKeys = new Set(['schema_version', 'updated_at', 'git_repos']);
  for (const key of Object.keys(parsed)) {
    if (!allowedKeys.has(key)) invalidCaptureConfig(filePath, `unknown field: ${key}`);
  }
  if (parsed['schema_version'] !== 1) {
    invalidCaptureConfig(filePath, 'schema_version must be 1');
  }
  const updatedAt = parsed['updated_at'];
  const gitRepos = parsed['git_repos'];
  if (!isNonEmptyString(updatedAt)) {
    invalidCaptureConfig(filePath, 'updated_at must be a non-empty string');
  }
  if (!Array.isArray(gitRepos)) {
    invalidCaptureConfig(filePath, 'git_repos must be an array');
  }
  for (let i = 0; i < gitRepos.length; i++) {
    if (!isNonEmptyString(gitRepos[i])) {
      invalidCaptureConfig(filePath, `git_repos[${i}] must be a non-empty string`);
    }
  }

  return {
    schema_version: 1,
    updated_at: updatedAt,
    git_repos: [...gitRepos],
  };
}

export function loadGitReposFromCaptureConfig(
  filePath = ECHO_HOME_PATHS.stateCaptureSources,
): string[] {
  const config = readCaptureSourcesConfig(filePath);
  return mergeGitRepos(DEFAULT_GIT_REPOS, config?.git_repos ?? []);
}

export function applyGitReposFromCaptureConfig(
  filePath = ECHO_HOME_PATHS.stateCaptureSources,
): string[] {
  const repos = loadGitReposFromCaptureConfig(filePath);
  const target = CAPTURED_SOURCES.git_repos as unknown as string[];
  target.splice(0, target.length, ...repos);
  return repos;
}

export function _isAllowedRepoIn(repoPath: unknown, repos: ReadonlyArray<string>): boolean {
  if (!isNonEmptyString(repoPath)) return false;
  const normalized = normalizeRepoPath(repoPath);
  return repos.some((entry) => normalizeRepoPath(entry) === normalized);
}

export function isAllowedApp(bundleId: string): boolean {
  return _isAllowedAppIn(bundleId, CAPTURED_SOURCES.apps);
}

export function isAllowedDomain(host: string): boolean {
  return _isAllowedDomainIn(host, CAPTURED_SOURCES.domains);
}

export function isAllowedPath(path: string): boolean {
  return _isAllowedPathIn(path, CAPTURED_SOURCES.fs_paths);
}

export function isAllowedApi(name: string): boolean {
  return _isAllowedApiIn(name, CAPTURED_SOURCES.apis);
}

export function isAllowedDerived(name: string): boolean {
  return _isAllowedDerivedIn(name, CAPTURED_SOURCES.derived);
}

export function isAllowedRepo(repoPath: string): boolean {
  return _isAllowedRepoIn(repoPath, CAPTURED_SOURCES.git_repos);
}
