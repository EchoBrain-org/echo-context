#!/usr/bin/env node

import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import https from 'node:https';
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const OWNER = 'zhenye0616';
const REPO = 'echo-context';
const API_VERSION = '2022-11-28';
const ASSET_SUFFIXES = ['.tgz', '.tgz.sha256', '.manifest.json'];

function die(message) {
  throw new Error(`release-publication-controller: ${message}`);
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function marker(name, target, runId, runAttempt) {
  process.stdout.write(`diagnostic mutation=${name} target=${target} run_id=${runId} run_attempt=${runAttempt}\n`);
}

export function annotation(version, sourceSha) {
  return `echo-context source release\nversion: ${version}\nsource-sha: ${sourceSha}\n`;
}

export function expectedWriteTrace(version) {
  return [
    'tag-push', 'tag-readback', 'draft-create', 'draft-readback',
    `asset-upload:echo-context-${version}-source.tgz`, `asset-readback:echo-context-${version}-source.tgz`,
    `asset-upload:echo-context-${version}-source.tgz.sha256`, `asset-readback:echo-context-${version}-source.tgz.sha256`,
    `asset-upload:echo-context-${version}-source.manifest.json`, `asset-readback:echo-context-${version}-source.manifest.json`,
    'publish-update', 'publish-readback',
  ];
}

export function validateWriteTrace(trace, version) {
  const expected = expectedWriteTrace(version);
  if (JSON.stringify(trace) !== JSON.stringify(expected)) die('external-write/readback trace differs from reviewed strict ordering');
}

function parseArgs(argv) {
  const keys = ['--repository-id', '--source-sha', '--version', '--manifest-hash', '--archive', '--checksum', '--manifest', '--run-id', '--run-attempt'];
  if (argv.length !== keys.length * 2) die('complete approved publication tuple is required');
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    if (argv[index] !== keys[index / 2] || values.has(argv[index])) die('publication arguments are missing, duplicated, reordered, or unknown');
    values.set(argv[index], argv[index + 1]);
  }
  if (!/^\d+$/.test(values.get('--repository-id'))) die('repository ID is malformed');
  if (!/^[0-9a-f]{40}$/.test(values.get('--source-sha'))) die('source SHA is malformed');
  if (!/^0\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/.test(values.get('--version'))) die('version is malformed');
  if (!/^[0-9a-f]{64}$/.test(values.get('--manifest-hash'))) die('manifest hash is malformed');
  if (values.get('--run-attempt') !== '1') die('workflow reruns are forbidden');
  return Object.fromEntries(values);
}

export function requestOnce({ method, url, token, body = null, headers = {}, accepted = [200] }) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const request = https.request({
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port || 443,
      path: `${target.pathname}${target.search}`,
      method,
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'X-GitHub-Api-Version': API_VERSION,
        'User-Agent': 'echo-context-publication-controller',
        ...(body === null ? {} : { 'Content-Length': Buffer.byteLength(body) }),
        ...headers,
      },
      agent: false,
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        const bytes = Buffer.concat(chunks);
        if (!accepted.includes(response.statusCode)) {
          reject(new Error(`${method} ${target.pathname} returned HTTP ${response.statusCode}`));
          return;
        }
        resolve({ status: response.statusCode, headers: response.headers, bytes });
      });
    });
    request.setTimeout(60_000, () => request.destroy(new Error(`${method} ${target.pathname} timed out`)));
    request.once('error', reject);
    if (body !== null) request.write(body);
    request.end();
  });
}

function json(response, context) {
  try {
    return JSON.parse(response.bytes.toString('utf8'));
  } catch {
    die(`${context} returned malformed JSON`);
  }
}

async function api(token, method, path, { body = null, accepted = [200], headers = {} } = {}) {
  const encoded = body === null || Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body));
  return requestOnce({
    method,
    url: `https://api.github.com${path}`,
    token,
    body: encoded,
    accepted,
    headers: { ...(body !== null && !Buffer.isBuffer(body) ? { 'Content-Type': 'application/json' } : {}), ...headers },
  });
}

