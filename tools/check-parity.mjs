#!/usr/bin/env node
// check-parity.mjs — AC6 parity verifier (item 135).
//
// Verifies provenance/source-evidence.v1.json and provenance/parity-matrix.v1.json
// against (a) the pinned Project_echo source objects and (b) the accepted target
// working tree:
//   - every source-evidence row's blob_oid + content_sha256 matches the pinned
//     source object;
//   - ported rows: the target file bytes equal the source blob byte-for-byte;
//   - rewritten rows: the target file hash equals the recorded target_content_sha256
//     (and differs from the source — an authored whole-blob replacement is allowed
//     to differ, but the row MUST carry a deterministic rewrite descriptor);
//   - excluded rows: the path is absent from the target working tree.
//
//   node tools/check-parity.mjs --source-git-dir <project_echo>/.git \
//        --source-sha <oid> --target <target-root>

import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

const GIT = '/usr/local/bin/git';
function fail(m) { process.stderr.write(`check-parity: ${m}\n`); process.exit(1); }
function arg(n) { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : undefined; }

const SRC_GIT = arg('--source-git-dir') || fail('--source-git-dir required');
const SRC_SHA = arg('--source-sha') || fail('--source-sha required');
const TARGET = arg('--target') || fail('--target required');
const ENV = { PATH: '/usr/bin:/bin:/usr/local/bin', HOME: process.env.HOME ?? '/tmp', GIT_CONFIG_NOSYSTEM: '1', GIT_ATTR_NOSYSTEM: '1', GIT_NO_REPLACE_OBJECTS: '1' };
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
function srcBlob(oid) { return execFileSync(GIT, ['--git-dir', SRC_GIT, 'cat-file', 'blob', oid], { env: ENV, maxBuffer: 256 * 1024 * 1024 }); }
function srcOidAt(path) {
  const out = execFileSync(GIT, ['--git-dir', SRC_GIT, 'ls-tree', SRC_SHA, '--', path], { env: ENV }).toString('utf8').trim();
  const m = out.match(/^\d{6} \w+ ([0-9a-f]{40})\t/);
  return m ? m[1] : null;
}

const evidence = JSON.parse(readFileSync(join(TARGET, 'provenance/source-evidence.v1.json'), 'utf8'));
const parity = JSON.parse(readFileSync(join(TARGET, 'provenance/parity-matrix.v1.json'), 'utf8'));

let checked = 0;
// 1. source-evidence: every row's oid + content hash matches the pinned source.
for (const e of evidence.entries) {
  const oid = srcOidAt(e.path);
  if (oid !== e.blob_oid) fail(`source-evidence oid mismatch for ${e.path}: pinned ${oid} != recorded ${e.blob_oid}`);
  const bytes = srcBlob(e.blob_oid);
  if (sha256(bytes) !== e.content_sha256) fail(`source-evidence content hash mismatch for ${e.path}`);
  checked++;
}

// 2. parity dispositions vs target.
let ported = 0, rewritten = 0, excluded = 0;
for (const r of parity.rows) {
  const tpath = join(TARGET, r.path);
  if (r.disposition === 'ported') {
    if (!existsSync(tpath)) fail(`ported file missing in target: ${r.path}`);
    const tgt = readFileSync(tpath);
    const src = srcBlob(r.source_blob_oid);
    if (!tgt.equals(src)) fail(`ported file bytes differ from source blob: ${r.path}`);
    ported++;
  } else if (r.disposition === 'rewritten') {
    if (!existsSync(tpath)) fail(`rewritten file missing in target: ${r.path}`);
    const th = sha256(readFileSync(tpath));
    if (!r.target_content_sha256) fail(`rewritten row lacks target_content_sha256: ${r.path}`);
    if (th !== r.target_content_sha256) fail(`rewritten file hash mismatch: ${r.path}`);
    if (!r.rewrite_kind || !r.replay) fail(`rewritten row lacks deterministic descriptor (rewrite_kind/replay): ${r.path}`);
    rewritten++;
  } else if (r.disposition === 'excluded') {
    if (existsSync(tpath)) fail(`excluded path present in target: ${r.path}`);
    if (!r.excluded_reason) fail(`excluded row lacks rationale: ${r.path}`);
    excluded++;
  } else fail(`unknown disposition ${r.disposition} for ${r.path}`);
}

if (parity.counts.total !== parity.rows.length) fail('parity counts.total mismatch');
process.stdout.write(`check-parity OK: ${checked} source-evidence rows; ported=${ported} rewritten=${rewritten} excluded=${excluded}\n`);
