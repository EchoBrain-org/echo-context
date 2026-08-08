#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  canonicalJsonBytes,
  canonicalJsonText,
  parseCanonicalJsonBytes,
  sha256,
} from './canonical-json.mjs';
import {
  compareBetaVersions,
  EXPECTED_NODE,
  githubEvidenceRecord,
  parseBetaVersion,
  renderBetaReleaseNotes,
  selectIndependentApproval,
  selectVerifyCheck,
  validateBetaEnvironmentPolicy,
  validateBetaManifest,
  validateHostedGateEvidence,
  validateManifestGithubEvidence,
  validateReleaseRecord,
  validateReleaseNotesFragment,
  validateRemoteReleasePayload,
} from './beta-release-domain.mjs';
import { verifyStagedPromotion } from './beta-promotion-evidence.mjs';
import {
  assembleBetaReleaseStatus,
  classifyReleaseLookup,
  exactHostedRunIdentity,
  formatBetaReleaseStatus,
  hasExactKeys,
  selectBetaCandidate,
  validateDraftBinding,
  validatePublishRecords,
} from './beta-release-status-state.mjs';

export {
  assembleBetaReleaseStatus,
  classifyReleaseLookup,
  deriveBetaReleaseState,
  exactHostedRunIdentity,
  formatBetaReleaseStatus,
  selectBetaCandidate,
  validateDraftBinding,
  validatePublishRecords,
} from './beta-release-status-state.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REPOSITORY = 'EchoBrain-org/echo-context';
const CANONICAL_REMOTE = `https://github.com/${REPOSITORY}.git`;
const RELEASES_DIRECTORY = join(homedir(), '.local', 'share', 'echo-context', 'releases');
const ONBOARDING_RECORD = join(homedir(), '.echo', 'state', 'onboarding.json');
const MAX_COMMAND_BYTES = 1024 * 1024;
const MAX_JSON_BYTES = 256 * 1024;
const MAX_PAGINATED_BYTES = 8 * 1024 * 1024;
const MAX_GITHUB_ROWS = 1_000;
const MAX_ARTIFACT_BYTES = 64 * 1024 * 1024;
const MAX_RELEASE_ROOTS = 128;
const MAX_MANIFEST_BYTES = 256 * 1024;
const MAX_CHECKSUM_BYTES = 512;
const RUNTIME_MANIFEST_MEMBER = 'package/dist/artifact-manifest.json';
const SHA_40 = /^[0-9a-f]{40}$/u;
const SHA_64 = /^[0-9a-f]{64}$/u;

function isStatusScratchArtifact(path) {
  if (typeof path !== 'string' || !isAbsolute(path) || basename(path) !== 'artifact.tgz') {
    return false;
  }
  const parent = dirname(resolve(path));
  return (
    parent.startsWith(`${resolve(tmpdir())}${sep}`) &&
    basename(parent).startsWith('echo-context-beta-observe-')
  );
}

