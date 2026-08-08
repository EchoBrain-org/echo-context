import { parseCanonicalJsonBytes, sha256 } from './canonical-json.mjs';

const BETA_VERSION = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)-beta\.(0|[1-9][0-9]*)$/u;
const MAX_RELEASE_NOTES_BYTES = 64 * 1024;

export const BETA_ENVIRONMENT = 'beta-release';
export const BETA_WORKFLOW = 'beta-release-gate.yml';
export const EXPECTED_NODE = 'v22.22.1';
export const EXPECTED_NPM = '10.9.4';
export const REPOSITORY = 'EchoBrain-org/echo-context';
export const SHA_40 = /^[0-9a-f]{40}$/u;
export const SHA_64 = /^[0-9a-f]{64}$/u;
export const VERIFY_APP_ID = 15368;
export const VERIFY_CHECK = 'verify';

function fail(message) {
  throw new Error(`beta release gate: ${message}`);
}

function assertExactKeys(value, keys, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail(`${label} must be an object`);
  }
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    fail(`${label} keys must be exactly ${expected.join(', ')}`);
  }
}

function assertString(value, pattern, label) {
  if (typeof value !== 'string' || (pattern && !pattern.test(value))) {
    fail(`${label} is invalid`);
  }
}

function assertBoolean(value, expected, label) {
  if (value !== expected) fail(`${label} must be ${expected}`);
}

function reviewTime(review) {
  const parsed = Date.parse(review.submitted_at ?? '');
  return Number.isFinite(parsed) ? parsed : 0;
}

export function parseBetaVersion(input) {
  if (typeof input !== 'string') fail('beta version must be a string');
  const version = input.startsWith('v') ? input.slice(1) : input;
  const match = version.match(BETA_VERSION);
  if (!match) fail(`invalid beta version: ${input}`);
  const parsed = {
    beta: Number(match[4]),
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    tag: `v${version}`,
    version,
  };
  return { ...parsed, core: `${parsed.major}.${parsed.minor}.${parsed.patch}` };
}

export function tryParseBetaVersion(input) {
  try {
    return parseBetaVersion(input);
  } catch {
    return null;
  }
}

export function compareBetaVersions(leftInput, rightInput) {
  const left = parseBetaVersion(leftInput);
  const right = parseBetaVersion(rightInput);
  for (const key of ['major', 'minor', 'patch', 'beta']) {
    if (left[key] !== right[key]) return left[key] < right[key] ? -1 : 1;
  }
  return 0;
}

export function validateReleaseNotesFragment(input, version) {
  const bytes = Buffer.isBuffer(input) ? input : Buffer.from(input ?? []);
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_RELEASE_NOTES_BYTES) {
    fail(`reviewed release notes for ${version} must contain 1-${MAX_RELEASE_NOTES_BYTES} bytes`);
  }
  if (bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))) {
    fail(`reviewed release notes for ${version} must not contain a UTF-8 BOM`);
  }
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    fail(`reviewed release notes for ${version} must be valid UTF-8`);
  }
  if (text.includes('\r')) fail(`reviewed release notes for ${version} must use LF line endings`);
  if (text.includes('\0')) fail(`reviewed release notes for ${version} must not contain NUL bytes`);
  if (!text.endsWith('\n') || text.endsWith('\n\n')) {
    fail(`reviewed release notes for ${version} must end with exactly one newline`);
  }
  const body = text.slice(0, -1);
  if (body.trim() === '') fail(`reviewed release notes for ${version} must not be empty`);
  if (body.split('\n').some((line) => /[\t ]$/u.test(line))) {
    fail(`reviewed release notes for ${version} must not contain trailing whitespace`);
  }
  return body;
}

export function renderBetaReleaseNotes(manifest, changes) {
  if (!SHA_40.test(manifest?.source?.commit ?? '')) fail('release-notes source commit is invalid');
  return [
    `## ECHO Context ${manifest.version} — technical preview`,
    '',
    changes,
    '',
    `Reviewed source: \`${manifest.source.commit}\`.`,
    'The attached tarball is the exact locally smoke-tested artifact described by `beta-release-manifest.v1.json`. Publication requires the independent beta environment approval and the hosted validation gate.',
  ].join('\n');
}

