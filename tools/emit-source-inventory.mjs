#!/usr/bin/env node
// emit-source-inventory.mjs — canonical AC6 source-closure inventory (item 135).
//
// Emits the exact set of tracked paths under the 20 sealed roots at a pinned
// Project_echo commit, one path per line (LF-terminated, including a final LF),
// sorted by raw UTF-8 bytes. The pinned expectation for item 135 is 217 paths
// (110 source, 107 test/fixture) with SHA-256
// 8b0280660ea5eb64851a5ce0d1a9d56b707d6e29ce00d113ec6656b055d72d37.
//
// Reads source objects only. Never checks out, mutates, or writes into the
// source repository. Runs git under a config-free envelope (AC1).
//
// Usage:
//   node tools/emit-source-inventory.mjs \
//     --git /usr/local/bin/git --git-dir <project_echo>/.git \
//     --sha <commit> --root <root> [--root <root> ...]

import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';

const LITERAL_GIT = '/usr/local/bin/git';

function fail(msg) {
  process.stderr.write(`emit-source-inventory: ${msg}\n`);
  process.exit(1);
}

function parseArgs(argv) {
  const out = { git: null, gitDir: null, sha: null, roots: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      if (i + 1 >= argv.length) fail(`missing value for ${a}`);
      return argv[++i];
    };
    switch (a) {
      case '--git': out.git = next(); break;
      case '--git-dir': out.gitDir = next(); break;
      case '--sha': out.sha = next(); break;
      case '--root': out.roots.push(next()); break;
      default: fail(`unknown argument: ${a}`);
    }
  }
  if (!out.git) fail('--git is required');
  if (!out.gitDir) fail('--git-dir is required');
  if (!out.sha) fail('--sha is required');
  if (out.roots.length === 0) fail('at least one --root is required');
  return out;
}

// AC6: refuse any --git that does not equal AND resolve (after symlinks) to the
// literal /usr/local/bin/git.
function assertLiteralGit(gitArg) {
  if (gitArg !== LITERAL_GIT) fail(`--git must be literally ${LITERAL_GIT}, got ${gitArg}`);
  let resolved;
  try {
    resolved = realpathSync(gitArg);
  } catch (e) {
    fail(`cannot resolve --git path: ${e.message}`);
  }
  let literalResolved;
  try {
    literalResolved = realpathSync(LITERAL_GIT);
  } catch (e) {
    fail(`cannot resolve ${LITERAL_GIT}: ${e.message}`);
  }
  if (resolved !== literalResolved) {
    fail(`--git resolves to ${resolved}, expected ${literalResolved}`);
  }
}

// AC1 config-free envelope: env -i allowlist. Omits GIT_DIR, GIT_WORK_TREE,
// GIT_COMMON_DIR, GIT_OBJECT_DIRECTORY, GIT_ALTERNATE_OBJECT_DIRECTORIES,
// GIT_NAMESPACE, GIT_EXEC_PATH, GIT_CONFIG_COUNT/KEY/VALUE.
function configFreeEnv() {
  return {
    PATH: '/usr/bin:/bin:/usr/local/bin',
    HOME: process.env.ECHO_SCRATCH_HOME || '/nonexistent-echo-context-scratch',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: process.env.ECHO_EMPTY_GITCONFIG || '/dev/null',
    GIT_ATTR_NOSYSTEM: '1',
    GIT_NO_REPLACE_OBJECTS: '1',
  };
}

// AC6: exact root-or-descendant membership. A root is either an exact file path
// or a directory whose descendants match on a '/' boundary.
function isMember(path, roots) {
  for (const root of roots) {
    if (path === root) return true;
    if (path.startsWith(root + '/')) return true;
  }
  return false;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  assertLiteralGit(args.git);

  // Full recursive tree at the pinned commit, NUL-delimited names only.
  const res = spawnSync(
    args.git,
    ['--git-dir', args.gitDir, 'ls-tree', '-r', '-z', '--name-only', args.sha],
    { env: configFreeEnv(), maxBuffer: 512 * 1024 * 1024 }
  );
  if (res.error) fail(`git spawn failed: ${res.error.message}`);
  if (res.signal) fail(`git terminated by signal ${res.signal}`);
  if (res.status !== 0) fail(`git ls-tree exited ${res.status}: ${res.stderr}`);

  const raw = res.stdout; // Buffer
  // Split on NUL; git -z terminates each record with NUL (trailing NUL after last).
  const records = [];
  let start = 0;
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] === 0x00) {
      if (i > start) records.push(raw.subarray(start, i));
      start = i + 1;
    }
  }
  if (start < raw.length) records.push(raw.subarray(start, raw.length));

  const selected = [];
  for (const buf of records) {
    // Reject embedded NUL (cannot occur post-split) and LF; validate UTF-8.
    if (buf.includes(0x0a)) fail('path contains LF byte; rejected');
    const path = buf.toString('utf8');
    // Round-trip check: rejects invalid UTF-8 (replacement char re-encodes differently).
    if (!Buffer.from(path, 'utf8').equals(buf)) fail(`invalid UTF-8 in path: ${buf.toString('latin1')}`);
    if (isMember(path, args.roots)) selected.push(buf);
  }

  // Sort by raw UTF-8 bytes.
  selected.sort(Buffer.compare);

  // Emit each path + LF, including final LF.
  const parts = [];
  for (const buf of selected) {
    parts.push(buf);
    parts.push(Buffer.from('\n', 'utf8'));
  }
  process.stdout.write(Buffer.concat(parts));
}

main();
