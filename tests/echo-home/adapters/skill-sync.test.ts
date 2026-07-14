import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  populateEchoSkills,
  syncCodexSkills,
  syncClaudeSkills,
} from '../../../src/echo-home/adapters/skill-sync.js';

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'echo-072-skills-'));
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

function setupSource(): { source: string; names: string[] } {
  const source = join(tmpRoot, 'src-skills');
  mkdirSync(source);
  const names = ['alpha.md', 'beta.md', 'gamma.md'];
  for (const n of names) writeFileSync(join(source, n), `# ${n}\n`);
  return { source, names };
}

// Each function is exercised independently to keep the union types narrow.
function runFn(
  label: 'populateEchoSkills' | 'syncClaudeSkills',
  opts: { sourceDir: string; targetDir: string },
): { copied: string[]; skipped: string[] } {
  if (label === 'populateEchoSkills') {
    const r = populateEchoSkills(opts);
    if (!r.ok) throw new Error(`populateEchoSkills failed: ${r.error}`);
    return { copied: r.copied, skipped: r.skipped };
  }
  const r = syncClaudeSkills(opts);
  return { copied: r.copied, skipped: r.skipped };
}

describe.each([{ label: 'populateEchoSkills' as const }, { label: 'syncClaudeSkills' as const }])(
  '$label (shared overwrite-posture contract)',
  ({ label }) => {
    it(`${label}: target dir does not exist → created; all source skills copied`, () => {
      const { source, names } = setupSource();
      const target = join(tmpRoot, 'tgt');
      expect(existsSync(target)).toBe(false);
      const r = runFn(label, { sourceDir: source, targetDir: target });
      expect(existsSync(target)).toBe(true);
      expect(r.copied.sort()).toEqual(names);
      for (const n of names) {
        expect(readFileSync(join(target, n), 'utf8')).toBe(`# ${n}\n`);
      }
    });

    it(`${label}: re-run produces byte-identical files (idempotency-by-overwrite)`, () => {
      const { source, names } = setupSource();
      const target = join(tmpRoot, 'tgt');
      runFn(label, { sourceDir: source, targetDir: target });
      const first: Record<string, Buffer> = {};
      for (const n of names) first[n] = readFileSync(join(target, n));
      runFn(label, { sourceDir: source, targetDir: target });
      for (const n of names) {
        expect(readFileSync(join(target, n)).equals(first[n])).toBe(true);
      }
    });

    it(`${label}: stale skill file in target (not in source) is LEFT IN PLACE`, () => {
      const { source } = setupSource();
      const target = join(tmpRoot, 'tgt');
      mkdirSync(target);
      writeFileSync(join(target, 'stale.md'), 'stale\n');
      runFn(label, { sourceDir: source, targetDir: target });
      expect(readFileSync(join(target, 'stale.md'), 'utf8')).toBe('stale\n');
    });

    it(`${label}: user-hand-edited target skill file matching a source filename is OVERWRITTEN`, () => {
      const { source } = setupSource();
      const target = join(tmpRoot, 'tgt');
      mkdirSync(target);
      writeFileSync(join(target, 'alpha.md'), 'user-edit\n');
      runFn(label, { sourceDir: source, targetDir: target });
      expect(readFileSync(join(target, 'alpha.md'), 'utf8')).toBe('# alpha.md\n');
    });
  },
);

describe('populateEchoSkills — symlink guards', () => {
  it('customer profile copies customer and untagged skills but skips dogfood-only skills', () => {
    const source = join(tmpRoot, 'audience-src');
    const target = join(tmpRoot, 'audience-target');
    mkdirSync(source);
    writeFileSync(join(source, 'customer.md'), '---\naudience: customer\n---\n# customer\n');
    writeFileSync(join(source, 'dogfood.md'), '---\naudience: dogfood\n---\n# dogfood\n');
    writeFileSync(join(source, 'untagged.md'), '# untagged\n');

    const result = populateEchoSkills({
      sourceDir: source,
      targetDir: target,
      profile: 'customer',
    });

    if (!result.ok) throw new Error('expected ok:true');
    expect(result.copied.sort()).toEqual(['customer.md', 'untagged.md']);
    expect(result.skipped).toContain('dogfood.md');
    expect(existsSync(join(target, 'dogfood.md'))).toBe(false);
  });

  it('dogfood profile copies all skill audiences', () => {
    const source = join(tmpRoot, 'dogfood-audience-src');
    const target = join(tmpRoot, 'dogfood-audience-target');
    mkdirSync(source);
    writeFileSync(join(source, 'customer.md'), '---\naudience: customer\n---\n# customer\n');
    writeFileSync(join(source, 'dogfood.md'), '---\naudience: dogfood\n---\n# dogfood\n');

    const result = populateEchoSkills({ sourceDir: source, targetDir: target, profile: 'dogfood' });

    if (!result.ok) throw new Error('expected ok:true');
    expect(result.copied.sort()).toEqual(['customer.md', 'dogfood.md']);
    expect(result.skipped).toEqual([]);
  });

  it('symlink in sourceDir is NEVER followed (skipped[])', () => {
    const { source } = setupSource();
    // Add a symlink in source pointing outside the dir.
    const external = join(tmpRoot, 'external.md');
    writeFileSync(external, 'symlinked\n');
    symlinkSync(external, join(source, 'symlinked.md'));
    const target = join(tmpRoot, 'tgt');
    const r = populateEchoSkills({ sourceDir: source, targetDir: target });
    if (!r.ok) throw new Error('expected ok:true');
    expect(r.skipped).toContain('symlinked.md');
    expect(existsSync(join(target, 'symlinked.md'))).toBe(false);
  });

  it('on unreadable sourceDir → ok:false (no throw)', () => {
    const target = join(tmpRoot, 'tgt');
    const r = populateEchoSkills({
      sourceDir: join(tmpRoot, 'does-not-exist'),
      targetDir: target,
    });
    expect(r.ok).toBe(false);
  });
});

