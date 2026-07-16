#!/usr/bin/env node

import { readFileSync } from 'node:fs';

function die(message) {
  throw new Error(`verify-workflow-artifact-metadata: ${message}`);
}

function main() {
  const keys = ['--metadata', '--artifact-id', '--name', '--run-id'];
  const argv = process.argv.slice(2);
  if (argv.length !== 8) die('complete exact-ID metadata tuple is required');
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    if (argv[index] !== keys[index / 2]) die('metadata arguments differ from reviewed order');
    values.set(argv[index], argv[index + 1]);
  }
  const metadata = JSON.parse(readFileSync(values.get('--metadata'), 'utf8'));
  if (String(metadata.id) !== values.get('--artifact-id')) die('workflow artifact ID differs');
  if (metadata.name !== values.get('--name')) die('workflow artifact name differs');
  if (metadata.expired !== false) die('workflow artifact is expired or expiration is unreadable');
  if (String(metadata.workflow_run?.id) !== values.get('--run-id')) die('workflow artifact belongs to a different run');
  process.stdout.write('workflow artifact metadata OK\n');
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}
