import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Ajv } from 'ajv';
import { describe, expect, it } from 'vitest';

// AC6 — the exact 217/110/107 raw-object inventory and disposition allowlists.
// Runs the operator audit + parity verifier against the pinned source, and
// validates every provenance document against its committed schema.
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const NODE = '/usr/local/bin/node';
const SRC_GIT = process.env.ECHO_SOURCE_GIT_DIR ?? '/Users/zhenye/Desktop/Project_echo/.git';
const SRC_SHA = process.env.ECHO_SOURCE_SHA ?? '2971310441b69735cbe759293abd8c4d044bf347';

function run(tool: string): string {
  return execFileSync(
    NODE,
    [join(ROOT, 'tools', tool), '--source-git-dir', SRC_GIT, '--source-sha', SRC_SHA, '--target', ROOT],
    { encoding: 'utf8' },
  );
}

describe('AC6 — parity matrix + source inventory', () => {
  it('audit-pinned-extraction recomputes the 217/110/107 closure', () => {
    expect(run('audit-pinned-extraction.mjs')).toMatch(/audit-pinned-extraction OK: 217 paths \(110 src, 107 test\)/);
  });

  it('check-parity EXECUTES each rewritten replay + verifies exclusions/duplication', () => {
    expect(run('check-parity.mjs')).toMatch(/check-parity OK: 217 source-evidence rows; ported=144 rewritten=7 duplicated=1 excluded=65/);
  }, 30000);

  it('the disposition counts partition the full 217-path inventory', () => {
    const pm = JSON.parse(readFileSync(join(ROOT, 'provenance/parity-matrix.v1.json'), 'utf8')) as {
      counts: { ported: number; rewritten: number; duplicated: number; excluded: number; total: number };
    };
    expect(pm.counts.ported + pm.counts.rewritten + pm.counts.duplicated + pm.counts.excluded).toBe(217);
    expect(pm.counts).toMatchObject({ ported: 144, rewritten: 7, duplicated: 1, excluded: 65, total: 217 });
  });

  it('every provenance document validates against its committed schema', () => {
    const ajv = new Ajv({ allErrors: true, strict: false });
    const pairs: [string, string][] = [
      ['target-only-policy.v1.json', 'target-only-policy.v1.schema.json'],
      ['runtime-inventory.v1.json', 'runtime-inventory.v1.schema.json'],
      ['source-evidence.v1.json', 'source-evidence.v1.schema.json'],
      ['parity-matrix.v1.json', 'parity-matrix.v1.schema.json'],
      ['source-extraction.v1.json', 'source-extraction.v1.schema.json'],
      ['lifecycle-expected.v1.json', 'lifecycle-expected.v1.schema.json'],
      ['lifecycle-observed.v1.json', 'lifecycle-observed.v1.schema.json'],
      ['native-toolchain.v1.json', 'native-toolchain.v1.schema.json'],
      ['context-tool-parity.v1.json', 'context-tool-parity.v1.schema.json'],
    ];
    for (const [doc, schema] of pairs) {
      const s = JSON.parse(readFileSync(join(ROOT, 'provenance/schemas', schema), 'utf8'));
      const d = JSON.parse(readFileSync(join(ROOT, 'provenance', doc), 'utf8'));
      const validate = ajv.compile(s);
      const ok = validate(d);
      if (!ok) throw new Error(`${doc} fails ${schema}: ${JSON.stringify(validate.errors)}`);
      expect(ok).toBe(true);
    }
  });
});

// AC6 F5 — the rewrite-replay verifier is fail-closed: an authored whole-blob
// substitution, an incomplete/mismatched replay, and an omitted descriptor must
// all be REJECTED. These mutation fixtures exercise check-parity's real logic.
type CheckParity = {
  applyUnifiedDiff: (source: string, patch: string) => string;
  sha256: (buf: Buffer) => string;
  gitBlobOid: (buf: Buffer) => string;
  sharedLineFraction: (source: string, target: string) => number;
  verifyRewrittenRow: (sourceBytes: Buffer, targetBytes: Buffer, row: unknown) => void;
  verifyDuplicatedRow: (sourceBytes: Buffer, targetBytes: Buffer, row: unknown) => void;
};
const importCheckParity = (): Promise<CheckParity> =>
  // @ts-expect-error tools/check-parity.mjs is a plain .mjs tool with no .d.ts; its shape is asserted via CheckParity.
  import('../../tools/check-parity.mjs') as Promise<CheckParity>;

