import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// @ts-expect-error the committed canonical JSON helper is intentionally plain .mjs.
import { canonicalJsonBytes } from '../../tools/canonical-json.mjs';

// @ts-expect-error the committed beta release operator is intentionally plain .mjs.
import * as betaGate from '../../tools/beta-release-gate.mjs';

const {
  betaReleaseNotes,
  buildPublishIntent,
  buildStageCommandPlan,
  compareBetaVersions,
  flattenGithubPages,
  normalizeReleaseView,
  parseBetaVersion,
  parseWorkflowRunId,
  selectIndependentApproval,
  selectVerifyCheck,
  validateBetaEnvironmentPolicy,
  validateBetaManifest,
  validateCanonicalRemote,
  validateHostedGateEvidence,
  validateHostedGateRunRecord,
  validateManifestGithubEvidence,
  validateReleaseAssetRoster,
  validateReleaseNotesFragment,
  validateReleaseRecord,
  validateRemoteReleasePayload,
} = betaGate;

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const BETA7_RELEASE_NOTES = readFileSync(
  join(ROOT, 'release-notes', '0.1.0-beta.7.md'),
);
const CURRENT_HEAD = execFileSync('git', ['rev-parse', 'HEAD'], {
  cwd: ROOT,
  encoding: 'utf8',
}).trim();

const SOURCE_SHA = '1'.repeat(40);
const SOURCE_TREE = '2'.repeat(40);
const ARTIFACT_SHA = '3'.repeat(64);
const RUNTIME_MANIFEST_SHA = '4'.repeat(64);
const RECEIPT_SHA = '5'.repeat(64);
const INSTALLED_TREE_SHA = '6'.repeat(64);

function manifestFixture() {
  return {
    schema: 'beta-release-manifest.v1',
    repository: 'EchoBrain-org/echo-context',
    channel: 'beta',
    version: '0.1.0-beta.7',
    tag: 'v0.1.0-beta.7',
    source: {
      commit: SOURCE_SHA,
      tree: SOURCE_TREE,
    },
    artifact: {
      filename: 'echo-context-0.1.0-beta.7.tgz',
      sha256: ARTIFACT_SHA,
      bytes: 123_456,
      runtime_manifest_digest: RUNTIME_MANIFEST_SHA,
    },
    evidence: {
      local_ci: {
        command: 'npm run ci',
        source_commit: SOURCE_SHA,
      },
      github_verify: {
        name: 'verify',
        app_id: 15_368,
        head_sha: SOURCE_SHA,
        conclusion: 'success',
        completed_at: '2026-08-03T20:00:00Z',
        url: 'https://github.com/EchoBrain-org/echo-context/actions/runs/1',
      },
      independent_review: {
        pull_request: 7,
        author: 'builder',
        reviewer: 'reviewer',
        commit_id: SOURCE_SHA,
        submitted_at: '2026-08-03T19:00:00Z',
        url: 'https://github.com/EchoBrain-org/echo-context/pull/7#review-1',
      },
    },
    promotion: {
      smoke: 'passed',
      receipt_sha256: RECEIPT_SHA,
      installed_tree_digest: INSTALLED_TREE_SHA,
    },
    release_policy: {
      draft_required: true,
      prerelease_required: true,
      immutable_required_before_publish: true,
    },
    toolchain: {
      node: '22.22.1',
      npm: '10.9.4',
    },
    runtime_authority: false,
    state_authority: false,
  };
}

function reviewFixture(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    state: 'APPROVED',
    commit_id: SOURCE_SHA,
    submitted_at: '2026-08-03T19:00:00Z',
    user: {
      login: 'reviewer',
      type: 'User',
    },
    ...overrides,
  };
}

function checkFixture(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    name: 'verify',
    app: { id: 15_368 },
    head_sha: SOURCE_SHA,
    status: 'completed',
    conclusion: 'success',
    completed_at: '2026-08-03T20:00:00Z',
    ...overrides,
  };
}