export function isReadOnlyCommand(executable, argv) {
  if (executable === '/usr/bin/tar') {
    return (
      argv.length === 3 &&
      argv[0] === '-xOzf' &&
      isStatusScratchArtifact(argv[1]) &&
      argv[2] === RUNTIME_MANIFEST_MEMBER
    );
  }
  if (executable === 'git') {
    const [subcommand, ...rest] = argv;
    if (subcommand === 'branch') return JSON.stringify(rest) === JSON.stringify(['--show-current']);
    if (subcommand === 'status') {
      return JSON.stringify(rest) === JSON.stringify(['--porcelain=v1', '--untracked-files=all']);
    }
    if (subcommand === 'rev-parse') {
      return rest.length === 1 && /^(?:HEAD|refs\/heads\/main)$/u.test(rest[0]);
    }
    if (subcommand === 'ls-remote') {
      return (
        rest[0] === CANONICAL_REMOTE &&
        rest.slice(1).every((value) => /^refs\/(?:heads\/main|tags\/v[0-9].*)$/u.test(value))
      );
    }
    if (subcommand === 'show-ref') {
      return (
        rest.length === 3 &&
        rest[0] === '--verify' &&
        rest[1] === '--quiet' &&
        /^refs\/tags\/v[0-9].*$/u.test(rest[2])
      );
    }
    if (subcommand === 'rev-list') {
      return rest.length === 3 && rest[0] === '-n' && rest[1] === '1' && /^v[0-9].*$/u.test(rest[2]);
    }
    if (subcommand === 'cat-file') {
      return (
        (rest.length === 2 && rest[0] === '-e' && /^[0-9a-f]{40}\^\{commit\}$/u.test(rest[1])) ||
        (rest.length === 2 && rest[0] === 'blob' && /^[0-9a-f]{40}:release-notes\//u.test(rest[1]))
      );
    }
    if (subcommand === 'ls-tree') {
      return rest.length === 3 && SHA_40.test(rest[0]) && rest[1] === '--' && rest[2].startsWith('release-notes/');
    }
    if (subcommand === 'merge-base') {
      return rest.length === 3 && rest[0] === '--is-ancestor' && SHA_40.test(rest[1]) && SHA_40.test(rest[2]);
    }
    return false;
  }
  if (executable !== 'gh' || argv[0] !== 'api') return false;
  const methodIndex = argv.indexOf('--method');
  return (
    methodIndex >= 0 &&
    argv.filter((value) => value === '--method').length === 1 &&
    argv[methodIndex + 1] === 'GET' &&
    !argv.some((value) => ['--field', '--input', '-f', '-F'].includes(value))
  );
}

function command(executable, argv, options = {}) {
  if (!isReadOnlyCommand(executable, argv)) {
    throw new Error(`beta release status rejected non-read-only command: ${executable} ${argv[0] ?? ''}`);
  }
  const binary = options.binary === true;
  const result = spawnSync(executable, argv, {
    cwd: ROOT,
    encoding: binary ? null : 'utf8',
    maxBuffer: options.maxBuffer ?? MAX_COMMAND_BYTES,
    shell: false,
    timeout: options.timeout ?? 8_000,
  });
  const stderr = Buffer.isBuffer(result.stderr)
    ? result.stderr.toString('utf8')
    : String(result.stderr ?? '');
  if (result.error || result.signal || result.status !== 0) {
    return {
      error: (result.error?.message || stderr.trim() || `exit ${result.status}`).slice(-1_024),
      status: result.status,
      state: 'unknown',
    };
  }
  return { state: 'observed', value: binary ? Buffer.from(result.stdout ?? []) : String(result.stdout ?? '').trim() };
}

function git(argv, options = {}) {
  return command('git', argv, options);
}

function githubJson(endpoint) {
  const result = command('gh', [
    'api',
    '--hostname',
    'github.com',
    '--method',
    'GET',
    '-H',
    'X-GitHub-Api-Version: 2026-03-10',
    endpoint,
  ]);
  if (result.state === 'unknown') {
    if (result.status === 1 && /(?:HTTP 404|Not Found)/u.test(result.error ?? '')) {
      return { state: 'not_found' };
    }
    return result;
  }
  try {
    return { state: 'observed', value: JSON.parse(result.value) };
  } catch (error) {
    return { state: 'unknown', error: `GitHub returned invalid JSON: ${error.message}` };
  }
}

function githubPages(endpoint, arrayField) {
  const result = command('gh', [
    'api',
    '--hostname',
    'github.com',
    '--method',
    'GET',
    '-H',
    'X-GitHub-Api-Version: 2026-03-10',
    '--paginate',
    '--slurp',
    endpoint,
  ], { maxBuffer: MAX_PAGINATED_BYTES });
  if (result.state !== 'observed') return result;
  try {
    const pages = JSON.parse(result.value);
    if (!Array.isArray(pages)) throw new Error('response is not a page array');
    const values = pages.flatMap((page) => {
      const rows = arrayField ? page?.[arrayField] : page;
      if (!Array.isArray(rows)) throw new Error(`page lacks ${arrayField ?? 'an array'}`);
      return rows;
    });
    if (values.length > MAX_GITHUB_ROWS) throw new Error(`response exceeds ${MAX_GITHUB_ROWS} rows`);
    return { state: 'observed', value: values };
  } catch (error) {
    return { state: 'unknown', error: `GitHub returned invalid pages: ${error.message}` };
  }
}

class UnavailableEvidenceError extends Error {}

function githubBytes(endpoint, maxBytes) {
  const result = command(
    'gh',
    [
      'api',
      '--hostname',
      'github.com',
      '--method',
      'GET',
      '-H',
      'X-GitHub-Api-Version: 2026-03-10',
      '-H',
      'Accept: application/octet-stream',
      endpoint,
    ],
    { binary: true, maxBuffer: maxBytes, timeout: 30_000 },
  );
  if (result.state !== 'observed') {
    throw new UnavailableEvidenceError(`GitHub asset is unavailable: ${result.error}`);
  }
  return result.value;
}

function remoteAssetBytes(asset, maximumBytes) {
  if (
    !asset ||
    !Number.isSafeInteger(asset.id) ||
    asset.id <= 0 ||
    !Number.isSafeInteger(asset.size) ||
    asset.size < 0
  ) {
    throw new Error('release asset lacks a valid ID or byte count');
  }
  if (asset.size > maximumBytes) {
    throw new Error(`release asset ${asset.name} exceeds its byte limit`);
  }
  const bytes = githubBytes(
    `repos/${REPOSITORY}/releases/assets/${asset.id}`,
    maximumBytes,
  );
  if (bytes.byteLength !== asset.size) {
    throw new Error(`release asset ${asset.name} byte count differs`);
  }
  if (asset.digest && asset.digest !== `sha256:${sha256(bytes)}`) {
    throw new Error(`release asset ${asset.name} digest differs`);
  }
  return bytes;
}

function validateObservedReleaseAssets(release, expected) {
  const manifestAsset = release.assets.find(
    (asset) => asset.name === 'beta-release-manifest.v1.json',
  );
  if (!manifestAsset) throw new Error('release omits beta-release-manifest.v1.json');
  const manifestBytes = remoteAssetBytes(manifestAsset, MAX_MANIFEST_BYTES);
  const manifest = validateBetaManifest(
    parseCanonicalJsonBytes(manifestBytes, 'remote beta release manifest'),
    expected,
  );
  validateReleaseRecord(release, manifest, expected.draftRequired, expected.releaseNotes);
  const artifactAsset = release.assets.find(
    (asset) => asset.name === manifest.artifact.filename,
  );
  const checksumAsset = release.assets.find(
    (asset) => asset.name === `${manifest.artifact.filename}.sha256`,
  );
  const artifactBytes = remoteAssetBytes(artifactAsset, MAX_ARTIFACT_BYTES);
  const checksumBytes = remoteAssetBytes(checksumAsset, MAX_CHECKSUM_BYTES);
  const scratch = mkdtempSync(join(tmpdir(), 'echo-context-beta-observe-'));
  try {
    const artifactPath = join(scratch, 'artifact.tgz');
    writeFileSync(artifactPath, artifactBytes, { mode: 0o600 });
    const runtime = command(
      '/usr/bin/tar',
      ['-xOzf', artifactPath, RUNTIME_MANIFEST_MEMBER],
      { binary: true, maxBuffer: 4 * 1024 * 1024 },
    );
    if (runtime.state !== 'observed') {
      throw new UnavailableEvidenceError(
        `runtime manifest extraction is unavailable: ${runtime.error}`,
      );
    }
    return validateRemoteReleasePayload(
      {
        artifactBytes,
        checksumBytes,
        manifestBytes,
        release,
        runtimeManifestBytes: runtime.value,
      },
      expected,
    );
  } finally {
    rmSync(scratch, { force: true, recursive: true });
  }
}

function readBoundedJson(path, canonical = false) {
  if (!existsSync(path)) return { state: 'absent' };
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_JSON_BYTES) {
      return { state: 'unknown', error: `unsafe or oversized state file: ${path}` };
    }
    const bytes = readFileSync(path);
    return {
      bytes,
      state: 'observed',
      value: canonical ? parseCanonicalJsonBytes(bytes, path) : JSON.parse(bytes.toString('utf8')),
    };
  } catch (error) {
    return { state: 'unknown', error: `cannot read ${path}: ${error.message}` };
  }
}

