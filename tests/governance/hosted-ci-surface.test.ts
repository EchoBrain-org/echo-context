import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const WORKFLOW_PATH = '.github/workflows/ci.yml';

function filesBelow(root: string): string[] {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    return entry.isDirectory() ? filesBelow(path) : [relative(ROOT, path)];
  });
}

describe('lean hosted CI boundary', () => {
  it('permits exactly one read-only source-verification workflow', () => {
    expect(filesBelow(join(ROOT, '.github', 'workflows'))).toEqual([WORKFLOW_PATH]);

    const workflow = readFileSync(join(ROOT, WORKFLOW_PATH), 'utf8');
    expect(workflow).toContain('pull_request:\n    branches: [main]');
    expect(workflow).toContain('push:\n    branches: [main]');
    expect(workflow).toContain('permissions:\n  contents: read');
    expect(workflow).toContain('jobs:\n  verify:');
    expect(workflow).toContain('run: npm run ci');
    expect(workflow).toContain('fetch-depth: 0');
    expect(workflow).toMatch(/actions\/checkout@[0-9a-f]{40}/u);
    expect(workflow).toMatch(/actions\/setup-node@[0-9a-f]{40}/u);
    expect(workflow).not.toMatch(/pull_request_target|workflow_run|workflow_dispatch|\bsecrets\.|\bwrite\b|npm publish|gh release/u);
  });

  it('keeps publication, release authority, and hosted controllers absent', () => {
    const paths = [...filesBelow(join(ROOT, 'tools')), ...filesBelow(join(ROOT, 'schemas'))];
    const forbidden = paths.filter((path) =>
      /(?:release-publication|operation-host|hosting-controls|workflow-artifact|release-bundle|release-tuple)/u.test(path) ||
      /schemas\/(?:hosted|operation|publication|release)-(?:evidence|plan|authorization)/u.test(path));
    expect(forbidden).toEqual([]);

    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { scripts: Record<string, string> };
    expect(pkg.scripts['ci']).toBe('node tools/run-ci.mjs');
    expect(Object.keys(pkg.scripts).filter((name) => /publish|release|hosted|workflow/u.test(name))).toEqual([]);

    const guidance = readFileSync(join(ROOT, 'AGENTS.md'), 'utf8');
    expect(guidance).toContain('one exact reviewed Git object');
    expect(guidance).toContain('source verification only');
    expect(guidance).not.toContain('workflow artifact ID');
  });
});