describe('beta release identity', () => {
  it('pins both Git directions to the canonical GitHub host and repository', () => {
    const canonical = 'https://github.com/EchoBrain-org/echo-context.git';
    const checkoutCanonical = 'https://github.com/EchoBrain-org/echo-context';
    expect(validateCanonicalRemote(canonical, canonical)).toBe(canonical);
    expect(validateCanonicalRemote(checkoutCanonical, checkoutCanonical)).toBe(canonical);
    expect(validateCanonicalRemote(canonical, checkoutCanonical)).toBe(canonical);
    expect(() => validateCanonicalRemote('git@github.com:other/repo.git', canonical)).toThrow(
      /origin fetch and push URLs/u,
    );
    expect(() =>
      validateCanonicalRemote(canonical, 'https://example.com/echo-context.git'),
    ).toThrow(/origin fetch and push URLs/u);
  });

  it('accepts only the strict beta version and tag syntax', () => {
    expect(parseBetaVersion('0.1.0-beta.7')).toEqual({
      version: '0.1.0-beta.7',
      tag: 'v0.1.0-beta.7',
      core: '0.1.0',
      major: 0,
      minor: 1,
      patch: 0,
      beta: 7,
    });
    expect(parseBetaVersion('v12.3.40-beta.9')).toMatchObject({
      version: '12.3.40-beta.9',
      tag: 'v12.3.40-beta.9',
    });

    for (const invalid of [
      '0.1.0',
      '0.1.0-beta',
      '0.1.0-beta.07',
      '00.1.0-beta.7',
      'v0.1.0-BETA.7',
      'v0.1.0-beta.7-extra',
      ' v0.1.0-beta.7',
    ]) {
      expect(() => parseBetaVersion(invalid), invalid).toThrow(/invalid beta version/u);
    }
  });

  it('compares the complete release core before the beta sequence', () => {
    expect(compareBetaVersions('0.1.0-beta.7', 'v0.1.0-beta.7')).toBe(0);
    expect(compareBetaVersions('0.1.0-beta.7', '0.1.0-beta.8')).toBe(-1);
    expect(compareBetaVersions('0.2.0-beta.1', '0.1.99-beta.999')).toBe(1);
    expect(compareBetaVersions('1.0.0-beta.0', '0.999.999-beta.999')).toBe(1);
  });
});