describe('syncClaudeSkills — symlink target skipped', () => {
  it('target symlink at ~/.claude/commands/<n>.md is skipped, linked file unchanged', () => {
    const { source } = setupSource();
    const target = join(tmpRoot, 'cmds');
    mkdirSync(target);
    // Pre-create a symlink at the target path
    const externalFile = join(tmpRoot, 'untouchable.md');
    writeFileSync(externalFile, 'pristine\n');
    symlinkSync(externalFile, join(target, 'alpha.md'));
    const r = syncClaudeSkills({ sourceDir: source, targetDir: target });
    expect(r.skipped).toContain('alpha.md');
    expect(readFileSync(externalFile, 'utf8')).toBe('pristine\n');
  });
});

describe('syncCodexSkills — Codex SKILL.md second-hop', () => {
  it('renders packaged skills into <codexHome>/skills/<name>/SKILL.md with name frontmatter', () => {
    const source = join(tmpRoot, 'codex-source');
    const target = join(tmpRoot, 'codex-target');
    mkdirSync(source);
    writeFileSync(join(source, 'using-echo-mcp.md'), '# Using ECHO MCP\n');

    const result = syncCodexSkills({ sourceDir: source, targetDir: target, profile: 'customer' });
    const skillPath = join(target, 'using-echo-mcp', 'SKILL.md');

    expect(result.copied).toEqual(['using-echo-mcp/SKILL.md']);
    expect(readFileSync(skillPath, 'utf8')).toBe(
      '---\nname: using-echo-mcp\n---\n# Using ECHO MCP\n',
    );
  });

  it('re-run is byte-identical and preserves existing frontmatter shape with corrected name', () => {
    const source = join(tmpRoot, 'codex-idempotent-source');
    const target = join(tmpRoot, 'codex-idempotent-target');
    mkdirSync(source);
    writeFileSync(
      join(source, 'using-echo-mcp.md'),
      '---\nname: stale-name\ndescription: Uses ECHO\n---\n# Body\n',
    );

    syncCodexSkills({ sourceDir: source, targetDir: target, profile: 'customer' });
    const skillPath = join(target, 'using-echo-mcp', 'SKILL.md');
    const first = readFileSync(skillPath);
    syncCodexSkills({ sourceDir: source, targetDir: target, profile: 'customer' });

    expect(readFileSync(skillPath).equals(first)).toBe(true);
    expect(readFileSync(skillPath, 'utf8')).toContain('name: using-echo-mcp\n');
    expect(readFileSync(skillPath, 'utf8')).toContain('description: Uses ECHO\n');
  });

  it('dogfood profile includes dogfood-only skills while customer profile skips them', () => {
    const source = join(tmpRoot, 'codex-profile-source');
    const customerTarget = join(tmpRoot, 'codex-customer-target');
    const dogfoodTarget = join(tmpRoot, 'codex-dogfood-target');
    mkdirSync(source);
    writeFileSync(join(source, 'using-echo-mcp.md'), '---\naudience: customer\n---\n# mcp\n');
    writeFileSync(join(source, 'using-echo-coord.md'), '---\naudience: dogfood\n---\n# coord\n');

    const customer = syncCodexSkills({
      sourceDir: source,
      targetDir: customerTarget,
      profile: 'customer',
    });
    const dogfood = syncCodexSkills({
      sourceDir: source,
      targetDir: dogfoodTarget,
      profile: 'dogfood',
    });

    expect(customer.copied).toEqual(['using-echo-mcp/SKILL.md']);
    expect(customer.skipped).toContain('using-echo-coord.md');
    expect(existsSync(join(customerTarget, 'using-echo-coord', 'SKILL.md'))).toBe(false);
    expect(dogfood.copied.sort()).toEqual(['using-echo-coord/SKILL.md', 'using-echo-mcp/SKILL.md']);
  });

  it('missing required using-echo-mcp source fails before target writes', () => {
    const source = join(tmpRoot, 'codex-missing-source');
    const target = join(tmpRoot, 'codex-missing-target');
    mkdirSync(source);
    writeFileSync(join(source, 'using-echo-coord.md'), '# coord\n');

    expect(() => syncCodexSkills({ sourceDir: source, targetDir: target })).toThrow(
      /missing required Codex skill source: .*using-echo-mcp\.md/,
    );
    expect(existsSync(target)).toBe(false);
  });
});
