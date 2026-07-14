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
const PINNED_SOURCE_COMMIT = '2971310441b69735cbe759293abd8c4d044bf347';
const EXPECT_SHA = '8b0280660ea5eb64851a5ce0d1a9d56b707d6e29ce00d113ec6656b055d72d37';
const EXPECT_PATH_COUNT = 217;
const READY_CONTENT_SHA = 'aa9fa9d89c30b2ba2823d6b3eecdc32e389120bb9f3bc46538b9335a301c8392';
const EXPECT_DISPOSITION_POLICY_SHA = '7f905d1e3b64828e7b10e794af2c93a64daf12f92b53b11439b6bf18ac2d7069';
const DISPOSITIONS = ['ported', 'rewritten', 'duplicated', 'excluded'];
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
const EVIDENCE_PATH = arg('--evidence') || join(TARGET, 'provenance/source-evidence.v1.json');
const PARITY_PATH = arg('--parity') || join(TARGET, 'provenance/parity-matrix.v1.json');
const TARGET_POLICY_PATH = arg('--target-only-policy') || join(TARGET, 'provenance/target-only-policy.v1.json');
const ENV = { PATH: '/usr/bin:/bin:/usr/local/bin', HOME: process.env.HOME ?? '/tmp', GIT_CONFIG_NOSYSTEM: '1', GIT_ATTR_NOSYSTEM: '1', GIT_NO_REPLACE_OBJECTS: '1' };
function git(a) { return execFileSync(GIT, ['--git-dir', SRC_GIT, ...a], { env: ENV, maxBuffer: 512 * 1024 * 1024 }); }
function sha256(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
function dispositionPolicySha(rows) {
  const sorted = [...rows].sort((a, b) => Buffer.compare(Buffer.from(a.path, 'utf8'), Buffer.from(b.path, 'utf8')));
  return sha256(Buffer.from(sorted.map((row) => `${row.path}\0${row.disposition}\n`).join(''), 'utf8'));
}
function replayCommandFor(row) {
  return `Apply this row's replay_patch (unified diff) to the pinned source blob ${row.source_blob_oid} — the result reproduces target_content_sha256. Enforced by: node tools/check-parity.mjs --source-git-dir <project_echo>/.git --source-sha ${SRC_SHA} --target .`;
}

// Recompute the closure: full recursive tree, filter to root-or-descendant, byte-sort.
if (SRC_SHA !== PINNED_SOURCE_COMMIT) fail(`source SHA ${SRC_SHA} != pinned ${PINNED_SOURCE_COMMIT}`);
const raw = git(['ls-tree', '-r', '-z', SRC_SHA]);
const rows = [];
let start = 0;
for (let i = 0; i < raw.length; i++) {
  if (raw[i] !== 0) continue;
  if (i > start) {
    const record = raw.subarray(start, i);
    const tab = record.indexOf(0x09);
    if (tab < 0) fail('malformed ls-tree record without TAB');
    const header = record.subarray(0, tab).toString('ascii').match(/^(\d{6}) (\w+) ([0-9a-f]{40})$/);
    if (!header) fail('malformed ls-tree record header');
    rows.push({ mode: header[1], type: header[2], oid: header[3], pathBytes: record.subarray(tab + 1) });
  }
  start = i + 1;
}
if (start < raw.length) fail('ls-tree output lacks final NUL');
const isMember = (p) => ROOTS.some((r) => p === r || p.startsWith(r + '/'));
const selected = rows
  .filter((row) => isMember(row.pathBytes.toString('utf8')))
  .sort((a, b) => Buffer.compare(a.pathBytes, b.pathBytes));
const stream = Buffer.concat(selected.flatMap((row) => [row.pathBytes, Buffer.from('\n')]));
const invSha = sha256(stream);
const invPaths = selected.map((row) => row.pathBytes.toString('utf8'));
const sourceByPath = new Map(selected.map((row) => [row.pathBytes.toString('utf8'), row]));

if (invPaths.length !== 217) fail(`recomputed inventory has ${invPaths.length} paths, expected 217`);
if (invSha !== EXPECT_SHA) fail(`recomputed inventory SHA ${invSha} != ${EXPECT_SHA}`);
const srcCount = invPaths.filter((p) => p.startsWith('src/')).length;
const testCount = invPaths.filter((p) => p.startsWith('tests/')).length;
if (srcCount !== 110 || testCount !== 107) fail(`split ${srcCount}/${testCount} != 110/107`);

// Cross-check against provenance.
const evidence = JSON.parse(readFileSync(EVIDENCE_PATH, 'utf8'));
const parity = JSON.parse(readFileSync(PARITY_PATH, 'utf8'));
const targetOnlyPolicy = JSON.parse(readFileSync(TARGET_POLICY_PATH, 'utf8'));
if (evidence.source_commit !== SRC_SHA) fail(`source-evidence source_commit ${evidence.source_commit} != ${SRC_SHA}`);
if (parity.source_commit !== SRC_SHA) fail(`parity source_commit ${parity.source_commit} != ${SRC_SHA}`);
if (evidence.inventory_sha256 !== EXPECT_SHA) fail(`source-evidence inventory_sha256 ${evidence.inventory_sha256} != ${EXPECT_SHA}`);
if (evidence.path_count !== EXPECT_PATH_COUNT || evidence.entries.length !== EXPECT_PATH_COUNT) {
  fail(`source-evidence path_count/entries ${evidence.path_count}/${evidence.entries.length} != ${EXPECT_PATH_COUNT}`);
}
const evidencePaths = evidence.entries.map((entry) => entry.path);
if (evidencePaths.some((path, index) => path !== invPaths[index])) {
  fail('source-evidence path order/content differs from recomputed canonical inventory');
}
if (sha256(Buffer.from(evidencePaths.map((path) => `${path}\n`).join(''), 'utf8')) !== evidence.inventory_sha256) {
  fail('source-evidence path stream does not reproduce inventory_sha256');
}
if (parity.ready_content_sha !== READY_CONTENT_SHA) fail(`parity ready_content_sha ${parity.ready_content_sha} != reviewed ${READY_CONTENT_SHA}`);
if (targetOnlyPolicy.ready_content_sha !== READY_CONTENT_SHA) fail(`target-only policy ready_content_sha ${targetOnlyPolicy.ready_content_sha} != reviewed ${READY_CONTENT_SHA}`);
const invSet = new Set(invPaths);
const evSet = new Set(evidence.entries.map((e) => e.path));
const pmSet = new Set(parity.rows.map((r) => r.path));
if (evSet.size !== 217 || pmSet.size !== 217) fail(`source-evidence(${evSet.size}) / parity(${pmSet.size}) not 217 unique paths`);
for (const p of invPaths) {
  if (!evSet.has(p)) fail(`inventory path missing from source-evidence: ${p}`);
  if (!pmSet.has(p)) fail(`inventory path missing from parity-matrix: ${p}`);
}
for (const p of evSet) if (!invSet.has(p)) fail(`source-evidence has a path not in the recomputed closure: ${p}`);

const evidenceByPath = new Map(evidence.entries.map((entry) => [entry.path, entry]));
for (const row of parity.rows) {
  const source = evidenceByPath.get(row.path);
  if (!source) fail(`parity path missing same-path source-evidence row: ${row.path}`);
  if (row.source_blob_oid !== source.blob_oid) {
    fail(`parity/source-evidence blob OID mismatch for ${row.path}: ${row.source_blob_oid} != ${source.blob_oid}`);
  }
  if (row.source_content_sha256 !== source.content_sha256) {
    fail(`parity/source-evidence content hash mismatch for ${row.path}: ${row.source_content_sha256} != ${source.content_sha256}`);
  }
  if (row.disposition === 'excluded') {
    if (Object.hasOwn(row, 'target_path')) fail(`excluded row must not declare target_path: ${row.path}`);
    if (typeof row.excluded_reason !== 'string' || row.excluded_reason.length === 0) fail(`excluded row lacks rationale: ${row.path}`);
  } else {
    if (row.target_path !== row.path) fail(`${row.disposition} target_path mismatch for ${row.path}`);
  }
  if (row.disposition === 'rewritten' && row.replay_command !== replayCommandFor(row)) {
    fail(`replay_command mismatch for ${row.path}`);
  }
}

const policySha = dispositionPolicySha(parity.rows);
if (parity.disposition_policy_sha256 !== policySha) {
  fail(`parity disposition_policy_sha256 ${parity.disposition_policy_sha256} != computed ${policySha}`);
}
if (policySha !== EXPECT_DISPOSITION_POLICY_SHA) {
  fail(`disposition policy differs from ready-reviewed cannot-exclude map: ${policySha}`);
}

const computed = Object.fromEntries(DISPOSITIONS.map((name) => [name, 0]));
for (const row of parity.rows) {
  if (!DISPOSITIONS.includes(row.disposition)) fail(`unknown disposition ${row.disposition} for ${row.path}`);
  computed[row.disposition]++;
}
for (const name of DISPOSITIONS) {
  if (parity.counts[name] !== computed[name]) {
    fail(`parity counts.${name} mismatch: declared ${parity.counts[name]} != computed ${computed[name]}`);
  }
}
if (parity.counts.total !== parity.rows.length) fail(`parity counts.total ${parity.counts.total} != computed ${parity.rows.length}`);

for (const entry of evidence.entries) {
  const source = sourceByPath.get(entry.path);
  if (!source || source.type !== 'blob') fail(`source-evidence path is not one pinned blob: ${entry.path}`);
  if (entry.mode !== source.mode) fail(`source-evidence mode mismatch for ${entry.path}: ${entry.mode} != ${source.mode}`);
  if (entry.mode !== '100644') fail(`source-evidence non-regular mode rejected for ${entry.path}: ${entry.mode}`);
  if (entry.blob_oid !== source.oid) fail(`source-evidence OID mismatch for ${entry.path}`);
  if (entry.content_sha256 !== sha256(git(['cat-file', 'blob', entry.blob_oid]))) {
    fail(`source-evidence content hash mismatch for ${entry.path}`);
  }
}

process.stdout.write(`audit-pinned-extraction OK: 217 paths (110 src, 107 test), SHA ${invSha.slice(0, 12)}…; partition ${computed.ported}/${computed.rewritten}/${computed.duplicated}/${computed.excluded}\n`);
