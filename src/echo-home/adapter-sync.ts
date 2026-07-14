import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  linkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import * as os from 'node:os';
import { dirname, isAbsolute, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

import { ECHO_HOME_PATHS } from './paths.js';
import { DEFAULT_ROLE_FILENAMES } from './roles.js';
import { mergeWithMarkers, type MarkerResult } from './adapters/markers.js';
import { syncCodexMcpBlock, RenderError, TomlParseError } from './adapters/codex-config.js';
import {
  registerClaudeCodeMcpServer,
  type ClaudeCodeMcpRegisterDeps,
} from './adapters/claude-code-mcp.js';
import { syncCursorMcpEntry, CursorJsonParseError } from './adapters/cursor-config.js';
import {
  populateEchoSkills,
  syncCodexSkills,
  syncClaudeSkills,
  SkillSyncError,
  type PopulateEchoSkillsResult,
} from './adapters/skill-sync.js';
import { syncDefaultRoles, type RoleSyncResult } from './adapters/role-sync.js';
import { syncDefaultWorkflows, type WorkflowSyncResult } from './adapters/workflow-sync.js';
import { AtomicWriteError } from './adapters/atomic-write.js';
import type { InstallProfile } from './paths.js';

// =============================================================================
// Public types
// =============================================================================

export type AgentKind = 'codex' | 'claude-code' | 'cursor';

export interface AdapterSyncProfile {
  kind: AgentKind;
  paths?: {
    configFile?: string;
    instructionsFile?: string;
    commandsDir?: string;
    skillsDir?: string;
  };
  echoSection?: string;
  previousEchoSection?: string;
  mcpServerConfig?: { url: string; [k: string]: unknown };
  previousMcpServerConfig?: Record<string, unknown>;
  claudeCodeMcpRegistration?: ClaudeCodeMcpRegisterDeps;
  force?: boolean;
}

export interface SyncAllOpts {
  echoMcpUrl?: string;
  repoRoot?: string;
  repoSkillsDir?: string;
  rolesSourceDir?: string;
  defaultRoles?: readonly string[];
  workflowsSourceDir?: string;
  defaultWorkflows?: readonly string[];
  allowUserModifiedRoles?: boolean;
  profile?: InstallProfile;
}

export type AdapterErrorCode =
  | 'EACCES'
  | 'ENOSPC'
  | 'ENOTDIR'
  | 'ENOENT'
  | 'EISDIR'
  | 'EROFS'
  | 'EEXIST'
  | 'ELOOP'
  | 'PARSE_ERROR'
  | 'RETRY_CONFLICT'
  | 'MISSING_REQUIRED_INPUT'
  | 'UNSUPPORTED_VALUE'
  | 'UNKNOWN';

export interface AdapterError {
  code: AdapterErrorCode;
  file: string;
  operation: 'read' | 'parse' | 'write' | 'rename' | 'stat' | 'link' | 'mkdir';
  message: string;
  field?: string;
  type?: string;
}

export interface ConfigConflict {
  kind: 'config';
  filePath: string;
  currentValue?: unknown;
  expectedValue?: unknown;
  proposedValue?: unknown;
  unifiedDiff?: string;
}

export interface MarkerConflict {
  kind: 'marker';
  filePath: string;
  currentInside: string;
  expectedInside?: string;
  proposedInside: string;
  unifiedDiff: string;
}

export interface TargetSymlinkConflict {
  kind: 'target-symlink';
  filePath: string;
  targetIsSymlink: true;
}

export interface MalformedMarkerConflict {
  kind: 'malformed-marker';
  filePath: string;
}

export type SyncConflict =
  | ConfigConflict
  | MarkerConflict
  | TargetSymlinkConflict
  | MalformedMarkerConflict;

export type AgentResult =
  | {
      agent: AgentKind;
      ok: true;
      files_written: string[];
      actions: Array<{ file: string; action: string }>;
      skipped?: string[];
    }
  | {
      agent: AgentKind;
      ok: false;
      conflicts: SyncConflict[];
      errors: AdapterError[];
      files_written: string[];
      skipped?: string[];
    };

export interface SyncResult {
  skillsPopulated: PopulateEchoSkillsResult;
  agents: AgentResult[];
  roles: RoleSyncResult;
  workflowsResult?: WorkflowSyncResult;
  syncLock?: AdapterError;
  repoRoot?: AdapterError;
  directorySymlink?: AdapterError;
  overallOk: boolean;
}

// =============================================================================
// Helpers
// =============================================================================

function errnoCode(err: unknown): AdapterErrorCode {
  if (err instanceof Error && 'code' in err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (
      code === 'EACCES' ||
      code === 'ENOSPC' ||
      code === 'ENOTDIR' ||
      code === 'ENOENT' ||
      code === 'EISDIR' ||
      code === 'EROFS' ||
      code === 'EEXIST' ||
      code === 'ELOOP'
    ) {
      return code;
    }
  }
  return 'UNKNOWN';
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

function shellEscapedRmHint(lockPath: string): string {
  return `lockfile present at ${JSON.stringify(lockPath)} — if no other ECHO sync is running, remove it with: rm -- ${shellQuote(lockPath)}. echo doctor will automate this in a future release.`;
}

function emptyOkResult(targetDir: string): PopulateEchoSkillsResult {
  return { ok: true, copied: [], skipped: [], targetDir };
}

function lockUnavailablePopulateResult(): PopulateEchoSkillsResult {
  return { ok: false, sourceDir: '', targetDir: '', error: 'sync_skipped:lock_unavailable' };
}

const DEFAULT_WORKFLOW_FILENAMES = ['change-review.toml'] as const;

function skippedRoles(defaultRoles: readonly string[]): RoleSyncResult {
  return {
    results: defaultRoles.map((role) => ({ role, action: 'noop' as const })),
    rolesErrors: [],
  };
}

function skippedWorkflows(defaultWorkflows: readonly string[]): WorkflowSyncResult {
  return {
    results: defaultWorkflows.map((workflow) => ({ workflow, action: 'noop' as const })),
    workflowsErrors: [],
  };
}

// -----------------------------------------------------------------------------
// Repo-root resolution
// -----------------------------------------------------------------------------

function walkUpwardForRepoRoot(startDir: string): string | null {
  let cur = startDir;
  for (let i = 0; i < 64; i++) {
    try {
      const hasPkg = existsSync(`${cur}${sep}package.json`);
      const hasEchoSkills = existsSync(`${cur}${sep}assets${sep}echo-skills`);
      if (hasPkg && hasEchoSkills) return cur;
    } catch {
      // continue
    }
    const parent = dirname(cur);
    if (parent === cur) return null;
    cur = parent;
  }
  return null;
}

function resolveRepoRoot(opts: SyncAllOpts): string | null {
  if (opts.repoRoot !== undefined) return resolve(opts.repoRoot);
  // Use the current file path as the starting point — fileURLToPath of import.meta.url.
  let startDir: string;
  try {
    startDir = dirname(fileURLToPath(import.meta.url));
  } catch {
    startDir = process.cwd();
  }
  return walkUpwardForRepoRoot(startDir);
}

// -----------------------------------------------------------------------------
// Directory-component symlink guard (AC6a)
// -----------------------------------------------------------------------------

function assertPathComponentsAreNotSymlinks(
  dirPath: string,
  rootBoundary: string,
): AdapterError | null {
  const resolvedRoot = resolve(rootBoundary);
  const resolvedDir = resolve(dirPath);

  // Build the components from rootBoundary down to dirPath, inclusive.
  // If dirPath does not extend through rootBoundary, we just check both.
  const components: string[] = [];
  if (resolvedDir === resolvedRoot) {
    components.push(resolvedRoot);
  } else if (resolvedDir.startsWith(`${resolvedRoot}${sep}`)) {
    components.push(resolvedRoot);
    const rel = resolvedDir.slice(resolvedRoot.length + 1).split(sep);
    let cur = resolvedRoot;
    for (const part of rel) {
      cur = `${cur}${sep}${part}`;
      components.push(cur);
    }
  } else {
    // Not nested — check root and leaf separately.
    components.push(resolvedRoot);
    if (resolvedDir !== resolvedRoot) components.push(resolvedDir);
  }

  if (components.length > 64) {
    return {
      code: 'UNKNOWN',
      file: dirPath,
      operation: 'stat',
      message: 'path-component walk exceeded depth bound (64)',
    };
  }

  for (const c of components) {
    let lst: ReturnType<typeof lstatSync>;
    try {
      lst = lstatSync(c);
    } catch (err) {
      const code = errnoCode(err);
      if (code === 'ENOENT') continue; // non-existent leaf is fine
      return {
        code,
        file: c,
        operation: 'stat',
        message: `lstat of ${c} failed during symlink guard: ${(err as Error).message}`,
      };
    }
    if (lst.isSymbolicLink()) {
      return {
        code: 'EEXIST',
        file: c,
        operation: 'stat',
        message: `path component is a symlink — refusing to operate: ${c}`,
      };
    }
  }
  return null;
}

// -----------------------------------------------------------------------------
// Per-user advisory lock
// -----------------------------------------------------------------------------

interface LockHandle {
  lockPath: string;
  acquisitionToken: string;
  exitHandler: () => void;
  sigintHandler: () => void;
  sigtermHandler: () => void;
}

function releaseLockIfOwned(lockPath: string, myToken: string): void {
  try {
    const raw = readFileSync(lockPath, 'utf-8');
    const meta = JSON.parse(raw) as { acquisitionToken?: string };
    if (meta?.acquisitionToken === myToken) {
      unlinkSync(lockPath);
    }
  } catch {
    // best-effort
  }
}

function acquireLock(stateDir: string): { handle: LockHandle } | { error: AdapterError } {
  try {
    mkdirSync(stateDir, { recursive: true });
  } catch (err) {
    return {
      error: {
        code: errnoCode(err),
        file: stateDir,
        operation: 'mkdir',
        message: `failed to ensure state dir at ${stateDir}: ${(err as Error).message}`,
      },
    };
  }

  const lockPath = `${stateDir}${sep}adapter-sync.lock`;
  const acquisitionToken = randomUUID();
  const tempPath = `${lockPath}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
  const meta = {
    pid: process.pid,
    hostname: os.hostname(),
    started_at: new Date().toISOString(),
    acquisitionToken,
  };

  try {
    writeFileSync(tempPath, JSON.stringify(meta), { mode: 0o600 });
  } catch (err) {
    try {
      unlinkSync(tempPath);
    } catch {
      // best-effort
    }
    return {
      error: {
        code: errnoCode(err),
        file: tempPath,
        operation: 'write',
        message: `failed to write lock temp file: ${(err as Error).message}`,
      },
    };
  }

  try {
    linkSync(tempPath, lockPath);
  } catch (err) {
    try {
      unlinkSync(tempPath);
    } catch {
      // best-effort
    }
    const code = errnoCode(err);
    if (code === 'EEXIST') {
      return {
        error: {
          code: 'RETRY_CONFLICT',
          file: lockPath,
          operation: 'link',
          message: shellEscapedRmHint(lockPath),
        },
      };
    }
    return {
      error: {
        code,
        file: lockPath,
        operation: 'link',
        message: `failed to acquire lock: ${(err as Error).message}`,
      },
    };
  }
  try {
    unlinkSync(tempPath);
  } catch {
    // best-effort
  }

  const exitHandler = (): void => releaseLockIfOwned(lockPath, acquisitionToken);
  const sigintHandler = (): void => {
    releaseLockIfOwned(lockPath, acquisitionToken);
    process.exit(130);
  };
  const sigtermHandler = (): void => {
    releaseLockIfOwned(lockPath, acquisitionToken);
    process.exit(143);
  };
  process.once('exit', exitHandler);
  process.once('SIGINT', sigintHandler);
  process.once('SIGTERM', sigtermHandler);

  return { handle: { lockPath, acquisitionToken, exitHandler, sigintHandler, sigtermHandler } };
}

function releaseLock(handle: LockHandle): void {
  process.removeListener('exit', handle.exitHandler);
  process.removeListener('SIGINT', handle.sigintHandler);
  process.removeListener('SIGTERM', handle.sigtermHandler);
  releaseLockIfOwned(handle.lockPath, handle.acquisitionToken);
}

// -----------------------------------------------------------------------------
// Default per-agent path resolution
// -----------------------------------------------------------------------------

function defaultConfigFile(kind: AgentKind): string | undefined {
  if (kind === 'codex') return resolve(defaultCodexHome(), 'config.toml');
  if (kind === 'cursor') return resolve(homedir(), '.cursor/mcp.json');
  return undefined;
}

function defaultInstructionsFile(kind: AgentKind): string | undefined {
  if (kind === 'codex') return resolve(defaultCodexHome(), 'AGENTS.md');
  if (kind === 'claude-code') return resolve(homedir(), '.claude/CLAUDE.md');
  return undefined;
}

function defaultCommandsDir(kind: AgentKind): string | undefined {
  if (kind === 'claude-code') return resolve(homedir(), '.claude/commands');
  return undefined;
}

function defaultCodexHome(): string {
  const configured = process.env['CODEX_HOME'];
  if (isString(configured) && configured.trim().length > 0) return resolve(configured);
  return resolve(homedir(), '.codex');
}

function defaultCodexSkillsDir(): string {
  return resolve(defaultCodexHome(), 'skills');
}

function isString(v: unknown): v is string {
  return typeof v === 'string';
}

// -----------------------------------------------------------------------------
// syncAll
// -----------------------------------------------------------------------------

export async function syncAll(
  profiles: AdapterSyncProfile[],
  opts: SyncAllOpts = {},
): Promise<SyncResult> {
  const installProfile = opts.profile ?? 'dogfood';
  // Step 1: directory-symlink guard.
  const dirChecks: Array<{ path: string; boundary: string }> = [
    { path: ECHO_HOME_PATHS.skills, boundary: ECHO_HOME_PATHS.root },
    { path: ECHO_HOME_PATHS.state, boundary: ECHO_HOME_PATHS.root },
  ];
  if (installProfile === 'dogfood') {
    dirChecks.push(
      { path: ECHO_HOME_PATHS.roles, boundary: ECHO_HOME_PATHS.root },
      { path: ECHO_HOME_PATHS.workflows, boundary: ECHO_HOME_PATHS.root },
    );
  }
  for (const profile of profiles) {
    const commandsDir = profile.paths?.commandsDir ?? defaultCommandsDir(profile.kind);
    if (isString(commandsDir)) {
      dirChecks.push({ path: commandsDir, boundary: dirname(commandsDir) });
    }
    const instructionsFile =
      profile.paths?.instructionsFile ?? defaultInstructionsFile(profile.kind);
    if (isString(instructionsFile)) {
      const d = dirname(instructionsFile);
      dirChecks.push({ path: d, boundary: dirname(d) });
    }
    const configFile = profile.paths?.configFile ?? defaultConfigFile(profile.kind);
    if (isString(configFile)) {
      const d = dirname(configFile);
      dirChecks.push({ path: d, boundary: dirname(d) });
    }
    if (profile.kind === 'codex') {
      const skillsDir = profile.paths?.skillsDir ?? defaultCodexSkillsDir();
      dirChecks.push({ path: skillsDir, boundary: dirname(skillsDir) });
    }
  }
  for (const check of dirChecks) {
    const err = assertPathComponentsAreNotSymlinks(check.path, check.boundary);
    if (err !== null) {
      return {
        skillsPopulated: lockUnavailablePopulateResult(),
        agents: [],
        roles: { results: [], rolesErrors: [] },
        directorySymlink: err,
        overallOk: false,
      };
    }
  }

  // Step 2: resolve repo root.
  const repoRootPath = resolveRepoRoot(opts);
  if (repoRootPath === null) {
    let initial = '';
    try {
      initial = dirname(fileURLToPath(import.meta.url));
    } catch {
      initial = process.cwd();
    }
    return {
      skillsPopulated: lockUnavailablePopulateResult(),
      agents: [],
      roles: { results: [], rolesErrors: [] },
      repoRoot: {
        code: 'UNKNOWN',
        file: initial,
        operation: 'stat',
        message:
          'could not locate repo root (no package.json + assets/echo-skills/ adjacent); caller must pass opts.repoRoot',
      },
      overallOk: false,
    };
  }

  const repoSkillsDir = opts.repoSkillsDir ?? resolve(repoRootPath, 'assets/echo-skills');
  const rolesSourceDir = opts.rolesSourceDir ?? resolve(repoRootPath, 'assets/echo-roles');
  const workflowsSourceDir =
    opts.workflowsSourceDir ?? resolve(repoRootPath, 'assets/echo-workflows');
  const defaultRoles = opts.defaultRoles ?? DEFAULT_ROLE_FILENAMES;
  const defaultWorkflows = opts.defaultWorkflows ?? DEFAULT_WORKFLOW_FILENAMES;

  // Step 3: acquire lock.
  const lockResult = acquireLock(ECHO_HOME_PATHS.state);
  if ('error' in lockResult) {
    return {
      skillsPopulated: lockUnavailablePopulateResult(),
      agents: [],
      roles: { results: [], rolesErrors: [] },
      syncLock: lockResult.error,
      overallOk: false,
    };
  }
  const lockHandle = lockResult.handle;

  let skillsPopulated: PopulateEchoSkillsResult = emptyOkResult(ECHO_HOME_PATHS.skills);
  const agents: AgentResult[] = [];
  let roles: RoleSyncResult = { results: [], rolesErrors: [] };
  let workflowsResult: WorkflowSyncResult | undefined;

  try {
    // Step 4: populate skills.
    skillsPopulated = populateEchoSkills({
      sourceDir: repoSkillsDir,
      targetDir: ECHO_HOME_PATHS.skills,
      profile: installProfile,
    });

    // Step 5: per-agent dispatch.
    for (const profile of profiles) {
      agents.push(
        await dispatchAgent(profile, {
          available: skillsPopulated.ok === true,
          sourceDir: repoSkillsDir,
          profile: installProfile,
        }),
      );
    }

    if (installProfile === 'dogfood') {
      // Step 6: roles once.
      roles = syncDefaultRoles({
        sourceDir: rolesSourceDir,
        targetDir: ECHO_HOME_PATHS.roles,
        defaults: defaultRoles,
      });

      // Step 7: workflows once.
      workflowsResult = syncDefaultWorkflows({
        sourceDir: workflowsSourceDir,
        targetDir: ECHO_HOME_PATHS.workflows,
        defaults: defaultWorkflows,
      });
    } else {
      roles = skippedRoles(defaultRoles);
      workflowsResult = skippedWorkflows(defaultWorkflows);
    }
  } finally {
    releaseLock(lockHandle);
  }

  const overallOk = computeOverallOk(
    skillsPopulated,
    agents,
    roles,
    workflowsResult,
    defaultWorkflows,
    opts,
  );

  return { skillsPopulated, agents, roles, workflowsResult, overallOk };
}

function computeOverallOk(
  skillsPopulated: PopulateEchoSkillsResult,
  agents: AgentResult[],
  roles: RoleSyncResult,
  workflowsResult: WorkflowSyncResult | undefined,
  defaultWorkflows: readonly string[],
  opts: SyncAllOpts,
): boolean {
  if (skillsPopulated.ok !== true) return false;
  if (skillsPopulated.copied.length < 1) return false;
  for (const a of agents) {
    if (a.ok !== true) return false;
  }
  for (const r of roles.results) {
    if (r.action === 'copied' || r.action === 'noop') continue;
    if (r.action === 'user-modified' && opts.allowUserModifiedRoles === true) continue;
    return false;
  }
  if (workflowsResult === undefined) return false;
  if (workflowsResult.workflowsErrors.length > 0) return false;
  const requiredWorkflows = new Set(defaultWorkflows);
  for (const r of workflowsResult.results) {
    if (r.action === 'copied' || r.action === 'noop' || r.action === 'user-modified') continue;
    if (r.action === 'source-missing' && requiredWorkflows.has(r.workflow)) return false;
    if (r.action === 'error') return false;
  }
  return true;
}

// -----------------------------------------------------------------------------
// Per-agent dispatch
// -----------------------------------------------------------------------------

async function dispatchAgent(
  profile: AdapterSyncProfile,
  skills: { available: boolean; sourceDir: string; profile: InstallProfile },
): Promise<AgentResult> {
  const filesWritten: string[] = [];
  const actions: Array<{ file: string; action: string }> = [];
  const conflicts: SyncConflict[] = [];
  const errors: AdapterError[] = [];
  const skipped: string[] = [];

  const configFile = profile.paths?.configFile ?? defaultConfigFile(profile.kind);
  const instructionsFile = profile.paths?.instructionsFile ?? defaultInstructionsFile(profile.kind);
  const commandsDir = profile.paths?.commandsDir ?? defaultCommandsDir(profile.kind);
  const codexSkillsDir = profile.paths?.skillsDir ?? defaultCodexSkillsDir();

  if (profile.kind === 'codex') {
    if (skills.available) {
      handleCodexSkills(
        skills.sourceDir,
        codexSkillsDir,
        skills.profile,
        filesWritten,
        actions,
        errors,
        skipped,
      );
    } else {
      errors.push({
        code: 'ENOENT',
        file: skills.sourceDir,
        operation: 'read',
        message: `syncCodexSkills skipped: packaged skills unavailable at ${skills.sourceDir}`,
      });
    }
    if (errors.length > 0) {
      return {
        agent: profile.kind,
        ok: false,
        conflicts,
        errors,
        files_written: filesWritten,
        skipped: skipped.length > 0 ? skipped : undefined,
      };
    }
    handleMarkersForAgent(
      'codex',
      profile,
      instructionsFile,
      filesWritten,
      actions,
      conflicts,
      errors,
    );
    handleCodexConfig(profile, configFile, filesWritten, actions, conflicts, errors);
  } else if (profile.kind === 'claude-code') {
    handleMarkersForAgent(
      'claude-code',
      profile,
      instructionsFile,
      filesWritten,
      actions,
      conflicts,
      errors,
    );
    if (skills.available) {
      handleClaudeSkills(commandsDir, filesWritten, actions, errors, skipped);
    } else {
      skipped.push('syncClaudeSkills');
    }
    await handleClaudeCodeMcpRegistration(profile, actions, skipped);
  } else if (profile.kind === 'cursor') {
    handleCursorConfig(profile, configFile, filesWritten, actions, conflicts, errors);
  }

  if (conflicts.length > 0 || errors.length > 0) {
    return {
      agent: profile.kind,
      ok: false,
      conflicts,
      errors,
      files_written: filesWritten,
      skipped: skipped.length > 0 ? skipped : undefined,
    };
  }
  return {
    agent: profile.kind,
    ok: true,
    files_written: filesWritten,
    actions,
    skipped: skipped.length > 0 ? skipped : undefined,
  };
}

async function handleClaudeCodeMcpRegistration(
  profile: AdapterSyncProfile,
  actions: Array<{ file: string; action: string }>,
  skipped: string[],
): Promise<void> {
  const url = profile.mcpServerConfig?.url;
  if (!isString(url)) {
    skipped.push('claudeCodeMcpRegistration');
    return;
  }
  const result = await registerClaudeCodeMcpServer(url, profile.claudeCodeMcpRegistration);
  let action: string = result.action;
  if (result.action === 'error' && result.exitCode !== undefined) {
    action = `error exit-${result.exitCode}`;
  }
  if (result.detail !== undefined && result.detail.length > 0) {
    action = `${action}: ${result.detail.replace(/\s+/g, ' ')}`;
  }
  actions.push({ file: 'claude:mcp:echo', action });
}

function handleMarkersForAgent(
  kind: AgentKind,
  profile: AdapterSyncProfile,
  instructionsFile: string | undefined,
  filesWritten: string[],
  actions: Array<{ file: string; action: string }>,
  conflicts: SyncConflict[],
  errors: AdapterError[],
): void {
  if (!isString(instructionsFile)) {
    errors.push({
      code: 'MISSING_REQUIRED_INPUT',
      file: '',
      operation: 'parse',
      message: `instructionsFile required for kind=${kind}`,
      field: 'instructionsFile',
    });
    return;
  }
  if (!isString(profile.echoSection)) {
    errors.push({
      code: 'MISSING_REQUIRED_INPUT',
      file: instructionsFile,
      operation: 'parse',
      message: `echoSection required for kind=${kind}`,
      field: 'echoSection',
    });
    return;
  }
  let result: MarkerResult;
  try {
    result = mergeWithMarkers({
      filePath: instructionsFile,
      echoSection: profile.echoSection,
      previousEchoSection: profile.previousEchoSection,
      force: profile.force === true,
    });
  } catch (err) {
    errors.push(toAdapterError(err, instructionsFile, 'write'));
    return;
  }
  if (result.action === 'conflict') {
    conflicts.push(result.conflict);
    return;
  }
  if (result.action !== 'noop') {
    filesWritten.push(instructionsFile);
  }
  actions.push({ file: instructionsFile, action: result.action });
}

function handleCodexConfig(
  profile: AdapterSyncProfile,
  configFile: string | undefined,
  filesWritten: string[],
  actions: Array<{ file: string; action: string }>,
  conflicts: SyncConflict[],
  errors: AdapterError[],
): void {
  if (!isString(configFile)) {
    errors.push({
      code: 'MISSING_REQUIRED_INPUT',
      file: '',
      operation: 'parse',
      message: 'configFile required for kind=codex',
      field: 'configFile',
    });
    return;
  }
  if (!profile.mcpServerConfig) {
    errors.push({
      code: 'MISSING_REQUIRED_INPUT',
      file: configFile,
      operation: 'parse',
      message: 'mcpServerConfig required for kind=codex',
      field: 'mcpServerConfig',
    });
    return;
  }
  try {
    const result = syncCodexMcpBlock({
      filePath: configFile,
      serverConfig: profile.mcpServerConfig,
      previousServerConfig: profile.previousMcpServerConfig,
      force: profile.force === true,
    });
    if (result.action === 'conflict') {
      conflicts.push(result.conflict);
      return;
    }
    if (result.action !== 'noop') {
      filesWritten.push(configFile);
    }
    actions.push({ file: configFile, action: result.action });
  } catch (err) {
    errors.push(toAdapterError(err, configFile, 'write'));
  }
}

function handleCursorConfig(
  profile: AdapterSyncProfile,
  configFile: string | undefined,
  filesWritten: string[],
  actions: Array<{ file: string; action: string }>,
  conflicts: SyncConflict[],
  errors: AdapterError[],
): void {
  if (!isString(configFile)) {
    errors.push({
      code: 'MISSING_REQUIRED_INPUT',
      file: '',
      operation: 'parse',
      message: 'configFile required for kind=cursor',
      field: 'configFile',
    });
    return;
  }
  if (!profile.mcpServerConfig) {
    errors.push({
      code: 'MISSING_REQUIRED_INPUT',
      file: configFile,
      operation: 'parse',
      message: 'mcpServerConfig required for kind=cursor',
      field: 'mcpServerConfig',
    });
    return;
  }
  try {
    const result = syncCursorMcpEntry({
      filePath: configFile,
      serverConfig: profile.mcpServerConfig,
      previousServerConfig: profile.previousMcpServerConfig,
      force: profile.force === true,
    });
    if (result.action === 'conflict') {
      conflicts.push(result.conflict);
      return;
    }
    if (result.action !== 'noop') {
      filesWritten.push(configFile);
    }
    actions.push({ file: configFile, action: result.action });
  } catch (err) {
    errors.push(toAdapterError(err, configFile, 'parse'));
  }
}

function handleCodexSkills(
  sourceDir: string,
  targetDir: string | undefined,
  profile: InstallProfile,
  filesWritten: string[],
  actions: Array<{ file: string; action: string }>,
  errors: AdapterError[],
  skipped: string[],
): void {
  if (!isString(targetDir)) {
    errors.push({
      code: 'MISSING_REQUIRED_INPUT',
      file: '',
      operation: 'parse',
      message: 'skillsDir required for kind=codex',
      field: 'skillsDir',
    });
    return;
  }
  try {
    const r = syncCodexSkills({
      sourceDir,
      targetDir,
      profile,
    });
    for (const name of r.copied) {
      filesWritten.push(`${targetDir}${sep}${name}`);
      actions.push({ file: `${targetDir}${sep}${name}`, action: 'copied' });
    }
    for (const name of r.skipped) {
      skipped.push(name);
    }
    if (r.copied.length === 0) {
      errors.push({
        code: 'EEXIST',
        file: targetDir,
        operation: 'write',
        message:
          r.skipped.length > 0
            ? `syncCodexSkills copied 0 files; ${r.skipped.length} skipped (profile, symlink targets, or non-regular source entries)`
            : `syncCodexSkills copied 0 files; source dir empty`,
      });
    }
  } catch (err) {
    errors.push(toAdapterError(err, targetDir, 'write'));
  }
}

function handleClaudeSkills(
  commandsDir: string | undefined,
  filesWritten: string[],
  actions: Array<{ file: string; action: string }>,
  errors: AdapterError[],
  skipped: string[],
): void {
  if (!isString(commandsDir)) {
    errors.push({
      code: 'MISSING_REQUIRED_INPUT',
      file: '',
      operation: 'parse',
      message: 'commandsDir required for kind=claude-code',
      field: 'commandsDir',
    });
    return;
  }
  try {
    const r = syncClaudeSkills({
      sourceDir: ECHO_HOME_PATHS.skills,
      targetDir: commandsDir,
    });
    for (const name of r.copied) {
      filesWritten.push(`${commandsDir}${sep}${name}`);
      actions.push({ file: `${commandsDir}${sep}${name}`, action: 'copied' });
    }
    for (const name of r.skipped) {
      skipped.push(name);
    }
    if (r.copied.length === 0) {
      errors.push({
        code: 'EEXIST',
        file: commandsDir,
        operation: 'write',
        message:
          r.skipped.length > 0
            ? `syncClaudeSkills copied 0 files; ${r.skipped.length} skipped (symlink targets or non-regular source entries)`
            : `syncClaudeSkills copied 0 files; source dir empty`,
      });
    }
  } catch (err) {
    errors.push(toAdapterError(err, commandsDir, 'write'));
  }
}

function toAdapterError(
  err: unknown,
  file: string,
  operation: AdapterError['operation'],
): AdapterError {
  if (err instanceof AtomicWriteError) {
    return {
      code: err.code,
      file: err.file,
      operation,
      message: err.message,
    };
  }
  if (err instanceof SkillSyncError) {
    return {
      code: err.code,
      file: err.file,
      operation: err.operation,
      message: err.message,
    };
  }
  if (err instanceof RenderError) {
    return {
      code: 'UNSUPPORTED_VALUE',
      file,
      operation: 'parse',
      message: err.message,
      field: err.field,
      type: err.typeName,
    };
  }
  if (err instanceof TomlParseError) {
    return {
      code: 'PARSE_ERROR',
      file: err.filePath,
      operation: 'parse',
      message: `TOML parse failed: ${err.firstLine}`,
    };
  }
  if (err instanceof CursorJsonParseError) {
    return {
      code: 'PARSE_ERROR',
      file: err.filePath,
      operation: 'parse',
      message: `JSON parse failed: ${err.firstLine}`,
    };
  }
  return {
    code: errnoCode(err),
    file,
    operation,
    message: `${operation} failed: ${(err as Error).message}`,
  };
}

// Suppress unused-var warning for isAbsolute import (kept for future readers
// that grep for path helpers in this file).
void isAbsolute;