async function paginate(token, path) {
  const rows = [];
  let next = `${path}${path.includes('?') ? '&' : '?'}per_page=100`;
  const seen = new Set();
  while (next) {
    if (seen.has(next)) die('pagination loop detected');
    seen.add(next);
    const response = await api(token, 'GET', next);
    const page = json(response, `GET ${next}`);
    if (!Array.isArray(page)) die(`GET ${next} returned non-array page`);
    rows.push(...page);
    const match = /<https:\/\/api\.github\.com([^>]+)>; rel="next"/.exec(String(response.headers.link ?? ''));
    next = match ? match[1] : null;
  }
  return rows;
}

async function namespace(token) {
  const [tags, releases] = await Promise.all([
    paginate(token, `/repos/${OWNER}/${REPO}/git/matching-refs/tags/`),
    paginate(token, `/repos/${OWNER}/${REPO}/releases`),
  ]);
  const assets = [];
  for (const release of releases) {
    if (!Number.isSafeInteger(release.id)) die('release listing contains unreadable ID');
    assets.push(...await paginate(token, `/repos/${OWNER}/${REPO}/releases/${release.id}/assets`));
  }
  return { tags, releases, assets };
}

function requireEmptyNamespace(state) {
  if (state.tags.length || state.releases.length || state.assets.length) die('release namespace is not completely empty; no adoption or cleanup is permitted');
}

async function verifyRepository(token, repositoryId, sourceSha) {
  const repository = json(await api(token, 'GET', `/repos/${OWNER}/${REPO}`), 'repository readback');
  if (String(repository.id) !== String(repositoryId) || repository.full_name !== `${OWNER}/${REPO}` || repository.private !== true || repository.default_branch !== 'main') {
    die('repository identity/private/default-branch readback differs');
  }
  const branch = json(await api(token, 'GET', `/repos/${OWNER}/${REPO}/branches/main`), 'main readback');
  if (branch.commit?.sha !== sourceSha) die('canonical main moved away from the approved source SHA');
}

function createTagObject(version, sourceSha) {
  const message = annotation(version, sourceSha);
  const timestamp = Math.floor(Date.now() / 1000);
  const object = `object ${sourceSha}\ntype commit\ntag v${version}\ntagger echo-context release <actions@users.noreply.github.com> ${timestamp} +0000\n\n${message}`;
  const result = spawnSync('git', ['mktag'], { input: object, encoding: 'utf8', shell: false });
  if (result.status !== 0 || !/^[0-9a-f]{40}\n$/.test(result.stdout)) die('failed to create annotated tag object');
  const oid = result.stdout.trim();
  const bytes = execFileSync('git', ['cat-file', 'tag', oid], { encoding: 'utf8' });
  const separator = bytes.indexOf('\n\n');
  if (separator < 0 || bytes.slice(separator + 2) !== message) die('local annotated-tag message differs from exact template');
  if (execFileSync('git', ['rev-parse', `${oid}^{commit}`], { encoding: 'utf8' }).trim() !== sourceSha) die('local tag object peels to wrong source');
  return { oid, message };
}

function pushTag(version, oid) {
  const ref = `refs/tags/v${version}`;
  const result = spawnSync('git', ['push', '--porcelain', `--force-with-lease=${ref}:`, 'origin', `${oid}:${ref}`], { encoding: 'utf8', shell: false });
  if (result.status !== 0 || !result.stdout.split('\n').some((line) => line.startsWith('*\t') && line.includes(`[new tag]`))) {
    die('create-only annotated-tag push did not return porcelain created-by-this-run proof');
  }
}

