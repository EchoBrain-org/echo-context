import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CAPABILITIES,
  DEFAULT_ROLE_FILENAMES,
  loadRolesFromDir,
  RoleValidationError,
} from '../../src/echo-home/roles.js';

const REPO_ROOT = resolve(import.meta.dirname, '..', '..');
const DEFAULT_ROLES_DIR = join(REPO_ROOT, 'assets', 'echo-roles');
const CUSTOMER_SKILLS_DIR = join(REPO_ROOT, 'assets', 'echo-skills');

const DEFAULT_SKILL_NAMES = ['using-echo-mcp'] as const;

let tmpRoot: string | undefined;

function makeTempDefaultRoles(filenames: readonly string[]): string {
  tmpRoot = mkdtempSync(join(tmpdir(), 'echo-default-roles-'));
  const repoRoot = join(tmpRoot, 'repo');
  const rolesDir = join(repoRoot, 'assets', 'echo-roles');
  const skillsDir = join(repoRoot, 'assets', 'echo-skills');
  mkdirSync(rolesDir, { recursive: true });
  mkdirSync(skillsDir, { recursive: true });
  writeFileSync(join(repoRoot, 'package.json'), '{}\n');
  for (const skill of DEFAULT_SKILL_NAMES) {
    writeFileSync(join(skillsDir, `${skill}.md`), `# ${skill}\n`);
  }
  for (const filename of filenames) {
    copyFileSync(join(DEFAULT_ROLES_DIR, filename), join(rolesDir, filename));
  }
  return rolesDir;
}

function expectDefaultAssertionError(dir: string, expectedMissingRole: string): void {
  try {
    loadRolesFromDir(dir, { assertDefaults: true });
    throw new Error('expected loadRolesFromDir to throw');
  } catch (err) {
    expect(err).toBeInstanceOf(RoleValidationError);
    expect((err as Error).message).toContain('installation integrity');
    expect((err as Error).message).toContain(expectedMissingRole);
  }
}

afterEach(() => {
  if (tmpRoot !== undefined) {
    rmSync(tmpRoot, { recursive: true, force: true });
    tmpRoot = undefined;
  }
});

describe('default ECHO role assets', () => {
  it('loads exactly the three default roles in deterministic order', () => {
    const roles = loadRolesFromDir(DEFAULT_ROLES_DIR, {
      assertDefaults: true,
      skillsRoot: CUSTOMER_SKILLS_DIR,
    });

    expect(roles.map((role) => role.name)).toEqual(['builder', 'reviewer', 'strategist']);
  });

  it('keeps DEFAULT_ROLE_FILENAMES in sync with the asset directory', () => {
    const filenames = readdirSync(DEFAULT_ROLES_DIR)
      .filter((filename) => filename.endsWith('.toml'))
      .sort();

    expect(DEFAULT_ROLE_FILENAMES).toEqual(filenames);
  });

  it('points every default skill reference at an existing customer-shipped skill file', () => {
    const roles = loadRolesFromDir(DEFAULT_ROLES_DIR, { skillsRoot: CUSTOMER_SKILLS_DIR });

    for (const role of roles) {
      expect(role.skills).toEqual(['using-echo-mcp']);
      for (const skill of role.skills) {
        expect(role.sourcePath).toContain(join('assets', 'echo-roles', `${role.name}.toml`));
        expect(DEFAULT_SKILL_NAMES).toContain(skill as (typeof DEFAULT_SKILL_NAMES)[number]);
      }
    }
  });

  it('uses only the public capability vocabulary in default role assets', () => {
    const allowed = new Set<string>(CAPABILITIES);
    const roles = loadRolesFromDir(DEFAULT_ROLES_DIR, { skillsRoot: CUSTOMER_SKILLS_DIR });

    for (const role of roles) {
      expect(role.requires.capabilities.length).toBeGreaterThan(0);
      for (const capability of role.requires.capabilities) {
        expect(allowed.has(capability)).toBe(true);
      }
    }
  });

  it('defines the reviewer role as read-only with review output fields', () => {
    const reviewer = loadRolesFromDir(DEFAULT_ROLES_DIR, {
      skillsRoot: CUSTOMER_SKILLS_DIR,
    }).find((role) => role.name === 'reviewer');

    expect(reviewer).toBeDefined();
    expect(reviewer?.sandbox).toBe('read-only');
    expect(reviewer?.skills).toEqual(['using-echo-mcp']);
    expect(reviewer?.requires.capabilities).toEqual(['fs.read', 'git.read', 'mcp.echo.read']);
    expect(reviewer?.output.requiredFields).toEqual(['verdict', 'reviewer', 'findings']);
  });

  it('keeps customer default roles minimal and backed by the shipped ECHO MCP skill', () => {
    const roles = loadRolesFromDir(DEFAULT_ROLES_DIR, { skillsRoot: CUSTOMER_SKILLS_DIR });
    const builder = roles.find((role) => role.name === 'builder');
    const strategist = roles.find((role) => role.name === 'strategist');

    expect(builder?.sandbox).toBe('workspace-write');
    expect(builder?.skills).toEqual(['using-echo-mcp']);
    expect(builder?.requires.capabilities).toEqual([
      'fs.read',
      'fs.write',
      'git.read',
      'git.write',
      'mcp.echo.read',
    ]);
    expect(strategist?.sandbox).toBe('read-only');
    expect(strategist?.skills).toEqual(['using-echo-mcp']);
    expect(strategist?.requires.capabilities).toEqual(['fs.read', 'git.read', 'mcp.echo.read']);
  });

  it('loads partial role directories when assertDefaults is not requested', () => {
    const partialRolesDir = makeTempDefaultRoles(['builder.toml']);

    const roles = loadRolesFromDir(partialRolesDir, {
      skillsRoot: join(dirname(partialRolesDir), 'echo-skills'),
    });

    expect(roles.map((role) => role.name)).toEqual(['builder']);
  });

  it('accepts a complete installation when assertDefaults is requested', () => {
    const rolesDir = makeTempDefaultRoles(DEFAULT_ROLE_FILENAMES);

    const roles = loadRolesFromDir(rolesDir, {
      assertDefaults: true,
      skillsRoot: join(dirname(rolesDir), 'echo-skills'),
    });

    expect(roles.map((role) => role.name)).toEqual(['builder', 'reviewer', 'strategist']);
  });

  it('rejects a missing reviewer default when assertDefaults is requested', () => {
    const partialRolesDir = makeTempDefaultRoles(['builder.toml', 'strategist.toml']);

    expectDefaultAssertionError(partialRolesDir, 'reviewer');
  });

  it('rejects a missing strategist default when assertDefaults is requested', () => {
    const partialRolesDir = makeTempDefaultRoles(['builder.toml', 'reviewer.toml']);

    expectDefaultAssertionError(partialRolesDir, 'strategist');
  });
});
