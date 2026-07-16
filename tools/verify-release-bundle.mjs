#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { basename, join } from 'node:path';

function die(message) {
  throw new Error(`verify-release-bundle: ${message}`);
}

function parseArgs(argv) {
  const keys = ['--dir', '--artifact-id', '--workflow-artifact-digest', '--run-id', '--source-sha', '--source-tree', '--version', '--source-archive-sha256', '--lock-hash', '--manifest-hash'];
  if (argv.length !== keys.length * 2) die('complete approved bundle tuple is required');
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    if (!keys.includes(argv[index]) || values.has(argv[index])) die('bundle arguments differ');
    values.set(argv[index], argv[index + 1]);
  }
  return Object.fromEntries(values);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const prefix = `echo-context-${args['--version']}-source`;
  const manifestPath = join(args['--dir'], `${prefix}.manifest.json`);
  const archivePath = join(args['--dir'], `${prefix}.tgz`);
  const checksumPath = join(args['--dir'], `${prefix}.tgz.sha256`);
  const tuplePath = join(args['--dir'], 'source-release-inner-tuple.v1.json');
  const manifestBytes = readFileSync(manifestPath);
  const manifest = JSON.parse(manifestBytes.toString('utf8'));
  const archiveDigest = createHash('sha256').update(readFileSync(archivePath)).digest('hex');
  const manifestHash = createHash('sha256').update(manifestBytes).digest('hex');
  const checksum = readFileSync(checksumPath, 'utf8').trim();
  if (checksum !== `${archiveDigest}  ${basename(archivePath)}`) die('checksum sidecar differs');
  const tuple = JSON.parse(readFileSync(tuplePath, 'utf8'));
  const expected = {
    source_sha: args['--source-sha'], source_tree: args['--source-tree'], version: args['--version'],
    source_archive_sha256: args['--source-archive-sha256'], lock_hash: args['--lock-hash'],
    manifest_hash: args['--manifest-hash'], run_id: args['--run-id'],
  };
  for (const [key, value] of Object.entries(expected)) if (String(tuple[key]) !== value) die(`inner tuple ${key} differs`);
  if (String(args['--artifact-id']).length === 0 || !/^[0-9a-f]{64}$/.test(args['--workflow-artifact-digest'])) die('outer tuple identity is malformed');
  if (manifest.source.commit !== expected.source_sha || manifest.source.tree !== expected.source_tree || manifest.version !== expected.version) die('manifest source identity differs');
  if (archiveDigest !== expected.source_archive_sha256 || manifest.source_archive.source_archive_sha256 !== expected.source_archive_sha256) die('source archive digest differs');
  if (manifest.lock_hash !== expected.lock_hash || manifestHash !== expected.manifest_hash) die('manifest/lock hash differs');
  process.stdout.write(`release bundle OK: artifact_id=${args['--artifact-id']} workflow_artifact_digest=${args['--workflow-artifact-digest']}\n`);
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}