async function verifyTag(token, version, sourceSha, tagObjectOid, message) {
  const ref = json(await api(token, 'GET', `/repos/${OWNER}/${REPO}/git/ref/tags/v${encodeURIComponent(version)}`), 'tag ref readback');
  if (ref.object?.type !== 'tag' || ref.object?.sha !== tagObjectOid) die('remote tag is lightweight, replaced, or points at a different tag object');
  const tag = json(await api(token, 'GET', `/repos/${OWNER}/${REPO}/git/tags/${tagObjectOid}`), 'tag object readback');
  if (tag.sha !== tagObjectOid || tag.object?.type !== 'commit' || tag.object?.sha !== sourceSha || tag.message !== message) {
    die('remote tag object, peeled source, or annotation differs');
  }
}

async function readRelease(token, releaseId, expected) {
  const release = json(await api(token, 'GET', `/repos/${OWNER}/${REPO}/releases/${releaseId}`), 'release exact-ID readback');
  if (release.id !== releaseId || release.tag_name !== expected.tag || release.name !== expected.tag || release.draft !== expected.draft || release.prerelease !== true) {
    die('release exact-ID readback differs');
  }
  return release;
}

async function downloadAsset(token, assetId) {
  const first = await api(token, 'GET', `/repos/${OWNER}/${REPO}/releases/assets/${assetId}`, {
    accepted: [200, 302],
    headers: { Accept: 'application/octet-stream' },
  });
  if (first.status === 200) return first.bytes;
  const location = first.headers.location;
  if (typeof location !== 'string' || !location.startsWith('https://')) die('asset download redirect is missing or unsafe');
  const second = await requestOnce({ method: 'GET', url: location, token: '', accepted: [200], headers: { Authorization: '' } });
  return second.bytes;
}

async function verifyAsset(token, assetId, releaseId, expectedName, expectedBytes) {
  const metadata = json(await api(token, 'GET', `/repos/${OWNER}/${REPO}/releases/assets/${assetId}`), 'asset exact-ID readback');
  if (metadata.id !== assetId || metadata.name !== expectedName || metadata.size !== expectedBytes.length || metadata.state !== 'uploaded') die('asset exact-ID metadata differs');
  const bytes = await downloadAsset(token, assetId);
  if (!bytes.equals(expectedBytes)) die('asset exact-ID downloaded bytes differ');
  const releaseAssets = await paginate(token, `/repos/${OWNER}/${REPO}/releases/${releaseId}/assets`);
  const listed = releaseAssets.find((asset) => asset.id === assetId);
  if (!listed || listed.name !== expectedName) die('asset is not bound to the captured draft release ID');
}

async function reconcileReadOnly(token, attempted) {
  try {
    const state = await namespace(token);
    process.stderr.write(`read-only reconciliation attempted=${attempted} tags=${state.tags.length} releases=${state.releases.length} assets=${state.assets.length}; manual disposition required\n`);
  } catch (error) {
    process.stderr.write(`read-only reconciliation failed after attempted=${attempted}: ${error instanceof Error ? error.message : String(error)}; manual destination readback required\n`);
  }
}

