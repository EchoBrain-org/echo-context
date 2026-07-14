#!/usr/bin/env node
// check-parity.mjs — AC6 parity verifier (item 135).
//
// Verifies provenance/source-evidence.v1.json and provenance/parity-matrix.v1.json
// against (a) the pinned Project_echo source objects and (b) the accepted target:
//   - source-evidence: every row's blob_oid + content_sha256 matches the pinned object;
//   - ported: target bytes == source blob byte-for-byte;
//   - rewritten: the row's `replay_patch` is a DETERMINISTIC unified diff that, applied
//     to the pinned source blob, reproduces the exact target bytes (target_content_sha256).
//     A whole-blob substitution FAILS (the rewrite must retain a substantial share of the
//     source; an authored full replacement is rejected). This is AC6's exact-replay /
//     anti-whole-blob guarantee, enforced fail-closed — not a hash+field-presence check.
//   - duplicated (AC5): an authored minimal generic duplicate (e.g. the item-133-owned
//     granola-signals subset). It is NOT a byte-diff of the source, so it carries a
//     `duplication_rationale` and is verified to (a) exist, (b) differ from the source blob,
//     and (c) not be a byte-copy — never a silent double-claim. No replay is executed.
//   - excluded: absent from the target, with a recorded rationale.
//
//   node tools/check-parity.mjs --source-git-dir <project_echo>/.git \
//        --source-sha <oid> --target <target-root>

import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const GIT = '/usr/local/bin/git';
const PINNED_SOURCE_COMMIT = '2971310441b69735cbe759293abd8c4d044bf347';
const EXPECTED_INVENTORY_SHA256 = '8b0280660ea5eb64851a5ce0d1a9d56b707d6e29ce00d113ec6656b055d72d37';
const EXPECTED_PATH_COUNT = 217;
const READY_CONTENT_SHA = 'aa9fa9d89c30b2ba2823d6b3eecdc32e389120bb9f3bc46538b9335a301c8392';
// SHA-256 of the ready-reviewed, UTF-8 byte-sorted stream
//   path + NUL + disposition + LF
// for all 217 rows. This makes the reviewed product/loop exclusion map the
// cannot-exclude policy: changing a protected row to `excluded` (or changing
// any other disposition), even while self-consistently editing counts, fails.
const EXPECTED_DISPOSITION_POLICY_SHA256 = '7f905d1e3b64828e7b10e794af2c93a64daf12f92b53b11439b6bf18ac2d7069';
const DISPOSITIONS = ['ported', 'rewritten', 'duplicated', 'excluded'];
export const WHOLE_BLOB_MIN_SHARED_LINE_FRACTION = 0.3;

export function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

// The Git blob object id of a byte buffer: sha1("blob <len>\0" + bytes). AC6
// requires each rewritten (and, for uniform completeness, duplicated) row to
// bind the TARGET blob OID; this recomputes it from the target file bytes.
export function gitBlobOid(buf) {
  const header = Buffer.from(`blob ${buf.length}\0`, 'utf8');
  return createHash('sha1').update(Buffer.concat([header, buf])).digest('hex');
}

// Minimal unified-diff applier (git `--no-index` output). Applies the hunks to
// `sourceText` and returns the transformed text; throws on any context mismatch,
// making the replay deterministic and fail-closed.
export function applyUnifiedDiff(sourceText, patchText) {
  const srcLines = sourceText.split('\n');
  const out = [];
  let srcIdx = 0; // 0-based cursor into srcLines
  const lines = patchText.split('\n');
  let i = 0;
  while (i < lines.length && !lines[i].startsWith('@@')) i++; // skip file headers
  while (i < lines.length) {
    const h = lines[i];
    if (!h.startsWith('@@')) { i++; continue; }
    const m = h.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
    if (!m) throw new Error(`bad hunk header: ${h}`);
    const srcStart = parseInt(m[1], 10) - 1; // 0-based
    while (srcIdx < srcStart) out.push(srcLines[srcIdx++]);
    i++;
    while (i < lines.length && !lines[i].startsWith('@@')) {
      const l = lines[i];
      if (l.startsWith('\\')) { i++; continue; } // "\ No newline at end of file"
      const tag = l[0];
      const text = l.slice(1);
      if (tag === ' ') {
        if (srcLines[srcIdx] !== text) throw new Error(`context mismatch at src line ${srcIdx + 1}`);
        out.push(srcLines[srcIdx++]);
      } else if (tag === '-') {
        if (srcLines[srcIdx] !== text) throw new Error(`deletion mismatch at src line ${srcIdx + 1}`);
        srcIdx++;
      } else if (tag === '+') {
        out.push(text);
      } else if (l === '') {
        if (srcLines[srcIdx] === '') { out.push(''); srcIdx++; }
      } else {
        throw new Error(`bad hunk line: ${l}`);
      }
      i++;
    }
  }
  while (srcIdx < srcLines.length) out.push(srcLines[srcIdx++]);
  return out.join('\n');
}

