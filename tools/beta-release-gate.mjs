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
import {
  BETA_ENVIRONMENT,
  BETA_WORKFLOW,
  EXPECTED_NODE,
  EXPECTED_NPM,
  REPOSITORY,
  SHA_40,
  SHA_64,
  VERIFY_CHECK,
  buildPublishIntent,
  compareBetaVersions,
  githubEvidenceRecord,
  parseBetaVersion,
  renderBetaReleaseNotes,
  selectIndependentApproval,
  selectVerifyCheck,
  tryParseBetaVersion,
  validateBetaEnvironmentPolicy,
  validateHostedGateEvidence,
  validateHostedGateRunRecord,
  validateManifestGithubEvidence,
  validateBetaManifest,
  validateReleaseNotesFragment,
  validateReleaseRecord,
  validateRemoteReleasePayload,
} from './beta-release-domain.mjs';
import { verifyStagedPromotion } from './beta-promotion-evidence.mjs';

export {
  buildPublishIntent,
  compareBetaVersions,
  githubEvidenceRecord,
  parseBetaVersion,
  selectIndependentApproval,
  selectVerifyCheck,
  validateBetaEnvironmentPolicy,
  validateHostedGateEvidence,
  validateHostedGateRunRecord,
  validateManifestGithubEvidence,
  validateBetaManifest,
  validateReleaseNotesFragment,
  validateReleaseAssetRoster,
  validateReleaseRecord,
  validateRemoteReleasePayload,
  validateRuntimeManifestBytes,
} from './beta-release-domain.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const GITHUB_HOST = 'github.com';
const GH_REPOSITORY = `${GITHUB_HOST}/${REPOSITORY}`;
const CANONICAL_REMOTE = `https://${GITHUB_HOST}/${REPOSITORY}.git`;
const CANONICAL_CHECKOUT_REMOTE = `https://${GITHUB_HOST}/${REPOSITORY}`;
const MAIN_REF = 'refs/remotes/echo-release-gate/main';
const GITHUB_API_VERSION = '2026-03-10';
const RELEASE_MANIFEST = 'beta-release-manifest.v1.json';
const STAGE_STATE = 'beta-stage-state.json';
const STAGE_RESULT = 'beta-stage-result.json';
const DRAFT_RESULT = 'beta-draft-result.json';
const PUBLISH_INTENT = 'beta-publish-intent.json';
const PUBLISH_RESULT = 'beta-publish-result.json';
const RELEASE_NOTES_DIRECTORY = 'release-notes';
const MAX_API_BYTES = 64 * 1024 * 1024;
const MAX_ARTIFACT_BYTES = 64 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 256 * 1024;
const MAX_CHECKSUM_BYTES = 512;
const MAX_RELEASE_NOTES_BYTES = 64 * 1024;

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

function releaseNotesPath(version) {
  return `${RELEASE_NOTES_DIRECTORY}/${parseBetaVersion(version).version}.md`;
}

function releaseNotesFragmentAtSource(version, sourceSha) {
  assertString(sourceSha, SHA_40, 'release-notes source commit');
  const path = releaseNotesPath(version);
  const treeRow = git(['ls-tree', sourceSha, '--', path]);
  if (!treeRow) fail(`reviewed release notes are missing for ${version}`);
  if (!/^100644 blob [0-9a-f]{40}\t/u.test(treeRow)) {
    fail(`reviewed release notes for ${version} must be a regular tracked file`);
  }
  const blob = `${sourceSha}:${path}`;
  const size = Number(git(['cat-file', '-s', blob]));
  if (!Number.isSafeInteger(size) || size <= 0 || size > MAX_RELEASE_NOTES_BYTES) {
    fail(`reviewed release notes for ${version} must contain 1-${MAX_RELEASE_NOTES_BYTES} bytes`);
  }
  return validateReleaseNotesFragment(
    git(['cat-file', 'blob', blob], { capture: 'buffer', maxBuffer: MAX_RELEASE_NOTES_BYTES }),
    version,
  );
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
    manifest: githubEvidenceRecord(pull, approval, verify),
  };
}

