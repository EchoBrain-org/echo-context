import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
// @ts-expect-error committed Node controller is intentionally plain .mjs; this test asserts its fixture surface.
import { expectedWriteTrace, annotation, validateWriteTrace } from '../../tools/release-publication-controller.mjs';
// @ts-expect-error committed Node verifier is intentionally plain .mjs; this test asserts its fixture surface.
import { discoverActionsApp, validateBranchProtection, validateEnvironment } from '../../tools/verify-hosting-controls.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const workflow = (name: string) => readFileSync(join(ROOT, '.github/workflows', name), 'utf8');
const ci = workflow('ci.yml');
const scan = workflow('secret-scan.yml');
const release = workflow('source-release.yml');
const all = `${ci}\n${scan}\n${release}`;
const PINNED_ACTION = /uses:\s+[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+@[0-9a-f]{40}$/gm;

describe('AC4/AC6 — workflow policy', () => {
  it('resolves hosted test executables from the active Node and Git environment', () => {
    for (const path of [
      'tools/verify-context-tools.mjs',
      'tests/migration/context-tool-evidence.test.ts',
      'tests/integration/context-service.test.ts',
    ]) {
      const source = readFileSync(join(ROOT, path), 'utf8');
      expect(source).toContain('const NODE = process.execPath;');
      expect(source).not.toContain('/usr/local/bin/node');
    }
    const sourceIndependence = readFileSync(join(ROOT, 'tests/migration/source-independence.test.ts'), 'utf8');
    expect(sourceIndependence).toContain("const GIT = process.env.ECHO_TEST_GIT_BIN ?? 'git';");
    expect(sourceIndependence).not.toContain('/usr/local/bin/git');
  });

  it('runs the exact protected contexts for every PR to main and push to main', () => {
    for (const source of [ci, scan]) {
      expect(source).toContain('pull_request:\n    branches: [main]');
      expect(source).toContain('push:\n    branches: [main]');
      expect(source).not.toMatch(/paths(?:-ignore)?:/);
    }
    expect(ci).toMatch(/^  quality-macos:/m);
    expect(ci).toMatch(/^  quality-ubuntu:/m);
    expect(scan).toMatch(/^  secret-scan:/m);
    expect(ci).toContain('node-version: 22.22.1');
    expect(ci).toContain('npm@10.9.4');
  });

  it('pins every third-party action and grants read-only permissions by default', () => {
    const uses = all.split('\n').filter((line) => /^\s+(?:- )?uses:/.test(line));
    expect(uses).not.toHaveLength(0);
    for (const line of uses) expect(line.trim()).toMatch(/^(?:- )?uses: [A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+@[0-9a-f]{40}$/);
    expect(all.match(PINNED_ACTION)?.length).toBe(uses.length);
    expect(ci).toMatch(/permissions:\n  contents: read/);
    expect(scan).toMatch(/permissions:\n  contents: read/);
    expect(release).toMatch(/publish-release:[\s\S]*?permissions:\n      contents: write\n      actions: read/);
    expect(all).not.toContain('/Users/zhenye/Desktop');
    expect(all).not.toMatch(/Project_echo|\.echo-context|\.echo\//);
  });

  it('binds hosted scanning to the exact committed bootstrap contract and fails closed', () => {
    const contractBytes = readFileSync(join(ROOT, 'tools/secret-scan-contract.json'));
    expect(createHash('sha256').update(contractBytes).digest('hex')).toBe('b186d99d61f774a6fbf6f16849c7aeb21618d90f79d3f7da4398d88d95925453');
    expect(scan).toContain('fetch-depth: 0');
    expect(scan).toContain("'+refs/heads/*:refs/remotes/origin/*'");
    expect(scan).toContain("'+refs/tags/*:refs/tags/*'");
    expect(scan).toContain("'+refs/*:refs/echo-scan/*'");
    expect(scan).toContain('tools/install-gitleaks.sh');
    expect(scan).toContain('tools/secret-scan.sh');
    const installer = readFileSync(join(ROOT, 'tools/install-gitleaks.sh'), 'utf8');
    expect(installer).toContain('printf \'%s\\n\' "$out"');
    expect(installer).not.toContain('printf \'%s\\n\' "$out/gitleaks"');
    for (const source of [ci, scan]) {
      expect(source).toContain('scanner_dir=$(tools/install-gitleaks.sh "$RUNNER_TEMP/gitleaks")');
      expect(source).toContain('test -x "$scanner_dir/gitleaks"');
      expect(source).toContain('printf \'%s\\n\' "$scanner_dir" >> "$GITHUB_PATH"');
      expect(source).not.toContain('tools/install-gitleaks.sh "$RUNNER_TEMP/gitleaks" >> "$GITHUB_PATH"');
    }
    expect(readFileSync(join(ROOT, 'tools/secret-scan.mjs'), 'utf8')).toContain("--log-opts=--all");
    expect(readFileSync(join(ROOT, 'tools/secret-scan.sh'), 'utf8')).toContain('secret-scan.mjs');
  });

  it('separates build-once from approval-gated publication and rejects all reruns observably', () => {
    expect(release).toMatch(/^  build-artifact:/m);
    expect(release).toMatch(/^  publish-release:/m);
    expect(release).toMatch(/^  rerun-sentinel:/m);
    expect(release).toMatch(/publish-release:[\s\S]*?needs: \[build-artifact\][\s\S]*?environment: source-release/);
    expect(release).toContain('needs: [build-artifact, publish-release]');
    expect(release).toContain('if: ${{ always() }}');
    expect(release).toContain('permissions: {}');
    expect((release.match(/github\.run_attempt == 1/g) ?? [])).toHaveLength(2);
    expect(release).toContain('GITHUB_RUN_ATTEMPT" != 1');
    expect(release).toContain('cancel-in-progress: false');
    const publishBlock = release.slice(release.indexOf('  publish-release:'), release.indexOf('  rerun-sentinel:'));
    expect(publishBlock).not.toContain('build:artifact');
    expect(publishBlock).toContain('/actions/artifacts/${ARTIFACT_ID}/zip');
    expect(publishBlock).toContain('workflow-artifact-digest');
    expect(publishBlock).not.toMatch(/download-artifact@/);
  });

  it('uses exact-ID bundle retrieval and the controller as the sole release REST mutation owner', () => {
    expect(release).toContain('verify-workflow-artifact-metadata.mjs');
    expect(release).toContain('verify-release-bundle.mjs');
    expect(release).toContain('release-publication-controller.mjs');
    expect(release).not.toMatch(/curl[^\n]*(?:-X|--request)\s+(?:POST|PATCH|PUT|DELETE)/i);
    const controller = readFileSync(join(ROOT, 'tools/release-publication-controller.mjs'), 'utf8');
    expect(controller).toContain("api(token, 'POST', `/repos/${OWNER}/${REPO}/releases`");
    expect(controller).toContain("api(token, 'PATCH', `/repos/${OWNER}/${REPO}/releases/${releaseId}`");
    expect(controller).toContain('https://uploads.github.com/repos/${OWNER}/${REPO}/releases/${releaseId}/assets');
    expect(controller).toContain("accepted: [201]");
    expect(controller).toContain("accepted: [200]");
    expect(controller).toContain("make_latest: 'false'");
    expect(controller).not.toContain('target_commitish');
  });

  it('locks the annotated tag, create-only porcelain lease, asset order, and response/readback trace', () => {
    const S = 'a'.repeat(40);
    expect(annotation('0.1.0-dev.136.1', S)).toBe(`echo-context source release\nversion: 0.1.0-dev.136.1\nsource-sha: ${S}\n`);
    const controller = readFileSync(join(ROOT, 'tools/release-publication-controller.mjs'), 'utf8');
    expect(controller).toContain("['push', '--porcelain', `--force-with-lease=${ref}:`, 'origin', `${oid}:${ref}`]");
    expect(controller).not.toContain('refs/tags/v${version}:refs/tags');
    const trace = expectedWriteTrace('0.1.0-dev.136.1');
    expect(trace).toEqual([
      'tag-push', 'tag-readback', 'draft-create', 'draft-readback',
      'asset-upload:echo-context-0.1.0-dev.136.1-source.tgz', 'asset-readback:echo-context-0.1.0-dev.136.1-source.tgz',
      'asset-upload:echo-context-0.1.0-dev.136.1-source.tgz.sha256', 'asset-readback:echo-context-0.1.0-dev.136.1-source.tgz.sha256',
      'asset-upload:echo-context-0.1.0-dev.136.1-source.manifest.json', 'asset-readback:echo-context-0.1.0-dev.136.1-source.manifest.json',
      'publish-update', 'publish-readback',
    ]);
    expect(() => validateWriteTrace(trace, '0.1.0-dev.136.1')).not.toThrow();
    expect(() => validateWriteTrace([trace[2], ...trace.slice(0, 2), ...trace.slice(3)], '0.1.0-dev.136.1')).toThrow(/trace differs/);
    expect(() => validateWriteTrace(trace.slice(0, -1), '0.1.0-dev.136.1')).toThrow(/trace differs/);
  });

  it('fails hosting controls closed for wrong reviewers, bypass, branch policy, app, SHA, and checks', () => {
    const environment = {
      can_admins_bypass: false,
      deployment_branch_policy: { protected_branches: false, custom_branch_policies: true },
      protection_rules: [{
        type: 'required_reviewers', prevent_self_review: false,
        reviewers: [{ type: 'User', reviewer: { login: 'zhenye0616' } }],
      }],
    };
    const policies = [{ name: 'main', type: 'branch' }];
    expect(() => validateEnvironment(environment, policies)).not.toThrow();
    expect(() => validateEnvironment({ ...environment, can_admins_bypass: true }, policies)).toThrow(/bypass/);
    expect(() => validateEnvironment(environment, [{ name: 'main', type: 'tag' }])).toThrow(/branch-policy/);
    const sha = 'b'.repeat(40);
    const runs = ['quality-macos', 'quality-ubuntu', 'secret-scan'].map((name) => ({ name, head_sha: sha, app: { id: 15368, slug: 'github-actions' } }));
    expect(discoverActionsApp(runs, sha)).toBe(15368);
    expect(() => discoverActionsApp([{ ...runs[0], head_sha: 'c'.repeat(40) }, ...runs.slice(1)], sha)).toThrow(/wrong SHA/);
    const protection = {
      enforce_admins: { enabled: true }, allow_force_pushes: { enabled: false }, allow_deletions: { enabled: false },
      required_pull_request_reviews: { required_approving_review_count: 1, bypass_pull_request_allowances: { users: [], teams: [], apps: [] } },
      required_status_checks: { strict: true, contexts: [], checks: runs.map((run) => ({ context: run.name, app_id: 15368 })) },
    };
    expect(() => validateBranchProtection(protection, 15368)).not.toThrow();
    expect(() => validateBranchProtection({ ...protection, enforce_admins: { enabled: false } }, 15368)).toThrow(/administrator/);
    expect(() => validateBranchProtection({ ...protection, required_status_checks: { ...protection.required_status_checks, checks: protection.required_status_checks.checks.slice(1) } }, 15368)).toThrow(/three app-bound/);
    expect(() => validateBranchProtection(protection, 999)).toThrow(/three app-bound/);
  });
});
