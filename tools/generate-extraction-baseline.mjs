#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const BASELINE_COMMIT = '0cf7b006eba665c0bf55e82ff04da70f19f01ebb';
const BASELINE_TREE = '70c5cf8352652b3c4c1dce68cd1a5e40d44e4b05';
const EVIDENCE = {
  migration_record: {
    path: 'raw/internal/migrations/2026-07-13-135-echo-context.md',
    sha256: 'eed83d4ad6d6706a3b2b1a454716f4344016481ba6108257b9f46f9055b0cc28',
  },
  independent_review: {
    path: 'raw/internal/migrations/2026-07-13-135-echo-context-review.md',
    sha256: '0125d26b2192a4bacbfa347c25fa592a5255a37aced46cc09877e639b5dcfa60',
  },
};

function die(message) {
  throw new Error(`generate-extraction-baseline: ${message}`);
}

function canonical(value) {
  const sort = (item) => Array.isArray(item)
    ? item.map(sort)
    : item && typeof item === 'object'
      ? Object.fromEntries(Object.keys(item).sort().map((key) => [key, sort(item[key])]))
      : item;
  return `${JSON.stringify(sort(value), null, 2)}\n`;
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function parseArgs(argv) {
  const allowed = new Set(['--git-dir', '--out']);
  const values = new Map();
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    const value = argv[i + 1];
    if (!allowed.has(key) || !value || values.has(key)) die('usage: --git-dir <path> --out <path>');
    values.set(key, value);
  }
  if (values.size !== 2) die('usage: --git-dir <path> --out <path>');
  return Object.fromEntries(values);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const git = (argv, encoding = null) => execFileSync('git', ['--git-dir', args['--git-dir'], ...argv], {
    encoding,
    maxBuffer: 128 * 1024 * 1024,
    env: { ...process.env, GIT_NO_REPLACE_OBJECTS: '1', GIT_OPTIONAL_LOCKS: '0' },
  });
  const tree = git(['rev-parse', `${BASELINE_COMMIT}^{tree}`], 'utf8').trim();
  if (tree !== BASELINE_TREE) die(`baseline tree mismatch: ${tree}`);
  const rows = git(['ls-tree', '-r', '-z', '--long', BASELINE_COMMIT])
    .toString('utf8')
    .split('\0')
    .filter(Boolean)
    .map((line) => {
      const match = /^(100644|100755) blob ([0-9a-f]{40})\s+(\d+)\t(.+)$/.exec(line);
      if (!match) die(`unsupported baseline tree row: ${line}`);
      const [, mode, blob_oid, sizeText, path] = match;
      const bytes = git(['cat-file', 'blob', blob_oid]);
      const size = Number(sizeText);
      if (bytes.length !== size) die(`size mismatch for ${path}`);
      return { path, mode, blob_oid, size, content_sha256: sha256(bytes) };
    })
    .sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)));
  if (rows.length !== 190) die(`expected 190 paths, got ${rows.length}`);
  const inventoryBytes = rows.map((row) => `${row.path}\0${row.mode}\0${row.blob_oid}\0${row.size}\0${row.content_sha256}\n`).join('');
  const record = {
    schema: 'extraction-baseline.v1',
    baseline_commit: BASELINE_COMMIT,
    baseline_tree: BASELINE_TREE,
    path_count: rows.length,
    inventory_sha256: sha256(inventoryBytes),
    evidence: EVIDENCE,
    paths: rows,
  };
  writeFileSync(resolve(args['--out']), canonical(record));
  process.stdout.write(`extraction baseline emitted: ${rows.length} paths\n`);
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}
