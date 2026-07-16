#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import Ajv from 'ajv';

const BASELINE = '0cf7b006eba665c0bf55e82ff04da70f19f01ebb';
const BASELINE_TREE = '70c5cf8352652b3c4c1dce68cd1a5e40d44e4b05';
const V1_RUNTIME_SHA256 = '29512b101dc672aec83102f147b60c04dd694b1602479024299b228becf95caf';

function die(message) {
  throw new Error(`check-repository-authority: ${message}`);
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function parseArgs(argv) {
  if (argv.length !== 4 || argv[0] !== '--git-dir' || argv[2] !== '--commit') {
    die('usage: --git-dir <path> --commit <sha>');
  }
  return { gitDir: argv[1], commit: argv[3] };
}

function canonical(value) {
  const sort = (item) => Array.isArray(item)
    ? item.map(sort)
    : item && typeof item === 'object'
      ? Object.fromEntries(Object.keys(item).sort().map((key) => [key, sort(item[key])]))
      : item;
  return `${JSON.stringify(sort(value), null, 2)}\n`;
}

function main() {
  const { gitDir, commit } = parseArgs(process.argv.slice(2));
  const git = (args, encoding = null) => execFileSync('git', ['--git-dir', gitDir, ...args], {
    encoding,
    maxBuffer: 128 * 1024 * 1024,
    env: { ...process.env, GIT_NO_REPLACE_OBJECTS: '1', GIT_OPTIONAL_LOCKS: '0' },
  });
  const resolved = git(['rev-parse', `${commit}^{commit}`], 'utf8').trim();
  if (git(['rev-parse', `${BASELINE}^{tree}`], 'utf8').trim() !== BASELINE_TREE) die('baseline tree differs');
  const ancestry = execFileSync('git', ['--git-dir', gitDir, 'merge-base', '--is-ancestor', BASELINE, resolved], { stdio: 'ignore' });
  void ancestry;

  const readBlob = (path) => git(['cat-file', 'blob', `${resolved}:${path}`]);
  const ajv = new Ajv({ allErrors: true, strict: false });
  for (const [recordPath, schemaPath] of [
    ['provenance/extraction-baseline.v1.json', 'schemas/extraction-baseline.v1.schema.json'],
    ['provenance/repository-authority.v1.json', 'schemas/repository-authority.v1.schema.json'],
  ]) {
    const record = JSON.parse(readBlob(recordPath).toString('utf8'));
    const schema = JSON.parse(readBlob(schemaPath).toString('utf8'));
    const validate = ajv.compile(schema);
    if (!validate(record)) die(`${recordPath} fails schema: ${JSON.stringify(validate.errors)}`);
  }

  const baseline = JSON.parse(readBlob('provenance/extraction-baseline.v1.json').toString('utf8'));
  const expectedRows = git(['ls-tree', '-r', '-z', '--long', BASELINE]).toString('utf8').split('\0').filter(Boolean).map((line) => {
    const match = /^(100644|100755) blob ([0-9a-f]{40})\s+(\d+)\t(.+)$/.exec(line);
    if (!match) die(`unsupported baseline row: ${line}`);
    const [, mode, blob_oid, sizeText, path] = match;
    const bytes = git(['cat-file', 'blob', blob_oid]);
    return { path, mode, blob_oid, size: Number(sizeText), content_sha256: sha256(bytes) };
  }).sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)));
  const inventoryBytes = expectedRows.map((row) => `${row.path}\0${row.mode}\0${row.blob_oid}\0${row.size}\0${row.content_sha256}\n`).join('');
  if (canonical(baseline.paths) !== canonical(expectedRows)) die('frozen baseline inventory differs from Git objects');
  if (baseline.inventory_sha256 !== sha256(inventoryBytes)) die('frozen baseline inventory hash differs');
  if (sha256(readBlob('provenance/runtime-inventory.v1.json')) !== V1_RUNTIME_SHA256) die('immutable runtime-inventory.v1 bytes changed');
  process.stdout.write(`repository-authority OK: baseline ancestor of ${resolved}\n`);
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}
