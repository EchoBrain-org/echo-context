import { createHash } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// @ts-expect-error the committed canonical JSON helper is intentionally plain .mjs.
import { canonicalJsonText } from '../../tools/canonical-json.mjs';

// @ts-expect-error the committed beta status operator is intentionally plain .mjs.
import * as betaStatus from '../../tools/beta-release-status.mjs';

const {
  assembleBetaReleaseStatus,
  classifyReleaseLookup,
  deriveBetaReleaseState,
  exactHostedRunIdentity,
  formatBetaReleaseStatus,
  isReadOnlyCommand,
  parseStatusArgs,
  scanStages,
  selectBetaCandidate,
  validateDraftBinding,
} = betaStatus;

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SOURCE_SHA = '1'.repeat(40);
const MAIN_SHA = '2'.repeat(40);
const ARTIFACT_DIGEST = '3'.repeat(64);
const TARBALL_SHA = '5'.repeat(64);
const MANIFEST_SHA = '6'.repeat(64);
const RELEASE_ROOT = '/release/beta.9';
const GATE_COMPLETED_AT = '2026-08-08T12:00:00.000Z';
const PUBLISHED_AT = '2026-08-08T12:01:00.000Z';

function exactReviewEvidence() {
  return {
    github_verify: {
      app_id: 15_368,
      completed_at: '2026-08-08T10:00:00Z',
      conclusion: 'success',
      head_sha: SOURCE_SHA,
      name: 'verify',
      url: 'https://github.com/check/99',
    },
    independent_review: {
      author: 'builder',
      commit_id: SOURCE_SHA,
      pull_request: 99,
      reviewer: 'independent-reviewer',
      submitted_at: '2026-08-08T09:00:00Z',
      url: 'https://github.com/review/99',
    },
  };
}

function statusFixture() {
  return {
    candidate: {
      draft: { state: 'absent' },
      gate: { state: 'not_started' },
      publication: { state: 'absent' },
      release_identity: { state: 'absent' },
      release_notes: { state: 'present' },
      release_policy: { state: 'verified' },
      runtime_digest: ARTIFACT_DIGEST,
      source_commit: SOURCE_SHA,
      source_on_main: true,
      source_review: { state: 'verified' },
      stage: { state: 'absent' },
      tarball_sha256: TARBALL_SHA,
      tag: {
        local_target: null,
        name: 'v0.1.0-beta.9',
        remote: { state: 'observed', target: null },
      },
      tag_mismatch: false,
      version: '0.1.0-beta.9',
    },
    checkout: {
      branch: 'agent/beta-9',
      clean: true,
      head: SOURCE_SHA,
      version: '0.1.0-beta.9',
    },
    latest_public_beta: {
      state: 'published',
      version: '0.1.0-beta.7',
    },
    live: {
      endpoint: 'http://127.0.0.1:39478/healthz',
      runtime_digest: '4'.repeat(64),
      state: 'healthy',
      version: '0.1.0-beta.6',
    },
    main: {
      local: MAIN_SHA,
      remote: { commit: MAIN_SHA, state: 'observed' },
    },
    schema: 'beta-release-status.v2',
    unknowns: [],
  };
}

function derive(overrides: Record<string, unknown> = {}) {
  const base = statusFixture();
  const snapshot = {
    ...base,
    ...overrides,
    candidate: {
      ...base.candidate,
      ...((overrides.candidate as Record<string, unknown> | undefined) ?? {}),
    },
  };
  return deriveBetaReleaseState(snapshot);
}

function stagedRecord() {
  return {
    manifest: { evidence: exactReviewEvidence(), tag: 'v0.1.0-beta.9' },
    manifest_sha256: MANIFEST_SHA,
    release_root: RELEASE_ROOT,
    runtime_digest: ARTIFACT_DIGEST,
    source_commit: SOURCE_SHA,
    state: 'recorded_passed',
    tarball_sha256: TARBALL_SHA,
  };
}

