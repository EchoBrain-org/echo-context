#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSourceArtifact } from './build-source-artifact.mjs';
import { verifySourceArtifact } from './verify-source-artifact.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CANDIDATE_REF = 'refs/echo-ci/candidate';
const EXPECTED_NODE = 'v22.22.1';
const EXPECTED_NPM = '10.9.4';

function fail(message) {
  throw new Error(`ci: ${message}`);
}

function run(executable, argv, options = {}) {
  const result = spawnSync(executable, argv, {
    cwd: ROOT,
    env: options.env ?? process.env,
    encoding: options.capture ? 'utf8' : undefined,
    stdio: options.capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    shell: false,
    maxBuffer: 512 * 1024 * 1024,
  });
  if (result.error) fail(`${executable} could not start: ${result.error.message}`);
  if (result.signal) fail(`${executable} ${argv[0] ?? ''} terminated by ${result.signal}`);
  if (options.allowedStatuses?.includes(result.status)) return result;
  if (result.status !== 0) {
    const detail = options.capture ? String(result.stderr ?? '').trim() : '';
    fail(`${executable} ${argv[0] ?? ''} exited ${result.status}${detail ? `: ${detail}` : ''}`);
  }
  return result;
}

function output(executable, argv) {
  return String(run(executable, argv, { capture: true }).stdout).trim();
}

function assertCleanBoundary(expectedHead) {
  const head = output('git', ['rev-parse', 'HEAD']);
  if (!/^[0-9a-f]{40}$/u.test(head)) fail('HEAD is not one exact commit');
  if (expectedHead && head !== expectedHead) fail('HEAD changed while CI was running');
  const status = output('git', ['status', '--porcelain=v1', '--untracked-files=all']);
  if (status) fail(`worktree is not clean:\n${status}`);
  return head;
}

function assertToolchain() {
  if (process.version !== EXPECTED_NODE) fail(`Node ${process.version} differs from ${EXPECTED_NODE}`);
  const npmVersion = output('npm', ['--version']);
  if (npmVersion !== EXPECTED_NPM) fail(`npm ${npmVersion} differs from ${EXPECTED_NPM}`);
}

function assertLockfileParity() {
  const packageLock = readFileSync(join(ROOT, 'package-lock.json'));
  const shrinkwrap = readFileSync(join(ROOT, 'npm-shrinkwrap.json'));
  if (!packageLock.equals(shrinkwrap)) {
    fail('package-lock.json and npm-shrinkwrap.json differ; audited and installed dependency inputs must be identical');
  }
}

function candidateRefExists() {
  return run('git', ['show-ref', '--verify', '--quiet', CANDIDATE_REF], {
    capture: true,
    allowedStatuses: [0, 1],
  }).status === 0;
}

function scanHistory(sourceSha, scratch) {
  if (candidateRefExists()) fail(`${CANDIDATE_REF} already exists`);
  const scannerDirectory = join(scratch, 'gitleaks');
  run(join(ROOT, 'tools', 'install-gitleaks.sh'), [scannerDirectory]);
  run('git', ['update-ref', CANDIDATE_REF, sourceSha]);
  try {
    run(process.execPath, [join(ROOT, 'tools', 'prefetch-secret-scan-refs.mjs')]);
    run('npm', ['run', 'scan:secrets'], {
      env: { ...process.env, GITLEAKS_BIN: realpathSync(join(scannerDirectory, 'gitleaks')) },
    });
  } finally {
    run('git', ['update-ref', '-d', CANDIDATE_REF]);
  }
}

function verifySourceArtifactFor(sourceSha, scratch) {
  const result = buildSourceArtifact({
    cwd: ROOT,
    sourceSha,
    out: join(scratch, 'source-artifact'),
  });
  verifySourceArtifact({
    cwd: ROOT,
    archive: result.archive,
    checksum: result.checksum,
    manifest: result.manifest,
    expectedManifestHash: result.manifestHash,
  });
}

export function runCi() {
  if (process.argv.length !== 2) fail('no arguments are accepted');
  const sourceSha = assertCleanBoundary();
  assertToolchain();
  assertLockfileParity();

  const scratch = mkdtempSync(join(tmpdir(), 'echo-context-ci-'));
  try {
    scanHistory(sourceSha, scratch);
    run('npm', ['ci', '--no-audit', '--no-fund']);
    for (const script of ['typecheck', 'lint', 'test:ci', 'verify:inventory', 'verify:authority']) {
      run('npm', ['run', script]);
    }
    run('git', ['fsck', '--full', '--no-dangling']);
    verifySourceArtifactFor(sourceSha, scratch);
    assertCleanBoundary(sourceSha);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  process.stdout.write(`ci OK: ${sourceSha}\n`);
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    runCi();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