describe('review and hosted verification evidence', () => {
  it('combines every paginated review or check page and rejects response-shape drift', () => {
    expect(flattenGithubPages([[{ id: 1 }], [{ id: 2 }]])).toEqual([{ id: 1 }, { id: 2 }]);
    expect(
      flattenGithubPages([{ check_runs: [{ id: 1 }] }, { check_runs: [{ id: 2 }] }], 'check_runs'),
    ).toEqual([{ id: 1 }, { id: 2 }]);
    expect(() => flattenGithubPages([{ reviews: [] }])).toThrow(/lacks an array page/u);
    expect(() => flattenGithubPages([{}], 'check_runs')).toThrow(/lacks check_runs/u);
  });

  it('accepts an independent approval bound to the exact source commit', () => {
    const exact = reviewFixture();
    expect(selectIndependentApproval([exact], 'builder', SOURCE_SHA)).toBe(exact);
  });

  it('rejects stale, superseded, dismissed, self, and bot approvals', () => {
    const stale = reviewFixture({ commit_id: '9'.repeat(40) });
    const self = reviewFixture({ user: { login: 'builder', type: 'User' } });
    const bot = reviewFixture({ user: { login: 'review-bot', type: 'Bot' } });
    const exact = reviewFixture({
      id: 10,
      submitted_at: '2026-08-03T19:00:00Z',
    });

    for (const reviews of [
      [stale],
      [self],
      [bot],
      [
        exact,
        reviewFixture({
          id: 11,
          state: 'CHANGES_REQUESTED',
          submitted_at: '2026-08-03T19:01:00Z',
        }),
      ],
      [
        exact,
        reviewFixture({
          id: 12,
          state: 'DISMISSED',
          submitted_at: '2026-08-03T19:02:00Z',
        }),
      ],
    ]) {
      expect(() => selectIndependentApproval(reviews, 'builder', SOURCE_SHA)).toThrow(
        /no current independent GitHub approval/u,
      );
    }
  });

  it('requires the exact completed successful verify check from GitHub Actions', () => {
    const exact = checkFixture();
    expect(selectVerifyCheck([exact], SOURCE_SHA)).toBe(exact);

    for (const invalid of [
      checkFixture({ name: 'other' }),
      checkFixture({ app: { id: 99 } }),
      checkFixture({ head_sha: '9'.repeat(40) }),
      checkFixture({ status: 'in_progress' }),
      checkFixture({ conclusion: 'failure' }),
    ]) {
      expect(() => selectVerifyCheck([invalid], SOURCE_SHA)).toThrow(
        /lacks a successful verify check/u,
      );
    }

    expect(() =>
      selectVerifyCheck(
        [
          exact,
          checkFixture({
            id: 2,
            conclusion: 'failure',
            completed_at: '2026-08-03T20:01:00Z',
          }),
        ],
        SOURCE_SHA,
      ),
    ).toThrow(/lacks a successful verify check/u);
  });

  it('revalidates the exact PR, reviewer, timestamp, URL, and check frozen in a manifest', () => {
    const manifest = manifestFixture();
    const pull = {
      base: { ref: 'main' },
      head: { sha: SOURCE_SHA },
      merged_at: '2026-08-03T20:30:00Z',
      number: 7,
      user: { login: 'builder' },
    };
    const approval = reviewFixture({
      html_url: manifest.evidence.independent_review.url,
      submitted_at: manifest.evidence.independent_review.submitted_at,
    });
    const verify = checkFixture({
      completed_at: manifest.evidence.github_verify.completed_at,
      html_url: manifest.evidence.github_verify.url,
    });
    expect(
      validateManifestGithubEvidence(
        { checks: [verify], pull, reviews: [approval] },
        SOURCE_SHA,
        manifest,
      ),
    ).toMatchObject({
      approval: { user: { login: 'reviewer' } },
      evidence: {
        github_verify: manifest.evidence.github_verify,
        independent_review: manifest.evidence.independent_review,
      },
    });
    expect(() =>
      validateManifestGithubEvidence(
        {
          checks: [verify],
          pull,
          reviews: [reviewFixture({ user: { login: 'different-reviewer', type: 'User' } })],
        },
        SOURCE_SHA,
        manifest,
      ),
    ).toThrow(/exact source commit/u);
  });

  it('requires nested self-review protection, one exact tag policy, and a named reviewer', () => {
    const environment = {
      name: 'beta-release',
      can_admins_bypass: false,
      deployment_branch_policy: { custom_branch_policies: true },
      protection_rules: [
        {
          type: 'required_reviewers',
          prevent_self_review: true,
          reviewers: [{ type: 'User', reviewer: { login: 'independent-reviewer' } }],
        },
      ],
    };
    const policies = {
      branch_policies: [{ name: 'v*-beta.*', type: 'tag' }],
    };
    expect(validateBetaEnvironmentPolicy(environment, policies).reviewerLogins).toEqual([
      'independent-reviewer',
    ]);

    for (const [invalidEnvironment, invalidPolicies] of [
      [
        {
          ...environment,
          protection_rules: [{ ...environment.protection_rules[0], prevent_self_review: false }],
        },
        policies,
      ],
      [{ ...environment, can_admins_bypass: true }, policies],
      [environment, { branch_policies: [{ name: 'v*-beta.*', type: 'branch' }] }],
      [
        environment,
        {
          branch_policies: [
            { name: 'v*-beta.*', type: 'tag' },
            { name: '*', type: 'tag' },
          ],
        },
      ],
    ]) {
      expect(() => validateBetaEnvironmentPolicy(invalidEnvironment, invalidPolicies)).toThrow(
        /beta release gate:/u,
      );
    }
  });

  it('accepts only the exact hosted workflow path at the exact beta tag and source', () => {
    const manifest = manifestFixture();
    const binding = { gate_run_id: 42 };
    const run = {
      id: 42,
      event: 'workflow_dispatch',
      run_attempt: 1,
      path: `.github/workflows/beta-release-gate.yml@${manifest.tag}`,
      head_sha: SOURCE_SHA,
      status: 'completed',
      conclusion: 'success',
    };

    expect(validateHostedGateRunRecord(run, manifest, binding)).toBe(run);
    expect(
      validateHostedGateRunRecord(
        { ...run, path: '.github/workflows/beta-release-gate.yml' },
        manifest,
        binding,
      ),
    ).toMatchObject({ id: 42 });

    for (const invalid of [
      { ...run, id: 43 },
      { ...run, event: 'push' },
      { ...run, run_attempt: 2 },
      { ...run, path: '.github/workflows/beta-release-gate.yml@main' },
      { ...run, path: '.github/workflows/other.yml@v0.1.0-beta.7' },
      { ...run, head_sha: '9'.repeat(40) },
      { ...run, status: 'in_progress' },
      { ...run, conclusion: 'failure' },
    ]) {
      expect(() => validateHostedGateRunRecord(invalid, manifest, binding)).toThrow(
        /recorded hosted beta gate did not pass/u,
      );
    }
  });

  it('requires one successful hosted job and an independent configured environment approval', () => {
    const manifest = manifestFixture();
    const binding = { gate_run_id: 42 };
    const evidence = {
      runRecord: {
        id: 42,
        event: 'workflow_dispatch',
        run_attempt: 1,
        path: `.github/workflows/beta-release-gate.yml@${manifest.tag}`,
        head_sha: SOURCE_SHA,
        status: 'completed',
        conclusion: 'success',
        triggering_actor: { login: 'release-operator' },
      },
      jobs: {
        jobs: [
          {
            name: 'beta-release-gate',
            status: 'completed',
            conclusion: 'success',
            completed_at: '2026-08-03T20:10:00Z',
          },
        ],
      },
      approvals: [
        {
          state: 'approved',
          environments: [{ name: 'beta-release' }],
          user: { login: 'independent-reviewer' },
        },
      ],
    };
    const environmentPolicy = { reviewerLogins: ['independent-reviewer'] };

    expect(
      validateHostedGateEvidence(evidence, manifest, binding, environmentPolicy),
    ).toMatchObject({
      approval: { user: { login: 'independent-reviewer' } },
      job: { name: 'beta-release-gate' },
      run: { id: 42 },
    });

    expect(() =>
      validateHostedGateEvidence(
        {
          ...evidence,
          jobs: { jobs: [{ ...evidence.jobs.jobs[0], conclusion: 'failure' }] },
        },
        manifest,
        binding,
        environmentPolicy,
      ),
    ).toThrow(/lacks the beta-release-gate job/u);
    expect(() =>
      validateHostedGateEvidence(
        {
          ...evidence,
          approvals: [
            {
              ...evidence.approvals[0],
              user: { login: 'release-operator' },
            },
          ],
        },
        manifest,
        binding,
        { reviewerLogins: ['release-operator'] },
      ),
    ).toThrow(/lacks an independent beta-release approval/u);
    expect(() =>
      validateHostedGateEvidence(
        {
          ...evidence,
          runRecord: { ...evidence.runRecord, triggering_actor: undefined },
        },
        manifest,
        binding,
        environmentPolicy,
      ),
    ).toThrow(/lacks its triggering actor identity/u);
  });
});

