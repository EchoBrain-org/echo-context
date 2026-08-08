import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CI_WORKFLOW_PATH = '.github/workflows/ci.yml';
const BETA_WORKFLOW_PATH = '.github/workflows/beta-release-gate.yml';
const ONBOARDING_WORKFLOW_PATH = '.github/workflows/onboarding-compatibility.yml';

function filesBelow(root: string): string[] {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    return entry.isDirectory() ? filesBelow(path) : [relative(ROOT, path)];
  });
}

describe('lean hosted CI boundary', () => {
  it('permits exactly the source, onboarding, and beta verification workflows', () => {
    expect(filesBelow(join(ROOT, '.github', 'workflows')).sort()).toEqual(
      [BETA_WORKFLOW_PATH, CI_WORKFLOW_PATH, ONBOARDING_WORKFLOW_PATH].sort(),
    );
  });

  it('locks the existing source-verification workflow', () => {
    const workflow = readFileSync(join(ROOT, CI_WORKFLOW_PATH), 'utf8');
    expect(workflow).toContain('name: Source verification');
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

  it('locks the manual beta gate to validation without release authority', () => {
    const workflow = readFileSync(join(ROOT, BETA_WORKFLOW_PATH), 'utf8');
    const triggerBlock = workflow.slice(workflow.indexOf('on:\n') + 'on:\n'.length, workflow.indexOf('\npermissions:\n'));
    const jobsBlock = workflow.slice(workflow.indexOf('jobs:\n') + 'jobs:\n'.length);

    expect(workflow).toContain('name: Beta release gate');
    expect(workflow).toContain('on:\n  workflow_dispatch:');
    expect(Array.from(triggerBlock.matchAll(/^  ([a-z0-9_-]+):$/gmu), (match) => match[1])).toEqual([
      'workflow_dispatch',
    ]);
    expect(workflow).toContain(
      'tag:\n        description: Existing beta Git tag to validate\n        required: true\n        type: string',
    );
    expect(workflow).toContain(
      'permissions:\n  actions: read\n  checks: read\n  contents: read\n  pull-requests: read',
    );
    expect(workflow).toContain(
      'concurrency:\n  group: beta-release-gate-${{ inputs.tag }}\n  cancel-in-progress: false',
    );
    expect(workflow).toContain('jobs:\n  beta-release-gate:');
    expect(workflow).toContain('runs-on: ubuntu-24.04');
    expect(workflow).toContain(
      '    environment:\n      name: beta-release\n      deployment: false',
    );
    expect(workflow).toContain(
      'uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1',
    );
    expect(workflow).toContain('ref: ${{ inputs.tag }}\n          fetch-depth: 0');
    expect(workflow).toContain(
      'uses: actions/setup-node@820762786026740c76f36085b0efc47a31fe5020',
    );
    expect(workflow).toContain('node-version: 22.22.1');
    expect(workflow).toContain('ACTUAL_REF_TYPE: ${{ github.ref_type }}');
    expect(workflow).toContain('ACTUAL_REF_NAME: ${{ github.ref_name }}');
    expect(workflow).toContain('test "$ACTUAL_REF_TYPE" = "tag"');
    expect(workflow).toContain('test "$ACTUAL_REF_NAME" = "$BETA_TAG"');
    expect(workflow).toContain('GH_TOKEN: ${{ github.token }}');
    expect(workflow).toContain('run: npm run beta:validate -- --tag "$BETA_TAG"');
    expect(workflow.match(/^\s*permissions:/gmu)).toHaveLength(1);
    expect(Array.from(jobsBlock.matchAll(/^  ([a-z0-9_-]+):$/gmu), (match) => match[1])).toEqual([
      'beta-release-gate',
    ]);
    expect(workflow.match(/^\s*environment:/gmu)).toHaveLength(1);
    expect(workflow.match(/^\s*deployment: false$/gmu)).toHaveLength(1);
    expect(workflow).not.toMatch(
      /pull_request_target|\bsecrets\.|\bwrite\b|npm (?:ci|install|pack|publish)|npm run (?:build|smoke:package)|node\s+\S*build\S*|actions\/(?:upload|download)-artifact|git (?:add|commit|push|tag)|gh release|gh api[^\n]*(?:--method|-X)\s+(?:POST|PUT|PATCH|DELETE)/u,
    );
  });

  it('labels the portability workflow with the same onboarding vocabulary as its required check', () => {
    const workflow = readFileSync(join(ROOT, ONBOARDING_WORKFLOW_PATH), 'utf8');
    expect(workflow).toContain('name: Onboarding compatibility');
    expect(workflow).toContain('jobs:\n  portable-onboarding:');
    expect(workflow).toContain('  onboarding-compatibility:');
  });

  it('keeps hosted publication and runtime controllers absent', () => {
    const paths = [...filesBelow(join(ROOT, 'tools')), ...filesBelow(join(ROOT, 'schemas'))];
    const forbidden = paths.filter((path) =>
      /(?:release-publication|operation-host|hosting-controls|workflow-artifact|release-bundle|release-tuple)/u.test(path) ||
      /schemas\/(?:hosted|operation|publication|release)-(?:evidence|plan|authorization)/u.test(path));
    expect(forbidden).toEqual([]);

    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { scripts: Record<string, string> };
    expect(pkg.scripts['ci']).toBe('node tools/run-ci.mjs');
    expect(pkg.scripts).toMatchObject({
      'beta:draft': 'node tools/beta-release-gate.mjs draft',
      'beta:publish': 'node tools/beta-release-gate.mjs publish',
      'beta:stage': 'node tools/beta-release-gate.mjs stage',
      'beta:status': 'node tools/beta-release-status.mjs',
      'beta:validate': 'node tools/beta-release-gate.mjs validate-hosted',
      'smoke:onboarding': 'node tools/smoke-portable-onboarding.mjs',
    });
    expect(
      Object.keys(pkg.scripts).filter(
        (name) => /release|hosted|workflow/u.test(name) || (/publish/u.test(name) && name !== 'beta:publish'),
      ),
    ).toEqual([]);

    const guidance = readFileSync(join(ROOT, 'AGENTS.md'), 'utf8');
    expect(guidance).toContain('one exact reviewed Git object');
    expect(guidance).toContain('runner-local portable onboarding checks');
    expect(guidance).toMatch(/only inside ephemeral\s+scratch state/u);
    expect(guidance).toContain('must never be uploaded, reused');
    expect(guidance).toContain('all external state remains read-only');
    expect(guidance).not.toContain('workflow artifact ID');
  });
});
