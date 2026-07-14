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

// Anti-whole-blob: fraction of target lines that also occur in the source. A
// genuine rewrite preserves most of the source; a whole-blob replacement ~0.
export function sharedLineFraction(sourceText, targetText) {
  const src = new Set(sourceText.split('\n'));
  const tgt = targetText.split('\n');
  if (tgt.length === 0) return 0;
  let shared = 0;
  for (const l of tgt) if (src.has(l)) shared++;
  return shared / tgt.length;
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

function main() {
  const arg = (n) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : undefined; };
  const fail = (m) => { process.stderr.write(`check-parity: ${m}\n`); process.exit(1); };
  const SRC_GIT = arg('--source-git-dir') || fail('--source-git-dir required');
  const SRC_SHA = arg('--source-sha') || fail('--source-sha required');
  const TARGET = arg('--target') || fail('--target required');
  const ENV = { PATH: '/usr/bin:/bin:/usr/local/bin', HOME: process.env.HOME ?? '/tmp', GIT_CONFIG_NOSYSTEM: '1', GIT_ATTR_NOSYSTEM: '1', GIT_NO_REPLACE_OBJECTS: '1' };
  const srcBlob = (oid) => execFileSync(GIT, ['--git-dir', SRC_GIT, 'cat-file', 'blob', oid], { env: ENV, maxBuffer: 256 * 1024 * 1024 });
  const srcOidAt = (path) => {
    const out = execFileSync(GIT, ['--git-dir', SRC_GIT, 'ls-tree', SRC_SHA, '--', path], { env: ENV }).toString('utf8').trim();
    const m = out.match(/^\d{6} \w+ ([0-9a-f]{40})\t/);
    return m ? m[1] : null;
  };
  const evidence = JSON.parse(readFileSync(join(TARGET, 'provenance/source-evidence.v1.json'), 'utf8'));
  const parity = JSON.parse(readFileSync(join(TARGET, 'provenance/parity-matrix.v1.json'), 'utf8'));

  let checked = 0;
  for (const e of evidence.entries) {
    const oid = srcOidAt(e.path);
    if (oid !== e.blob_oid) fail(`source-evidence oid mismatch for ${e.path}`);
    if (sha256(srcBlob(e.blob_oid)) !== e.content_sha256) fail(`source-evidence content hash mismatch for ${e.path}`);
    checked++;
  }

  const counts = { ported: 0, rewritten: 0, duplicated: 0, excluded: 0 };
  for (const r of parity.rows) {
    const tpath = join(TARGET, r.path);
    try {
      if (r.disposition === 'ported') {
        if (!existsSync(tpath)) fail(`ported file missing: ${r.path}`);
        if (!readFileSync(tpath).equals(srcBlob(r.source_blob_oid))) fail(`ported bytes differ from source: ${r.path}`);
      } else if (r.disposition === 'rewritten') {
        if (!existsSync(tpath)) fail(`rewritten file missing: ${r.path}`);
        verifyRewrittenRow(srcBlob(r.source_blob_oid), readFileSync(tpath), r);
      } else if (r.disposition === 'duplicated') {
        if (!existsSync(tpath)) fail(`duplicated file missing: ${r.path}`);
        verifyDuplicatedRow(srcBlob(r.source_blob_oid), readFileSync(tpath), r);
      } else if (r.disposition === 'excluded') {
        if (existsSync(tpath)) fail(`excluded path present: ${r.path}`);
        if (!r.excluded_reason) fail(`excluded row lacks rationale: ${r.path}`);
      } else fail(`unknown disposition ${r.disposition} for ${r.path}`);
    } catch (err) {
      fail(err.message);
    }
    counts[r.disposition]++;
  }
  if (parity.counts.total !== parity.rows.length) fail('parity counts.total mismatch');
  process.stdout.write(`check-parity OK: ${checked} source-evidence rows; ported=${counts.ported} rewritten=${counts.rewritten} duplicated=${counts.duplicated} excluded=${counts.excluded}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main();