export function validateBetaManifest(manifest, expected = {}) {
  assertExactKeys(
    manifest,
    [
      'artifact',
      'channel',
      'evidence',
      'promotion',
      'release_policy',
      'repository',
      'runtime_authority',
      'schema',
      'source',
      'state_authority',
      'tag',
      'toolchain',
      'version',
    ],
    'beta manifest',
  );
  if (manifest.schema !== 'beta-release-manifest.v1') fail('beta manifest schema is invalid');
  if (manifest.repository !== REPOSITORY) fail('beta manifest repository is invalid');
  if (manifest.channel !== 'beta') fail('beta manifest channel is invalid');
  const parsed = parseBetaVersion(manifest.version);
  if (manifest.tag !== parsed.tag) fail('beta manifest tag/version mismatch');
  if (expected.tag && manifest.tag !== expected.tag) {
    fail('beta manifest tag differs from requested tag');
  }
  if (expected.version && manifest.version !== expected.version) {
    fail('beta manifest version differs from the package version');
  }

  assertExactKeys(manifest.source, ['commit', 'tree'], 'beta manifest source');
  assertString(manifest.source.commit, SHA_40, 'beta manifest source commit');
  assertString(manifest.source.tree, SHA_40, 'beta manifest source tree');
  if (expected.sourceCommit && manifest.source.commit !== expected.sourceCommit) {
    fail('beta manifest source commit differs from the tag target');
  }
  if (expected.sourceTree && manifest.source.tree !== expected.sourceTree) {
    fail('beta manifest source tree differs from the tag tree');
  }

  assertExactKeys(
    manifest.artifact,
    ['bytes', 'filename', 'runtime_manifest_digest', 'sha256'],
    'beta manifest artifact',
  );
  if (manifest.artifact.filename !== `echo-context-${manifest.version}.tgz`) {
    fail('beta manifest artifact filename is invalid');
  }
  assertString(manifest.artifact.sha256, SHA_64, 'beta manifest artifact SHA-256');
  assertString(manifest.artifact.runtime_manifest_digest, SHA_64, 'beta manifest runtime digest');
  if (!Number.isSafeInteger(manifest.artifact.bytes) || manifest.artifact.bytes <= 0) {
    fail('beta manifest artifact byte count is invalid');
  }

  assertExactKeys(
    manifest.evidence,
    ['github_verify', 'independent_review', 'local_ci'],
    'beta manifest evidence',
  );
  assertExactKeys(
    manifest.evidence.local_ci,
    ['command', 'source_commit'],
    'beta manifest local CI evidence',
  );
  if (manifest.evidence.local_ci.command !== 'npm run ci') fail('local CI command is invalid');
  if (manifest.evidence.local_ci.source_commit !== manifest.source.commit) {
    fail('local CI evidence is not bound to the source commit');
  }

  assertExactKeys(
    manifest.promotion,
    ['installed_tree_digest', 'receipt_sha256', 'smoke'],
    'beta manifest promotion evidence',
  );
  if (manifest.promotion.smoke !== 'passed') fail('beta manifest package smoke did not pass');
  assertString(manifest.promotion.receipt_sha256, SHA_64, 'beta manifest promotion receipt digest');
  assertString(
    manifest.promotion.installed_tree_digest,
    SHA_64,
    'beta manifest installed tree digest',
  );
  assertExactKeys(
    manifest.evidence.github_verify,
    ['app_id', 'completed_at', 'conclusion', 'head_sha', 'name', 'url'],
    'beta manifest GitHub check evidence',
  );
  if (
    manifest.evidence.github_verify.name !== VERIFY_CHECK ||
    manifest.evidence.github_verify.app_id !== VERIFY_APP_ID ||
    manifest.evidence.github_verify.conclusion !== 'success' ||
    manifest.evidence.github_verify.head_sha !== manifest.source.commit
  ) {
    fail('GitHub check evidence is invalid');
  }
  assertString(manifest.evidence.github_verify.completed_at, null, 'GitHub check completion');
  assertString(manifest.evidence.github_verify.url, null, 'GitHub check URL');

  assertExactKeys(
    manifest.evidence.independent_review,
    ['author', 'commit_id', 'pull_request', 'reviewer', 'submitted_at', 'url'],
    'beta manifest review evidence',
  );
  const review = manifest.evidence.independent_review;
  if (!Number.isSafeInteger(review.pull_request) || review.pull_request <= 0) {
    fail('review pull request number is invalid');
  }
  if (review.commit_id !== manifest.source.commit || review.author === review.reviewer) {
    fail('independent review evidence is not bound to the source commit and another user');
  }
  for (const [value, label] of [
    [review.author, 'review author'],
    [review.reviewer, 'review reviewer'],
    [review.submitted_at, 'review timestamp'],
    [review.url, 'review URL'],
  ]) {
    assertString(value, null, label);
  }

  assertExactKeys(
    manifest.release_policy,
    ['draft_required', 'immutable_required_before_publish', 'prerelease_required'],
    'beta manifest release policy',
  );
  assertBoolean(manifest.release_policy.draft_required, true, 'draft policy');
  assertBoolean(manifest.release_policy.prerelease_required, true, 'prerelease policy');
  assertBoolean(
    manifest.release_policy.immutable_required_before_publish,
    true,
    'immutable release policy',
  );
  assertExactKeys(manifest.toolchain, ['node', 'npm'], 'beta manifest toolchain');
  if (
    manifest.toolchain.node !== EXPECTED_NODE.slice(1) ||
    manifest.toolchain.npm !== EXPECTED_NPM
  ) {
    fail('beta manifest toolchain is invalid');
  }
  assertBoolean(manifest.runtime_authority, false, 'runtime authority');
  assertBoolean(manifest.state_authority, false, 'state authority');
  return manifest;
}