// Anti-whole-blob: ordered, multiplicity-bounded retention of substantive
// lines. Blank/whitespace-only lines carry no evidence. Longest-common-
// subsequence matching means one source occurrence can justify at most one
// target occurrence and line order must be preserved, so repeating a common
// line (or injecting blank lines) cannot inflate the score as it could with a
// Set-membership metric. The max(source,target) denominator also rejects a
// tiny harvested subset and insertion-heavy authored replacements.
export function sharedLineFraction(sourceText, targetText) {
  const src = sourceText.split('\n').filter((line) => line.trim().length > 0);
  const tgt = targetText.split('\n').filter((line) => line.trim().length > 0);
  const denominator = Math.max(src.length, tgt.length);
  if (denominator === 0) return 0;

  // O(source*target) time, O(target) memory. The sealed rewritten files are
  // small enough for this deterministic exact algorithm (the largest is a
  // test module of roughly 1.6k lines).
  let previous = new Uint32Array(tgt.length + 1);
  for (const sourceLine of src) {
    const current = new Uint32Array(tgt.length + 1);
    for (let j = 1; j <= tgt.length; j++) {
      current[j] = sourceLine === tgt[j - 1]
        ? previous[j - 1] + 1
        : Math.max(previous[j], current[j - 1]);
    }
    previous = current;
  }
  return previous[tgt.length] / denominator;
}

export function dispositionPolicySha256(rows) {
  const sorted = [...rows].sort((a, b) => Buffer.compare(Buffer.from(a.path, 'utf8'), Buffer.from(b.path, 'utf8')));
  const framed = sorted.map((row) => `${row.path}\0${row.disposition}\n`).join('');
  return sha256(Buffer.from(framed, 'utf8'));
}

export function replayCommandFor(row, sourceSha) {
  return `Apply this row's replay_patch (unified diff) to the pinned source blob ${row.source_blob_oid} — the result reproduces target_content_sha256. Enforced by: node tools/check-parity.mjs --source-git-dir <project_echo>/.git --source-sha ${sourceSha} --target .`;
}

function verifyReplayDescriptor(row, sourceSha) {
  const expectedCommand = replayCommandFor(row, sourceSha);
  if (row.replay_command !== expectedCommand) {
    throw new Error(`replay_command mismatch for ${row.path}`);
  }
  const lines = row.replay_patch.split('\n');
  const expectedHeaders = [
    `diff --git a/src/${row.path} b/tgt/${row.path}`,
    `index ${row.source_blob_oid.slice(0, 7)}..${row.target_blob_oid.slice(0, 7)} 100644`,
    `--- a/src/${row.path}`,
    `+++ b/tgt/${row.path}`,
  ];
  for (let i = 0; i < expectedHeaders.length; i++) {
    if (lines[i] !== expectedHeaders[i]) {
      throw new Error(`replay_patch identity header mismatch for ${row.path}`);
    }
  }
}

function computeAndVerifyCounts(parity) {
  const computed = Object.fromEntries(DISPOSITIONS.map((name) => [name, 0]));
  for (const row of parity.rows) {
    if (!DISPOSITIONS.includes(row.disposition)) {
      throw new Error(`unknown disposition ${row.disposition} for ${row.path}`);
    }
    computed[row.disposition]++;
  }
  for (const name of DISPOSITIONS) {
    if (parity.counts[name] !== computed[name]) {
      throw new Error(`parity counts.${name} mismatch: declared ${parity.counts[name]} != computed ${computed[name]}`);
    }
  }
  if (parity.counts.total !== parity.rows.length) {
    throw new Error(`parity counts.total mismatch: declared ${parity.counts.total} != computed ${parity.rows.length}`);
  }
  return computed;
}

