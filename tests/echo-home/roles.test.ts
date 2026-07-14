import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadRoleFromFile, RoleValidationError } from '../../src/echo-home/roles.js';

let root: string;
let repoRoot: string;
let rolesDir: string;
let skillsDir: string;

function writeSkill(name: string, dir = skillsDir): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}.md`), `# ${name}\n`);
}

function validToml(skills: readonly string[] = ['process-backlog']): string {
  return `
[role]
description = "Claims one item and ships it to review."
sandbox = "workspace-write"
skills = [${skills.map((skill) => JSON.stringify(skill)).join(', ')}]

[role.requires]
mcp_servers = ["echo"]
capabilities = ["fs.read", "fs.write", "git.read", "git.write", "mcp.echo.read"]

[role.output]
format = "markdown"
required_fields = ["run-log"]
`;
}

function writeRole(filename: string, contents = validToml()): string {
  mkdirSync(rolesDir, { recursive: true });
  const path = join(rolesDir, filename);
  writeFileSync(path, contents);
  return path;
}

function expectRoleError(
  filePath: string,
  expected: readonly string[],
  opts?: Parameters<typeof loadRoleFromFile>[1],
): void {
  try {
    loadRoleFromFile(filePath, opts);
    throw new Error('expected loadRoleFromFile to throw');
  } catch (err) {
    expect(err).toBeInstanceOf(RoleValidationError);
    const message = (err as Error).message;
    expect(message).toContain(filePath);
    for (const part of expected) {
      expect(message).toContain(part);
    }
  }
}

