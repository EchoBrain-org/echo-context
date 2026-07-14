import { readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { parse } from 'smol-toml';

const ROLE_FILENAME_GRAMMAR = '^[a-z][a-z0-9-]*\\.toml$';
const ROLE_FILENAME_RE = /^[a-z][a-z0-9-]*\.toml$/;
const SKILL_NAME_GRAMMAR = '^[a-z][a-z0-9-]*$';
const SKILL_NAME_RE = /^[a-z][a-z0-9-]*$/;
const MCP_SERVER_NAME_GRAMMAR = '^[a-z][a-z0-9_-]*$';
const MCP_SERVER_NAME_RE = /^[a-z][a-z0-9_-]*$/;

export const DEFAULT_ROLE_FILENAMES: readonly string[] = [
  'builder.toml',
  'reviewer.toml',
  'strategist.toml',
] as const;

export const CAPABILITIES = [
  'fs.read',
  'fs.write',
  'git.read',
  'git.write',
  'network',
  'mcp.echo.read',
  'mcp.echo.write',
] as const;

export type Capability = (typeof CAPABILITIES)[number];
export type RoleSandbox = 'read-only' | 'workspace-write';

export interface Role {
  readonly name: string;
  readonly description: string;
  readonly sandbox: RoleSandbox;
  readonly skills: readonly string[];
  readonly requires: {
    readonly mcpServers: readonly string[];
    readonly capabilities: readonly Capability[];
  };
  readonly output: {
    readonly format: string;
    readonly requiredFields: readonly string[];
  };
  readonly sourcePath: string;
}

export class RoleValidationError extends Error {
  constructor(
    message: string,
    public readonly filePath: string,
    public readonly field?: string,
  ) {
    super(field === undefined ? `${filePath}: ${message}` : `${filePath}: ${field}: ${message}`);
    this.name = 'RoleValidationError';
  }
}

export interface RoleLoadOptions {
  /** Directory containing `<skill>.md` files. Defaults to repo-root discovery. */
  skillsRoot?: string;
  /** Require every DEFAULT_ROLE_FILENAMES entry to be present in dir loads. */
  assertDefaults?: boolean;
}

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function fail(filePath: string, field: string | undefined, message: string): never {
  throw new RoleValidationError(message, filePath, field);
}

function hasOwn(record: UnknownRecord, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function assertAllowedKeys(
  table: UnknownRecord,
  allowed: readonly string[],
  filePath: string,
  fieldPrefix: string,
): void {
  for (const key of Object.keys(table)) {
    if (!allowed.includes(key)) {
      fail(filePath, `${fieldPrefix}.${key}`, `unknown key ${key}`);
    }
  }
}

function requiredTable(
  parent: UnknownRecord,
  key: string,
  filePath: string,
  tableLabel: string,
): UnknownRecord {
  const value = parent[key];
  if (!isRecord(value)) {
    fail(filePath, tableLabel, `missing required table ${tableLabel}`);
  }
  return value;
}

function requiredString(
  table: UnknownRecord,
  key: string,
  filePath: string,
  field: string,
): string {
  const value = table[key];
  if (typeof value !== 'string' || value.length === 0) {
    fail(filePath, field, `missing or invalid required field ${key}`);
  }
  return value;
}

function requiredStringArray(
  table: UnknownRecord,
  key: string,
  filePath: string,
  field: string,
): readonly string[] {
  const value = table[key];
  if (!Array.isArray(value)) {
    fail(filePath, field, `missing or invalid required field ${key}`);
  }
  if (value.length === 0) {
    fail(filePath, field, `${key} must be a non-empty array`);
  }
  for (const entry of value) {
    if (typeof entry !== 'string' || entry.length === 0) {
      fail(filePath, field, `${key} must contain only non-empty strings`);
    }
  }
  return value;
}

function validateFilename(filePath: string): string {
  const filename = basename(filePath);
  if (!ROLE_FILENAME_RE.test(filename)) {
    fail(filePath, 'filename', `filename must match kebab-case rule ${ROLE_FILENAME_GRAMMAR}`);
  }
  return filename.slice(0, -'.toml'.length);
}

function discoverSkillsRoot(sourcePath: string): string {
  let current = dirname(resolve(sourcePath));
  for (;;) {
    try {
      const packageJson = statSync(join(current, 'package.json'));
      const skillsDir = statSync(join(current, 'skills'));
      if (packageJson.isFile() && skillsDir.isDirectory()) return join(current, 'skills');
    } catch {
      // keep walking
    }
    const parent = dirname(current);
    if (parent === current) {
      fail(sourcePath, 'skills', 'could not discover skills root from sourcePath');
    }
    current = parent;
  }
}

function resolveSkillsRoot(sourcePath: string, opts: RoleLoadOptions | undefined): string {
  if (opts?.skillsRoot !== undefined) return resolve(opts.skillsRoot);
  return discoverSkillsRoot(sourcePath);
}

function isInsideRoot(path: string, root: string): boolean {
  const rel = relative(root, path);
  return rel.length > 0 && !rel.startsWith('..') && !isAbsolute(rel);
}

function validateSkills(
  skills: readonly string[],
  skillsRoot: string,
  filePath: string,
): readonly string[] {
  const root = resolve(skillsRoot);
  for (const skill of skills) {
    if (!SKILL_NAME_RE.test(skill)) {
      fail(filePath, 'role.skills', `skill ${skill} must match grammar ${SKILL_NAME_GRAMMAR}`);
    }
    const candidate = resolve(root, `${skill}.md`);
    if (!isInsideRoot(candidate, root)) {
      fail(filePath, 'role.skills', `skill ${skill} resolves outside skillsRoot ${root}`);
    }
    try {
      if (!statSync(candidate).isFile()) {
        fail(filePath, 'role.skills', `missing skill ${skill} at ${candidate}`);
      }
    } catch (err) {
      if (err instanceof RoleValidationError) throw err;
      fail(filePath, 'role.skills', `missing skill ${skill} at ${candidate}`);
    }
  }
  return skills;
}

function validateSandbox(value: string, filePath: string): RoleSandbox {
  if (value === 'read-only' || value === 'workspace-write') return value;
  fail(filePath, 'role.sandbox', 'sandbox must be one of: read-only, workspace-write');
}

function validateMcpServers(servers: readonly string[], filePath: string): readonly string[] {
  for (const server of servers) {
    if (!MCP_SERVER_NAME_RE.test(server)) {
      fail(
        filePath,
        'role.requires.mcp_servers',
        `mcp server name ${server} must match grammar ${MCP_SERVER_NAME_GRAMMAR}`,
      );
    }
  }
  return servers;
}

function validateCapabilities(
  capabilities: readonly string[],
  filePath: string,
): readonly Capability[] {
  const allowed = new Set<string>(CAPABILITIES);
  for (const capability of capabilities) {
    if (!allowed.has(capability)) {
      fail(
        filePath,
        'role.requires.capabilities',
        `capability ${capability} is not in vocabulary: ${CAPABILITIES.join(', ')}`,
      );
    }
  }
  return capabilities as readonly Capability[];
}

function parseToml(filePath: string): UnknownRecord {
  try {
    const parsed = parse(readFileSync(filePath, 'utf8'));
    if (!isRecord(parsed)) fail(filePath, undefined, 'TOML root must be a table');
    return parsed;
  } catch (err) {
    if (err instanceof RoleValidationError) throw err;
    fail(filePath, undefined, `TOML parse failed: ${(err as Error).message}`);
  }
}

function freezeRole(role: Role): Role {
  Object.freeze(role.skills);
  Object.freeze(role.requires.mcpServers);
  Object.freeze(role.requires.capabilities);
  Object.freeze(role.requires);
  Object.freeze(role.output.requiredFields);
  Object.freeze(role.output);
  Object.freeze(role);
  return role;
}

export function loadRoleFromFile(filePath: string, opts?: RoleLoadOptions): Role {
  const sourcePath = resolve(filePath);
  const name = validateFilename(sourcePath);
  const root = parseToml(sourcePath);

  const roleTable = requiredTable(root, 'role', sourcePath, '[role]');
  assertAllowedKeys(root, ['role'], sourcePath, '<root>');
  if (hasOwn(roleTable, 'name')) {
    fail(sourcePath, 'role.name', 'name must be derived from filename, not declared in body');
  }
  assertAllowedKeys(
    roleTable,
    ['description', 'sandbox', 'skills', 'requires', 'output'],
    sourcePath,
    'role',
  );

  const requiresTable = requiredTable(roleTable, 'requires', sourcePath, '[role.requires]');
  assertAllowedKeys(requiresTable, ['mcp_servers', 'capabilities'], sourcePath, 'role.requires');

  const outputTable = requiredTable(roleTable, 'output', sourcePath, '[role.output]');
  assertAllowedKeys(outputTable, ['format', 'required_fields'], sourcePath, 'role.output');

  const description = requiredString(roleTable, 'description', sourcePath, 'role.description');
  const sandbox = validateSandbox(
    requiredString(roleTable, 'sandbox', sourcePath, 'role.sandbox'),
    sourcePath,
  );
  const rawSkills = requiredStringArray(roleTable, 'skills', sourcePath, 'role.skills');
  const skills = validateSkills(rawSkills, resolveSkillsRoot(sourcePath, opts), sourcePath);

  const mcpServers = validateMcpServers(
    requiredStringArray(requiresTable, 'mcp_servers', sourcePath, 'role.requires.mcp_servers'),
    sourcePath,
  );
  const capabilities = validateCapabilities(
    requiredStringArray(requiresTable, 'capabilities', sourcePath, 'role.requires.capabilities'),
    sourcePath,
  );

  const format = requiredString(outputTable, 'format', sourcePath, 'role.output.format');
  const requiredFields = requiredStringArray(
    outputTable,
    'required_fields',
    sourcePath,
    'role.output.required_fields',
  );

  return freezeRole({
    name,
    description,
    sandbox,
    skills,
    requires: {
      mcpServers,
      capabilities,
    },
    output: {
      format,
      requiredFields,
    },
    sourcePath,
  });
}

export function loadRolesFromDir(dirPath: string, opts?: RoleLoadOptions): Role[] {
  const resolvedDir = resolve(dirPath);
  const entries = readdirSync(resolvedDir, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .filter((name) => !name.startsWith('.') && name.endsWith('.toml'))
    .sort();

  if (opts?.assertDefaults === true) {
    const present = new Set(entries);
    for (const filename of DEFAULT_ROLE_FILENAMES) {
      if (!present.has(filename)) {
        const roleName = filename.slice(0, -'.toml'.length);
        fail(
          resolvedDir,
          'DEFAULT_ROLE_FILENAMES',
          `installation integrity: missing default role ${roleName}`,
        );
      }
    }
  }

  const roles = entries.map((entry) => loadRoleFromFile(join(resolvedDir, entry), opts));
  const seen = new Set<string>();
  for (const role of roles) {
    const normalized = role.name.toLowerCase();
    if (seen.has(normalized)) {
      fail(resolvedDir, 'name', `duplicate role name ${role.name}`);
    }
    seen.add(normalized);
  }
  return roles.sort((a, b) => a.name.localeCompare(b.name));
}