function verifyPolicyEnvelope(parity, targetOnlyPolicy) {
  if (parity.ready_content_sha !== READY_CONTENT_SHA) {
    throw new Error(`parity ready_content_sha ${parity.ready_content_sha} != reviewed ${READY_CONTENT_SHA}`);
  }
  if (targetOnlyPolicy.ready_content_sha !== READY_CONTENT_SHA) {
    throw new Error(`target-only policy ready_content_sha ${targetOnlyPolicy.ready_content_sha} != reviewed ${READY_CONTENT_SHA}`);
  }
  const computed = dispositionPolicySha256(parity.rows);
  if (parity.disposition_policy_sha256 !== computed) {
    throw new Error(`parity disposition_policy_sha256 ${parity.disposition_policy_sha256} != computed ${computed}`);
  }
  if (computed !== EXPECTED_DISPOSITION_POLICY_SHA256) {
    throw new Error(`disposition policy differs from ready-reviewed cannot-exclude map: ${computed}`);
  }
}

function verifyEvidenceEnvelope(evidence) {
  if (evidence.inventory_sha256 !== EXPECTED_INVENTORY_SHA256) {
    throw new Error(`source-evidence inventory_sha256 ${evidence.inventory_sha256} != ${EXPECTED_INVENTORY_SHA256}`);
  }
  if (evidence.path_count !== EXPECTED_PATH_COUNT || evidence.entries.length !== EXPECTED_PATH_COUNT) {
    throw new Error(`source-evidence path_count/entries mismatch: ${evidence.path_count}/${evidence.entries.length} != ${EXPECTED_PATH_COUNT}`);
  }
  const paths = evidence.entries.map((entry) => entry.path);
  const sorted = [...paths].sort((a, b) => Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8')));
  if (paths.some((path, index) => path !== sorted[index])) {
    throw new Error('source-evidence entries are not in canonical raw UTF-8 path order');
  }
  const computed = sha256(Buffer.from(paths.map((path) => `${path}\n`).join(''), 'utf8'));
  if (computed !== evidence.inventory_sha256) {
    throw new Error(`source-evidence path stream hash ${computed} != inventory_sha256 ${evidence.inventory_sha256}`);
  }
}

export function verifyRewrittenRow(sourceBytes, targetBytes, row) {
  if (!row.replay_patch || typeof row.replay_patch !== 'string') throw new Error(`rewritten row lacks replay_patch: ${row.path}`);
  if (!row.replay_command) throw new Error(`rewritten row lacks replay_command: ${row.path}`);
  // AC6 (F6): the row must bind the full target Git blob OID; recompute + verify.
  if (!row.target_blob_oid || !/^[0-9a-f]{40}$/.test(row.target_blob_oid)) throw new Error(`rewritten row lacks a full target_blob_oid: ${row.path}`);
  const computedOid = gitBlobOid(targetBytes);
  if (computedOid !== row.target_blob_oid) throw new Error(`target_blob_oid mismatch for ${row.path}: row ${row.target_blob_oid} != git ${computedOid}`);
  const sourceText = sourceBytes.toString('utf8');
  const targetText = targetBytes.toString('utf8');
  const frac = sharedLineFraction(sourceText, targetText);
  if (frac < WHOLE_BLOB_MIN_SHARED_LINE_FRACTION) {
    throw new Error(`whole-blob substitution rejected for ${row.path}: only ${(frac * 100).toFixed(1)}% of target lines shared with source (min ${WHOLE_BLOB_MIN_SHARED_LINE_FRACTION * 100}%)`);
  }
  const replayed = applyUnifiedDiff(sourceText, row.replay_patch);
  const replayedSha = sha256(Buffer.from(replayed, 'utf8'));
  if (replayedSha !== row.target_content_sha256) {
    throw new Error(`replay for ${row.path} does NOT reproduce target_content_sha256 (got ${replayedSha.slice(0, 16)}…)`);
  }
  if (replayedSha !== sha256(targetBytes)) {
    throw new Error(`replay for ${row.path} reproduces a different byte stream than the committed target`);
  }
}

export function verifyDuplicatedRow(sourceBytes, targetBytes, row) {
  if (!row.duplication_rationale) throw new Error(`duplicated row lacks duplication_rationale: ${row.path}`);
  if (targetBytes.equals(sourceBytes)) throw new Error(`duplicated row is a byte-copy of the source (silent double-claim): ${row.path}`);
  if (!row.target_content_sha256 || sha256(targetBytes) !== row.target_content_sha256) throw new Error(`duplicated row target hash mismatch: ${row.path}`);
  // Bind the full target Git blob OID (uniform with rewritten rows).
  if (!row.target_blob_oid || !/^[0-9a-f]{40}$/.test(row.target_blob_oid)) throw new Error(`duplicated row lacks a full target_blob_oid: ${row.path}`);
  if (gitBlobOid(targetBytes) !== row.target_blob_oid) throw new Error(`target_blob_oid mismatch for ${row.path}`);
}

export function bindParityRowsToEvidence(evidenceEntries, parityRows) {
  const evidenceByPath = new Map();
  for (const entry of evidenceEntries) {
    if (evidenceByPath.has(entry.path)) {
      throw new Error(`duplicate source-evidence path: ${entry.path}`);
    }
    evidenceByPath.set(entry.path, entry);
  }
  const parityPaths = new Set();
  for (const row of parityRows) {
    if (parityPaths.has(row.path)) throw new Error(`duplicate parity path: ${row.path}`);
    parityPaths.add(row.path);
    const evidence = evidenceByPath.get(row.path);
    if (!evidence) throw new Error(`parity path missing same-path source-evidence row: ${row.path}`);
    if (row.source_blob_oid !== evidence.blob_oid) {
      throw new Error(
        `parity/source-evidence blob OID mismatch for ${row.path}: ` +
          `${row.source_blob_oid} != ${evidence.blob_oid}`,
      );
    }
    if (row.source_content_sha256 !== evidence.content_sha256) {
      throw new Error(
        `parity/source-evidence content hash mismatch for ${row.path}: ` +
          `${row.source_content_sha256} != ${evidence.content_sha256}`,
      );
    }
  }
  for (const path of evidenceByPath.keys()) {
    if (!parityPaths.has(path)) throw new Error(`source-evidence path missing parity row: ${path}`);
  }
}

function main() {
  const arg = (n) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : undefined; };
  const fail = (m) => { process.stderr.write(`check-parity: ${m}\n`); process.exit(1); };
  const SRC_GIT = arg('--source-git-dir') || fail('--source-git-dir required');
  const SRC_SHA = arg('--source-sha') || fail('--source-sha required');
  const TARGET = arg('--target') || fail('--target required');
  const EVIDENCE_PATH = arg('--evidence') || join(TARGET, 'provenance/source-evidence.v1.json');
  const PARITY_PATH = arg('--parity') || join(TARGET, 'provenance/parity-matrix.v1.json');
  const TARGET_POLICY_PATH = arg('--target-only-policy') || join(TARGET, 'provenance/target-only-policy.v1.json');
  const ENV = { PATH: '/usr/bin:/bin:/usr/local/bin', HOME: process.env.HOME ?? '/tmp', GIT_CONFIG_NOSYSTEM: '1', GIT_ATTR_NOSYSTEM: '1', GIT_NO_REPLACE_OBJECTS: '1' };
  const srcBlob = (oid) => execFileSync(GIT, ['--git-dir', SRC_GIT, 'cat-file', 'blob', oid], { env: ENV, maxBuffer: 256 * 1024 * 1024 });
  const srcEntryAt = (path) => {
    const out = execFileSync(GIT, ['--git-dir', SRC_GIT, 'ls-tree', SRC_SHA, '--', path], { env: ENV }).toString('utf8').trim();
    const m = out.match(/^(\d{6}) (\w+) ([0-9a-f]{40})\t/);
    return m ? { mode: m[1], type: m[2], oid: m[3] } : null;
  };
  const evidence = JSON.parse(readFileSync(EVIDENCE_PATH, 'utf8'));
  const parity = JSON.parse(readFileSync(PARITY_PATH, 'utf8'));
  const targetOnlyPolicy = JSON.parse(readFileSync(TARGET_POLICY_PATH, 'utf8'));

  if (SRC_SHA !== PINNED_SOURCE_COMMIT) fail(`source SHA ${SRC_SHA} != pinned ${PINNED_SOURCE_COMMIT}`);
  if (evidence.source_commit !== SRC_SHA) fail(`source-evidence source_commit ${evidence.source_commit} != ${SRC_SHA}`);
  if (parity.source_commit !== SRC_SHA) fail(`parity source_commit ${parity.source_commit} != ${SRC_SHA}`);
  try {
    verifyEvidenceEnvelope(evidence);
    bindParityRowsToEvidence(evidence.entries, parity.rows);
    verifyPolicyEnvelope(parity, targetOnlyPolicy);
  } catch (err) {
    fail(err.message);
  }

  let checked = 0;
  let counts;
  try {
    counts = computeAndVerifyCounts(parity);
    for (const row of parity.rows) {
      if (row.disposition === 'excluded') {
        if (Object.hasOwn(row, 'target_path')) throw new Error(`excluded row must not declare target_path: ${row.path}`);
        if (typeof row.excluded_reason !== 'string' || row.excluded_reason.length === 0) throw new Error(`excluded row lacks rationale: ${row.path}`);
      } else if (row.target_path !== row.path) {
        throw new Error(`${row.disposition} target_path mismatch for ${row.path}`);
      }
      if (row.disposition === 'rewritten') verifyReplayDescriptor(row, SRC_SHA);
    }
  } catch (err) {
    fail(err.message);
  }

  for (const e of evidence.entries) {
    const entry = srcEntryAt(e.path);
    if (entry?.type !== 'blob') fail(`source-evidence path is not one pinned blob: ${e.path}`);
    if (entry.oid !== e.blob_oid) fail(`source-evidence oid mismatch for ${e.path}`);
    if (entry.mode !== e.mode) fail(`source-evidence mode mismatch for ${e.path}: ${e.mode} != ${entry.mode}`);
    if (e.mode !== '100644') fail(`source-evidence non-regular mode rejected for ${e.path}: ${e.mode}`);
    if (sha256(srcBlob(e.blob_oid)) !== e.content_sha256) fail(`source-evidence content hash mismatch for ${e.path}`);
    checked++;
  }

  for (const r of parity.rows) {
    const tpath = join(TARGET, r.path);
    try {
      if (r.disposition === 'ported') {
        if (r.target_path !== r.path) fail(`ported target_path mismatch for ${r.path}`);
        if (!existsSync(tpath)) fail(`ported file missing: ${r.path}`);
        if (!readFileSync(tpath).equals(srcBlob(r.source_blob_oid))) fail(`ported bytes differ from source: ${r.path}`);
      } else if (r.disposition === 'rewritten') {
        if (r.target_path !== r.path) fail(`rewritten target_path mismatch for ${r.path}`);
        if (!existsSync(tpath)) fail(`rewritten file missing: ${r.path}`);
        verifyReplayDescriptor(r, SRC_SHA);
        verifyRewrittenRow(srcBlob(r.source_blob_oid), readFileSync(tpath), r);
      } else if (r.disposition === 'duplicated') {
        if (r.target_path !== r.path) fail(`duplicated target_path mismatch for ${r.path}`);
        if (!existsSync(tpath)) fail(`duplicated file missing: ${r.path}`);
        verifyDuplicatedRow(srcBlob(r.source_blob_oid), readFileSync(tpath), r);
      } else if (r.disposition === 'excluded') {
        if (Object.hasOwn(r, 'target_path')) fail(`excluded row must not declare target_path: ${r.path}`);
        if (existsSync(tpath)) fail(`excluded path present: ${r.path}`);
        if (!r.excluded_reason) fail(`excluded row lacks rationale: ${r.path}`);
      } else fail(`unknown disposition ${r.disposition} for ${r.path}`);
    } catch (err) {
      fail(err.message);
    }
  }
  process.stdout.write(`check-parity OK: ${checked} source-evidence rows; ported=${counts.ported} rewritten=${counts.rewritten} duplicated=${counts.duplicated} excluded=${counts.excluded}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main();