function assemblyFixture(overrides: Record<string, unknown> = {}) {
  const base = {
    beta: { tag: 'v0.1.0-beta.9', version: '0.1.0-beta.9' },
    checkout: statusFixture().checkout,
    draftBinding: { state: 'absent' },
    gate: { state: 'not_started' },
    latestPublicBeta: statusFixture().latest_public_beta,
    live: statusFixture().live,
    localMain: { state: 'observed', value: MAIN_SHA },
    localTag: { state: 'observed', target: null },
    publishRecords: { intent: 'absent', state: 'absent' },
    refs: { main: MAIN_SHA, state: 'observed', tag: null },
    release: null,
    releaseIdentity: { state: 'absent' },
    releaseNotes: { state: 'present' },
    releasePolicy: { state: 'verified' },
    sourceOnMain: true,
    sourceReviewObservation: {
      approval: 'independent-reviewer',
      evidence: exactReviewEvidence(),
      pull_request: 99,
      source_commit: SOURCE_SHA,
      state: 'verified',
      verify_url: 'https://github.com/check/99',
    },
    stageRecords: [stagedRecord()],
    unknowns: [],
  };
  return assembleBetaReleaseStatus({ ...base, ...overrides });
}

function observedDraft() {
  return {
    html_url: 'https://github.com/EchoBrain-org/echo-context/releases/tag/v0.1.0-beta.9',
    draft: true,
    target_commitish: SOURCE_SHA,
  };
}

function observedPublication() {
  return {
    ...observedDraft(),
    draft: false,
    immutable: true,
    published_at: PUBLISHED_AT,
  };
}

