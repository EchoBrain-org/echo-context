#!/usr/bin/env node

import { lstat, realpath, rm } from 'node:fs/promises';
import { dirname, basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';

function fail(message) {
  throw new Error(`fresh-clone-cleanup: ${message}`);
}

export async function runCleanup(argv, deps = {}) {
  if (argv.length !== 2 || argv[0] !== '--owned-root') fail('usage: --owned-root <path>');
  const ownedRoot = argv[1];
  if (typeof ownedRoot !== 'string' || !ownedRoot.startsWith('/') || /[\r\n\0]/u.test(ownedRoot)) {
    fail('owned root must be one canonical absolute path');
  }
  const fs = deps.fs ?? { lstat, realpath, rm };
  const helperPath = fileURLToPath(import.meta.url);
  const cloneRoot = dirname(dirname(helperPath));
  const expectedParent = join(cloneRoot, '.fresh-clone-acceptance');
  if (dirname(ownedRoot) !== expectedParent || !/^run-[A-Za-z0-9_-]+$/u.test(basename(ownedRoot))) {
    fail('owned root is outside the authenticated acceptance-temp parent');
  }
  const [parentInfo, rootInfo, realParent, realRoot] = await Promise.all([
    fs.lstat(expectedParent),
    fs.lstat(ownedRoot),
    fs.realpath(expectedParent),
    fs.realpath(ownedRoot),
  ]);
  if (!parentInfo.isDirectory() || parentInfo.isSymbolicLink() || !rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
    fail('owned root or parent is not a regular nonsymlink directory');
  }
  if (realParent !== expectedParent || realRoot !== ownedRoot) fail('owned root contains a symlink or noncanonical component');
  await fs.rm(ownedRoot, { recursive: true, force: false });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runCleanup(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
