#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { lstatSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = realpathSync(join(dirname(fileURLToPath(import.meta.url)), '..'));
const FULL_SHA = /^[0-9a-f]{40}$/;
const HASH = /^[0-9a-f]{64}$/;
const VERSION = /^0\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/;

function die(message) {
  throw new Error(`fresh-clone-verifier: ${message}`);
}

function parseArgs(argv) {
  const pairs = new Map();
  let mode;
  for (let index = 0; index < argv.length;) {
    const token = argv[index];
    if (token.startsWith('--mode=')) {
      if (mode !== undefined) die('usage: duplicate --mode');
      mode = token.slice('--mode='.length);
      index += 1;
      continue;
    }
    if (!token.startsWith('--') || !argv[index + 1] || pairs.has(token)) die('usage: arguments must be unique --key value pairs');
    pairs.set(token, argv[index + 1]);
    index += 2;
  }
  const sourceKeys = ['--source-sha'];
  const releaseKeys = ['--source-sha', '--version', '--archive', '--checksum', '--manifest', '--expected-manifest-hash'];
  const expected = mode === 'source' ? sourceKeys : mode === 'release' ? releaseKeys : null;
  if (!expected || JSON.stringify([...pairs.keys()]) !== JSON.stringify(expected)) {
    die('usage: --mode=source --source-sha <sha> OR --mode=release --source-sha <sha> --version <version> --archive <path> --checksum <path> --manifest <path> --expected-manifest-hash <hash>');
  }
  const sourceSha = pairs.get('--source-sha');
  if (!FULL_SHA.test(sourceSha)) die('source SHA must be a full lowercase 40-hex Git OID');
  if (mode === 'release') {
    if (!VERSION.test(pairs.get('--version'))) die('release version is malformed');
    if (!HASH.test(pairs.get('--expected-manifest-hash'))) die('expected manifest hash must be lowercase 64-hex');
  }
  return { mode, sourceSha, values: Object.freeze(Object.fromEntries(pairs)) };
}

function boundary(sourceSha) {
  return [
    { executable: 'git', argv: ['status', '--porcelain=v1', '--untracked-files=all'], expectation: 'clean' },
    { executable: 'git', argv: ['rev-parse', 'HEAD'], expectation: sourceSha },
  ];
}

export function sourceTrace(sourceSha, out, version, manifestHash = '<manifest-hash>') {
  const prefix = `echo-context-${version}-source`;
  return [
    ...boundary(sourceSha),
    { executable: 'npm', argv: ['ci'] },
    ...boundary(sourceSha),
    { executable: 'npm', argv: ['run', 'typecheck'] },
    { executable: 'npm', argv: ['run', 'lint'] },
    { executable: 'npm', argv: ['run', 'test:ci'] },
    { executable: 'npm', argv: ['run', 'verify:inventory'] },
    { executable: 'npm', argv: ['run', 'verify:authority'] },
    { executable: 'npm', argv: ['run', 'build:artifact', '--', '--source-sha', sourceSha, '--out', out], carrier: true },
    { executable: 'npm', argv: ['run', 'verify:artifact', '--', '--archive', join(out, `${prefix}.tgz`), '--checksum', join(out, `${prefix}.tgz.sha256`), '--manifest', join(out, `${prefix}.manifest.json`), '--expected-manifest-hash', manifestHash] },
    { executable: 'git', argv: ['fsck', '--full'] },
    { executable: 'npm', argv: ['run', 'scan:secrets'] },
    ...boundary(sourceSha),
  ];
}

export function releaseTrace(args) {
  return [
    ...boundary(args.sourceSha),
    { executable: 'npm', argv: ['ci'] },
    ...boundary(args.sourceSha),
    { executable: 'npm', argv: ['run', 'typecheck'] },
    { executable: 'npm', argv: ['run', 'lint'] },
    { executable: 'npm', argv: ['run', 'test:ci'] },
    { executable: 'npm', argv: ['run', 'verify:inventory'] },
    { executable: 'npm', argv: ['run', 'verify:authority'] },
    { executable: 'npm', argv: ['run', 'verify:artifact', '--', '--archive', args.archive, '--checksum', args.checksum, '--manifest', args.manifest, '--expected-manifest-hash', args.expectedManifestHash] },
    { executable: 'git', argv: ['fsck', '--full'] },
    { executable: 'npm', argv: ['run', 'scan:secrets'] },
    ...boundary(args.sourceSha),
  ];
}

