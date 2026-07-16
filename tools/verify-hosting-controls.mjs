#!/usr/bin/env node

import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const EXPECTED_CONTEXTS = ['quality-macos', 'quality-ubuntu', 'secret-scan'];

function die(message) {
  throw new Error(`verify-hosting-controls: ${message}`);
}

function exactKeys(values) {
  return [...values].sort((a, b) => a.localeCompare(b));
}

export function validateEnvironment(environment, policies) {
  const rules = Array.isArray(environment.protection_rules) ? environment.protection_rules : null;
  if (!rules) die('environment protection rules are unreadable');
  const reviewerRules = rules.filter((rule) => rule.type === 'required_reviewers');
  if (reviewerRules.length !== 1) die('environment must expose exactly one required-reviewers rule');
  const reviewerRule = reviewerRules[0];
  const reviewers = reviewerRule.reviewers;
  if (!Array.isArray(reviewers)) die('environment reviewer set is unreadable');
  const identities = reviewers.map((row) => `${row.type}:${row.reviewer?.login ?? ''}`);
  if (JSON.stringify(identities) !== JSON.stringify(['User:zhenye0616'])) die('environment reviewer set must be exactly founder user zhenye0616');
  if (reviewerRule.prevent_self_review !== false) die('prevent-self-review must be explicitly disabled for the delegated founder operator');
  if (environment.can_admins_bypass !== false) die('environment administrative bypass must be explicitly disabled and readable');
  if (environment.deployment_branch_policy?.protected_branches !== false || environment.deployment_branch_policy?.custom_branch_policies !== true) {
    die('environment deployment branch policy differs from reviewed custom main-only mode');
  }
  if (!Array.isArray(policies) || policies.length !== 1 || policies[0]?.name !== 'main' || policies[0]?.type !== 'branch') {
    die('environment branch-policy set must be exactly [{name:"main",type:"branch"}]');
  }
}

export function validateBranchProtection(protection, appId) {
  if (!Number.isSafeInteger(appId) || appId <= 0) die('GitHub Actions App ID must be discovered from authenticated check-run readback');
  if (protection.enforce_admins?.enabled !== true) die('administrator enforcement is absent, false, or unreadable');
  const status = protection.required_status_checks;
  if (status?.strict !== true || !Array.isArray(status.checks)) die('strict app-bound required status checks are unreadable');
  const checks = status.checks.map((row) => `${row.context}:${row.app_id}`).sort();
  const expected = EXPECTED_CONTEXTS.map((context) => `${context}:${appId}`).sort();
  if (JSON.stringify(checks) !== JSON.stringify(expected)) die('required checks are not exactly the three app-bound contexts');
  if (Array.isArray(status.contexts) && status.contexts.length !== 0) die('legacy context-only required checks are forbidden');
  const reviews = protection.required_pull_request_reviews;
  if (!reviews || reviews.required_approving_review_count < 1) die('at least one approving review is required');
  for (const type of ['users', 'teams', 'apps']) {
    if ((reviews.bypass_pull_request_allowances?.[type] ?? []).length !== 0) die('pull-request bypass actors are forbidden');
  }
  if (protection.allow_force_pushes?.enabled !== false || protection.allow_deletions?.enabled !== false) {
    die('force pushes and branch deletion must be explicitly rejected');
  }
}

export function discoverActionsApp(checkRuns, sourceSha) {
  if (!Array.isArray(checkRuns)) die('check-run list is unreadable');
  const relevant = checkRuns.filter((run) => EXPECTED_CONTEXTS.includes(run.name));
  if (relevant.length !== EXPECTED_CONTEXTS.length) die('expected exactly one authenticated check run for each required context');
  if (JSON.stringify(exactKeys(relevant.map((run) => run.name))) !== JSON.stringify(exactKeys(EXPECTED_CONTEXTS))) die('check-run context set differs');
  const ids = new Set();
  for (const run of relevant) {
    if (run.head_sha !== sourceSha) die(`check run ${run.name} belongs to the wrong SHA`);
    if (!Number.isSafeInteger(run.app?.id) || !run.app?.slug) die(`check run ${run.name} app identity is unreadable`);
    if (run.app.slug !== 'github-actions') die(`check run ${run.name} was not produced by GitHub Actions`);
    ids.add(run.app.id);
  }
  if (ids.size !== 1) die('required check runs do not share one GitHub Actions App identity');
  return [...ids][0];
}

function parseArgs(argv) {
  const keys = ['--owner', '--repo', '--environment', '--source-sha'];
  if (argv.length !== keys.length * 2) die(`usage: ${keys.map((key) => `${key} <value>`).join(' ')}`);
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    if (!keys.includes(argv[index]) || values.has(argv[index])) die('arguments are missing, duplicated, or unknown');
    values.set(argv[index], argv[index + 1]);
  }
  if (JSON.stringify([...values.keys()]) !== JSON.stringify(keys)) die('arguments must follow the reviewed order');
  if (!/^[0-9a-f]{40}$/.test(values.get('--source-sha'))) die('source SHA must be full lowercase 40-hex');
  return Object.fromEntries(values);
}

async function api(path, token) {
  const response = await fetch(`https://api.github.com${path}`, {
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'echo-context-hosting-control-verifier',
    },
    redirect: 'error',
  });
  if (response.status !== 200) die(`GET ${path} returned HTTP ${response.status}`);
  return { body: await response.json(), link: response.headers.get('link') };
}

async function paginated(path, token, field = null) {
  const rows = [];
  let next = `${path}${path.includes('?') ? '&' : '?'}per_page=100`;
  const seen = new Set();
  while (next) {
    if (seen.has(next)) die('pagination loop detected');
    seen.add(next);
    const result = await api(next, token);
    const page = field ? result.body[field] : result.body;
    if (!Array.isArray(page)) die(`paginated GET ${path} returned a non-array page`);
    rows.push(...page);
    const match = /<https:\/\/api\.github\.com([^>]+)>; rel="next"/.exec(result.link ?? '');
    next = match ? match[1] : null;
  }
  return rows;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const token = process.env.GITHUB_TOKEN;
  if (!token) die('GITHUB_TOKEN is required');
  const base = `/repos/${encodeURIComponent(args['--owner'])}/${encodeURIComponent(args['--repo'])}`;
  const environmentName = encodeURIComponent(args['--environment']);
  const [environment, policies, protection, checkRuns] = await Promise.all([
    api(`${base}/environments/${environmentName}`, token).then((result) => result.body),
    paginated(`${base}/environments/${environmentName}/deployment-branch-policies`, token, 'branch_policies'),
    api(`${base}/branches/main/protection`, token).then((result) => result.body),
    paginated(`${base}/commits/${args['--source-sha']}/check-runs`, token, 'check_runs'),
  ]);
  const appId = discoverActionsApp(checkRuns, args['--source-sha']);
  validateEnvironment(environment, policies);
  validateBranchProtection(protection, appId);
  process.stdout.write(`${JSON.stringify({ schema: 'hosting-controls-readback.v1', source_sha: args['--source-sha'], github_actions_app_id: appId, contexts: EXPECTED_CONTEXTS, environment: args['--environment'] })}\n`);
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}

export { EXPECTED_CONTEXTS };
