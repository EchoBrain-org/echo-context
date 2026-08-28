#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  canonicalJsonBytes,
  canonicalJsonText,
  parseCanonicalJsonBytes,
  sha256,
} from './canonical-json.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REPOSITORY = 'EchoBrain-org/echo-context';
const GITHUB_HOST = 'github.com';
const GH_REPOSITORY = `${GITHUB_HOST}/${REPOSITORY}`;
const CANONICAL_REMOTE = `https://${GITHUB_HOST}/${REPOSITORY}.git`;
const CANONICAL_CHECKOUT_REMOTE = `https://${GITHUB_HOST}/${REPOSITORY}`;
const MAIN_REF = 'refs/remotes/echo-release-gate/main';
const EXPECTED_NODE = 'v22.22.1';
const EXPECTED_NPM = '10.9.4';
const GITHUB_API_VERSION = '2026-03-10';
const VERIFY_CHECK = 'verify';
const VERIFY_APP_ID = 15368;
const BETA_ENVIRONMENT = 'beta-release';
const BETA_WORKFLOW = 'beta-release-gate.yml';
const RELEASE_MANIFEST = 'beta-release-manifest.v1.json';
const STAGE_STATE = 'beta-stage-state.json';
const STAGE_RESULT = 'beta-stage-result.json';
const DRAFT_RESULT = 'beta-draft-result.json';
const PUBLISH_INTENT = 'beta-publish-intent.json';
const PUBLISH_RESULT = 'beta-publish-result.json';
const SHA_40 = /^[0-9a-f]{40}$/u;
const SHA_64 = /^[0-9a-f]{64}$/u;
const BETA_VERSION = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)-beta\.(0|[1-9][0-9]*)$/u;
const MAX_API_BYTES = 64 * 1024 * 1024;
const MAX_ARTIFACT_BYTES = 64 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 256 * 1024;
const MAX_CHECKSUM_BYTES = 512;

function fail(message) {
  throw new Error(`beta release gate: ${message}`);
}

function commandFailure(executable, argv, result) {
  const stderr = Buffer.isBuffer(result.stderr)
    ? result.stderr.toString('utf8')
    : String(result.stderr ?? '');
  const stdout = Buffer.isBuffer(result.stdout)
    ? result.stdout.toString('utf8')
    : String(result.stdout ?? '');
  const detail = (stderr || stdout).trim().slice(-4096);
  return `${executable} ${argv.join(' ')} exited ${result.status}${detail ? `: ${detail}` : ''}`;
}

function run(executable, argv, options = {}) {
  const capture = options.capture ?? 'text';
  const result = spawnSync(executable, argv, {
    cwd: options.cwd ?? ROOT,
    env: options.env ?? process.env,
    input: options.input,
    encoding: capture === 'buffer' ? null : 'utf8',
    stdio: capture === 'inherit' ? 'inherit' : ['pipe', 'pipe', 'pipe'],
    shell: false,
    maxBuffer: options.maxBuffer ?? MAX_API_BYTES,
  });
  if (result.error) fail(`${executable} could not start: ${result.error.message}`);
  if (result.signal) fail(`${executable} terminated by ${result.signal}`);
  const allowedStatuses = options.allowedStatuses ?? [0];
  if (!allowedStatuses.includes(result.status)) {
    fail(commandFailure(executable, argv, result));
  }
  if (capture === 'inherit') return undefined;
  if (capture === 'buffer') return Buffer.from(result.stdout ?? []);
  return String(result.stdout ?? '').trim();
}

function git(argv, options = {}) {
  return run('git', argv, options);
}

function gh(argv, options = {}) {
  return run('gh', [...argv, '--repo', GH_REPOSITORY], options);
}

function ghApi(endpoint, options = {}) {
  const result = run(
    'gh',
    [
      'api',
      '--hostname',
      GITHUB_HOST,
      '--method',
      'GET',
      '-H',
      `X-GitHub-Api-Version: ${GITHUB_API_VERSION}`,
      endpoint,
      ...(options.headers ?? []).flatMap((value) => ['-H', value]),
    ],
    {
      capture: options.capture ?? 'text',
      allowedStatuses: options.allowedStatuses,
      maxBuffer: options.maxBuffer,
    },
  );
  if (options.capture === 'buffer') return result;
  try {
    return JSON.parse(result);
  } catch (error) {
    fail(`GitHub returned invalid JSON for ${endpoint}: ${error.message}`);
  }
}

export function flattenGithubPages(pages, arrayField) {
  if (!Array.isArray(pages)) fail('paginated GitHub response must be an array of pages');
  const values = [];
  for (const page of pages) {
    const entries = arrayField ? page?.[arrayField] : page;
    if (!Array.isArray(entries)) {
      fail(`paginated GitHub response lacks ${arrayField ?? 'an array page'}`);
    }
    values.push(...entries);
  }
  return values;
}

function ghApiAll(endpoint, options = {}) {
  const output = run('gh', [
    'api',
    '--hostname',
    GITHUB_HOST,
    '--method',
    'GET',
    '-H',
    `X-GitHub-Api-Version: ${GITHUB_API_VERSION}`,
    ...(options.headers ?? []).flatMap((value) => ['-H', value]),
    '--paginate',
    '--slurp',
    endpoint,
  ]);
  let pages;
  try {
    pages = JSON.parse(output);
  } catch (error) {
    fail(`GitHub returned invalid paginated JSON for ${endpoint}: ${error.message}`);
  }
  return flattenGithubPages(pages, options.arrayField);
}

function writePrivateJson(path, value) {
  writeFileSync(path, canonicalJsonText(value), { mode: 0o600 });
  if (process.platform !== 'win32') chmodSync(path, 0o600);
}

function readCanonicalJson(path, label) {
  if (!existsSync(path)) fail(`${label} is missing: ${path}`);
  return parseCanonicalJsonBytes(readFileSync(path), label);
}