function localCheckout() {
  const head = git(['rev-parse', 'HEAD']);
  const branch = git(['branch', '--show-current']);
  const worktree = git(['status', '--porcelain=v1', '--untracked-files=all']);
  const packageRecord = readBoundedJson(join(ROOT, 'package.json'));
  if (
    head.state !== 'observed' ||
    branch.state !== 'observed' ||
    worktree.state !== 'observed' ||
    packageRecord.state !== 'observed'
  ) {
    throw new Error('beta status requires a readable Git checkout and package.json');
  }
  const beta = parseBetaVersion(packageRecord.value.version);
  return {
    branch: branch.value || '(detached)',
    clean: worktree.value === '',
    head: head.value,
    version: beta.version,
  };
}

function remoteRefs(tag) {
  const result = git([
    'ls-remote',
    CANONICAL_REMOTE,
    'refs/heads/main',
    `refs/tags/${tag}`,
    `refs/tags/${tag}^{}`,
  ]);
  if (result.state === 'unknown') return result;
  const refs = new Map(
    result.value
      .split('\n')
      .filter(Boolean)
      .map((line) => line.split(/\s+/u).reverse()),
  );
  return {
    state: 'observed',
    main: refs.get('refs/heads/main') ?? null,
    tag: refs.get(`refs/tags/${tag}^{}`) ?? refs.get(`refs/tags/${tag}`) ?? null,
  };
}

function localTagTarget(tag) {
  const exists = git(['show-ref', '--verify', '--quiet', `refs/tags/${tag}`]);
  if (exists.state === 'unknown' && exists.status === 1) return { state: 'absent', target: null };
  if (exists.state === 'unknown') return exists;
  const target = git(['rev-list', '-n', '1', tag]);
  return target.state === 'observed'
    ? { state: 'observed', target: target.value }
    : target;
}

function regularFile(path, maximumBytes = MAX_ARTIFACT_BYTES) {
  if (!existsSync(path)) return false;
  const stat = lstatSync(path);
  return stat.isFile() && !stat.isSymbolicLink() && stat.size <= maximumBytes;
}