describe('beta release manifest and assets', () => {
  it('accepts the exact safe manifest with package-promotion evidence', () => {
    const manifest = manifestFixture();
    expect(
      validateBetaManifest(manifest, {
        tag: manifest.tag,
        version: manifest.version,
        sourceCommit: SOURCE_SHA,
        sourceTree: SOURCE_TREE,
      }),
    ).toBe(manifest);
  });

  it('rejects shape drift, incomplete promotion evidence, and runtime authority', () => {
    const extra = { ...manifestFixture(), unexpected: true };
    const missingPromotion = manifestFixture();
    // @ts-expect-error exercise rejection of a malformed external manifest.
    delete missingPromotion.promotion;
    const failedSmoke = manifestFixture();
    failedSmoke.promotion.smoke = 'failed';
    const badReceipt = manifestFixture();
    badReceipt.promotion.receipt_sha256 = 'not-a-digest';
    const runtimeAuthority = manifestFixture();
    runtimeAuthority.runtime_authority = true;
    const stateAuthority = manifestFixture();
    stateAuthority.state_authority = true;

    for (const invalid of [
      extra,
      missingPromotion,
      failedSmoke,
      badReceipt,
      runtimeAuthority,
      stateAuthority,
    ]) {
      expect(() => validateBetaManifest(invalid)).toThrow(/beta release gate:/u);
    }
  });

  it('permits exactly the tarball, checksum, and safe manifest assets', () => {
    const manifest = manifestFixture();
    const assets = [
      { id: 1, state: 'uploaded', name: manifest.artifact.filename },
      {
        id: 2,
        state: 'uploaded',
        name: `${manifest.artifact.filename}.sha256`,
      },
      { id: 3, state: 'uploaded', name: 'beta-release-manifest.v1.json' },
    ];
    expect(validateReleaseAssetRoster(assets, manifest)).toBe(assets);

    for (const invalid of [
      assets.slice(0, 2),
      [...assets, { id: 4, state: 'uploaded', name: 'promotion-result.json' }],
      [assets[0], assets[0], assets[2]],
    ]) {
      expect(() => validateReleaseAssetRoster(invalid, manifest)).toThrow(
        /release assets must be exactly/u,
      );
    }
  });

  it('normalizes the draft-capable gh release view into REST asset identities', () => {
    expect(
      normalizeReleaseView({
        assets: [
          {
            apiUrl: 'https://api.github.com/repos/EchoBrain-org/echo-context/releases/assets/123',
            digest: `sha256:${ARTIFACT_SHA}`,
            name: 'echo-context-0.1.0-beta.7.tgz',
            size: 123_456,
            state: 'uploaded',
          },
        ],
        body: 'reviewed beta notes',
        createdAt: '2026-08-03T21:00:00Z',
        databaseId: 99,
        isDraft: true,
        isImmutable: false,
        isPrerelease: true,
        name: 'ECHO Context 0.1.0-beta.7',
        tagName: 'v0.1.0-beta.7',
        targetCommitish: SOURCE_SHA,
        url: 'https://github.com/EchoBrain-org/echo-context/releases/tag/untagged-99',
      }),
    ).toMatchObject({
      id: 99,
      body: 'reviewed beta notes',
      draft: true,
      immutable: false,
      tag_name: 'v0.1.0-beta.7',
      assets: [{ id: 123, name: 'echo-context-0.1.0-beta.7.tgz' }],
    });
    expect(() =>
      normalizeReleaseView({
        databaseId: 99,
        assets: [{ name: 'missing-api-url' }],
      }),
    ).toThrow(/lacks a REST ID/u);
  });

  it('requires reviewed, version-specific technical-preview notes', () => {
    const notes = betaReleaseNotes(manifestFixture(), BETA7_RELEASE_NOTES);
    expect(notes).toContain('## ECHO Context 0.1.0-beta.7 — technical preview');
    expect(notes).toContain('keeps the beta.6 seven-tool read-only MCP contract');
    expect(notes).toContain('GitHub prerelease tarball, not an npm registry package');
    expect(notes).toContain(`Reviewed source: \`${SOURCE_SHA}\`.`);
    expect(
      createHash('sha256')
        .update(
          betaReleaseNotes(
            {
              ...manifestFixture(),
              source: {
                ...manifestFixture().source,
                commit: 'f4ee8dfb3716587e457070ea1a8909875f0bd9ab',
              },
            },
            BETA7_RELEASE_NOTES,
          ),
        )
        .digest('hex'),
    ).toBe('7ba6f3ff0498f7d2848a4affd8450a8ca64b0a669c287b307d99932db36298a7');
    expect(() =>
      betaReleaseNotes({
        ...manifestFixture(),
        version: '0.1.0-beta.8',
        source: { ...manifestFixture().source, commit: CURRENT_HEAD },
      }),
    ).toThrow(/reviewed release notes are missing/u);
  });

  it('requires canonical bounded release-note fragments', () => {
    expect(validateReleaseNotesFragment(Buffer.from('Reviewed change.\n'), '0.1.0-beta.9')).toBe(
      'Reviewed change.',
    );
    for (const invalid of [
      Buffer.alloc(0),
      Buffer.from('\ufeffReviewed change.\n'),
      Buffer.from('Reviewed change.\r\n'),
      Buffer.from('Reviewed change.'),
      Buffer.from('Reviewed change.\n\n'),
      Buffer.from('Reviewed change. \n'),
      Buffer.from('Reviewed\0change.\n'),
      Buffer.from([0xc3, 0x28, 0x0a]),
      Buffer.concat([Buffer.alloc(65_536, 0x61), Buffer.from('\n')]),
    ]) {
      expect(() => validateReleaseNotesFragment(invalid, '0.1.0-beta.9')).toThrow(
        /reviewed release notes/u,
      );
    }
  });

  it('treats the reviewed release body as immutable release identity', () => {
    const manifest = manifestFixture();
    const notes = betaReleaseNotes(manifest, BETA7_RELEASE_NOTES);
    const release = {
      assets: [
        { id: 1, state: 'uploaded', name: manifest.artifact.filename },
        { id: 2, state: 'uploaded', name: `${manifest.artifact.filename}.sha256` },
        { id: 3, state: 'uploaded', name: 'beta-release-manifest.v1.json' },
      ],
      body: notes,
      draft: true,
      name: 'ECHO Context 0.1.0-beta.7',
      prerelease: true,
      tag_name: 'v0.1.0-beta.7',
      target_commitish: SOURCE_SHA,
    };
    expect(validateReleaseRecord(release, manifest, true, notes)).toBe(release.assets);
    expect(() =>
      validateReleaseRecord(
        { ...release, body: `${release.body}\nchanged` },
        manifest,
        true,
        notes,
      ),
    ).toThrow(/release metadata differs/u);
    expect(() =>
      validateReleaseRecord(
        { ...release, target_commitish: '9'.repeat(40) },
        manifest,
        true,
        notes,
      ),
    ).toThrow(/release metadata differs/u);
  });

  it('validates downloaded release bytes without GitHub or subprocess authority', () => {
    const artifactBytes = Buffer.from('exact artifact bytes');
    const runtimeBody = {
      schemaVersion: 1,
      packageVersion: '0.1.0-beta.7',
      sourceCommit: SOURCE_SHA,
      files: [{ bytes: 1, path: 'dist/cli.js', sha256: 'a'.repeat(64) }],
    };
    const runtimeDigest = createHash('sha256')
      .update(JSON.stringify(runtimeBody))
      .digest('hex');
    const runtimeManifestBytes = Buffer.from(
      JSON.stringify({ ...runtimeBody, digest: runtimeDigest }),
    );
    const manifest = manifestFixture();
    manifest.artifact.bytes = artifactBytes.byteLength;
    manifest.artifact.sha256 = createHash('sha256').update(artifactBytes).digest('hex');
    manifest.artifact.runtime_manifest_digest = runtimeDigest;
    const manifestBytes = canonicalJsonBytes(manifest);
    const notes = betaReleaseNotes(manifest, BETA7_RELEASE_NOTES);
    const release = {
      assets: [
        { id: 1, state: 'uploaded', name: manifest.artifact.filename },
        { id: 2, state: 'uploaded', name: `${manifest.artifact.filename}.sha256` },
        { id: 3, state: 'uploaded', name: 'beta-release-manifest.v1.json' },
      ],
      body: notes,
      draft: true,
      name: 'ECHO Context 0.1.0-beta.7',
      prerelease: true,
      tag_name: 'v0.1.0-beta.7',
      target_commitish: SOURCE_SHA,
    };
    const payload = {
      artifactBytes,
      checksumBytes: Buffer.from(
        `${manifest.artifact.sha256}  ${manifest.artifact.filename}\n`,
      ),
      manifestBytes,
      release,
      runtimeManifestBytes,
    };
    expect(
      validateRemoteReleasePayload(payload, {
        draftRequired: true,
        releaseNotes: notes,
        sourceCommit: SOURCE_SHA,
        sourceTree: SOURCE_TREE,
        tag: manifest.tag,
        version: manifest.version,
      }),
    ).toMatchObject({ manifest });
    expect(() =>
      validateRemoteReleasePayload(
        { ...payload, artifactBytes: Buffer.from('changed') },
        { draftRequired: true, releaseNotes: notes },
      ),
    ).toThrow(/remote artifact differs/u);
  });

  it('revalidates the final draft bytes before the irreversible publish edit', () => {
    const source = readFileSync(join(ROOT, 'tools', 'beta-release-gate.mjs'), 'utf8');
    const publishStart = source.indexOf('function publishBeta(');
    const draftStart = source.indexOf('if (release.draft) {', publishStart);
    const publishEnd = source.indexOf('const published = releaseForTag', draftStart);
    const block = source.slice(draftStart, publishEnd);
    const refetch = block.indexOf('const finalDraft = releaseForTag');
    const revalidate = block.indexOf('validateRemoteReleaseAssets(finalDraft');
    const intent = block.indexOf('assertPublishIntent(local, binding, true)');
    const edit = block.indexOf("gh(['release', 'edit'");
    expect([publishStart, draftStart, publishEnd, refetch, revalidate, intent, edit]).not.toContain(
      -1,
    );
    expect(refetch).toBeLessThan(revalidate);
    expect(revalidate).toBeLessThan(intent);
    expect(intent).toBeLessThan(edit);
  });

  it('binds a draft handoff to one exact returned workflow run', () => {
    expect(
      parseWorkflowRunId(
        'Created workflow dispatch\nhttps://github.com/EchoBrain-org/echo-context/actions/runs/123456\n',
      ),
    ).toBe(123_456);
    expect(() => parseWorkflowRunId('dispatch accepted without a URL')).toThrow(
      /did not return one run URL/u,
    );
    expect(() =>
      parseWorkflowRunId(
        'https://github.com/x/y/actions/runs/1\nhttps://github.com/x/y/actions/runs/2',
      ),
    ).toThrow(/did not return one run URL/u);
  });

  it('records a stable pre-publication authorization for crash-safe recovery', () => {
    expect(
      buildPublishIntent({
        artifactSha256: ARTIFACT_SHA,
        gateRunId: 123_456,
        manifestSha256: '7'.repeat(64),
        releaseId: 99,
        sourceCommit: SOURCE_SHA,
        tag: 'v0.1.0-beta.7',
      }),
    ).toEqual({
      artifact_sha256: ARTIFACT_SHA,
      gate_run_id: 123_456,
      manifest_sha256: '7'.repeat(64),
      release_id: 99,
      schema: 'beta-publish-intent.v1',
      source_commit: SOURCE_SHA,
      status: 'authorized',
      tag: 'v0.1.0-beta.7',
    });
  });
});