function assertAllowed(step, expected) {
  if (!step || step.executable !== expected.executable || JSON.stringify(step.argv) !== JSON.stringify(expected.argv)) {
    die('child vector differs from the selected mode trace');
  }
  if (!['git', 'npm'].includes(step.executable)) die(`unlisted executable ${step.executable}`);
  if (step.executable === 'npm' && step.argv[0] === 'run') {
    const allowed = new Set(['typecheck', 'lint', 'test:ci', 'verify:inventory', 'verify:authority', 'build:artifact', 'verify:artifact', 'scan:secrets']);
    if (!allowed.has(step.argv[1]) || step.argv[1] === 'test:operator') die(`unlisted npm script ${step.argv[1]}`);
  }
}

function sanitizedEnvironment() {
  return Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('ECHO_')));
}

function executeStep(step, expected, env) {
  assertAllowed(step, expected);
  const result = spawnSync(step.executable, step.argv, {
    cwd: ROOT,
    env,
    encoding: 'utf8',
    shell: false,
    maxBuffer: 128 * 1024 * 1024,
  });
  if (result.status !== 0) {
    const output = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim();
    die(`child failed: ${step.executable} ${step.argv.join(' ')}${output ? `\n${output}` : ''}`);
  }
  if (step.expectation === 'clean' && result.stdout !== '') die('cleanliness boundary found staged, unstaged, or nonignored untracked state');
  if (FULL_SHA.test(step.expectation ?? '') && result.stdout.trim() !== step.expectation) die(`HEAD differs from immutable expected SHA ${step.expectation}`);
  return result.stdout;
}

function removeOwnedTemp(path) {
  rmSync(path, { recursive: true, force: false });
  try {
    lstatSync(path);
  } catch (error) {
    if (error && error.code === 'ENOENT') return;
    throw error;
  }
  die(`owned temporary directory survived removal: ${path}`);
}

function committedVersion() {
  return JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;
}

function run() {
  const args = parseArgs(process.argv.slice(2));
  const env = sanitizedEnvironment();
  if (args.mode === 'release') {
    const traceArgs = {
      sourceSha: args.sourceSha,
      version: args.values['--version'],
      archive: resolve(args.values['--archive']),
      checksum: resolve(args.values['--checksum']),
      manifest: resolve(args.values['--manifest']),
      expectedManifestHash: args.values['--expected-manifest-hash'],
    };
    const trace = releaseTrace(traceArgs);
    for (let index = 0; index < trace.length; index += 1) executeStep(trace[index], trace[index], env);
    const manifest = JSON.parse(readFileSync(traceArgs.manifest, 'utf8'));
    if (manifest.source?.commit !== args.sourceSha) die('authenticated manifest source differs from approved source SHA');
    if (manifest.version !== traceArgs.version || committedVersion() !== traceArgs.version) die('release version differs from manifest or committed package version');
    return;
  }

  const version = committedVersion();
  let ownedTemp;
  let manifestHash;
  const placeholder = join(ROOT, '.fresh-clone-artifacts-PENDING');
  let trace = sourceTrace(args.sourceSha, placeholder, version);
  try {
    for (let index = 0; index < 10; index += 1) executeStep(trace[index], trace[index], env);
    ownedTemp = mkdtempSync(join(ROOT, '.fresh-clone-artifacts-'));
    trace = sourceTrace(args.sourceSha, ownedTemp, version);
    const carrier = executeStep(trace[10], trace[10], env).trim().split('\n').at(-1);
    const match = /^manifest_hash=([0-9a-f]{64})$/.exec(carrier ?? '');
    if (!match) die('build:artifact did not emit the exact manifest-hash carrier as its final stdout line');
    manifestHash = match[1];
    trace = sourceTrace(args.sourceSha, ownedTemp, version, manifestHash);
    for (let index = 11; index <= 13; index += 1) executeStep(trace[index], trace[index], env);
    removeOwnedTemp(ownedTemp);
    ownedTemp = undefined;
    for (let index = 14; index < trace.length; index += 1) executeStep(trace[index], trace[index], env);
  } finally {
    if (ownedTemp !== undefined) rmSync(ownedTemp, { recursive: true, force: true });
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    run();
    process.stdout.write('fresh-clone acceptance OK\n');
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}

export { assertAllowed, parseArgs };