function hashFile(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function readOptionalCanonical(path) {
  const result = readBoundedJson(path, true);
  if (result.state === 'unknown') throw new Error(result.error);
  return result.state === 'observed' ? result.value : null;
}

function validateInstalledStageEvidence(root, result, manifest, artifact) {
  const promotionRecord = readBoundedJson(join(root, 'promotion-result.json'), true);
  if (promotionRecord.state !== 'observed') {
    throw new Error(`passed stage lacks a valid promotion-result.json: ${root}`);
  }
  const smoke = promotionRecord.value;
  if (
    !hasExactKeys(smoke, [
      'artifact',
      'artifactDigest',
      'artifactSha256',
      'cliPath',
      'installedPrefix',
      'installedTreeBytes',
      'installedTreeDigest',
      'installedTreeEntries',
      'installedTreeFiles',
      'nodeExecutable',
      'nodeVersion',
      'packageRoot',
      'promotionReceipt',
      'promotionReceiptDigest',
      'schemaVersion',
      'smoke',
      'sourceCommit',
      'version',
    ])
  ) {
    throw new Error(`promotion result has unexpected fields: ${root}`);
  }
  const prefix = join(root, 'prefix');
  const packageRoot = join(prefix, 'lib', 'node_modules', 'echo-context');
  const cliLink = join(prefix, 'bin', 'echo-context');
  const receipt = join(prefix, 'share', 'echo-context', 'promotion-receipt.json');
  if (
    !existsSync(prefix) ||
    !lstatSync(prefix).isDirectory() ||
    lstatSync(prefix).isSymbolicLink() ||
    realpathSync(prefix) !== prefix ||
    !existsSync(packageRoot) ||
    !lstatSync(packageRoot).isDirectory() ||
    lstatSync(packageRoot).isSymbolicLink() ||
    !existsSync(cliLink) ||
    !regularFile(join(packageRoot, 'dist', 'index.js'), 4 * 1024 * 1024) ||
    !regularFile(join(packageRoot, 'dist', 'cli.js'), 4 * 1024 * 1024) ||
    !regularFile(receipt, 64 * 1024)
  ) {
    throw new Error(`passed stage installed promotion is missing or unsafe: ${root}`);
  }
  const resolvedPackageRoot = realpathSync(packageRoot);
  const resolvedCli = realpathSync(cliLink);
  if (
    smoke.schemaVersion !== 1 ||
    smoke.smoke !== 'passed' ||
    smoke.artifact !== realpathSync(artifact) ||
    smoke.artifactSha256 !== manifest.artifact.sha256 ||
    smoke.artifactDigest !== manifest.artifact.runtime_manifest_digest ||
    smoke.sourceCommit !== manifest.source.commit ||
    smoke.version !== manifest.version ||
    smoke.nodeVersion !== EXPECTED_NODE.slice(1) ||
    smoke.nodeExecutable !== realpathSync(process.execPath) ||
    smoke.installedPrefix !== prefix ||
    smoke.packageRoot !== resolvedPackageRoot ||
    smoke.cliPath !== resolvedCli ||
    resolvedCli !== join(resolvedPackageRoot, 'dist', 'cli.js') ||
    smoke.installedTreeDigest !== manifest.promotion.installed_tree_digest ||
    smoke.promotionReceipt !== receipt ||
    smoke.promotionReceiptDigest !== manifest.promotion.receipt_sha256 ||
    result.promotion_receipt !== receipt ||
    result.promotion_receipt_sha256 !== smoke.promotionReceiptDigest ||
    !Number.isSafeInteger(smoke.installedTreeEntries) ||
    smoke.installedTreeEntries <= 0 ||
    smoke.installedTreeEntries > 20_000 ||
    !Number.isSafeInteger(smoke.installedTreeFiles) ||
    smoke.installedTreeFiles <= 0 ||
    smoke.installedTreeFiles > smoke.installedTreeEntries ||
    !Number.isSafeInteger(smoke.installedTreeBytes) ||
    smoke.installedTreeBytes <= 0 ||
    smoke.installedTreeBytes > 512 * 1024 * 1024 ||
    sha256(readFileSync(receipt)) !== smoke.promotionReceiptDigest
  ) {
    throw new Error(`passed stage promotion identity differs at ${root}`);
  }
  verifyStagedPromotion(smoke);
  return smoke;
}

export function scanStages(version, releasesDirectory = RELEASES_DIRECTORY) {
  if (!existsSync(releasesDirectory)) return { state: 'observed', records: [] };
  try {
    const directory = lstatSync(releasesDirectory);
    if (!directory.isDirectory() || directory.isSymbolicLink()) {
      return { state: 'unknown', error: `unsafe releases directory: ${releasesDirectory}` };
    }
    const entries = readdirSync(releasesDirectory, { withFileTypes: true });
    if (entries.length > MAX_RELEASE_ROOTS) {
      return { state: 'unknown', error: `release-root scan exceeds ${MAX_RELEASE_ROOTS} entries` };
    }
    const records = [];
    for (const entry of entries) {
      if (!entry.name.startsWith(`${version}-`)) continue;
      if (!entry.isDirectory() || entry.isSymbolicLink()) {
        return { state: 'unknown', error: `partial or unsafe release root: ${join(releasesDirectory, entry.name)}` };
      }
      const root = join(releasesDirectory, entry.name);
      if (realpathSync(root) !== resolve(root)) {
        return { state: 'unknown', error: `release root resolves through a symlink: ${root}` };
      }
      const stage = readBoundedJson(join(root, 'beta-stage-state.json'), true);
      if (stage.state === 'unknown') return stage;
      if (stage.state === 'absent') {
        return { state: 'unknown', error: `partial release root lacks beta-stage-state.json: ${root}` };
      }
      const source = stage.value?.source_commit;
      if (
        stage.value?.version !== version ||
        stage.value?.tag !== `v${version}` ||
        !SHA_40.test(source ?? '') ||
        entry.name !== `${version}-${source}`
      ) {
        return { state: 'unknown', error: `invalid stage identity: ${root}` };
      }
      if (stage.value.status !== 'passed') {
        records.push({ release_root: root, source_commit: source, state: stage.value.status });
        continue;
      }
      if (!hasExactKeys(stage.value, ['source_commit', 'status', 'tag', 'version'])) {
        return { state: 'unknown', error: `passed stage state has unexpected fields: ${root}` };
      }
      const manifestPath = join(root, 'beta-release-manifest.v1.json');
      const manifestRecord = readBoundedJson(manifestPath, true);
      const resultRecord = readBoundedJson(join(root, 'beta-stage-result.json'), true);
      if (manifestRecord.state !== 'observed' || resultRecord.state !== 'observed') {
        return { state: 'unknown', error: `passed stage lacks its manifest or result: ${root}` };
      }
      let manifest;
      try {
        manifest = validateBetaManifest(manifestRecord.value, {
          sourceCommit: source,
          tag: `v${version}`,
          version,
        });
      } catch (error) {
        return { state: 'unknown', error: `invalid staged manifest at ${root}: ${error.message}` };
      }
      const artifact = join(root, manifest.artifact.filename);
      const checksum = `${artifact}.sha256`;
      const result = resultRecord.value;
      if (
        !hasExactKeys(result, [
          'artifact',
          'artifact_sha256',
          'checksum',
          'installed_prefix',
          'manifest',
          'manifest_sha256',
          'promotion_receipt',
          'promotion_receipt_sha256',
          'release_root',
          'source_commit',
          'status',
          'tag',
          'version',
        ]) ||
        result?.status !== 'passed' ||
        result?.release_root !== root ||
        result?.source_commit !== source ||
        result?.tag !== manifest.tag ||
        result?.version !== manifest.version ||
        result?.artifact !== artifact ||
        result?.artifact_sha256 !== manifest.artifact.sha256 ||
        result?.checksum !== checksum ||
        result?.manifest !== manifestPath ||
        result?.manifest_sha256 !== sha256(manifestRecord.bytes) ||
        result?.installed_prefix !== join(root, 'prefix') ||
        result?.promotion_receipt_sha256 !== manifest.promotion.receipt_sha256 ||
        !regularFile(artifact) ||
        lstatSync(artifact).size !== manifest.artifact.bytes ||
        hashFile(artifact) !== manifest.artifact.sha256 ||
        !regularFile(checksum, 512) ||
        !readFileSync(checksum).equals(
          Buffer.from(`${manifest.artifact.sha256}  ${manifest.artifact.filename}\n`),
        )
      ) {
        return { state: 'unknown', error: `passed stage evidence differs at ${root}` };
      }
      validateInstalledStageEvidence(root, result, manifest, artifact);
      let draft;
      let publishIntent;
      let publishResult;
      try {
        draft = readOptionalCanonical(join(root, 'beta-draft-result.json'));
        publishIntent = readOptionalCanonical(join(root, 'beta-publish-intent.json'));
        publishResult = readOptionalCanonical(join(root, 'beta-publish-result.json'));
      } catch (error) {
        return { state: 'unknown', error: error.message };
      }
      if ((publishIntent || publishResult) && !draft) {
        return { state: 'unknown', error: `publish evidence exists without a draft handoff: ${root}` };
      }
      records.push({
        draft,
        manifest,
        manifest_bytes: manifestRecord.bytes,
        manifest_sha256: result.manifest_sha256,
        publish_intent: publishIntent,
        publish_result: publishResult,
        release_root: root,
        runtime_digest: manifest.artifact.runtime_manifest_digest,
        source_commit: source,
        state: 'recorded_passed',
        tarball_sha256: manifest.artifact.sha256,
      });
    }
    return { state: 'observed', records };
  } catch (error) {
    return { state: 'unknown', error: `cannot scan release roots: ${error.message}` };
  }
}

function releaseNotesState(version, sourceCommit) {
  if (!SHA_40.test(sourceCommit ?? '')) return { state: 'unknown' };
  const commit = git(['cat-file', '-e', `${sourceCommit}^{commit}`]);
  if (commit.state === 'unknown') return { state: 'unknown', error: 'candidate commit is unavailable locally' };
  const path = `release-notes/${version}.md`;
  const row = git(['ls-tree', sourceCommit, '--', path]);
  if (row.state === 'unknown') return row;
  if (row.value === '') return { state: 'missing' };
  if (!/^100644 blob [0-9a-f]{40}\t/u.test(row.value)) return { state: 'invalid' };
  const blob = git(['cat-file', 'blob', `${sourceCommit}:${path}`], {
    binary: true,
    maxBuffer: 64 * 1024,
  });
  if (blob.state === 'unknown') return blob;
  try {
    return {
      fragment: validateReleaseNotesFragment(blob.value, version),
      state: 'present',
    };
  } catch (error) {
    return { state: 'invalid', error: error.message };
  }
}

function sourceOnMain(sourceCommit, remoteMain) {
  if (!SHA_40.test(sourceCommit ?? '') || !SHA_40.test(remoteMain ?? '')) return 'unknown';
  if (sourceCommit === remoteMain) return true;
  const result = git(['merge-base', '--is-ancestor', sourceCommit, remoteMain]);
  if (result.state === 'observed') return true;
  if (result.status === 1) return false;
  return 'unknown';
}

function reviewedSource(checkoutHead, remoteMain, expectedManifest) {
  const pulls = githubPages(
    `repos/${REPOSITORY}/commits/${checkoutHead}/pulls?per_page=100`,
  );
  if (pulls.state !== 'observed') return pulls;
  const candidates = pulls.value
    .filter(
      (pull) =>
        pull?.merged_at &&
        pull?.base?.ref === 'main' &&
        SHA_40.test(pull?.head?.sha ?? '') &&
        typeof pull?.user?.login === 'string' &&
        sourceOnMain(pull.head.sha, remoteMain) === true,
    )
    .sort((left, right) => Number(right.number) - Number(left.number));
  const reviewCandidates = expectedManifest
    ? candidates.filter(
        (pull) =>
          pull.number === expectedManifest.evidence.independent_review.pull_request,
      )
    : candidates;
  for (const pull of reviewCandidates) {
    const reviews = githubPages(`repos/${REPOSITORY}/pulls/${pull.number}/reviews?per_page=100`);
    const checks = githubPages(
      `repos/${REPOSITORY}/commits/${pull.head.sha}/check-runs?check_name=verify&filter=all&per_page=100`,
      'check_runs',
    );
    if (reviews.state !== 'observed' || checks.state !== 'observed') {
      return { state: 'unknown', error: `review or verify evidence is unavailable for PR #${pull.number}` };
    }
    try {
      const selected = expectedManifest
        ? validateManifestGithubEvidence(
            { checks: checks.value, pull, reviews: reviews.value },
            pull.head.sha,
            expectedManifest,
          )
        : (() => {
            const approval = selectIndependentApproval(
              reviews.value,
              pull.user.login,
              pull.head.sha,
            );
            const verify = selectVerifyCheck(checks.value, pull.head.sha);
            return {
              approval,
              evidence: githubEvidenceRecord(pull, approval, verify),
              pull,
              verify,
            };
          })();
      return {
        approval: selected.approval.user.login,
        evidence: selected.evidence,
        pull_request: pull.number,
        source_commit: pull.head.sha,
        state: 'verified',
        verify_url: selected.verify.html_url ?? null,
      };
    } catch {
      // A related PR without exact current approval/check evidence is not release-ready.
    }
  }
  return { state: 'missing' };
}

function normalizeRelease(release) {
  if (!release || typeof release !== 'object') return null;
  return {
    assets: Array.isArray(release.assets)
      ? release.assets.map((asset) => ({
          digest: asset?.digest,
          id: asset?.id,
          name: asset?.name,
          size: asset?.size,
          state: asset?.state,
        }))
      : [],
    body: release.body,
    created_at: release.created_at,
    draft: release.draft === true,
    html_url: release.html_url,
    id: release.id,
    immutable: release.immutable === true,
    name: release.name,
    published_at: release.published_at,
    prerelease: release.prerelease === true,
    tag_name: release.tag_name,
    target_commitish: release.target_commitish,
    version: release.tag_name?.startsWith('v') ? release.tag_name.slice(1) : null,
  };
}

function latestPublicBeta(releases) {
  if (releases.state !== 'observed' || !Array.isArray(releases.value)) {
    return { state: 'unknown' };
  }
  const candidates = releases.value
    .map(normalizeRelease)
    .filter((release) => {
      if (!release || release.draft || !release.prerelease) return false;
      try {
        parseBetaVersion(release.version);
        return true;
      } catch {
        return false;
      }
    })
    .sort((left, right) => compareBetaVersions(right.version, left.version));
  return candidates[0]
    ? {
        immutable: candidates[0].immutable,
        state: 'published',
        tag: candidates[0].tag_name,
        url: candidates[0].html_url ?? null,
        version: candidates[0].version,
      }
    : { state: 'absent' };
}

function releasePolicyStatus() {
  const immutable = githubJson(`repos/${REPOSITORY}/immutable-releases`);
  const workflow = githubJson(`repos/${REPOSITORY}/actions/workflows/beta-release-gate.yml`);
  const environment = githubJson(`repos/${REPOSITORY}/environments/beta-release`);
  const policies = githubJson(
    `repos/${REPOSITORY}/environments/beta-release/deployment-branch-policies?per_page=100`,
  );
  for (const [label, observation] of [
    ['immutable-release policy', immutable],
    ['beta workflow', workflow],
    ['beta environment', environment],
    ['beta environment policies', policies],
  ]) {
    if (observation.state !== 'observed') {
      return { state: 'unknown', error: `${label} is unavailable` };
    }
  }
  try {
    if (immutable.value?.enabled !== true) throw new Error('immutable releases are disabled');
    if (
      workflow.value?.state !== 'active' ||
      workflow.value?.path !== '.github/workflows/beta-release-gate.yml'
    ) {
      throw new Error('beta-release-gate.yml is not active at its canonical path');
    }
    const environmentPolicy = validateBetaEnvironmentPolicy(environment.value, policies.value);
    return { environment_policy: environmentPolicy, state: 'verified' };
  } catch (error) {
    return { state: 'invalid', error: error.message };
  }
}

function gateState(stageRecord, release, environmentPolicy) {
  const bindingResult = validateDraftBinding(stageRecord, release);
  if (bindingResult.state === 'absent') return { state: 'not_started' };
  if (bindingResult.state === 'unknown') return bindingResult;
  const binding = bindingResult.value;
  const runId = binding.gate_run_id;
  if (!Number.isSafeInteger(runId) || runId <= 0) {
    return { state: 'unknown', error: 'draft result has no valid gate run ID' };
  }
  const run = githubJson(`repos/${REPOSITORY}/actions/runs/${runId}`);
  if (run.state !== 'observed') {
    return { state: 'unknown', error: 'recorded hosted gate run is unavailable' };
  }
  if (!exactHostedRunIdentity(run.value, stageRecord, binding)) {
    return { state: 'unknown', error: 'hosted run identity differs from the recorded draft' };
  }
  if (run.value?.status !== 'completed') {
    return { run_id: runId, state: 'pending', url: run.value?.html_url ?? null };
  }
  if (run.value?.conclusion !== 'success') {
    return { run_id: runId, state: 'failed', url: run.value?.html_url ?? null };
  }
  const jobs = githubJson(`repos/${REPOSITORY}/actions/runs/${runId}/jobs?per_page=100`);
  const approvals = githubJson(`repos/${REPOSITORY}/actions/runs/${runId}/approvals`);
  for (const [label, observation] of [
    ['jobs', jobs],
    ['approvals', approvals],
  ]) {
    if (observation.state !== 'observed') {
      return { state: 'unknown', error: `hosted gate ${label} are unavailable` };
    }
  }
  try {
    const hosted = validateHostedGateEvidence(
      { approvals: approvals.value, jobs: jobs.value, runRecord: run.value },
      stageRecord.manifest,
      binding,
      environmentPolicy,
    );
    return {
      completed_at: hosted.job.completed_at,
      run_id: runId,
      state: 'verified_succeeded',
      url: run.value?.html_url ?? null,
    };
  } catch (error) {
    return { state: 'unknown', error: `hosted gate evidence is invalid: ${error.message}` };
  }
}

async function readResponseBytes(response, limit) {
  const chunks = [];
  let total = 0;
  for await (const chunk of response.body) {
    total += chunk.byteLength;
    if (total > limit) throw new Error(`health response exceeds ${limit} bytes`);
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

async function liveStatus() {
  const onboarding = readBoundedJson(ONBOARDING_RECORD);
  if (onboarding.state === 'absent') return { state: 'not_configured' };
  if (onboarding.state === 'unknown') return onboarding;
  const port = onboarding.value?.bound_port;
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    return { state: 'unknown', error: 'onboarding record has no valid bound port' };
  }
  const endpoint = `http://127.0.0.1:${port}/healthz`;
  try {
    const response = await fetch(endpoint, { signal: AbortSignal.timeout(2_000) });
    if (!response.ok) return { endpoint, state: 'unhealthy', status_code: response.status };
    const health = JSON.parse((await readResponseBytes(response, MAX_JSON_BYTES)).toString('utf8'));
    const version = health?.components?.runtime?.details?.version;
    const artifactDigest = health?.components?.runtime?.details?.artifact_digest;
    if (typeof version !== 'string' || !SHA_64.test(artifactDigest ?? '')) {
      return { endpoint, state: 'unknown', error: 'health response lacks runtime identity' };
    }
    return {
      endpoint,
      runtime_digest: artifactDigest,
      state: health.status === 'healthy' ? 'healthy' : 'unhealthy',
      version,
    };
  } catch (error) {
    return { endpoint, state: 'unreachable', error: error.message };
  }
}

export async function collectBetaReleaseStatus() {
  const checkout = localCheckout();
  const beta = parseBetaVersion(checkout.version);
  const localMain = git(['rev-parse', 'refs/heads/main']);
  const refs = remoteRefs(beta.tag);
  const localTag = localTagTarget(beta.tag);
  const stages = scanStages(beta.version);
  const repository = githubJson(`repos/${REPOSITORY}`);
  const releaseRequest = githubJson(`repos/${REPOSITORY}/releases/tags/${beta.tag}`);
  const recentReleases = githubPages(`repos/${REPOSITORY}/releases?per_page=100`);
  const releasePolicy = releasePolicyStatus();
  const unknowns = [];
  for (const [label, observed] of [
    ['local main', localMain],
    ['GitHub refs', refs],
    ['local stages', stages],
    ['repository access', repository],
    ['public releases', recentReleases],
  ]) {
    if (observed.state !== 'observed') unknowns.push(`${label}: ${observed.error ?? 'unavailable'}`);
  }
  if (localTag.state === 'unknown') {
    unknowns.push(`local tag: ${localTag.error ?? 'unavailable'}`);
  }
  if (releasePolicy.state === 'unknown') {
    unknowns.push(`release policy: ${releasePolicy.error ?? 'unavailable'}`);
  }
  const exactRelease = classifyReleaseLookup(releaseRequest, repository);
  if (!['absent', 'observed'].includes(exactRelease.state)) {
    unknowns.push(`candidate release: ${exactRelease.error ?? 'unavailable'}`);
  }
  const stageRecords = stages.state === 'observed' ? stages.records : [];
  const preliminarySelection = selectBetaCandidate({
    checkout,
    localTag,
    refs,
    sourceReviewObservation: { state: 'missing' },
    stageRecords,
  });
  const sourceReviewObservation = reviewedSource(
    preliminarySelection.sourceCommit,
    refs.state === 'observed' ? refs.main : null,
    preliminarySelection.matchingStage?.manifest,
  );
  if (sourceReviewObservation.state === 'unknown') {
    unknowns.push(`source review: ${sourceReviewObservation.error ?? 'unavailable'}`);
  }
  const selection = selectBetaCandidate({
    checkout,
    localTag,
    refs,
    sourceReviewObservation,
    stageRecords,
  });
  const candidateSource = selection.sourceCommit;
  const matchingStage = selection.matchingStage;
  const releaseObserved = exactRelease.state === 'observed';
  const release = releaseObserved ? normalizeRelease(exactRelease.value) : null;
  const releaseNotes = releaseNotesState(beta.version, candidateSource);
  let releaseIdentity = releaseObserved
    ? { state: 'invalid', error: 'release shape is invalid' }
    : { state: 'absent' };
  if (release && matchingStage?.manifest && releaseNotes.state === 'present') {
    try {
      const expectedNotes = renderBetaReleaseNotes(
        matchingStage.manifest,
        releaseNotes.fragment,
      );
      validateReleaseRecord(release, matchingStage.manifest, release.draft, expectedNotes);
      if (!release.draft && release.immutable !== true) {
        throw new Error('published beta is not immutable');
      }
      const remote = validateObservedReleaseAssets(release, {
        draftRequired: release.draft,
        releaseNotes: expectedNotes,
        sourceCommit: candidateSource,
        sourceTree: matchingStage.manifest.source.tree,
        tag: beta.tag,
        version: beta.version,
      });
      if (!canonicalJsonBytes(remote.manifest).equals(matchingStage.manifest_bytes)) {
        throw new Error('remote release manifest differs from the exact local stage');
      }
      releaseIdentity = { state: 'validated' };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      if (error instanceof UnavailableEvidenceError) {
        unknowns.push(`release validation: ${detail}`);
        releaseIdentity = { state: 'unknown', error: detail };
      } else {
        releaseIdentity = { state: 'invalid', error: detail };
      }
    }
  }
  const draftBinding = validateDraftBinding(matchingStage, release);
  if (draftBinding.state === 'unknown') {
    releaseIdentity = { state: 'invalid', error: draftBinding.error };
  }
  const publishRecords =
    draftBinding.state === 'observed'
      ? validatePublishRecords(matchingStage, draftBinding.value, release)
      : { intent: 'absent', state: 'absent' };
  if (publishRecords.state === 'unknown') {
    releaseIdentity = { state: 'invalid', error: publishRecords.error };
  }
  const gate =
    draftBinding.state === 'observed' && releasePolicy.state === 'verified'
      ? gateState(matchingStage, release, releasePolicy.environment_policy)
      : { state: 'not_started' };
  if (gate.state === 'unknown') unknowns.push(`hosted gate: ${gate.error ?? 'unavailable'}`);
  const live = await liveStatus();
  if (live.state === 'unknown') unknowns.push(`live runtime: ${live.error ?? 'unavailable'}`);
  return assembleBetaReleaseStatus({
    beta,
    checkout,
    draftBinding,
    gate,
    latestPublicBeta: latestPublicBeta(recentReleases),
    live,
    localMain,
    localTag,
    publishRecords,
    refs,
    release,
    releaseIdentity,
    releaseNotes,
    releasePolicy,
    sourceOnMain: sourceOnMain(
      candidateSource,
      refs.state === 'observed' ? refs.main : null,
    ),
    sourceReviewObservation,
    stageRecords,
    unknowns,
  });
}

export function parseStatusArgs(argv) {
  if (argv.length === 0) return { json: false };
  if (argv.length === 1 && argv[0] === '--json') return { json: true };
  throw new Error('beta release status: usage: beta:status [-- --json]');
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseStatusArgs(argv);
  const status = await collectBetaReleaseStatus();
  process.stdout.write(options.json ? canonicalJsonText(status) : `${formatBetaReleaseStatus(status)}\n`);
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
