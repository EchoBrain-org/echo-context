import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// @ts-expect-error the portable operator is intentionally plain .mjs.
import * as portable from '../../tools/smoke-portable-onboarding.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const {
  PORTABLE_ONBOARDING_PLAN,
  PORTABLE_ONBOARDING_REQUIRED_FILES,
  validatePackMetadata,
} = portable;

describe('portable onboarding boundary', () => {
  it('declares one disposable pack/install and a manual live-capture runtime', () => {
    expect(PORTABLE_ONBOARDING_PLAN).toEqual({
      pack_invocations: 1,
      local_tarball_installs: 1,
      runtime_entrypoint: 'installed-package/dist/cli.js',
      runtime_command: 'daemon run',
      live_capture: 'codex-and-claude-post-start-jsonl',
      promotable: false,
    });
  });

  it('requires the installed package surfaces used by onboarding', () => {
    const files = PORTABLE_ONBOARDING_REQUIRED_FILES.map((path: string) => ({
      path,
    }));
    expect(
      validatePackMetadata([{ filename: 'echo-context.tgz', files }]),
    ).toEqual({
      filename: 'echo-context.tgz',
      files,
    });
    expect(() =>
      validatePackMetadata([
        {
          filename: 'echo-context.tgz',
          files: files.filter(
            (entry: { path: string }) => entry.path !== 'dist/cli.js',
          ),
        },
      ]),
    ).toThrow('portable package omits dist/cli.js');
    expect(() => validatePackMetadata([])).toThrow(
      'portable onboarding requires exactly one npm pack result',
    );
  });

  it('contains no hosted publication, promotion, or native-service controller', () => {
    const source = readFileSync(
      join(ROOT, 'tools', 'smoke-portable-onboarding.mjs'),
      'utf8',
    );
    expect(source.match(/^\s*'pack',$/gmu)).toHaveLength(1);
    expect(source.match(/^\s*'install',$/gmu)).toHaveLength(1);
    expect(source).toContain("join(packageRoot, 'dist', 'cli.js')");
    expect(source).toContain('timeout: COMMAND_TIMEOUT_MS');
    expect(source).toContain('tolerateExited: true');
    expect(source).not.toMatch(/^\s*'exec',$/gmu);
    expect(source).not.toMatch(
      /npm publish|gh release|gh api|upload-artifact|download-artifact|launchctl|\binstallLaunchdAgent\b|\bcopyDatabaseForContext\b|\bcutoverLaunchdAgent\b|\brollbackLaunchdCutover\b/u,
    );
  });

  it('locks the hosted matrix to disposable Linux, Windows, and macOS lanes', () => {
    const workflow = readFileSync(
      join(ROOT, '.github', 'workflows', 'onboarding-compatibility.yml'),
      'utf8',
    );
    const triggerBlock = workflow.slice(
      workflow.indexOf('on:\n') + 'on:\n'.length,
      workflow.indexOf('\npermissions:\n'),
    );
    const jobsBlock = workflow.slice(workflow.indexOf('jobs:\n') + 'jobs:\n'.length);

    expect(
      Array.from(triggerBlock.matchAll(/^  ([a-z0-9_-]+):$/gmu), (match) => match[1]),
    ).toEqual(['pull_request', 'push']);
    expect(workflow).toContain('pull_request:\n    branches: [main]');
    expect(workflow).toContain('push:\n    branches: [main]');
    expect(workflow).toContain('permissions:\n  contents: read');
    expect(workflow.match(/^permissions:/gmu)).toHaveLength(1);
    expect(workflow).toContain(
      'group: portable-onboarding-${{ github.event.pull_request.number || github.ref }}',
    );
    expect(workflow).toContain('cancel-in-progress: true');
    expect(
      Array.from(jobsBlock.matchAll(/^  ([a-z0-9_-]+):$/gmu), (match) => match[1]),
    ).toEqual(['portable-onboarding', 'onboarding-compatibility']);
    expect(workflow).toContain('fail-fast: false');
    expect(workflow).toContain(
      `include:
          - platform: linux-x64
            os: ubuntu-24.04
          - platform: windows-x64
            os: windows-2025
          - platform: macos-arm64
            os: macos-15`,
    );
    expect(workflow).toContain(
      'uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1',
    );
    expect(workflow).toContain('fetch-depth: 1');
    expect(workflow).toContain('persist-credentials: false');
    expect(workflow).toContain(
      'uses: actions/setup-node@820762786026740c76f36085b0efc47a31fe5020',
    );
    expect(workflow).toContain('node-version: 22.22.1');
    expect(workflow).toContain('run: npm ci --no-audit --no-fund');
    expect(workflow).toContain('run: npm run smoke:onboarding');
    expect(workflow).toContain('timeout-minutes: 30');
    expect(workflow).toContain('name: onboarding-compatibility');
    expect(workflow).toContain('if: ${{ always() }}');
    expect(workflow).toContain('needs: portable-onboarding');
    expect(workflow).toContain('runs-on: ubuntu-24.04\n    timeout-minutes: 5');
    expect(workflow).toContain(
      'MATRIX_RESULT: ${{ needs.portable-onboarding.result }}',
    );
    expect(workflow).toContain('run: test "$MATRIX_RESULT" = "success"');
    expect(workflow).not.toMatch(
      /pull_request_target|workflow_run|workflow_dispatch|\bsecrets\.|\bwrite\b|environment:|deployment:|actions\/(?:upload|download)-artifact|actions\/cache|cache:|npm (?:install|pack|publish)|npm run (?:build|smoke:package|beta:)|git (?:add|commit|push|tag)|gh (?:api|release)|launchctl|echo-context (?:install|migrate|cutover|rollback|recover|uninstall)/u,
    );
  });
});
