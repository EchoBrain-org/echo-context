#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

function die(message) {
  throw new Error(`write-release-tuple: ${message}`);
}

function canonical(value) {
  const sort = (item) => Array.isArray(item) ? item.map(sort) : item && typeof item === 'object'
    ? Object.fromEntries(Object.keys(item).sort().map((key) => [key, sort(item[key])])) : item;
  return `${JSON.stringify(sort(value), null, 2)}\n`;
}

function main() {
  const keys = ['--manifest', '--run-id', '--out'];
  const argv = process.argv.slice(2);
  if (argv.length !== 6) die('usage: --manifest <path> --run-id <id> --out <path>');
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    if (!keys.includes(argv[index]) || values.has(argv[index])) die('arguments differ from reviewed contract');
    values.set(argv[index], argv[index + 1]);
  }
  const bytes = readFileSync(values.get('--manifest'));
  const manifest = JSON.parse(bytes.toString('utf8'));
  const record = {
    schema: 'source-release-inner-tuple.v1',
    source_sha: manifest.source.commit,
    source_tree: manifest.source.tree,
    version: manifest.version,
    source_archive_sha256: manifest.source_archive.source_archive_sha256,
    lock_hash: manifest.lock_hash,
    manifest_hash: createHash('sha256').update(bytes).digest('hex'),
    run_id: values.get('--run-id'),
  };
  writeFileSync(values.get('--out'), canonical(record));
  process.stdout.write(`${canonical(record)}`);
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}