describe('AC6 — rewrite replay + anti-whole-blob + target-OID enforcement (mutation fixtures)', () => {
  const source = 'line1\nline2\nline3\nline4\nline5\n';
  const b = (s: string) => Buffer.from(s, 'utf8');
  // a complete, valid rewritten row for `target`, given a reproducing patch.
  const validRow = (cp: CheckParity, patch: string, target: string) => ({
    path: 'x',
    replay_patch: patch,
    replay_command: 'cmd',
    target_content_sha256: cp.sha256(b(target)),
    target_blob_oid: cp.gitBlobOid(b(target)),
  });
  const deletePatch = '--- a\n+++ b\n@@ -1,5 +1,4 @@\n line1\n line2\n-line3\n line4\n line5\n';

  it('a legitimate deletion rewrite (replay reproduces target, OID matches) PASSES', async () => {
    const cp = await importCheckParity();
    const target = cp.applyUnifiedDiff(source, deletePatch);
    expect(() => cp.verifyRewrittenRow(b(source), b(target), validRow(cp, deletePatch, target))).not.toThrow();
  });

  it('a whole-blob substitution (target shares nothing with source) is REJECTED', async () => {
    const cp = await importCheckParity();
    const target = 'totally\ndifferent\nauthored\ncontent\nhere\n';
    const patch = '--- a\n+++ b\n@@ -1,5 +1,5 @@\n-line1\n-line2\n-line3\n-line4\n-line5\n+totally\n+different\n+authored\n+content\n+here\n';
    expect(() => cp.verifyRewrittenRow(b(source), b(target), validRow(cp, patch, target))).toThrow(/whole-blob/);
  });

  it('an incomplete/mismatched replay (patch does not reproduce target) is REJECTED', async () => {
    const cp = await importCheckParity();
    const realTarget = 'line1\nline2\nline4\nline5\n'; // line3 deleted
    const wrongPatch = '--- a\n+++ b\n@@ -1,5 +1,4 @@\n line1\n-line2\n line3\n line4\n line5\n';
    expect(() => cp.verifyRewrittenRow(b(source), b(realTarget), validRow(cp, wrongPatch, realTarget))).toThrow(/does NOT reproduce/);
  });

  it('a rewritten row with no replay_patch descriptor is REJECTED', async () => {
    const cp = await importCheckParity();
    const target = 'line1\nline2\nline4\nline5\n';
    const row = { path: 'x', replay_command: 'cmd', target_content_sha256: cp.sha256(b(target)) };
    expect(() => cp.verifyRewrittenRow(b(source), b(target), row)).toThrow(/lacks replay_patch/);
  });

  it('a rewritten row MISSING target_blob_oid is REJECTED (F6)', async () => {
    const cp = await importCheckParity();
    const target = cp.applyUnifiedDiff(source, deletePatch);
    const row = { path: 'x', replay_patch: deletePatch, replay_command: 'cmd', target_content_sha256: cp.sha256(b(target)) };
    expect(() => cp.verifyRewrittenRow(b(source), b(target), row)).toThrow(/lacks a full target_blob_oid/);
  });

  it('a rewritten row with a WRONG target_blob_oid is REJECTED (F6)', async () => {
    const cp = await importCheckParity();
    const target = cp.applyUnifiedDiff(source, deletePatch);
    const row = { ...validRow(cp, deletePatch, target), target_blob_oid: '0'.repeat(40) };
    expect(() => cp.verifyRewrittenRow(b(source), b(target), row)).toThrow(/target_blob_oid mismatch/);
  });

  it('a duplicated row that is a byte-copy of the source is REJECTED (no silent double-claim)', async () => {
    const cp = await importCheckParity();
    const row = { path: 'x', duplication_rationale: 'r', target_content_sha256: cp.sha256(b(source)), target_blob_oid: cp.gitBlobOid(b(source)) };
    expect(() => cp.verifyDuplicatedRow(b(source), b(source), row)).toThrow(/byte-copy/);
  });
});