describe('local build-once stage plan', () => {
  it('finishes read-only release preflight before CI, durable staging, or tag mutation', () => {
    const source = readFileSync(join(ROOT, 'tools', 'beta-release-gate.mjs'), 'utf8');
    const stageStart = source.indexOf('function stageBeta()');
    const stageEnd = source.indexOf('function parseArgs(', stageStart);
    const stage = source.slice(stageStart, stageEnd);
    const firstPreflight = stage.indexOf('stagePreflight(beta, sourceSha)');
    const ci = stage.indexOf('run(plan[0].executable');
    const secondPreflight = stage.indexOf('stagePreflight(beta, sourceSha)', firstPreflight + 1);
    const durableRoot = stage.indexOf('mkdirSync(releaseRoot');

    expect([stageStart, stageEnd, firstPreflight, ci, secondPreflight, durableRoot]).not.toContain(
      -1,
    );
    expect(firstPreflight).toBeLessThan(ci);
    expect(ci).toBeLessThan(secondPreflight);
    expect(secondPreflight).toBeLessThan(durableRoot);

    const draftStart = source.indexOf('function draftBeta(');
    const draftEnd = source.indexOf('function assertImmutableReleases(', draftStart);
    const draft = source.slice(draftStart, draftEnd);
    const notes = draft.indexOf('const notes = betaReleaseNotes(local.manifest)');
    const inspectTag = draft.indexOf('inspectExactTag(');
    const validateExisting = draft.indexOf('validateRemoteReleaseAssets(existingRelease');
    const ensureTag = draft.indexOf('ensureExactTag(');
    const createDraft = draft.indexOf('createOrValidateDraft(local, notes, existingRelease)');
    expect([
      draftStart,
      draftEnd,
      notes,
      inspectTag,
      validateExisting,
      ensureTag,
      createDraft,
    ]).not.toContain(-1);
    expect(notes).toBeLessThan(inspectTag);
    expect(inspectTag).toBeLessThan(validateExisting);
    expect(validateExisting).toBeLessThan(ensureTag);
    expect(ensureTag).toBeLessThan(createDraft);

    const createStart = source.indexOf('function createOrValidateDraft(');
    const createEnd = source.indexOf('function remoteAssetBytes(', createStart);
    expect(source.slice(createStart, createEnd)).not.toContain('betaReleaseNotes(');
  });

  it('runs CI, pack, and smoke exactly once against one durable artifact identity', () => {
    const artifact = '/durable/beta 7/echo-context-0.1.0-beta.7.tgz';
    const prefix = '/durable/beta 7/prefix';
    const plan = buildStageCommandPlan({ artifact, prefix });

    expect(plan).toEqual([
      { executable: 'npm', argv: ['run', 'ci'] },
      {
        executable: 'npm',
        argv: ['pack', '--pack-destination', '/durable/beta 7'],
      },
      {
        executable: 'npm',
        argv: ['run', '--silent', 'smoke:package', '--', artifact, '--prefix', prefix],
      },
    ]);

    const commands = plan.map(
      (command: { executable: string; argv: string[] }) =>
        `${command.executable} ${command.argv.join(' ')}`,
    );
    expect(commands.filter((command: string) => command === 'npm run ci')).toHaveLength(1);
    expect(commands.filter((command: string) => command.startsWith('npm pack '))).toHaveLength(1);
    expect(commands.filter((command: string) => command.includes('smoke:package'))).toHaveLength(1);
    expect(commands.join('\n')).not.toMatch(/\b(?:publish|tag|migrate|cutover|rollback)\b/u);
    expect(plan[2]?.argv).toContain(artifact);
    expect(plan[2]?.argv).toContain(prefix);
  });
});