export function validateReleaseAssetRoster(assets, manifest) {
  if (!Array.isArray(assets)) fail('GitHub release assets payload is invalid');
  const expected = [
    manifest.artifact.filename,
    `${manifest.artifact.filename}.sha256`,
    'beta-release-manifest.v1.json',
  ].sort();
  const names = assets.map((asset) => asset?.name).sort();
  if (JSON.stringify(names) !== JSON.stringify(expected)) {
    fail(
      `release assets must be exactly ${expected.join(', ')}; ` +
        'if an interrupted upload left a partial draft, delete only that draft and rerun beta:draft',
    );
  }
  for (const asset of assets) {
    if (!Number.isSafeInteger(asset.id) || asset.id <= 0 || asset.state !== 'uploaded') {
      fail(`release asset ${asset.name} is not a completed GitHub asset`);
    }
  }
  return assets;
}

export function validateReleaseRecord(release, manifest, draftRequired, expectedNotes) {
  if (!release) fail(`GitHub release does not exist for ${manifest.tag}`);
  if (typeof expectedNotes !== 'string') fail('expected release notes are required');
  if (
    release.tag_name !== manifest.tag ||
    release.name !== `ECHO Context ${manifest.version}` ||
    release.body !== expectedNotes ||
    release.target_commitish !== manifest.source.commit ||
    release.prerelease !== true ||
    release.draft !== draftRequired
  ) {
    fail('GitHub release metadata differs from the beta manifest');
  }
  return validateReleaseAssetRoster(release.assets, manifest);
}

export function validateRuntimeManifestBytes(input, manifest) {
  let runtime;
  try {
    runtime = JSON.parse(Buffer.from(input).toString('utf8'));
  } catch (error) {
    fail(`runtime artifact manifest is invalid JSON: ${error.message}`);
  }
  assertExactKeys(
    runtime,
    ['digest', 'files', 'packageVersion', 'schemaVersion', 'sourceCommit'],
    'runtime artifact manifest',
  );
  if (
    runtime.schemaVersion !== 1 ||
    runtime.packageVersion !== manifest.version ||
    runtime.sourceCommit !== manifest.source.commit ||
    !Array.isArray(runtime.files) ||
    runtime.files.length === 0
  ) {
    fail('runtime artifact manifest identity differs from the beta manifest');
  }
  const digest = sha256(
    Buffer.from(
      JSON.stringify({
        schemaVersion: runtime.schemaVersion,
        packageVersion: runtime.packageVersion,
        sourceCommit: runtime.sourceCommit,
        files: runtime.files,
      }),
    ),
  );
  if (runtime.digest !== digest || digest !== manifest.artifact.runtime_manifest_digest) {
    fail('runtime artifact manifest digest differs from the smoke-tested digest');
  }
  return runtime;
}