describe('read-only beta release status', () => {
  it('assembles a staged candidate into the exact draft handoff', () => {
    expect(assemblyFixture()).toMatchObject({
      candidate: {
        source_commit: SOURCE_SHA,
        source_on_main: true,
        source_review: { pull_request: 99, state: 'verified' },
        stage: { release_root: RELEASE_ROOT, state: 'recorded_passed' },
      },
      next_action: {
        command: ['npm', 'run', 'beta:draft', '--', '--release-root', RELEASE_ROOT],
        id: 'draft_exact_stage',
      },
      overall: 'ready_to_draft',
    });
  });

  it('assembles a validated draft that is still waiting for its hosted gate', () => {
    expect(
      assemblyFixture({
        draftBinding: { state: 'observed', value: { gate_run_id: 7 } },
        gate: { run_id: 7, state: 'pending' },
        refs: { main: MAIN_SHA, state: 'observed', tag: SOURCE_SHA },
        release: observedDraft(),
        releaseIdentity: { state: 'validated' },
      }),
    ).toMatchObject({
      candidate: { draft: { state: 'validated' }, gate: { state: 'pending' } },
      next_action: { id: 'approve_or_wait' },
      overall: 'waiting_for_gate',
    });
  });

  it('assembles an independently approved draft into the exact publish handoff', () => {
    expect(
      assemblyFixture({
        draftBinding: { state: 'observed', value: { gate_run_id: 7 } },
        gate: {
          completed_at: GATE_COMPLETED_AT,
          run_id: 7,
          state: 'verified_succeeded',
        },
        refs: { main: MAIN_SHA, state: 'observed', tag: SOURCE_SHA },
        release: observedDraft(),
        releaseIdentity: { state: 'validated' },
      }),
    ).toMatchObject({
      candidate: { draft: { state: 'validated' }, gate: { state: 'verified_succeeded' } },
      next_action: {
        command: [
          'npm',
          'run',
          'beta:publish',
          '--',
          '--release-root',
          RELEASE_ROOT,
          '--confirm-source-sha',
          SOURCE_SHA,
          '--confirm-artifact-sha',
          TARBALL_SHA,
        ],
        id: 'publish_exact_draft',
      },
      overall: 'ready_to_publish',
    });
  });

  it('blocks a draft when its remote tag disappears', () => {
    expect(
      assemblyFixture({
        draftBinding: { state: 'observed', value: { gate_run_id: 7 } },
        gate: {
          completed_at: GATE_COMPLETED_AT,
          run_id: 7,
          state: 'verified_succeeded',
        },
        release: observedDraft(),
        releaseIdentity: { state: 'validated' },
      }),
    ).toMatchObject({
      next_action: { id: 'inspect_identity_conflict' },
      overall: 'blocked',
    });
  });

  it('binds staged readiness to the exact review and check frozen in its manifest', () => {
    const changedEvidence = exactReviewEvidence();
    changedEvidence.independent_review.reviewer = 'different-reviewer';
    expect(
      assemblyFixture({
        sourceReviewObservation: {
          approval: 'different-reviewer',
          evidence: changedEvidence,
          pull_request: 99,
          source_commit: SOURCE_SHA,
          state: 'verified',
          verify_url: 'https://github.com/check/99',
        },
      }),
    ).toMatchObject({
      candidate: { source_review: { state: 'missing' } },
      next_action: { id: 'merge_reviewed_source' },
      overall: 'blocked',
    });
  });

  it('assembles an interrupted publication into the exact recovery handoff', () => {
    expect(
      assemblyFixture({
        draftBinding: { state: 'observed', value: { gate_run_id: 7 } },
        gate: {
          completed_at: GATE_COMPLETED_AT,
          run_id: 7,
          state: 'verified_succeeded',
        },
        publishRecords: { intent: 'recorded', state: 'absent' },
        refs: { main: MAIN_SHA, state: 'observed', tag: SOURCE_SHA },
        release: observedPublication(),
        releaseIdentity: { state: 'validated' },
      }),
    ).toMatchObject({
      candidate: { publication: { intent: 'recorded', state: 'partial' } },
      next_action: {
        command: [
          'npm',
          'run',
          'beta:publish',
          '--',
          '--release-root',
          RELEASE_ROOT,
          '--confirm-source-sha',
          SOURCE_SHA,
          '--confirm-artifact-sha',
          TARBALL_SHA,
        ],
        id: 'finish_exact_publication',
      },
      overall: 'ready_to_publish',
    });
  });

  it('assembles a validated publication without confusing it for founder-live', () => {
    expect(
      assemblyFixture({
        draftBinding: { state: 'observed', value: { gate_run_id: 7 } },
        gate: {
          completed_at: GATE_COMPLETED_AT,
          run_id: 7,
          state: 'verified_succeeded',
        },
        publishRecords: { intent: 'recorded', state: 'recorded' },
        refs: { main: MAIN_SHA, state: 'observed', tag: SOURCE_SHA },
        release: observedPublication(),
        releaseIdentity: { state: 'validated' },
      }),
    ).toMatchObject({
      candidate: { publication: { state: 'validated' } },
      next_action: { id: 'promote_founder_live' },
      overall: 'published_not_live',
    });
  });

  it('assembles a complete state only when the live digest matches the published artifact', () => {
    expect(
      assemblyFixture({
        draftBinding: { state: 'observed', value: { gate_run_id: 7 } },
        gate: {
          completed_at: GATE_COMPLETED_AT,
          run_id: 7,
          state: 'verified_succeeded',
        },
        live: { ...statusFixture().live, runtime_digest: ARTIFACT_DIGEST },
        publishRecords: { intent: 'recorded', state: 'recorded' },
        refs: { main: MAIN_SHA, state: 'observed', tag: SOURCE_SHA },
        release: observedPublication(),
        releaseIdentity: { state: 'validated' },
      }),
    ).toMatchObject({
      candidate: { publication: { state: 'validated' } },
      next_action: { id: 'none' },
      overall: 'complete',
    });
  });

  it('selects the reviewed PR head instead of treating a related merge commit as reviewed', () => {
    expect(
      selectBetaCandidate({
        checkout: { ...statusFixture().checkout, head: MAIN_SHA },
        localTag: { state: 'observed', target: null },
        refs: { main: MAIN_SHA, state: 'observed', tag: null },
        sourceReviewObservation: {
          source_commit: SOURCE_SHA,
          state: 'verified',
        },
        stageRecords: [],
      }),
    ).toMatchObject({
      sourceCommit: SOURCE_SHA,
      sourceReview: { source_commit: SOURCE_SHA, state: 'verified' },
    });
  });

  it('maps each safe operator boundary to one next action', () => {
    expect(derive()).toMatchObject({
      overall: 'ready_to_stage',
      next_action: { command: ['npm', 'run', 'beta:stage'], id: 'stage_candidate' },
    });
    expect(
      derive({
        candidate: { stage: { release_root: '/release/beta.9', state: 'recorded_passed' } },
      }),
    ).toMatchObject({
      overall: 'ready_to_draft',
      next_action: {
        command: ['npm', 'run', 'beta:draft', '--', '--release-root', '/release/beta.9'],
        id: 'draft_exact_stage',
      },
    });
    expect(
      derive({ candidate: { draft: { state: 'validated' }, gate: { state: 'pending' } } }),
    ).toMatchObject({ overall: 'waiting_for_gate', next_action: { id: 'approve_or_wait' } });
    expect(
      derive({
        candidate: {
          draft: { state: 'validated' },
          gate: { state: 'verified_succeeded' },
          stage: { release_root: '/release/beta.9', state: 'recorded_passed' },
        },
      }),
    ).toMatchObject({ overall: 'ready_to_publish', next_action: { id: 'publish_exact_draft' } });
    expect(
      derive({ candidate: { publication: { state: 'validated' } } }),
    ).toMatchObject({ overall: 'published_not_live', next_action: { id: 'promote_founder_live' } });
    expect(
      derive({
        candidate: { publication: { state: 'validated' } },
        live: { ...statusFixture().live, runtime_digest: ARTIFACT_DIGEST },
      }),
    ).toMatchObject({ overall: 'complete', next_action: { id: 'none' } });
  });

  it('requires a clean checkout at the exact candidate for every mutating handoff', () => {
    const transitions = [
      {},
      { stage: { release_root: '/release/beta.9', state: 'recorded_passed' } },
      {
        draft: { state: 'validated' },
        gate: { state: 'verified_succeeded' },
        stage: { release_root: '/release/beta.9', state: 'recorded_passed' },
      },
    ];
    for (const candidate of transitions) {
      expect(
        derive({
          candidate,
          checkout: { ...statusFixture().checkout, clean: false },
        }),
      ).toMatchObject({ overall: 'blocked', next_action: { command: null, id: 'clean_checkout' } });
      expect(
        derive({
          candidate,
          checkout: { ...statusFixture().checkout, head: MAIN_SHA },
        }),
      ).toMatchObject({
        overall: 'blocked',
        next_action: {
          command: ['git', 'switch', '--detach', SOURCE_SHA],
          id: 'checkout_exact_source',
        },
      });
    }
  });

  it('does not promote a merely observed or partially bound publication', () => {
    expect(
      derive({
        candidate: { publication: { state: 'partial' } },
        live: { ...statusFixture().live, runtime_digest: ARTIFACT_DIGEST },
      }),
    ).toMatchObject({ overall: 'blocked', next_action: { id: 'inspect_published_handoff' } });
    expect(
      derive({ candidate: { release_identity: { state: 'invalid' } } }),
    ).toMatchObject({ overall: 'blocked', next_action: { id: 'inspect_identity_conflict' } });
  });

  it('requires current main ancestry and exact review before every prospective mutation', () => {
    for (const candidate of [
      { stage: { release_root: RELEASE_ROOT, state: 'recorded_passed' } },
      {
        draft: { state: 'validated' },
        gate: { state: 'pending' },
        stage: { release_root: RELEASE_ROOT, state: 'recorded_passed' },
      },
      {
        draft: { state: 'validated' },
        gate: { state: 'verified_succeeded' },
        stage: { release_root: RELEASE_ROOT, state: 'recorded_passed' },
      },
    ]) {
      expect(
        derive({
          candidate: {
            ...candidate,
            source_on_main: false,
            source_review: { state: 'missing' },
          },
        }),
      ).toMatchObject({
        next_action: { id: 'merge_reviewed_source' },
        overall: 'blocked',
      });
    }
  });

  it('fails closed for the current beta.8 partial-release shape', () => {
    expect(
      derive({
        candidate: {
          release_notes: { state: 'missing' },
          stage: { state: 'recorded_passed' },
          tag: {
            local_target: SOURCE_SHA,
            name: 'v0.1.0-beta.8',
            remote: { state: 'observed', target: SOURCE_SHA },
          },
          version: '0.1.0-beta.8',
        },
      }),
    ).toMatchObject({ overall: 'blocked', next_action: { id: 'prepare_next_beta' } });
  });

  it('never turns missing visibility or conflicting identity into permission to mutate', () => {
    expect(derive({ unknowns: ['GitHub refs unavailable'] })).toMatchObject({
      overall: 'unknown',
      next_action: { id: 'restore_visibility' },
    });
    expect(derive({ candidate: { tag_mismatch: true } })).toMatchObject({
      overall: 'blocked',
      next_action: { id: 'inspect_identity_conflict' },
    });
    expect(derive({ candidate: { stage: { state: 'failed' } } })).toMatchObject({
      overall: 'blocked',
      next_action: { id: 'inspect_stage_evidence' },
    });
  });

  it('renders the four version clocks and accepts only the explicit JSON flag', () => {
    const base = statusFixture();
    const derived = deriveBetaReleaseState(base);
    const output = formatBetaReleaseStatus({ ...base, ...derived });
    expect(output).toContain('Beta status — 0.1.0-beta.9');
    expect(output).toContain('latest public beta is 0.1.0-beta.7');
    expect(output).toContain('healthy 0.1.0-beta.6');
    expect(output).toContain('READY_TO_STAGE');
    expect(output).toContain('v0.1.0-beta.9 absent');
    expect(output).toContain('Command     npm run beta:stage');
    expect(parseStatusArgs([])).toEqual({ json: false });
    expect(parseStatusArgs(['--json'])).toEqual({ json: true });
    expect(() => parseStatusArgs(['--delete'])).toThrow(/usage/u);
  });

  it('enforces a subprocess allowlist instead of relying on a short denylist', () => {
    expect(isReadOnlyCommand('git', ['status', '--porcelain=v1', '--untracked-files=all'])).toBe(
      true,
    );
    expect(
      isReadOnlyCommand('gh', [
        'api',
        '--hostname',
        'github.com',
        '--method',
        'GET',
        'repos/EchoBrain-org/echo-context',
      ]),
    ).toBe(true);
    expect(
      isReadOnlyCommand('/usr/bin/tar', [
        '-xOzf',
        join(tmpdir(), 'echo-context-beta-observe-fixture', 'artifact.tgz'),
        'package/dist/artifact-manifest.json',
      ]),
    ).toBe(true);
    for (const [executable, argv] of [
      ['git', ['fetch', 'origin']],
      ['git', ['branch', '-D', 'main']],
      ['git', ['show-ref', '--delete', 'refs/tags/v0.1.0-beta.9']],
      ['git', ['update-ref', '-d', 'refs/heads/main']],
      ['git', ['reset', '--hard']],
      ['git', ['clean', '-fdx']],
      ['gh', ['release', 'delete', 'v0.1.0-beta.9']],
      ['gh', ['repo', 'edit', '--visibility', 'private']],
      ['gh', ['api', '--method', 'DELETE', 'repos/EchoBrain-org/echo-context/releases/1']],
      ['/usr/bin/tar', ['-czf', '/tmp/release.tgz', '/release']],
      [
        '/usr/bin/tar',
        [
          '-xOzf',
          join(tmpdir(), 'echo-context-beta-observe-fixture', 'artifact.tgz'),
          'package/dist/index.js',
        ],
      ],
      [
        'gh',
        [
          'api',
          '--method',
          'GET',
          '--method',
          'DELETE',
          'repos/EchoBrain-org/echo-context/releases/1',
        ],
      ],
    ] as const) {
      expect(isReadOnlyCommand(executable, [...argv]), `${executable} ${argv.join(' ')}`).toBe(false);
    }

    const source = readFileSync(join(ROOT, 'tools', 'beta-release-status.mjs'), 'utf8');
    expect(source).toContain('isReadOnlyCommand(executable, argv)');
    expect(source).toContain('const MAX_RELEASE_ROOTS = 128');
    expect(source).toContain('AbortSignal.timeout(2_000)');
    expect(source).not.toContain("from './beta-release-gate.mjs'");
    expect(source).not.toContain('await import(pathToFileURL(modulePath).href)');
  });

  it('does not call a GitHub 404 absent without draft visibility', () => {
    const notFound = { state: 'not_found' };
    expect(
      classifyReleaseLookup(notFound, {
        state: 'observed',
        value: { permissions: { pull: true, push: false } },
      }),
    ).toMatchObject({ state: 'unknown' });
    expect(
      classifyReleaseLookup(notFound, {
        state: 'observed',
        value: { permissions: { push: true } },
      }),
    ).toEqual({ state: 'absent' });
  });

  it('surfaces durable release roots that have no readable stage state', () => {
    const releases = mkdtempSync(join(tmpdir(), 'echo-beta-status-'));
    try {
      mkdirSync(join(releases, `0.1.0-beta.9-${SOURCE_SHA}`));
      expect(scanStages('0.1.0-beta.9', releases)).toMatchObject({ state: 'unknown' });

      rmSync(join(releases, `0.1.0-beta.9-${SOURCE_SHA}`), { recursive: true });
      writeFileSync(join(releases, `0.1.0-beta.9-${SOURCE_SHA}`), 'partial');
      expect(scanStages('0.1.0-beta.9', releases)).toMatchObject({ state: 'unknown' });
    } finally {
      rmSync(releases, { force: true, recursive: true });
    }
  });

  it('does not call a stage passed when its installed promotion evidence is missing', () => {
    const releases = realpathSync(mkdtempSync(join(tmpdir(), 'echo-beta-status-promotion-')));
    const root = join(releases, `0.1.0-beta.9-${SOURCE_SHA}`);
    try {
      mkdirSync(root);
      const artifactBytes = Buffer.from('staged artifact');
      const artifactSha = createHash('sha256').update(artifactBytes).digest('hex');
      const artifact = join(root, 'echo-context-0.1.0-beta.9.tgz');
      const manifest = {
        artifact: {
          bytes: artifactBytes.byteLength,
          filename: 'echo-context-0.1.0-beta.9.tgz',
          runtime_manifest_digest: ARTIFACT_DIGEST,
          sha256: artifactSha,
        },
        channel: 'beta',
        evidence: {
          github_verify: {
            app_id: 15_368,
            completed_at: '2026-08-08T10:00:00Z',
            conclusion: 'success',
            head_sha: SOURCE_SHA,
            name: 'verify',
            url: 'https://github.com/check/1',
          },
          independent_review: {
            author: 'builder',
            commit_id: SOURCE_SHA,
            pull_request: 99,
            reviewer: 'reviewer',
            submitted_at: '2026-08-08T09:00:00Z',
            url: 'https://github.com/review/1',
          },
          local_ci: { command: 'npm run ci', source_commit: SOURCE_SHA },
        },
        promotion: {
          installed_tree_digest: '7'.repeat(64),
          receipt_sha256: '8'.repeat(64),
          smoke: 'passed',
        },
        release_policy: {
          draft_required: true,
          immutable_required_before_publish: true,
          prerelease_required: true,
        },
        repository: 'EchoBrain-org/echo-context',
        runtime_authority: false,
        schema: 'beta-release-manifest.v1',
        source: { commit: SOURCE_SHA, tree: '9'.repeat(40) },
        state_authority: false,
        tag: 'v0.1.0-beta.9',
        toolchain: { node: '22.22.1', npm: '10.9.4' },
        version: '0.1.0-beta.9',
      };
      const manifestPath = join(root, 'beta-release-manifest.v1.json');
      const manifestBytes = Buffer.from(canonicalJsonText(manifest));
      writeFileSync(artifact, artifactBytes);
      writeFileSync(`${artifact}.sha256`, `${artifactSha}  echo-context-0.1.0-beta.9.tgz\n`);
      writeFileSync(manifestPath, manifestBytes);
      writeFileSync(
        join(root, 'beta-stage-state.json'),
        canonicalJsonText({
          source_commit: SOURCE_SHA,
          status: 'passed',
          tag: 'v0.1.0-beta.9',
          version: '0.1.0-beta.9',
        }),
      );
      writeFileSync(
        join(root, 'beta-stage-result.json'),
        canonicalJsonText({
          artifact,
          artifact_sha256: artifactSha,
          checksum: `${artifact}.sha256`,
          installed_prefix: join(root, 'prefix'),
          manifest: manifestPath,
          manifest_sha256: createHash('sha256').update(manifestBytes).digest('hex'),
          promotion_receipt: join(
            root,
            'prefix',
            'share',
            'echo-context',
            'promotion-receipt.json',
          ),
          promotion_receipt_sha256: '8'.repeat(64),
          release_root: root,
          source_commit: SOURCE_SHA,
          status: 'passed',
          tag: 'v0.1.0-beta.9',
          version: '0.1.0-beta.9',
        }),
      );
      expect(scanStages('0.1.0-beta.9', releases)).toMatchObject({
        error: expect.stringContaining('promotion-result.json'),
        state: 'unknown',
      });
    } finally {
      rmSync(releases, { force: true, recursive: true });
    }
  });

  it('binds local draft and hosted-run observations to one exact stage', () => {
    const release = { id: 42 };
    const stage = {
      draft: {
        artifact_sha256: TARBALL_SHA,
        gate_run_id: 7,
        manifest_sha256: '6'.repeat(64),
        release_id: 42,
        release_root: '/release/beta.9',
        release_url: 'https://github.com/release/42',
        source_commit: SOURCE_SHA,
        status: 'drafted',
        tag: 'v0.1.0-beta.9',
      },
      manifest: { tag: 'v0.1.0-beta.9' },
      manifest_sha256: '6'.repeat(64),
      release_root: '/release/beta.9',
      source_commit: SOURCE_SHA,
      tarball_sha256: TARBALL_SHA,
    };
    expect(validateDraftBinding(stage, release)).toMatchObject({ state: 'observed' });
    expect(
      validateDraftBinding(
        { ...stage, draft: { ...stage.draft, release_id: 99 } },
        release,
      ),
    ).toMatchObject({ state: 'unknown' });
    expect(
      exactHostedRunIdentity(
        {
          event: 'workflow_dispatch',
          head_sha: SOURCE_SHA,
          id: 7,
          path: '.github/workflows/beta-release-gate.yml@v0.1.0-beta.9',
          run_attempt: 1,
        },
        stage,
        stage.draft,
      ),
    ).toBe(true);
    expect(
      exactHostedRunIdentity(
        {
          event: 'workflow_dispatch',
          head_sha: MAIN_SHA,
          id: 7,
          path: '.github/workflows/beta-release-gate.yml@v0.1.0-beta.9',
          run_attempt: 1,
        },
        stage,
        stage.draft,
      ),
    ).toBe(false);
  });
});