function assertCurrentGithubEvidence(sourceSha, manifest) {
  const reviewEvidence = manifest.evidence.independent_review;
  const pull = ghApi(`repos/${REPOSITORY}/pulls/${reviewEvidence.pull_request}`);
  const reviews = ghApiAll(
    `repos/${REPOSITORY}/pulls/${reviewEvidence.pull_request}/reviews?per_page=100`,
  );
  const checks = ghApiAll(
    `repos/${REPOSITORY}/commits/${sourceSha}/check-runs?check_name=${VERIFY_CHECK}&filter=all&per_page=100`,
    {
      arrayField: 'check_runs',
      headers: ['Accept: application/vnd.github+json'],
    },
  );
  return validateManifestGithubEvidence({ checks, pull, reviews }, sourceSha, manifest);
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

function assertBetaWorkflowActive() {
  const workflow = ghApi(`repos/${REPOSITORY}/actions/workflows/${BETA_WORKFLOW}`);
  if (
    workflow?.state !== 'active' ||
    workflow?.path !== `.github/workflows/${BETA_WORKFLOW}`
  ) {
    fail(`GitHub workflow ${BETA_WORKFLOW} must be active at its canonical path`);
  }
}

function stagePreflight(beta, sourceSha) {
  betaReleaseNotes({ version: beta.version, source: { commit: sourceSha } });
  fetchMain();
  assertOnMainHistory(sourceSha);
  assertVersionIsNew(beta);
  assertTagAndReleaseAbsent(beta.tag);
  const evidence = githubEvidence(sourceSha);
  assertBetaEnvironment();
  assertImmutableReleases();
  assertBetaWorkflowActive();
  return evidence;
}

function stageBeta() {
  assertRepository();
  assertToolchain();
  const sourceSha = assertCleanHead();
  const { beta } = readPackageIdentity();
  stagePreflight(beta, sourceSha);
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
  const evidence = stagePreflight(beta, sourceSha);
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
  verifyStagedPromotion(smoke);
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

function inspectExactTag(tag, sourceSha) {
  const localTarget = localTagTarget(tag);
  if (localTarget && localTarget !== sourceSha) fail(`local ${tag} points at another commit`);
  const remoteTarget = remoteTagTarget(tag);
  if (remoteTarget && remoteTarget !== sourceSha) fail(`remote ${tag} points at another commit`);
  return { localTarget, remoteTarget };
}

function ensureExactTag(tag, sourceSha, inspected = inspectExactTag(tag, sourceSha)) {
  if (!inspected.localTarget) {
    git(['tag', '--annotate', tag, '--message', `ECHO Context ${tag}`, sourceSha]);
  }
  const remoteTarget = inspected.remoteTarget;
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

export function betaReleaseNotes(manifest, fragment) {
  assertString(manifest?.source?.commit, SHA_40, 'release-notes source commit');
  const changes =
    fragment === undefined
      ? releaseNotesFragmentAtSource(manifest.version, manifest.source.commit)
      : validateReleaseNotesFragment(fragment, manifest.version);
  return renderBetaReleaseNotes(manifest, changes);
}

function createOrValidateDraft(local, notes, existingRelease) {
  let release = existingRelease;
  if (!release) {
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
  validateReleaseRecord(release, local.manifest, true, notes);
  return release;
}

function remoteAssetBytes(asset, maxBytes) {
  if (!asset || !Number.isSafeInteger(asset.id) || asset.id <= 0) {
    fail('GitHub release asset is missing or lacks a valid ID');
  }
  if (!Number.isSafeInteger(asset.size) || asset.size < 0) {
    fail(`GitHub asset ${asset.name} has an invalid byte count`);
  }
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

export function validateRemoteReleaseAssets(release, expected = {}) {
  const manifestAsset = release.assets.find((asset) => asset.name === RELEASE_MANIFEST);
  if (!manifestAsset) fail(`release omits ${RELEASE_MANIFEST}`);
  const manifestBytes = remoteAssetBytes(manifestAsset, MAX_MANIFEST_BYTES);
  const manifest = validateBetaManifest(
    parseCanonicalJsonBytes(manifestBytes, 'remote beta release manifest'),
    expected,
  );
  const releaseNotes = expected.releaseNotes ?? betaReleaseNotes(manifest);
  validateReleaseRecord(release, manifest, expected.draftRequired ?? true, releaseNotes);
  const artifactAsset = release.assets.find((asset) => asset.name === manifest.artifact.filename);
  const checksumAsset = release.assets.find(
    (asset) => asset.name === `${manifest.artifact.filename}.sha256`,
  );
  const artifactBytes = remoteAssetBytes(artifactAsset, MAX_ARTIFACT_BYTES);
  const checksumBytes = remoteAssetBytes(checksumAsset, MAX_CHECKSUM_BYTES);
  const scratch = mkdtempSync(join(tmpdir(), 'echo-context-beta-validate-'));
  try {
    const artifactPath = join(scratch, manifest.artifact.filename);
    writeFileSync(artifactPath, artifactBytes, { mode: 0o600 });
    const runtimeManifestBytes = run(
      '/usr/bin/tar',
      ['-xOzf', artifactPath, 'package/dist/artifact-manifest.json'],
      { capture: 'buffer', maxBuffer: 4 * 1024 * 1024 },
    );
    return validateRemoteReleasePayload(
      {
        artifactBytes,
        checksumBytes,
        manifestBytes,
        release,
        runtimeManifestBytes,
      },
      { ...expected, releaseNotes },
    );
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
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
  const notes = betaReleaseNotes(local.manifest);
  fetchMain();
  assertOnMainHistory(sourceSha);
  assertCurrentGithubEvidence(sourceSha, local.manifest);
  assertBetaEnvironment();
  assertImmutableReleases();
  assertBetaWorkflowActive();
  const inspectedTag = inspectExactTag(local.manifest.tag, sourceSha);
  const existingRelease = releaseForTag(local.manifest.tag);
  if (existingRelease) {
    const { manifest: existingManifest } = validateRemoteReleaseAssets(existingRelease, {
      draftRequired: true,
      sourceCommit: sourceSha,
      sourceTree: local.manifest.source.tree,
      tag: local.manifest.tag,
      version: local.manifest.version,
    });
    if (!canonicalJsonBytes(existingManifest).equals(canonicalJsonBytes(local.manifest))) {
      fail('existing beta draft manifest differs from the locally staged manifest');
    }
  }
  ensureExactTag(local.manifest.tag, sourceSha, inspectedTag);
  const release = createOrValidateDraft(local, notes, existingRelease);
  validateRemoteReleaseAssets(release, {
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
  const { manifest } = validateRemoteReleaseAssets(release, {
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
    const { manifest: finalManifest } = validateRemoteReleaseAssets(finalDraft, {
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
  validateReleaseRecord(published, manifest, false, betaReleaseNotes(manifest));
  if (published.immutable !== true) fail('published beta release is not immutable');
  const publishedTime = Date.parse(published.published_at ?? '');
  const gateTime = Date.parse(hosted.job.completed_at);
  if (!Number.isFinite(publishedTime) || !Number.isFinite(gateTime) || publishedTime < gateTime) {
    fail('beta publication timestamp predates the successful hosted gate');
  }
  assertImmutableReleases();
  validateRemoteReleaseAssets(published, {
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
