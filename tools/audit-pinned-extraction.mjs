#!/usr/bin/env node
// audit-pinned-extraction.mjs — AC6/AC7 operator audit (item 135).
//
// Independently recomputes the 217-path source closure from the pinned
// Project_echo commit (the 20 sealed roots) and cross-checks it against
// provenance/source-evidence.v1.json and provenance/parity-matrix.v1.json:
//   - the recomputed inventory equals 217 paths with SHA-256
//     8b0280660ea5eb64851a5ce0d1a9d56b707d6e29ce00d113ec6656b055d72d37;
//   - every inventory path appears exactly once in source-evidence and in
//     parity-matrix, with a matching pinned blob OID;
//   - the partition ported+rewritten+excluded == the full inventory.
//
//   node tools/audit-pinned-extraction.mjs --source-git-dir <project_echo>/.git \
//        --source-sha <oid> --target <target-root>

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

const GIT = '/usr/local/bin/git';
const EXPECT_SHA = '8b0280660ea5eb64851a5ce0d1a9d56b707d6e29ce00d113ec6656b055d72d37';
const ROOTS = [
  'src/capture', 'src/normalize', 'src/storage', 'src/trace', 'src/echo-home', 'src/enrich',
  'src/logging', 'src/mcp', 'src/util', 'src/guards.ts', 'tests/capture', 'tests/normalize',
  'tests/storage', 'tests/trace', 'tests/echo-home', 'tests/enrich', 'tests/logging',
  'tests/mcp', 'tests/util', 'tests/fixtures',
];
function fail(m) { process.stderr.write(`audit-pinned-extraction: ${m}\n`); process.exit(1); }
function arg(n) { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : undefined; }
const SRC_GIT = arg('--source-git-dir') || fail('--source-git-dir required');
const SRC_SHA = arg('--source-sha') || fail('--source-sha required');
const TARGET = arg('--target') || fail('--target required');
const ENV = { PATH: '/usr/bin:/bin:/usr/local/bin', HOME: process.env.HOME ?? '/tmp', GIT_CONFIG_NOSYSTEM: '1', GIT_ATTR_NOSYSTEM: '1', GIT_NO_REPLACE_OBJECTS: '1' };
function git(a) { return execFileSync(GIT, ['--git-dir', SRC_GIT, ...a], { env: ENV, maxBuffer: 512 * 1024 * 1024 }); }

// Recompute the closure: full recursive tree, filter to root-or-descendant, byte-sort.
const raw = git(['ls-tree', '-r', '-z', '--name-only', SRC_SHA]);
const rows = [];
let start = 0;
for (let i = 0; i < raw.length; i++) if (raw[i] === 0) { if (i > start) rows.push(raw.subarray(start, i)); start = i + 1; }
if (start < raw.length) rows.push(raw.subarray(start));
const isMember = (p) => ROOTS.some((r) => p === r || p.startsWith(r + '/'));
const selected = rows.filter((b) => isMember(b.toString('utf8'))).sort(Buffer.compare);
const stream = Buffer.concat(selected.flatMap((b) => [b, Buffer.from('\n')]));
const invSha = createHash('sha256').update(stream).digest('hex');
const invPaths = selected.map((b) => b.toString('utf8'));

if (invPaths.length !== 217) fail(`recomputed inventory has ${invPaths.length} paths, expected 217`);
if (invSha !== EXPECT_SHA) fail(`recomputed inventory SHA ${invSha} != ${EXPECT_SHA}`);
const srcCount = invPaths.filter((p) => p.startsWith('src/')).length;
const testCount = invPaths.filter((p) => p.startsWith('tests/')).length;
if (srcCount !== 110 || testCount !== 107) fail(`split ${srcCount}/${testCount} != 110/107`);

// Cross-check against provenance.
const evidence = JSON.parse(readFileSync(join(TARGET, 'provenance/source-evidence.v1.json'), 'utf8'));
const parity = JSON.parse(readFileSync(join(TARGET, 'provenance/parity-matrix.v1.json'), 'utf8'));
const invSet = new Set(invPaths);
const evSet = new Set(evidence.entries.map((e) => e.path));
const pmSet = new Set(parity.rows.map((r) => r.path));
if (evSet.size !== 217 || pmSet.size !== 217) fail(`source-evidence(${evSet.size}) / parity(${pmSet.size}) not 217 unique paths`);
for (const p of invPaths) {
  if (!evSet.has(p)) fail(`inventory path missing from source-evidence: ${p}`);
  if (!pmSet.has(p)) fail(`inventory path missing from parity-matrix: ${p}`);
}
for (const p of evSet) if (!invSet.has(p)) fail(`source-evidence has a path not in the recomputed closure: ${p}`);

const c = parity.counts;
if (c.ported + c.rewritten + c.excluded !== 217) fail(`partition ${c.ported}+${c.rewritten}+${c.excluded} != 217`);

process.stdout.write(`audit-pinned-extraction OK: 217 paths (110 src, 107 test), SHA ${invSha.slice(0, 12)}…; partition ${c.ported}/${c.rewritten}/${c.excluded}\n`);