describe('role TOML loader', () => {
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'echo-role-loader-'));
    repoRoot = join(root, 'repo');
    rolesDir = join(repoRoot, 'roles');
    skillsDir = join(repoRoot, 'skills');
    mkdirSync(rolesDir, { recursive: true });
    mkdirSync(skillsDir, { recursive: true });
    writeFileSync(join(repoRoot, 'package.json'), '{}\n');
    writeSkill('process-backlog');
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('loads a valid minimal TOML with the name derived from filename', () => {
    const path = writeRole('builder.toml');

    const role = loadRoleFromFile(path);

    expect(role.name).toBe('builder');
    expect(role.description).toBe('Claims one item and ships it to review.');
    expect(role.sandbox).toBe('workspace-write');
    expect(role.skills).toEqual(['process-backlog']);
    expect(role.requires.mcpServers).toEqual(['echo']);
    expect(role.requires.capabilities).toEqual([
      'fs.read',
      'fs.write',
      'git.read',
      'git.write',
      'mcp.echo.read',
    ]);
    expect(role.output).toEqual({ format: 'markdown', requiredFields: ['run-log'] });
    expect(role.sourcePath).toBe(path);
  });

  it('rejects a missing [role] table', () => {
    const path = writeRole('builder.toml', '[other]\nvalue = true\n');
    expectRoleError(path, ['[role]', 'missing required table [role]']);
  });

  it('rejects a missing description', () => {
    const path = writeRole(
      'builder.toml',
      `
[role]
sandbox = "workspace-write"
skills = ["process-backlog"]

[role.requires]
mcp_servers = ["echo"]
capabilities = ["fs.read"]

[role.output]
format = "markdown"
required_fields = ["run-log"]
`,
    );
    expectRoleError(path, ['description']);
  });

  it('rejects a missing sandbox', () => {
    const path = writeRole(
      'builder.toml',
      validToml().replace('sandbox = "workspace-write"\n', ''),
    );
    expectRoleError(path, ['sandbox']);
  });

  it('rejects invalid sandbox values and lists the enum', () => {
    const path = writeRole(
      'builder.toml',
      validToml().replace('sandbox = "workspace-write"', 'sandbox = "danger-full-access"'),
    );
    expectRoleError(path, ['sandbox', 'read-only', 'workspace-write']);
  });

  it('rejects an empty skills array', () => {
    const path = writeRole(
      'builder.toml',
      validToml().replace('skills = ["process-backlog"]', 'skills = []'),
    );
    expectRoleError(path, ['skills', 'non-empty']);
  });

  it('rejects a skills entry that does not exist on disk', () => {
    const path = writeRole('builder.toml', validToml(['nonexistent-skill']));
    expectRoleError(path, ['nonexistent-skill', 'skills/nonexistent-skill.md']);
  });

  it('rejects a [role].name declared in the body', () => {
    const path = writeRole(
      'builder.toml',
      validToml().replace('[role]\n', '[role]\nname = "builder"\n'),
    );
    expectRoleError(path, ['name must be derived from filename']);
  });

  it('rejects filenames outside the kebab-case rule', () => {
    const path = writeRole('Reviewer.toml');
    expectRoleError(path, ['filename', 'kebab-case', '^[a-z][a-z0-9-]*\\.toml$']);
  });

  it('rejects capabilities outside the controlled vocabulary', () => {
    const path = writeRole('builder.toml', validToml().replace('"fs.read"', '"fs.fly"'));
    expectRoleError(path, ['fs.fly', 'fs.read', 'mcp.echo.write']);
  });

  it('rejects unknown keys under [role]', () => {
    const path = writeRole(
      'builder.toml',
      `${validToml()}
[role.metadata]
owner = "echo"
`,
    );
    expectRoleError(path, ['metadata', 'unknown key']);
  });

  it('rejects an empty mcp_servers array', () => {
    const path = writeRole(
      'builder.toml',
      validToml().replace('mcp_servers = ["echo"]', 'mcp_servers = []'),
    );
    expectRoleError(path, ['mcp_servers', 'non-empty']);
  });

  it('rejects missing [role.output].required_fields', () => {
    const path = writeRole(
      'builder.toml',
      validToml().replace('required_fields = ["run-log"]\n', ''),
    );
    expectRoleError(path, ['required_fields']);
  });

  it('wraps TOML parse failures in RoleValidationError', () => {
    const path = writeRole('builder.toml', '[role\nbad = true\n');
    expectRoleError(path, ['TOML parse failed']);
  });

  it('rejects a missing skills field', () => {
    const path = writeRole(
      'builder.toml',
      validToml().replace('skills = ["process-backlog"]\n', ''),
    );
    expectRoleError(path, ['skills']);
  });

  it('rejects a missing [role.requires] table', () => {
    const path = writeRole(
      'builder.toml',
      `
[role]
description = "Claims one item and ships it to review."
sandbox = "workspace-write"
skills = ["process-backlog"]

[role.output]
format = "markdown"
required_fields = ["run-log"]
`,
    );
    expectRoleError(path, ['[role.requires]']);
  });

  it('rejects a missing mcp_servers field', () => {
    const path = writeRole('builder.toml', validToml().replace('mcp_servers = ["echo"]\n', ''));
    expectRoleError(path, ['mcp_servers']);
  });

  it('rejects a missing capabilities field', () => {
    const path = writeRole(
      'builder.toml',
      validToml().replace(
        'capabilities = ["fs.read", "fs.write", "git.read", "git.write", "mcp.echo.read"]\n',
        '',
      ),
    );
    expectRoleError(path, ['capabilities']);
  });

  it('rejects a missing [role.output] table', () => {
    const path = writeRole(
      'builder.toml',
      `
[role]
description = "Claims one item and ships it to review."
sandbox = "workspace-write"
skills = ["process-backlog"]

[role.requires]
mcp_servers = ["echo"]
capabilities = ["fs.read"]
`,
    );
    expectRoleError(path, ['[role.output]']);
  });

  it('rejects a missing output format field', () => {
    const path = writeRole('builder.toml', validToml().replace('format = "markdown"\n', ''));
    expectRoleError(path, ['format']);
  });

  it('rejects unknown keys under [role.requires]', () => {
    const path = writeRole(
      'builder.toml',
      validToml().replace(
        'capabilities = ["fs.read", "fs.write", "git.read", "git.write", "mcp.echo.read"]',
        'capabilities = ["fs.read"]\nsecrets = ["token"]',
      ),
    );
    expectRoleError(path, ['secrets', 'unknown key']);
  });

  it('rejects unknown keys under [role.output]', () => {
    const path = writeRole(
      'builder.toml',
      validToml().replace(
        'required_fields = ["run-log"]',
        'required_fields = ["run-log"]\nmax_tokens = 1000',
      ),
    );
    expectRoleError(path, ['max_tokens', 'unknown key']);
  });

  it('loads with an explicit skillsRoot without walking upward', () => {
    const outsideRoles = join(root, 'outside', 'roles');
    const explicitSkills = join(root, 'explicit-skills');
    mkdirSync(outsideRoles, { recursive: true });
    writeSkill('process-backlog', explicitSkills);
    const path = join(outsideRoles, 'builder.toml');
    writeFileSync(path, validToml());

    const role = loadRoleFromFile(path, { skillsRoot: explicitSkills });

    expect(role.name).toBe('builder');
  });

  it('rejects missing skills under an explicit wrong skillsRoot', () => {
    const emptySkills = join(root, 'empty-skills');
    mkdirSync(emptySkills, { recursive: true });
    const path = writeRole('builder.toml');

    expectRoleError(path, ['process-backlog', 'empty-skills'], { skillsRoot: emptySkills });
  });

  it('does not fall back to walking when skillsRoot is supplied', () => {
    const emptySkills = join(root, 'empty-skills');
    mkdirSync(emptySkills, { recursive: true });
    const path = writeRole('builder.toml');

    expectRoleError(path, ['process-backlog', 'empty-skills'], { skillsRoot: emptySkills });
  });

  it('rejects traversal-shaped skill names before filesystem lookup', () => {
    const path = writeRole('builder.toml', validToml(['../escape']));
    expectRoleError(path, ['../escape', '^[a-z][a-z0-9-]*$']);
  });

  it('rejects skill names with capital letters', () => {
    const path = writeRole('builder.toml', validToml(['Foo']));
    expectRoleError(path, ['Foo', '^[a-z][a-z0-9-]*$']);
  });

  it('rejects skill names with dots', () => {
    const path = writeRole('builder.toml', validToml(['foo.bar']));
    expectRoleError(path, ['foo.bar', '^[a-z][a-z0-9-]*$']);
  });
});