function hashFile(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
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

export function parseBetaVersion(input) {
  if (typeof input !== 'string') fail('beta version must be a string');
  const version = input.startsWith('v') ? input.slice(1) : input;
  const match = version.match(BETA_VERSION);
  if (!match) fail(`invalid beta version: ${input}`);
  const parsed = {
    version,
    tag: `v${version}`,
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    beta: Number(match[4]),
  };
  return { ...parsed, core: `${parsed.major}.${parsed.minor}.${parsed.patch}` };
}

function tryParseBetaVersion(input) {
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

function reviewTime(review) {
  const parsed = Date.parse(review.submitted_at ?? '');
  return Number.isFinite(parsed) ? parsed : 0;
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

export function buildStageCommandPlan({ artifact, prefix }) {
  return [
    { executable: 'npm', argv: ['run', 'ci'] },
    {
      executable: 'npm',
      argv: ['pack', '--pack-destination', dirname(artifact)],
    },
    {
      executable: 'npm',
      argv: ['run', '--silent', 'smoke:package', '--', artifact, '--prefix', prefix],
    },
  ];
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
  if (expected.tag && manifest.tag !== expected.tag)
    fail('beta manifest tag differs from requested tag');
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
    RELEASE_MANIFEST,
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

export function normalizeReleaseView(view) {
  if (!Number.isSafeInteger(view?.databaseId) || view.databaseId <= 0) {
    fail('GitHub release view lacks a numeric database ID');
  }
  if (!Array.isArray(view.assets)) fail('GitHub release view assets are invalid');
  return {
    assets: view.assets.map((asset) => {
      const match = asset?.apiUrl?.match(/\/releases\/assets\/([0-9]+)$/u);
      if (!match) fail(`GitHub release asset ${asset?.name ?? '(unknown)'} lacks a REST ID`);
      return {
        digest: asset.digest,
        id: Number(match[1]),
        name: asset.name,
        size: asset.size,
        state: asset.state,
      };
    }),
    body: view.body,
    created_at: view.createdAt,
    draft: view.isDraft,
    html_url: view.url,
    id: view.databaseId,
    immutable: view.isImmutable,
    name: view.name,
    published_at: view.publishedAt,
    prerelease: view.isPrerelease,
    tag_name: view.tagName,
    target_commitish: view.targetCommitish,
  };
}

function assertCleanHead(expectedHead) {
  const head = git(['rev-parse', '--verify', 'HEAD']);
  if (!SHA_40.test(head)) fail('HEAD is not one exact commit');
  if (expectedHead && head !== expectedHead) fail('HEAD changed during the release gate');
  const status = git(['status', '--porcelain=v1', '--untracked-files=all']);
  if (status) fail(`worktree is not clean:\n${status}`);
  return head;
}

function assertToolchain() {
  if (process.version !== EXPECTED_NODE) {
    fail(`Node ${process.version} differs from reviewed ${EXPECTED_NODE}`);
  }
  const npmVersion = run('npm', ['--version']);
  if (npmVersion !== EXPECTED_NPM) {
    fail(`npm ${npmVersion} differs from reviewed ${EXPECTED_NPM}`);
  }
}

function readPackageIdentity() {
  const packageBytes = readFileSync(join(ROOT, 'package.json'));
  const packageLockBytes = readFileSync(join(ROOT, 'package-lock.json'));
  const shrinkwrapBytes = readFileSync(join(ROOT, 'npm-shrinkwrap.json'));
  if (!packageLockBytes.equals(shrinkwrapBytes)) {
    fail('package-lock.json and npm-shrinkwrap.json differ');
  }
  const packageJson = JSON.parse(packageBytes.toString('utf8'));
  const packageLock = JSON.parse(packageLockBytes.toString('utf8'));
  const versions = [packageJson.version, packageLock.version, packageLock.packages?.['']?.version];
  if (new Set(versions).size !== 1) fail('package and lockfile versions differ');
  const sourceVersion = readFileSync(join(ROOT, 'src', 'version.ts'), 'utf8');
  if (!sourceVersion.includes(`ECHO_CONTEXT_VERSION = '${packageJson.version}'`)) {
    fail('src/version.ts differs from the package version');
  }
  if (!sourceVersion.includes(`ECHO_CONTEXT_NODE_VERSION = '${EXPECTED_NODE.slice(1)}'`)) {
    fail('src/version.ts differs from the reviewed Node version');
  }
  return { packageJson, beta: parseBetaVersion(packageJson.version) };
}

export function validateCanonicalRemote(fetchUrl, pushUrl) {
  const accepted = new Set([CANONICAL_REMOTE, CANONICAL_CHECKOUT_REMOTE]);
  if (!accepted.has(fetchUrl) || !accepted.has(pushUrl)) {
    fail(
      `origin fetch and push URLs must both identify ${GITHUB_HOST}/${REPOSITORY} over HTTPS`,
    );
  }
  return CANONICAL_REMOTE;
}

function assertRepository() {
  const nameWithOwner = run('gh', [
    'repo',
    'view',
    GH_REPOSITORY,
    '--json',
    'nameWithOwner',
    '--jq',
    '.nameWithOwner',
  ]);
  if (nameWithOwner !== REPOSITORY) fail(`canonical GitHub repository must be ${REPOSITORY}`);
  const fetchUrl = git(['remote', 'get-url', 'origin']);
  const pushUrl = git(['remote', 'get-url', '--push', 'origin']);
  validateCanonicalRemote(fetchUrl, pushUrl);
}

function fetchMain() {
  git(['fetch', '--quiet', '--no-tags', CANONICAL_REMOTE, `refs/heads/main:${MAIN_REF}`]);
}

function assertOnMainHistory(sourceSha) {
  const status = spawnSync('git', ['merge-base', '--is-ancestor', sourceSha, MAIN_REF], {
    cwd: ROOT,
    stdio: 'ignore',
    shell: false,
  }).status;
  if (status !== 0) fail('source commit is not reachable from canonical main');
}

function assertVersionIsNew(beta) {
  const remoteTags = git(['ls-remote', '--tags', CANONICAL_REMOTE]);
  const versions = remoteTags
    .split('\n')
    .map((line) => line.match(/refs\/tags\/(v[^{}]+)$/u)?.[1])
    .map((tag) => (tag ? tryParseBetaVersion(tag) : null))
    .filter(Boolean);
  const newest = versions.sort((left, right) =>
    compareBetaVersions(right.version, left.version),
  )[0];
  if (newest && compareBetaVersions(beta.version, newest.version) <= 0) {
    fail(`candidate ${beta.version} must be newer than existing ${newest.version}`);
  }
}

function releaseForTag(tag) {
  const fields = [
    'assets',
    'body',
    'createdAt',
    'databaseId',
    'isDraft',
    'isImmutable',
    'isPrerelease',
    'name',
    'publishedAt',
    'tagName',
    'targetCommitish',
    'url',
  ].join(',');
  const argv = ['release', 'view', tag, '--repo', GH_REPOSITORY, '--json', fields];
  const result = spawnSync('gh', argv, {
    cwd: ROOT,
    encoding: 'utf8',
    shell: false,
    maxBuffer: MAX_API_BYTES,
  });
  if (result.error) fail(`gh could not start: ${result.error.message}`);
  if (result.status !== 0) {
    const detail = `${result.stderr ?? ''}${result.stdout ?? ''}`;
    if (/release not found|HTTP 404|Could not resolve to a Release/iu.test(detail)) return null;
    fail(commandFailure('gh', argv, result));
  }
  let view;
  try {
    view = JSON.parse(result.stdout);
  } catch (error) {
    fail(`gh release view returned invalid JSON: ${error.message}`);
  }
  const release = normalizeReleaseView(view);
  if (release.tag_name !== tag) fail(`gh release view returned the wrong tag for ${tag}`);
  return release;
}

function assertTagAndReleaseAbsent(tag) {
  const remoteTag = git([
    'ls-remote',
    '--tags',
    CANONICAL_REMOTE,
    `refs/tags/${tag}`,
    `refs/tags/${tag}^{}`,
  ]);
  if (remoteTag) fail(`remote tag already exists: ${tag}`);
  const localTagStatus = spawnSync('git', ['show-ref', '--verify', '--quiet', `refs/tags/${tag}`], {
    cwd: ROOT,
    stdio: 'ignore',
    shell: false,
  }).status;
  if (localTagStatus === 0) fail(`local tag already exists: ${tag}`);
  if (releaseForTag(tag)) fail(`GitHub release already exists: ${tag}`);
}

function githubEvidence(sourceSha) {
  const pulls = ghApiAll(`repos/${REPOSITORY}/commits/${sourceSha}/pulls?per_page=100`, {
    headers: ['Accept: application/vnd.github+json'],
  });
  const eligiblePulls = pulls
    .filter(
      (pull) =>
        pull?.merged_at &&
        pull?.base?.ref === 'main' &&
        pull?.head?.sha === sourceSha &&
        pull?.user?.login,
    )
    .sort((left, right) => right.number - left.number);
  if (eligiblePulls.length === 0) {
    fail('source commit is not the exact reviewed head of a merged pull request into main');
  }
  const pull = eligiblePulls[0];
  const reviews = ghApiAll(`repos/${REPOSITORY}/pulls/${pull.number}/reviews?per_page=100`);
  const approval = selectIndependentApproval(reviews, pull.user.login, sourceSha);
  const checks = ghApiAll(
    `repos/${REPOSITORY}/commits/${sourceSha}/check-runs?check_name=${VERIFY_CHECK}&filter=latest&per_page=100`,
    {
      arrayField: 'check_runs',
      headers: ['Accept: application/vnd.github+json'],
    },
  );
  const verify = selectVerifyCheck(checks, sourceSha);
  return {
    pull,
    approval,
    verify,
    manifest: {
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
    },
  };
}

function assertCurrentGithubEvidence(sourceSha, manifest) {
  const reviewEvidence = manifest.evidence.independent_review;
  const pull = ghApi(`repos/${REPOSITORY}/pulls/${reviewEvidence.pull_request}`);
  if (
    !pull?.merged_at ||
    pull?.base?.ref !== 'main' ||
    pull?.head?.sha !== sourceSha ||
    pull?.user?.login !== reviewEvidence.author
  ) {
    fail('beta manifest pull-request evidence is invalid on GitHub');
  }
  const reviews = ghApiAll(
    `repos/${REPOSITORY}/pulls/${reviewEvidence.pull_request}/reviews?per_page=100`,
  ).filter((review) => review?.user?.login === reviewEvidence.reviewer);
  const approval = selectIndependentApproval(reviews, reviewEvidence.author, sourceSha);
  if (
    approval.commit_id !== reviewEvidence.commit_id ||
    approval.submitted_at !== reviewEvidence.submitted_at ||
    approval.html_url !== reviewEvidence.url
  ) {
    fail('beta manifest independent-review evidence is invalid on GitHub');
  }
  const checks = ghApiAll(
    `repos/${REPOSITORY}/commits/${sourceSha}/check-runs?check_name=${VERIFY_CHECK}&filter=all&per_page=100`,
    {
      arrayField: 'check_runs',
      headers: ['Accept: application/vnd.github+json'],
    },
  );
  selectVerifyCheck(checks, sourceSha);
  const verifyEvidence = manifest.evidence.github_verify;
  const exactCheck = checks.find(
    (check) =>
      check?.name === verifyEvidence.name &&
      check?.app?.id === verifyEvidence.app_id &&
      check?.head_sha === verifyEvidence.head_sha &&
      check?.status === 'completed' &&
      check?.conclusion === verifyEvidence.conclusion &&
      check?.completed_at === verifyEvidence.completed_at &&
      check?.html_url === verifyEvidence.url,
  );
  if (!exactCheck) fail('beta manifest verify-check evidence is invalid on GitHub');
  return { approval, pull, verify: exactCheck };
}

function defaultReleaseRoot(beta, sourceSha) {
  return join(
    homedir(),
    '.local',
    'share',
    'echo-context',
    'releases',
    `${beta.version}-${sourceSha}`,
  );
}

function resolveReleaseRoot(value) {
  if (typeof value !== 'string' || !isAbsolute(value)) {
    fail('--release-root must be an absolute path');
  }
  return resolve(value);
}

function parseJsonOutput(output, label) {
  const lines = output.split('\n').filter((line) => line.trim() !== '');
  if (lines.length === 0) fail(`${label} emitted no JSON`);
  try {
    return JSON.parse(lines.at(-1));
  } catch (error) {
    fail(`${label} emitted invalid JSON: ${error.message}`);
  }
}

function validateSmokeResult(smoke, expected) {
  const stringFields = [
    'artifact',
    'artifactSha256',
    'artifactDigest',
    'sourceCommit',
    'version',
    'nodeVersion',
    'nodeExecutable',
    'installedPrefix',
    'cliPath',
    'packageRoot',
    'installedTreeDigest',
    'promotionReceipt',
    'promotionReceiptDigest',
  ];
  for (const field of stringFields) assertString(smoke?.[field], null, `smoke ${field}`);
  const expectedReceipt = join(expected.prefix, 'share', 'echo-context', 'promotion-receipt.json');
  if (
    smoke.artifact !== realpathSync(expected.artifact) ||
    smoke.artifactSha256 !== expected.artifactSha256 ||
    smoke.sourceCommit !== expected.sourceSha ||
    smoke.version !== expected.version ||
    smoke.nodeVersion !== EXPECTED_NODE.slice(1) ||
    smoke.nodeExecutable !== realpathSync(process.execPath) ||
    smoke.installedPrefix !== realpathSync(expected.prefix) ||
    smoke.cliPath !== realpathSync(join(expected.prefix, 'bin', 'echo-context')) ||
    smoke.packageRoot !==
      realpathSync(join(expected.prefix, 'lib', 'node_modules', 'echo-context')) ||
    smoke.promotionReceipt !== realpathSync(expectedReceipt) ||
    smoke.smoke !== 'passed'
  ) {
    fail('package smoke result differs from the staged artifact identity');
  }
  for (const field of [
    'artifactSha256',
    'artifactDigest',
    'installedTreeDigest',
    'promotionReceiptDigest',
  ]) {
    assertString(smoke[field], SHA_64, `smoke ${field}`);
  }
  const receipt = readFileSync(smoke.promotionReceipt);
  if (sha256(receipt) !== smoke.promotionReceiptDigest) {
    fail('promotion receipt digest differs from the receipt bytes');
  }
  return smoke;
}

function buildManifest({ beta, sourceSha, sourceTree, artifact, smoke, evidence }) {
  const manifest = {
    artifact: {
      bytes: statSync(artifact).size,
      filename: basename(artifact),
      runtime_manifest_digest: smoke.artifactDigest,
      sha256: smoke.artifactSha256,
    },
    channel: 'beta',
    evidence: {
      ...evidence.manifest,
      local_ci: { command: 'npm run ci', source_commit: sourceSha },
    },
    release_policy: {
      draft_required: true,
      immutable_required_before_publish: true,
      prerelease_required: true,
    },
    repository: REPOSITORY,
    promotion: {
      installed_tree_digest: smoke.installedTreeDigest,
      receipt_sha256: smoke.promotionReceiptDigest,
      smoke: smoke.smoke,
    },
    runtime_authority: false,
    schema: 'beta-release-manifest.v1',
    source: { commit: sourceSha, tree: sourceTree },
    state_authority: false,
    tag: beta.tag,
    toolchain: { node: EXPECTED_NODE.slice(1), npm: EXPECTED_NPM },
    version: beta.version,
  };
  return validateBetaManifest(manifest, {
    sourceCommit: sourceSha,
    sourceTree,
    tag: beta.tag,
    version: beta.version,
  });
}

function writeStageFailure(releaseRoot, state, error) {
  if (!releaseRoot || !existsSync(releaseRoot)) return;
  writePrivateJson(join(releaseRoot, STAGE_STATE), {
    ...state,
    error: error instanceof Error ? error.message : String(error),
    status: 'failed',
  });
}

function stageBeta() {
  assertRepository();
  assertToolchain();
  const sourceSha = assertCleanHead();
  const { beta } = readPackageIdentity();
  fetchMain();
  assertOnMainHistory(sourceSha);
  assertVersionIsNew(beta);
  assertTagAndReleaseAbsent(beta.tag);
  githubEvidence(sourceSha);
  const sourceTree = git(['rev-parse', `${sourceSha}^{tree}`]);
  const releaseRoot = defaultReleaseRoot(beta, sourceSha);
  if (existsSync(releaseRoot)) {
    fail(`durable release root already exists; inspect it instead of rebuilding: ${releaseRoot}`);
  }

  const artifact = join(releaseRoot, `echo-context-${beta.version}.tgz`);
  const prefix = join(releaseRoot, 'prefix');
  const plan = buildStageCommandPlan({ artifact, prefix });
  run(plan[0].executable, plan[0].argv, { capture: 'inherit' });
  assertCleanHead(sourceSha);
  const evidence = githubEvidence(sourceSha);
  if (existsSync(releaseRoot)) {
    fail(
      `durable release root appeared during CI; inspect it instead of rebuilding: ${releaseRoot}`,
    );
  }
  const state = {
    source_commit: sourceSha,
    status: 'staging',
    tag: beta.tag,
    version: beta.version,
  };
  mkdirSync(dirname(releaseRoot), { recursive: true, mode: 0o700 });
  mkdirSync(releaseRoot, { mode: 0o700 });
  writePrivateJson(join(releaseRoot, STAGE_STATE), state);

  try {
    run(plan[1].executable, plan[1].argv);
    const tarballs = [artifact].filter(existsSync);
    if (tarballs.length !== 1) fail(`npm pack did not create ${artifact}`);
    if (statSync(artifact).size > MAX_ARTIFACT_BYTES) {
      fail(`npm package exceeds the ${MAX_ARTIFACT_BYTES}-byte beta limit`);
    }
    const artifactSha256 = hashFile(artifact);
    writeFileSync(`${artifact}.sha256`, `${artifactSha256}  ${basename(artifact)}\n`, {
      mode: 0o644,
    });
    const smokeOutput = run(plan[2].executable, plan[2].argv);
    const smoke = validateSmokeResult(parseJsonOutput(smokeOutput, 'package smoke'), {
      artifact,
      artifactSha256,
      prefix,
      sourceSha,
      version: beta.version,
    });
    writePrivateJson(join(releaseRoot, 'promotion-result.json'), smoke);
    const manifest = buildManifest({
      artifact,
      beta,
      evidence,
      smoke,
      sourceSha,
      sourceTree,
    });
    const manifestPath = join(releaseRoot, RELEASE_MANIFEST);
    writeFileSync(manifestPath, canonicalJsonBytes(manifest), { mode: 0o644 });
    const result = {
      artifact,
      artifact_sha256: artifactSha256,
      checksum: `${artifact}.sha256`,
      installed_prefix: prefix,
      manifest: manifestPath,
      manifest_sha256: hashFile(manifestPath),
      promotion_receipt: smoke.promotionReceipt,
      promotion_receipt_sha256: smoke.promotionReceiptDigest,
      release_root: realpathSync(releaseRoot),
      source_commit: sourceSha,
      status: 'passed',
      tag: beta.tag,
      version: beta.version,
    };
    writePrivateJson(join(releaseRoot, STAGE_RESULT), result);
    writePrivateJson(join(releaseRoot, STAGE_STATE), {
      source_commit: sourceSha,
      status: 'passed',
      tag: beta.tag,
      version: beta.version,
    });
    assertCleanHead(sourceSha);
    process.stdout.write(canonicalJsonText(result));
  } catch (error) {
    writeStageFailure(releaseRoot, state, error);
    throw error;
  }
}

function parseArgs(argv) {
  if (argv.length === 0) fail('expected one of: stage, draft, validate-hosted, publish');
  const [command, ...rest] = argv;
  const values = {};
  for (let index = 0; index < rest.length; index += 1) {
    const key = rest[index];
    if (!key.startsWith('--')) fail(`unexpected argument: ${key}`);
    const value = rest[index + 1];
    if (value === undefined || value.startsWith('--')) fail(`${key} requires a value`);
    if (values[key] !== undefined) fail(`duplicate argument: ${key}`);
    values[key] = value;
    index += 1;
  }
  return { command, values };
}

function assertArgs(values, required) {
  const actual = Object.keys(values).sort();
  const expected = [...required].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    fail(`arguments must be exactly ${expected.join(', ') || '(none)'}`);
  }
}

function verifyInstalledPromotion(smoke) {
  const modulePath = join(smoke.packageRoot, 'dist', 'index.js');
  const startPath = join(smoke.packageRoot, 'dist', 'cli.js');
  const verifier = [
    "import { pathToFileURL } from 'node:url';",
    'const [modulePath, startPath, cliPath, artifactDigest, receiptDigest] = process.argv.slice(1);',
    'const runtime = await import(pathToFileURL(modulePath).href);',
    'runtime.verifyPromotionReceipt({',
    '  startPath,',
    '  cliPath,',
    '  expectedArtifactDigest: artifactDigest,',
    '  expectedPromotionReceiptDigest: receiptDigest,',
    '});',
  ].join('\n');
  run(process.execPath, [
    '--input-type=module',
    '--eval',
    verifier,
    modulePath,
    startPath,
    smoke.cliPath,
    smoke.artifactDigest,
    smoke.promotionReceiptDigest,
  ]);
}

function verifyLocalStage(releaseRoot) {
  const root = resolveReleaseRoot(releaseRoot);
  if (!existsSync(root) || realpathSync(root) !== root)
    fail('release root must exist without symlinks');
  const stage = readCanonicalJson(join(root, STAGE_RESULT), 'beta stage result');
  if (stage.status !== 'passed' || stage.release_root !== root)
    fail('beta stage did not pass for this root');
  assertString(stage.source_commit, SHA_40, 'stage source commit');
  const manifestPath = join(root, RELEASE_MANIFEST);
  const manifestBytes = readFileSync(manifestPath);
  if (sha256(manifestBytes) !== stage.manifest_sha256) fail('staged manifest digest changed');
  const manifest = validateBetaManifest(
    parseCanonicalJsonBytes(manifestBytes, 'beta release manifest'),
    {
      sourceCommit: stage.source_commit,
      tag: stage.tag,
      version: stage.version,
    },
  );
  const artifact = join(root, manifest.artifact.filename);
  const checksum = `${artifact}.sha256`;
  if (
    stage.artifact !== artifact ||
    stage.checksum !== checksum ||
    stage.manifest !== manifestPath ||
    hashFile(artifact) !== manifest.artifact.sha256 ||
    statSync(artifact).size !== manifest.artifact.bytes
  ) {
    fail('staged artifact identity changed');
  }
  const expectedChecksum = `${manifest.artifact.sha256}  ${manifest.artifact.filename}\n`;
  if (!readFileSync(checksum).equals(Buffer.from(expectedChecksum)))
    fail('staged checksum changed');
  const smoke = readCanonicalJson(join(root, 'promotion-result.json'), 'promotion result');
  validateSmokeResult(smoke, {
    artifact,
    artifactSha256: manifest.artifact.sha256,
    prefix: join(root, 'prefix'),
    sourceSha: manifest.source.commit,
    version: manifest.version,
  });
  if (
    smoke.artifactDigest !== manifest.artifact.runtime_manifest_digest ||
    smoke.installedTreeDigest !== manifest.promotion.installed_tree_digest ||
    smoke.promotionReceiptDigest !== manifest.promotion.receipt_sha256
  ) {
    fail('staged promotion identity differs from the release manifest');
  }
  verifyInstalledPromotion(smoke);
  return { artifact, checksum, manifest, manifestPath, root, smoke, stage };
}

function localTagTarget(tag) {
  const status = spawnSync('git', ['show-ref', '--verify', '--quiet', `refs/tags/${tag}`], {
    cwd: ROOT,
    stdio: 'ignore',
    shell: false,
  }).status;
  return status === 0 ? git(['rev-parse', `${tag}^{commit}`]) : null;
}

function remoteTagTarget(tag) {
  const output = git([
    'ls-remote',
    '--tags',
    CANONICAL_REMOTE,
    `refs/tags/${tag}`,
    `refs/tags/${tag}^{}`,
  ]);
  if (!output) return null;
  const rows = output.split('\n').map((line) => line.split(/\s+/u));
  return rows.find(([, ref]) => ref === `refs/tags/${tag}^{}`)?.[0] ?? rows[0]?.[0] ?? null;
}

function ensureExactTag(tag, sourceSha) {
  const localTarget = localTagTarget(tag);
  if (localTarget && localTarget !== sourceSha) fail(`local ${tag} points at another commit`);
  if (!localTarget) git(['tag', '--annotate', tag, '--message', `ECHO Context ${tag}`, sourceSha]);
  const remoteTarget = remoteTagTarget(tag);
  if (remoteTarget && remoteTarget !== sourceSha) fail(`remote ${tag} points at another commit`);
  if (!remoteTarget) {
    git(['push', CANONICAL_REMOTE, `refs/tags/${tag}:refs/tags/${tag}`], {
      capture: 'inherit',
    });
  }
  if (remoteTagTarget(tag) !== sourceSha)
    fail(`remote ${tag} did not resolve to the source commit`);
}

function releaseTitle(version) {
  return `ECHO Context ${version}`;
}

const BETA_RELEASE_CHANGES = Object.freeze({
  '0.1.0-beta.7': Object.freeze([
    'This prerelease keeps the beta.6 seven-tool read-only MCP contract.',
    '',
    'What changed:',
    '',
    '- Repository-owned ECHO usage instructions and an explicit sync/check operator for Codex and Claude Code.',
    '- Founder-live dogfooding journals bound to the live runtime version and artifact digest, with fail-closed endpoint and mapping checks.',
    '- Lean source CI plus an exact-artifact, independently approved beta prerelease gate.',
    '- Portable manual-daemon verification on Ubuntu 24.04 x64, Windows 2025 x64, and macOS 15 arm64, including post-start Codex and Claude capture, health, service API, MCP retrieval, and normalized discovery.',
    '- Windows path-separator fixes for Codex and Claude session capture and normalization.',
    '',
    'Technical-preview limits: distribution is a GitHub prerelease tarball, not an npm registry package. Cross-platform operation uses the foreground `daemon run` path. Managed installation remains macOS launchd-only; there is no systemd or Windows Service installer. Agent sync installs instructions and banners but does not configure MCP clients.',
  ]),
  '0.1.0-beta.9': Object.freeze([
    'This prerelease keeps the beta.7 seven-tool read-only MCP contract. Beta.8 was consumed during staging and is intentionally not retagged.',
    '',
    'What changed:',
    '',
    '- Explicit source-app searches now use conservative SQLite family indexes to skip unrelated history while preserving the existing authoritative source matcher.',
    '- In the 8,193-row warm-cache benchmark, an old Codex hit fell from 8,193 inspected descriptors to one, and an absent Granola search returned without inspecting a candidate descriptor.',
    '- Arbitrary source-prefix searches retain the existing bounded, resumable scan rather than taking the optimized app-family path.',
    '- Schema migration 0006 adds virtual family classification plus ordered partial indexes and fails transactionally if a legacy descriptor exceeds the storage budgets.',
    '',
    'Technical-preview limits: distribution is a GitHub prerelease tarball, not an npm registry package. Cross-platform operation uses the foreground `daemon run` path. Managed installation remains macOS launchd-only; there is no systemd or Windows Service installer. Agent sync installs instructions and banners but does not configure MCP clients.',
  ]),
  '0.1.0-beta.10': Object.freeze([
    'This prerelease keeps the beta.7 seven-tool read-only MCP contract. Beta.9 was staged from reviewed source and passed its gate, but could not be activated against a founder-live database and is intentionally not retagged.',
    '',
    'What changed:',
    '',
    '- `echo-context migrate` now succeeds on a database that migrate itself produced. The copy-lineage record inherited from the source is replaced by this copy\'s own record, and the inherited source digest is carried forward in a new `previous_source_database_digest` column so the copy chain stays recoverable.',
    '- Lineage records written before that column existed read back as first-generation copies, so existing founder-live databases remain valid `migrate` and `cutover` inputs.',
    '- Everything staged for beta.9 is included: bounded source-app family-index searches and schema migration 0006.',
    '',
    'Technical-preview limits: distribution is a GitHub prerelease tarball, not an npm registry package. Cross-platform operation uses the foreground `daemon run` path. Managed installation remains macOS launchd-only; there is no systemd or Windows Service installer. Agent sync installs instructions and banners but does not configure MCP clients.',
  ]),
});

export function betaReleaseNotes(manifest) {
  const changes = BETA_RELEASE_CHANGES[manifest?.version];
  if (changes === undefined) {
    fail(`reviewed release notes are missing for ${manifest?.version ?? '(unknown version)'}`);
  }
  assertString(manifest?.source?.commit, SHA_40, 'release-notes source commit');
  return [
    `## ECHO Context ${manifest.version} — technical preview`,
    '',
    ...changes,
    '',
    `Reviewed source: \`${manifest.source.commit}\`.`,
    'The attached tarball is the exact locally smoke-tested artifact described by `beta-release-manifest.v1.json`. Publication requires the independent beta environment approval and the hosted validation gate.',
  ].join('\n');
}

export function validateReleaseRecord(release, manifest, draftRequired) {
  if (!release) fail(`GitHub release does not exist for ${manifest.tag}`);
  if (
    release.tag_name !== manifest.tag ||
    release.name !== releaseTitle(manifest.version) ||
    release.body !== betaReleaseNotes(manifest) ||
    release.prerelease !== true ||
    release.draft !== draftRequired
  ) {
    fail('GitHub release metadata differs from the beta manifest');
  }
  return validateReleaseAssetRoster(release.assets, manifest);
}

function createOrValidateDraft(local) {
  let release = releaseForTag(local.manifest.tag);
  if (!release) {
    const notes = betaReleaseNotes(local.manifest);
    gh(
      [
        'release',
        'create',
        local.manifest.tag,
        local.artifact,
        local.checksum,
        local.manifestPath,
        '--draft',
        '--prerelease',
        '--latest=false',
        '--verify-tag',
        '--target',
        local.manifest.source.commit,
        '--title',
        releaseTitle(local.manifest.version),
        '--notes',
        notes,
      ],
      { capture: 'inherit' },
    );
    release = releaseForTag(local.manifest.tag);
  }
  validateReleaseRecord(release, local.manifest, true);
  return release;
}

function remoteAssetBytes(asset, maxBytes) {
  if (asset.size > maxBytes) fail(`GitHub asset ${asset.name} exceeds its byte limit`);
  const bytes = ghApi(`repos/${REPOSITORY}/releases/assets/${asset.id}`, {
    capture: 'buffer',
    headers: ['Accept: application/octet-stream'],
    maxBuffer: maxBytes,
  });
  if (bytes.byteLength !== asset.size) fail(`GitHub asset ${asset.name} byte count differs`);
  if (asset.digest && asset.digest !== `sha256:${sha256(bytes)}`) {
    fail(`GitHub asset ${asset.name} digest differs`);
  }
  return bytes;
}

function validateRuntimeManifest(artifactPath, manifest) {
  const bytes = run(
    '/usr/bin/tar',
    ['-xOzf', artifactPath, 'package/dist/artifact-manifest.json'],
    { capture: 'buffer', maxBuffer: 4 * 1024 * 1024 },
  );
  let runtime;
  try {
    runtime = JSON.parse(bytes.toString('utf8'));
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
}

function validateRemoteAssets(release, expected = {}) {
  const manifestAsset = release.assets.find((asset) => asset.name === RELEASE_MANIFEST);
  if (!manifestAsset) fail(`release omits ${RELEASE_MANIFEST}`);
  const manifestBytes = remoteAssetBytes(manifestAsset, MAX_MANIFEST_BYTES);
  const manifest = validateBetaManifest(
    parseCanonicalJsonBytes(manifestBytes, 'remote beta release manifest'),
    expected,
  );
  validateReleaseRecord(release, manifest, expected.draftRequired ?? true);
  const artifactAsset = release.assets.find((asset) => asset.name === manifest.artifact.filename);
  const checksumAsset = release.assets.find(
    (asset) => asset.name === `${manifest.artifact.filename}.sha256`,
  );
  const artifactBytes = remoteAssetBytes(artifactAsset, MAX_ARTIFACT_BYTES);
  const checksumBytes = remoteAssetBytes(checksumAsset, MAX_CHECKSUM_BYTES);
  if (
    sha256(artifactBytes) !== manifest.artifact.sha256 ||
    artifactBytes.byteLength !== manifest.artifact.bytes
  ) {
    fail('remote artifact differs from the beta manifest');
  }
  const expectedChecksum = `${manifest.artifact.sha256}  ${manifest.artifact.filename}\n`;
  if (!checksumBytes.equals(Buffer.from(expectedChecksum))) fail('remote checksum is invalid');
  const scratch = mkdtempSync(join(tmpdir(), 'echo-context-beta-validate-'));
  try {
    const artifactPath = join(scratch, manifest.artifact.filename);
    writeFileSync(artifactPath, artifactBytes, { mode: 0o600 });
    validateRuntimeManifest(artifactPath, manifest);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  return { manifest, manifestBytes };
}

function validateHostedTag(tag) {
  assertRepository();
  assertToolchain();
  const parsed = parseBetaVersion(tag);
  if (parsed.tag !== tag) fail('--tag must include the leading v');
  const sourceSha = assertCleanHead();
  if (localTagTarget(tag) !== sourceSha) fail('checked-out tag does not resolve to HEAD');
  const { beta } = readPackageIdentity();
  if (beta.tag !== tag || beta.version !== parsed.version)
    fail('package version differs from the tag');
  fetchMain();
  assertOnMainHistory(sourceSha);
  if (remoteTagTarget(tag) !== sourceSha) fail('remote beta tag differs from checked-out HEAD');
  const evidence = githubEvidence(sourceSha);
  const result = {
    pull_request: evidence.pull.number,
    reviewer: evidence.approval.user.login,
    source_commit: sourceSha,
    status: 'passed',
    tag,
    workflow: BETA_WORKFLOW,
  };
  process.stdout.write(canonicalJsonText(result));
  return result;
}

export function parseWorkflowRunId(output) {
  if (typeof output !== 'string') fail('workflow dispatch output must be text');
  const matches = [...output.matchAll(/\/actions\/runs\/([0-9]+)/gu)].map((match) =>
    Number(match[1]),
  );
  const unique = [...new Set(matches)];
  if (unique.length !== 1 || !Number.isSafeInteger(unique[0]) || unique[0] <= 0) {
    fail(
      'workflow dispatch did not return one run URL; rerun beta:draft against the unchanged draft',
    );
  }
  return unique[0];
}

function draftBeta(releaseRoot) {
  assertRepository();
  assertToolchain();
  const local = verifyLocalStage(releaseRoot);
  const sourceSha = assertCleanHead(local.manifest.source.commit);
  fetchMain();
  assertOnMainHistory(sourceSha);
  assertCurrentGithubEvidence(sourceSha, local.manifest);
  assertBetaEnvironment();
  assertImmutableReleases();
  ensureExactTag(local.manifest.tag, sourceSha);
  const release = createOrValidateDraft(local);
  validateRemoteAssets(release, {
    draftRequired: true,
    sourceCommit: sourceSha,
    sourceTree: local.manifest.source.tree,
    tag: local.manifest.tag,
    version: local.manifest.version,
  });
  const dispatchOutput = gh([
    'workflow',
    'run',
    BETA_WORKFLOW,
    '--ref',
    local.manifest.tag,
    '--field',
    `tag=${local.manifest.tag}`,
  ]);
  const result = {
    artifact_sha256: local.manifest.artifact.sha256,
    gate_run_id: parseWorkflowRunId(dispatchOutput),
    manifest_sha256: hashFile(local.manifestPath),
    release_root: local.root,
    release_id: release.id,
    release_url: release.html_url,
    source_commit: sourceSha,
    status: 'drafted',
    tag: local.manifest.tag,
  };
  writePrivateJson(join(local.root, DRAFT_RESULT), result);
  if (dispatchOutput) process.stderr.write(`${dispatchOutput}\n`);
  process.stdout.write(canonicalJsonText(result));
}

function assertImmutableReleases() {
  const policy = ghApi(`repos/${REPOSITORY}/immutable-releases`);
  if (policy?.enabled !== true)
    fail('GitHub immutable releases must be enabled before publication');
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

function assertBetaEnvironment() {
  const environment = ghApi(
    `repos/${REPOSITORY}/environments/${encodeURIComponent(BETA_ENVIRONMENT)}`,
  );
  const policies = ghApi(
    `repos/${REPOSITORY}/environments/${encodeURIComponent(BETA_ENVIRONMENT)}/deployment-branch-policies?per_page=100`,
  );
  return validateBetaEnvironmentPolicy(environment, policies);
}

function readDraftBinding(local, release) {
  const binding = readCanonicalJson(join(local.root, DRAFT_RESULT), 'beta draft result');
  assertExactKeys(
    binding,
    [
      'artifact_sha256',
      'gate_run_id',
      'manifest_sha256',
      'release_id',
      'release_root',
      'release_url',
      'source_commit',
      'status',
      'tag',
    ],
    'beta draft result',
  );
  if (
    binding.status !== 'drafted' ||
    binding.release_root !== local.root ||
    binding.release_id !== release.id ||
    binding.source_commit !== local.manifest.source.commit ||
    binding.artifact_sha256 !== local.manifest.artifact.sha256 ||
    binding.manifest_sha256 !== hashFile(local.manifestPath) ||
    binding.tag !== local.manifest.tag ||
    !Number.isSafeInteger(binding.gate_run_id) ||
    binding.gate_run_id <= 0
  ) {
    fail('beta draft result is not bound to this exact release, source, and artifact');
  }
  return binding;
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

function assertPublishIntent(local, binding, writeIfMissing) {
  const path = join(local.root, PUBLISH_INTENT);
  const expected = buildPublishIntent({
    artifactSha256: local.manifest.artifact.sha256,
    gateRunId: binding.gate_run_id,
    manifestSha256: hashFile(local.manifestPath),
    releaseId: binding.release_id,
    sourceCommit: local.manifest.source.commit,
    tag: local.manifest.tag,
  });
  if (!existsSync(path)) {
    if (!writeIfMissing) {
      fail(
        'published release lacks a pre-publication local intent; refusing retroactive attestation',
      );
    }
    writePrivateJson(path, expected);
  }
  const actual = readCanonicalJson(path, 'beta publish intent');
  if (canonicalJsonText(actual) !== canonicalJsonText(expected)) {
    fail('beta publish intent differs from this exact gate authorization');
  }
  return actual;
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

function successfulHostedGate(manifest, binding, environmentPolicy) {
  const runRecord = ghApi(`repos/${REPOSITORY}/actions/runs/${binding.gate_run_id}`);
  const jobs = ghApi(`repos/${REPOSITORY}/actions/runs/${binding.gate_run_id}/jobs?per_page=100`);
  const approvals = ghApi(`repos/${REPOSITORY}/actions/runs/${binding.gate_run_id}/approvals`);
  return validateHostedGateEvidence(
    { runRecord, jobs, approvals },
    manifest,
    binding,
    environmentPolicy,
  );
}

function publishBeta(releaseRoot, confirmSourceSha, confirmArtifactSha) {
  assertRepository();
  assertToolchain();
  const local = verifyLocalStage(releaseRoot);
  if (
    confirmSourceSha !== local.manifest.source.commit ||
    confirmArtifactSha !== local.manifest.artifact.sha256
  ) {
    fail('explicit source and artifact confirmations must match the staged manifest');
  }
  const sourceSha = assertCleanHead(local.manifest.source.commit);
  fetchMain();
  assertOnMainHistory(sourceSha);
  if (remoteTagTarget(local.manifest.tag) !== sourceSha) fail('remote beta tag changed');
  assertCurrentGithubEvidence(sourceSha, local.manifest);
  assertImmutableReleases();
  const environmentPolicy = assertBetaEnvironment();
  const release = releaseForTag(local.manifest.tag);
  if (!release) fail(`GitHub release does not exist: ${local.manifest.tag}`);
  const binding = readDraftBinding(local, release);
  const { manifest } = validateRemoteAssets(release, {
    draftRequired: release.draft,
    sourceCommit: sourceSha,
    sourceTree: local.manifest.source.tree,
    tag: local.manifest.tag,
    version: local.manifest.version,
  });
  if (!canonicalJsonBytes(manifest).equals(canonicalJsonBytes(local.manifest))) {
    fail('remote beta manifest differs from the locally staged manifest');
  }
  const hosted = successfulHostedGate(manifest, binding, environmentPolicy);
  if (release.draft) {
    const finalDraft = releaseForTag(manifest.tag);
    if (finalDraft?.id !== release.id || finalDraft?.draft !== true) {
      fail('beta draft changed before publication');
    }
    const { manifest: finalManifest } = validateRemoteAssets(finalDraft, {
      draftRequired: true,
      sourceCommit: sourceSha,
      sourceTree: local.manifest.source.tree,
      tag: local.manifest.tag,
      version: local.manifest.version,
    });
    if (!canonicalJsonBytes(finalManifest).equals(canonicalJsonBytes(local.manifest))) {
      fail('beta draft manifest changed before publication');
    }
    assertPublishIntent(local, binding, true);
    gh(['release', 'edit', manifest.tag, '--draft=false', '--prerelease', '--latest=false'], {
      capture: 'inherit',
    });
  } else {
    assertPublishIntent(local, binding, false);
  }
  const published = releaseForTag(manifest.tag);
  validateReleaseRecord(published, manifest, false);
  if (published.immutable !== true) fail('published beta release is not immutable');
  const publishedTime = Date.parse(published.published_at ?? '');
  const gateTime = Date.parse(hosted.job.completed_at);
  if (!Number.isFinite(publishedTime) || !Number.isFinite(gateTime) || publishedTime < gateTime) {
    fail('beta publication timestamp predates the successful hosted gate');
  }
  assertImmutableReleases();
  validateRemoteAssets(published, {
    draftRequired: false,
    sourceCommit: sourceSha,
    sourceTree: local.manifest.source.tree,
    tag: local.manifest.tag,
    version: local.manifest.version,
  });
  const result = {
    artifact_sha256: manifest.artifact.sha256,
    gate_run_id: hosted.run.id,
    gate_run_url: hosted.run.html_url,
    release_root: local.root,
    release_url: published.html_url,
    source_commit: sourceSha,
    status: 'published',
    tag: manifest.tag,
  };
  writePrivateJson(join(local.root, PUBLISH_RESULT), result);
  process.stdout.write(canonicalJsonText(result));
}

export function main(argv = process.argv.slice(2)) {
  const { command, values } = parseArgs(argv);
  if (command === 'stage') {
    assertArgs(values, []);
    stageBeta();
    return;
  }
  if (command === 'draft') {
    assertArgs(values, ['--release-root']);
    draftBeta(values['--release-root']);
    return;
  }
  if (command === 'validate-hosted') {
    assertArgs(values, ['--tag']);
    validateHostedTag(values['--tag']);
    return;
  }
  if (command === 'publish') {
    assertArgs(values, ['--confirm-artifact-sha', '--confirm-source-sha', '--release-root']);
    publishBeta(
      values['--release-root'],
      values['--confirm-source-sha'],
      values['--confirm-artifact-sha'],
    );
    return;
  }
  fail(`unknown command: ${command}`);
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