async function run() {
  const args = parseArgs(process.argv.slice(2));
  const token = process.env.GITHUB_TOKEN;
  if (!token) die('GITHUB_TOKEN is required');
  const version = args['--version'];
  const sourceSha = args['--source-sha'];
  const tagName = `v${version}`;
  const files = [args['--archive'], args['--checksum'], args['--manifest']].map((path) => ({ path, name: basename(path), bytes: readFileSync(path) }));
  const expectedNames = ASSET_SUFFIXES.map((suffix) => `echo-context-${version}-source${suffix}`);
  if (JSON.stringify(files.map((file) => file.name)) !== JSON.stringify(expectedNames)) die('asset names or order differ from reviewed contract');
  const manifestBytes = files[2].bytes;
  if (sha256(manifestBytes) !== args['--manifest-hash']) die('approved manifest hash differs from exact manifest bytes');
  const manifest = JSON.parse(manifestBytes.toString('utf8'));
  if (manifest.source?.commit !== sourceSha || manifest.version !== version || manifest.source_archive?.source_archive_sha256 !== sha256(files[0].bytes)) die('manifest tuple differs from approved source/archive');

  let attempted = 'none';
  const observedTrace = [];
  try {
    await verifyRepository(token, args['--repository-id'], sourceSha);
    requireEmptyNamespace(await namespace(token));

    const tag = createTagObject(version, sourceSha);
    attempted = 'tag-push';
    marker(attempted, `refs/tags/${tagName}`, args['--run-id'], args['--run-attempt']);
    pushTag(version, tag.oid);
    observedTrace.push('tag-push');
    await verifyTag(token, version, sourceSha, tag.oid, tag.message);
    observedTrace.push('tag-readback');

    attempted = 'draft-create';
    marker(attempted, tagName, args['--run-id'], args['--run-attempt']);
    const createResponse = await api(token, 'POST', `/repos/${OWNER}/${REPO}/releases`, {
      accepted: [201], body: { tag_name: tagName, name: tagName, draft: true, prerelease: true },
    });
    const created = json(createResponse, 'draft creation response');
    if (!Number.isSafeInteger(created.id)) die('draft creation response lacks stable release ID');
    const releaseId = created.id;
    observedTrace.push('draft-create');
    await readRelease(token, releaseId, { tag: tagName, draft: true });
    await verifyTag(token, version, sourceSha, tag.oid, tag.message);
    observedTrace.push('draft-readback');

    for (const file of files) {
      attempted = `asset-upload:${file.name}`;
      marker(attempted, `release_id=${releaseId}/${file.name}`, args['--run-id'], args['--run-attempt']);
      const response = await requestOnce({
        method: 'POST',
        url: `https://uploads.github.com/repos/${OWNER}/${REPO}/releases/${releaseId}/assets?name=${encodeURIComponent(file.name)}`,
        token,
        body: file.bytes,
        accepted: [201],
        headers: { 'Content-Type': 'application/octet-stream' },
      });
      const asset = json(response, `asset upload ${file.name}`);
      if (!Number.isSafeInteger(asset.id)) die(`asset upload response lacks stable ID: ${file.name}`);
      observedTrace.push(`asset-upload:${file.name}`);
      await verifyAsset(token, asset.id, releaseId, file.name, file.bytes);
      observedTrace.push(`asset-readback:${file.name}`);
    }

    attempted = 'publish-update';
    marker(attempted, `release_id=${releaseId}`, args['--run-id'], args['--run-attempt']);
    await api(token, 'PATCH', `/repos/${OWNER}/${REPO}/releases/${releaseId}`, {
      accepted: [200], body: { draft: false, prerelease: true, make_latest: 'false' },
    });
    observedTrace.push('publish-update');
    await readRelease(token, releaseId, { tag: tagName, draft: false });
    observedTrace.push('publish-readback');
    const latestResponse = await api(token, 'GET', `/repos/${OWNER}/${REPO}/releases/latest`, { accepted: [200, 404] });
    if (latestResponse.status === 200 && json(latestResponse, 'latest release lookup').id === releaseId) die('prerelease was incorrectly made latest');

    const final = await namespace(token);
    if (final.tags.length !== 1 || final.releases.length !== 1 || final.assets.length !== 3) die('final namespace contains missing or foreign objects');
    if (final.releases[0].id !== releaseId || final.releases[0].draft !== false || final.releases[0].prerelease !== true) die('final release identity differs');
    const finalNames = final.assets.map((asset) => asset.name).sort();
    if (JSON.stringify(finalNames) !== JSON.stringify([...expectedNames].sort())) die('final asset exact set differs');
    await verifyTag(token, version, sourceSha, tag.oid, tag.message);
    validateWriteTrace(observedTrace, version);
    process.stdout.write(`publication OK: release_id=${releaseId} tag_object_oid=${tag.oid}\n`);
  } catch (error) {
    if (attempted !== 'none') await reconcileReadOnly(token, attempted);
    throw error;
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  run().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
