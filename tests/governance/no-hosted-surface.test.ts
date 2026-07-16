import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

function filesBelow(root: string): string[] {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    return entry.isDirectory() ? filesBelow(path) : [relative(ROOT, path)];
  });
}

describe('AC4/AC6 — item 140 hosted surfaces remain absent', () => {
  it('contains no workflow, hosted evidence schema, or publication/controller tool', () => {
    expect(filesBelow(join(ROOT, '.github', 'workflows'))).toEqual([]);

    const paths = [...filesBelow(join(ROOT, 'tools')), ...filesBelow(join(ROOT, 'schemas'))];
    const forbidden = paths.filter((path) =>
      /(?:release-publication|operation-host|hosting-controls|workflow-artifact|release-bundle|release-tuple)/u.test(path) ||
      /schemas\/(?:hosted|operation|publication|release)-(?:evidence|plan|authorization)/u.test(path));
    expect(forbidden).toEqual([]);
  });

  it('keeps package scripts and authority guidance source-only', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { scripts: Record<string, string> };
    expect(Object.keys(pkg.scripts).filter((name) => /publish|release|hosted|workflow/u.test(name))).toEqual([]);
    const guidance = readFileSync(join(ROOT, 'AGENTS.md'), 'utf8');
    expect(guidance).toContain('six-field content tuple');
    expect(guidance).not.toContain('workflow run ID');
    expect(guidance).not.toContain('workflow artifact ID');
  });
});