export function validateRemoteReleasePayload(payload, expected = {}) {
  const manifestBytes = Buffer.from(payload.manifestBytes);
  const manifest = validateBetaManifest(
    parseCanonicalJsonBytes(manifestBytes, 'remote beta release manifest'),
    expected,
  );
  validateReleaseRecord(
    payload.release,
    manifest,
    expected.draftRequired ?? true,
    expected.releaseNotes,
  );
  const artifactBytes = Buffer.from(payload.artifactBytes);
  if (
    sha256(artifactBytes) !== manifest.artifact.sha256 ||
    artifactBytes.byteLength !== manifest.artifact.bytes
  ) {
    fail('remote artifact differs from the beta manifest');
  }
  const checksumBytes = Buffer.from(payload.checksumBytes);
  const expectedChecksum = `${manifest.artifact.sha256}  ${manifest.artifact.filename}\n`;
  if (!checksumBytes.equals(Buffer.from(expectedChecksum))) fail('remote checksum is invalid');
  validateRuntimeManifestBytes(payload.runtimeManifestBytes, manifest);
  return { manifest, manifestBytes };
}

export function selectIndependentApproval(reviews, author, sourceSha) {
  if (!Array.isArray(reviews)) fail('GitHub reviews payload is invalid');
  const latestByReviewer = new Map();
  for (const review of reviews) {
    const reviewer = review?.user?.login;
    if (typeof reviewer !== 'string') continue;
    if (!['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED'].includes(review.state)) continue;
    const previous = latestByReviewer.get(reviewer);
    if (
      previous === undefined ||
      reviewTime(review) > reviewTime(previous) ||
      (reviewTime(review) === reviewTime(previous) && Number(review.id) > Number(previous.id))
    ) {
      latestByReviewer.set(reviewer, review);
    }
  }
  const eligible = [...latestByReviewer.values()]
    .filter(
      (review) =>
        review.state === 'APPROVED' &&
        review.commit_id === sourceSha &&
        review.user.login !== author &&
        review.user.type !== 'Bot',
    )
    .sort((left, right) => reviewTime(right) - reviewTime(left));
  if (eligible.length === 0) {
    fail('no current independent GitHub approval is bound to the exact source commit');
  }
  return eligible[0];
}

export function selectVerifyCheck(checkRuns, sourceSha) {
  if (!Array.isArray(checkRuns)) fail('GitHub check-runs payload is invalid');
  const matching = checkRuns
    .filter(
      (check) =>
        check?.name === VERIFY_CHECK &&
        check?.app?.id === VERIFY_APP_ID &&
        check?.head_sha === sourceSha,
    )
    .sort((left, right) => {
      const leftTime = Date.parse(left.completed_at ?? left.started_at ?? '') || 0;
      const rightTime = Date.parse(right.completed_at ?? right.started_at ?? '') || 0;
      return rightTime - leftTime || Number(right.id ?? 0) - Number(left.id ?? 0);
    });
  const latest = matching[0];
  if (latest?.status !== 'completed' || latest?.conclusion !== 'success') {
    fail(`the exact source commit lacks a successful ${VERIFY_CHECK} check from GitHub Actions`);
  }
  return latest;
}

export function githubEvidenceRecord(pull, approval, verify) {
  return {
    github_verify: {
      app_id: VERIFY_APP_ID,
      completed_at: verify.completed_at,
      conclusion: verify.conclusion,
      head_sha: verify.head_sha,
      name: verify.name,
      url: verify.html_url,
    },
    independent_review: {
      author: pull.user.login,
      commit_id: approval.commit_id,
      pull_request: pull.number,
      reviewer: approval.user.login,
      submitted_at: approval.submitted_at,
      url: approval.html_url,
    },
  };
}

export function validateManifestGithubEvidence(
  { checks, pull, reviews },
  sourceSha,
  manifest,
) {
  if (!Array.isArray(reviews) || !Array.isArray(checks)) {
    fail('GitHub review or check evidence payload is invalid');
  }
  const expectedReview = manifest.evidence.independent_review;
  if (
    !pull?.merged_at ||
    pull?.base?.ref !== 'main' ||
    pull?.head?.sha !== sourceSha ||
    pull?.number !== expectedReview.pull_request ||
    pull?.user?.login !== expectedReview.author
  ) {
    fail('beta manifest pull-request evidence is invalid on GitHub');
  }
  const approval = selectIndependentApproval(
    reviews.filter((review) => review?.user?.login === expectedReview.reviewer),
    expectedReview.author,
    sourceSha,
  );
  if (
    approval.commit_id !== expectedReview.commit_id ||
    approval.submitted_at !== expectedReview.submitted_at ||
    approval.html_url !== expectedReview.url
  ) {
    fail('beta manifest independent-review evidence is invalid on GitHub');
  }
  selectVerifyCheck(checks, sourceSha);
  const expectedVerify = manifest.evidence.github_verify;
  const verify = checks.find(
    (check) =>
      check?.name === expectedVerify.name &&
      check?.app?.id === expectedVerify.app_id &&
      check?.head_sha === expectedVerify.head_sha &&
      check?.status === 'completed' &&
      check?.conclusion === expectedVerify.conclusion &&
      check?.completed_at === expectedVerify.completed_at &&
      check?.html_url === expectedVerify.url,
  );
  if (!verify) fail('beta manifest verify-check evidence is invalid on GitHub');
  return { approval, evidence: githubEvidenceRecord(pull, approval, verify), pull, verify };
}

