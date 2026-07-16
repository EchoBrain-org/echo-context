#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { chmodSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const MANIFEST_NAME = 'echo-scan-advertised-refs.v1';
const HEADER = 'echo-scan-advertised-refs.v1';
const ROW = /^([0-9a-f]{40})\t(refs\/.+)$/u;

function fail(message) {
  throw new Error(`prefetch-secret-scan-refs: ${message}`);
}

function git(args) {
  return execFileSync('git', ['-C', ROOT, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, GIT_NO_REPLACE_OBJECTS: '1', GIT_OPTIONAL_LOCKS: '0' },
  });
}

export function snapshotRef(ref) {
  if (!ref.startsWith('refs/')) fail(`advertised ref is outside refs/: ${ref}`);
  return `refs/echo-scan/${ref.slice('refs/'.length)}`;
}

export function parseAdvertisedRefs(stdout) {
  if (typeof stdout !== 'string' || stdout.includes('\r') || stdout.includes('\0')) fail('ls-remote output contains forbidden bytes');
  const body = stdout.endsWith('\n') ? stdout.slice(0, -1) : stdout;
  if (!body) fail('origin advertised no refs');
  const rows = body.split('\n').map((line) => {
    const match = ROW.exec(line);
    if (!match || match[2].includes('^{}')) fail(`malformed advertised-ref row: ${line}`);
    return Object.freeze({ oid: match[1], ref: match[2], snapshotRef: snapshotRef(match[2]) });
  }).sort((left, right) => left.ref.localeCompare(right.ref));
  for (let index = 1; index < rows.length; index += 1) {
    if (rows[index - 1].ref === rows[index].ref) fail(`duplicate advertised ref: ${rows[index].ref}`);
  }
  if (!rows.some((row) => row.ref === 'refs/heads/main')) fail('origin advertisement lacks refs/heads/main');
  return rows;
}

export function renderManifest(rows) {
  return `${HEADER}\n${rows.map(({ oid, ref }) => `${oid}\t${ref}`).join('\n')}\n`;
}

function localSnapshotRows() {
  const output = git(['for-each-ref', '--format=%(objectname)%09%(refname)', 'refs/echo-scan']);
  return output.split('\n').filter(Boolean).map((line) => {
    const match = /^([0-9a-f]{40})\t(refs\/echo-scan\/.+)$/u.exec(line);
    if (!match) fail(`malformed local snapshot row: ${line}`);
    return { oid: match[1], ref: match[2] };
  }).sort((left, right) => left.ref.localeCompare(right.ref));
}

function assertExactSnapshot(advertised) {
  const expected = advertised.map(({ oid, snapshotRef: ref }) => ({ oid, ref }));
  const actual = localSnapshotRows();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) fail('local complete-ref snapshot differs from the exhaustive origin advertisement');
  for (const { oid } of actual) git(['cat-file', '-e', `${oid}^{object}`]);
}

export function prefetch() {
  if (git(['rev-parse', '--is-shallow-repository']).trim() !== 'false') fail('shallow checkout cannot capture full history');
  const advertised = parseAdvertisedRefs(git(['ls-remote', '--refs', 'origin']));
  git(['fetch', '--no-tags', 'origin', ...advertised.map(({ oid, ref, snapshotRef: target }) => `+${ref}:${target}`)]);

  const expected = new Set(advertised.map(({ snapshotRef: ref }) => ref));
  for (const { ref } of localSnapshotRows()) if (!expected.has(ref)) git(['update-ref', '-d', ref]);
  assertExactSnapshot(advertised);

  const gitDirectory = git(['rev-parse', '--absolute-git-dir']).trim();
  if (!gitDirectory.startsWith('/')) fail('Git directory is not absolute');
  const manifest = join(gitDirectory, MANIFEST_NAME);
  const temporary = `${manifest}.tmp-${process.pid}`;
  try {
    writeFileSync(temporary, renderManifest(advertised), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    chmodSync(temporary, 0o600);
    renameSync(temporary, manifest);
  } finally {
    rmSync(temporary, { force: true });
  }
  return advertised.length;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 2) fail('no arguments are accepted');
    const count = prefetch();
    process.stdout.write(`secret-scan prefetch OK: ${count} exhaustive advertised ref(s)\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
