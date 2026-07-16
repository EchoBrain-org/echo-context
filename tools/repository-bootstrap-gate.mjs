const BASELINE = '0cf7b006eba665c0bf55e82ff04da70f19f01ebb';

export const FROZEN_BOOTSTRAP = Object.freeze({
  ownerLogin: 'zhenye0616',
  ownerId: 73834646,
  repositoryName: 'echo-context',
  repositoryId: 1302541575,
  repositoryNodeId: 'R_kgDOTaM1Bw',
  private: true,
  defaultBranch: 'main',
  baseline: BASELINE,
  createBody: Object.freeze({ auto_init: false, name: 'echo-context', private: true }),
  pushArgv: Object.freeze([
    'git',
    'push',
    '--porcelain',
    '--force-with-lease=refs/heads/main:',
    'origin',
    `${BASELINE}:refs/heads/main`,
  ]),
});

function fail(message) {
  throw new Error(`repository-bootstrap-gate: ${message}`);
}

function exactKeys(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object`);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    fail(`${label} keys differ from the recorded contract`);
  }
}

function expectUser(response, expected) {
  exactKeys(response, ['status', 'direct', 'body'], 'GET /user response');
  if (response.status !== 200 || response.direct !== true) fail('authenticated user readback was not a direct HTTP 200');
  if (response.body?.login !== expected.ownerLogin || response.body?.id !== expected.ownerId) {
    fail('authenticated user identity differs');
  }
}

function expectRepository(response, expected, label) {
  exactKeys(response, ['status', 'direct', 'body'], label);
  if (response.status !== 200 || response.direct !== true) fail(`${label} was not a direct HTTP 200`);
  const repository = response.body;
  if (
    repository?.id !== expected.repositoryId ||
    repository?.node_id !== expected.repositoryNodeId ||
    repository?.full_name !== `${expected.ownerLogin}/${expected.repositoryName}` ||
    repository?.owner?.login !== expected.ownerLogin ||
    repository?.owner?.id !== expected.ownerId ||
    repository?.private !== expected.private ||
    repository?.default_branch !== expected.defaultBranch
  ) {
    fail(`${label} identity or visibility differs`);
  }
}

function expectCompleteEmptyBranches(result) {
  exactKeys(result, ['complete', 'pages'], 'branch-list result');
  if (result.complete !== true || !Array.isArray(result.pages) || result.pages.length === 0) {
    fail('branch pagination is incomplete');
  }
  if (result.pages.some((page) => !Array.isArray(page)) || result.pages.flat().length !== 0) {
    fail('repository branch namespace is not empty');
  }
}

function expectEmptyRemote(result) {
  exactKeys(result, ['status', 'signal', 'stdout', 'stderr'], 'ls-remote result');
  if (result.status !== 0 || result.signal !== null || result.stdout !== '' || result.stderr !== '') {
    fail('exhaustive ls-remote did not prove zero refs');
  }
}

export function parseCreatedMainPorcelain(result) {
  exactKeys(result, ['status', 'signal', 'stdout', 'stderr', 'ambiguous'], 'push result');
  if (result.status !== 0 || result.signal !== null || result.ambiguous !== false || result.stderr !== '') {
    fail('initial push failed or was ambiguous');
  }
  if (result.stdout.includes('\r') || result.stdout.includes('\0')) fail('push porcelain contains forbidden bytes');
  const rows = result.stdout.split('\n').filter((row) => row.startsWith('*\t') || row.startsWith('+\t') || row.startsWith('=\t') || row.startsWith('!\t') || row.startsWith('-\t'));
  if (rows.length !== 1) fail('push porcelain must contain exactly one structural ref row');
  const match = /^\*\trefs\/heads\/main:refs\/heads\/main\t\[new branch\]$/u.exec(rows[0]);
  if (!match) fail('push porcelain is not the exact created-by-this-run main row');
  return Object.freeze({ flag: '*', source: 'refs/heads/main', destination: 'refs/heads/main', summary: '[new branch]' });
}

/**
 * Execute the frozen bootstrap state machine exclusively through injected
 * adapters. Production code intentionally provides no live adapter: item 136's
 * create and baseline push already happened, and tests replay recorded fixtures.
 */
export async function runRepositoryBootstrapGate(adapter, expected = FROZEN_BOOTSTRAP) {
  const required = [
    'getUser', 'getRepositoryByName', 'listOwnedRepositories', 'createRepository',
    'getRepositoryById', 'listBranches', 'lsRemote', 'push', 'getMainRef',
  ];
  for (const name of required) if (typeof adapter?.[name] !== 'function') fail(`missing injected adapter ${name}`);

  expectUser(await adapter.getUser(), expected);
  const nameLookup = await adapter.getRepositoryByName(expected.ownerLogin, expected.repositoryName);
  exactKeys(nameLookup, ['status', 'direct'], 'negative name lookup');
  if (nameLookup.status !== 404 || nameLookup.direct !== true) {
    fail('name lookup must be a direct negative response and is never adoption evidence');
  }
  const owned = await adapter.listOwnedRepositories();
  exactKeys(owned, ['complete', 'pages'], 'owned-repository listing');
  if (owned.complete !== true || !Array.isArray(owned.pages) || owned.pages.length === 0) {
    fail('owned-repository pagination is incomplete');
  }
  if (owned.pages.flat().some((repository) => repository?.name === expected.repositoryName)) {
    fail('foreign or pre-existing repository name cannot be adopted');
  }

  const created = await adapter.createRepository(expected.createBody);
  exactKeys(created, ['status', 'direct', 'body'], 'repository-create response');
  if (created.status !== 201 || created.direct !== true) fail('repository creation must be one direct HTTP 201');
  expectRepository({ status: 200, direct: true, body: created.body }, expected, 'repository-create body');
  expectRepository(await adapter.getRepositoryById(expected.repositoryId), expected, 'repository ID readback');
  expectCompleteEmptyBranches(await adapter.listBranches(expected.repositoryId));
  expectEmptyRemote(await adapter.lsRemote());

  const preexisting = await adapter.getMainRef(expected.repositoryId);
  exactKeys(preexisting, ['status', 'direct', 'oid'], 'pre-push main readback');
  if (preexisting.status !== 404 || preexisting.direct !== true || preexisting.oid !== null) {
    fail('pre-existing main is forbidden even when it names the identical baseline');
  }

  const push = await adapter.push([...expected.pushArgv]);
  const porcelain = parseCreatedMainPorcelain(push);
  const after = await adapter.getMainRef(expected.repositoryId);
  exactKeys(after, ['status', 'direct', 'oid'], 'post-push main readback');
  if (after.status !== 200 || after.direct !== true || after.oid !== expected.baseline) {
    fail('post-push main readback differs from the exact baseline');
  }
  return Object.freeze({ repositoryId: expected.repositoryId, repositoryNodeId: expected.repositoryNodeId, baseline: expected.baseline, porcelain });
}

if (process.argv[1] && new URL(import.meta.url).pathname === process.argv[1]) {
  process.stderr.write('repository-bootstrap-gate: live execution is disabled; use injected recorded fixtures\n');
  process.exitCode = 2;
}