export function buildPublishIntent({
  artifactSha256,
  gateRunId,
  manifestSha256,
  releaseId,
  sourceCommit,
  tag,
}) {
  return {
    artifact_sha256: artifactSha256,
    gate_run_id: gateRunId,
    manifest_sha256: manifestSha256,
    release_id: releaseId,
    schema: 'beta-publish-intent.v1',
    source_commit: sourceCommit,
    status: 'authorized',
    tag,
  };
}

export function validateBetaEnvironmentPolicy(environment, policies) {
  const required = environment?.protection_rules?.find(
    (rule) => rule.type === 'required_reviewers',
  );
  if (
    environment?.name !== BETA_ENVIRONMENT ||
    !required ||
    required.prevent_self_review !== true ||
    !Array.isArray(required.reviewers) ||
    required.reviewers.length === 0 ||
    environment?.can_admins_bypass !== false ||
    environment?.deployment_branch_policy?.custom_branch_policies !== true
  ) {
    fail('beta-release environment lacks independent approval and custom tag protection');
  }
  if (
    policies?.branch_policies?.length !== 1 ||
    !policies?.branch_policies?.some(
      (policy) => policy.name === 'v*-beta.*' && policy.type === 'tag',
    )
  ) {
    fail('beta-release environment does not restrict deployments to beta tags');
  }
  const reviewerLogins = required.reviewers
    .filter((entry) => entry?.type === 'User' && typeof entry?.reviewer?.login === 'string')
    .map((entry) => entry.reviewer.login);
  if (reviewerLogins.length === 0) fail('beta-release environment needs a named user reviewer');
  return { environment, reviewerLogins };
}

export function validateHostedGateRunRecord(runRecord, manifest, binding) {
  const workflowPath = `.github/workflows/${BETA_WORKFLOW}`;
  const acceptedWorkflowPaths = new Set([workflowPath, `${workflowPath}@${manifest.tag}`]);
  if (
    runRecord.id !== binding.gate_run_id ||
    runRecord.event !== 'workflow_dispatch' ||
    runRecord.run_attempt !== 1 ||
    !acceptedWorkflowPaths.has(runRecord.path) ||
    runRecord.head_sha !== manifest.source.commit ||
    runRecord.status !== 'completed' ||
    runRecord.conclusion !== 'success'
  ) {
    fail('recorded hosted beta gate did not pass for this exact tag and source');
  }
  return runRecord;
}

export function validateHostedGateEvidence(
  { runRecord, jobs, approvals },
  manifest,
  binding,
  environmentPolicy,
) {
  validateHostedGateRunRecord(runRecord, manifest, binding);
  const job = (jobs.jobs ?? []).find(
    (candidate) =>
      candidate.name === 'beta-release-gate' &&
      candidate.status === 'completed' &&
      candidate.conclusion === 'success' &&
      typeof candidate.completed_at === 'string',
  );
  if (!job) fail('successful workflow run lacks the beta-release-gate job');
  const triggeringLogin = runRecord.triggering_actor?.login;
  if (typeof triggeringLogin !== 'string' || triggeringLogin.length === 0) {
    fail('hosted beta gate lacks its triggering actor identity');
  }
  const approval = approvals.find(
    (review) =>
      review?.state === 'approved' &&
      review?.environments?.some((environment) => environment.name === BETA_ENVIRONMENT) &&
      environmentPolicy.reviewerLogins.includes(review?.user?.login) &&
      review?.user?.login !== triggeringLogin,
  );
  if (!approval) fail('hosted beta gate lacks an independent beta-release approval');
  return { approval, job, run: runRecord };
}
