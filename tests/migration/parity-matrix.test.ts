import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { Ajv } from 'ajv';
import { describe, expect, it } from 'vitest';

// AC6 — the exact 217/110/107 raw-object inventory and disposition allowlists.
// Runs the operator audit + parity verifier against the pinned source, and
// validates every provenance document against its committed schema.
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const NODE = '/usr/local/bin/node';
const SRC_GIT = process.env.ECHO_SOURCE_GIT_DIR ?? '/Users/zhenye/Desktop/Project_echo/.git';
const SRC_SHA = process.env.ECHO_SOURCE_SHA ?? '2971310441b69735cbe759293abd8c4d044bf347';
const TOOL_NAMES = ['check-parity.mjs', 'audit-pinned-extraction.mjs'] as const;

function run(tool: string): string {
  return execFileSync(
    NODE,
    [join(ROOT, 'tools', tool), '--source-git-dir', SRC_GIT, '--source-sha', SRC_SHA, '--target', ROOT],
    { encoding: 'utf8' },
  );
}

function runWithDocuments(
  tool: (typeof TOOL_NAMES)[number],
  evidencePath: string,
  parityPath: string,
  targetPolicyPath?: string,
) {
  return spawnSync(
    NODE,
    [
      join(ROOT, 'tools', tool),
      '--source-git-dir',
      SRC_GIT,
      '--source-sha',
      SRC_SHA,
      '--target',
      ROOT,
      '--evidence',
      evidencePath,
      '--parity',
      parityPath,
      ...(targetPolicyPath === undefined ? [] : ['--target-only-policy', targetPolicyPath]),
    ],
    { encoding: 'utf8' },
  );
}

function policySha(rows: { path: string; disposition: string }[]): string {
  const sorted = [...rows].sort((a, b) =>
    Buffer.compare(Buffer.from(a.path, 'utf8'), Buffer.from(b.path, 'utf8')),
  );
  return createHash('sha256')
    .update(sorted.map((row) => `${row.path}\0${row.disposition}\n`).join(''))
    .digest('hex');
}

describe('AC6 — parity matrix + source inventory', () => {
  it('audit-pinned-extraction recomputes the 217/110/107 closure', () => {
    expect(run('audit-pinned-extraction.mjs')).toMatch(/audit-pinned-extraction OK: 217 paths \(110 src, 107 test\)/);
  }, 30_000);

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

  it('repeated common lines and blank-line padding cannot game anti-whole-blob retention', async () => {
    const cp = await importCheckParity();
    const adversarialSource = [
      'shared();',
      'sourceOne();',
      'sourceTwo();',
      'sourceThree();',
      'sourceFour();',
      'sourceFive();',
      '',
    ].join('\n');
    const targetLines = Array.from({ length: 30 }, () => 'shared();\n\n').join('');
    const adversarialTarget = `${targetLines}authoredReplacement();\n`;
    const patch = [
      '--- a',
      '+++ b',
      '@@ -1,6 +1,31 @@',
      '-shared();',
      '-sourceOne();',
      '-sourceTwo();',
      '-sourceThree();',
      '-sourceFour();',
      '-sourceFive();',
      ...Array.from({ length: 30 }, () => '+shared();'),
      '+authoredReplacement();',
      '',
    ].join('\n');
    expect(cp.sharedLineFraction(adversarialSource, adversarialTarget)).toBeLessThan(0.3);
    expect(() =>
      cp.verifyRewrittenRow(
        b(adversarialSource),
        b(adversarialTarget),
        validRow(cp, patch, adversarialTarget),
      ),
    ).toThrow(/whole-blob/);
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

  it('cross-swapped source OIDs/hashes are rejected by check-parity and the operator audit', () => {
    const dir = mkdtempSync(join(tmpdir(), 'echo-context-cross-swap-'));
    try {
      const parity = JSON.parse(
        readFileSync(join(ROOT, 'provenance', 'parity-matrix.v1.json'), 'utf8'),
      ) as {
        rows: { path: string; source_blob_oid: string; source_content_sha256: string }[];
      };
      const first = parity.rows[0]!;
      const second = parity.rows.find(
        (row) =>
          row.source_blob_oid !== first.source_blob_oid &&
          row.source_content_sha256 !== first.source_content_sha256,
      )!;
      [first.source_blob_oid, second.source_blob_oid] = [
        second.source_blob_oid,
        first.source_blob_oid,
      ];
      [first.source_content_sha256, second.source_content_sha256] = [
        second.source_content_sha256,
        first.source_content_sha256,
      ];
      const mutated = join(dir, 'cross-swapped-parity.json');
      writeFileSync(mutated, `${JSON.stringify(parity, null, 2)}\n`);
      for (const tool of TOOL_NAMES) {
        const result = spawnSync(
          NODE,
          [
            join(ROOT, 'tools', tool),
            '--source-git-dir',
            SRC_GIT,
            '--source-sha',
            SRC_SHA,
            '--target',
            ROOT,
            '--parity',
            mutated,
          ],
          { encoding: 'utf8' },
        );
        expect(result.status, `${tool} unexpectedly accepted cross-swapped source evidence`).not.toBe(0);
        expect(result.stderr).toMatch(/parity\/source-evidence (blob OID|content hash) mismatch/);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('both real CLIs reject mutations of every sealed policy and evidence dimension', () => {
    const dir = mkdtempSync(join(tmpdir(), 'echo-context-ac6-seals-'));
    try {
      const originalEvidence = JSON.parse(
        readFileSync(join(ROOT, 'provenance/source-evidence.v1.json'), 'utf8'),
      ) as {
        inventory_sha256: string;
        path_count: number;
        entries: { path: string; mode: string }[];
      };
      const originalParity = JSON.parse(
        readFileSync(join(ROOT, 'provenance/parity-matrix.v1.json'), 'utf8'),
      ) as {
        ready_content_sha: string;
        disposition_policy_sha256: string;
        counts: Record<'ported' | 'rewritten' | 'duplicated' | 'excluded' | 'total', number>;
        rows: {
          path: string;
          disposition: 'ported' | 'rewritten' | 'duplicated' | 'excluded';
          target_path?: string;
          excluded_reason?: string;
          replay_command?: string;
        }[];
      };
      const originalTargetPolicy = JSON.parse(
        readFileSync(join(ROOT, 'provenance/target-only-policy.v1.json'), 'utf8'),
      ) as { ready_content_sha: string };

      const mutations: {
        name: string;
        expected: RegExp;
        mutate: (
          evidence: typeof originalEvidence,
          parity: typeof originalParity,
          targetPolicy: typeof originalTargetPolicy,
        ) => void;
      }[] = [
        {
          name: 'source mode',
          expected: /mode mismatch|non-regular mode/,
          mutate: (evidence) => { evidence.entries[0]!.mode = '100755'; },
        },
        {
          name: 'inventory sha',
          expected: /inventory_sha256/,
          mutate: (evidence) => { evidence.inventory_sha256 = '0'.repeat(64); },
        },
        {
          name: 'path count',
          expected: /path_count/,
          mutate: (evidence) => { evidence.path_count -= 1; },
        },
        {
          name: 'target path',
          expected: /target_path mismatch/,
          mutate: (_evidence, parity) => { parity.rows[0]!.target_path = 'src/capture/not-the-row.ts'; },
        },
        {
          name: 'computed counts',
          expected: /counts\.ported mismatch/,
          mutate: (_evidence, parity) => { parity.counts.ported -= 1; parity.counts.excluded += 1; },
        },
        {
          name: 'cannot-exclude disposition despite internally updated hash and counts',
          expected: /ready-reviewed cannot-exclude map/,
          mutate: (_evidence, parity) => {
            const protectedRow = parity.rows.find((row) => row.path === 'src/capture/gate.ts')!;
            protectedRow.disposition = 'excluded';
            delete protectedRow.target_path;
            protectedRow.excluded_reason = 'adversarial reclassification';
            parity.counts.ported -= 1;
            parity.counts.excluded += 1;
            parity.disposition_policy_sha256 = policySha(parity.rows);
          },
        },
        {
          name: 'parity ready seal',
          expected: /parity ready_content_sha/,
          mutate: (_evidence, parity) => { parity.ready_content_sha = '0'.repeat(64); },
        },
        {
          name: 'target-policy ready seal',
          expected: /target-only policy ready_content_sha/,
          mutate: (_evidence, _parity, targetPolicy) => { targetPolicy.ready_content_sha = '0'.repeat(64); },
        },
        {
          name: 'replay command semantics',
          expected: /replay_command mismatch/,
          mutate: (_evidence, parity) => {
            parity.rows.find((row) => row.disposition === 'rewritten')!.replay_command = 'node tools/check-parity.mjs';
          },
        },
      ];

      for (const mutation of mutations) {
        const evidence = structuredClone(originalEvidence);
        const parity = structuredClone(originalParity);
        const targetPolicy = structuredClone(originalTargetPolicy);
        mutation.mutate(evidence, parity, targetPolicy);
        const evidencePath = join(dir, `${mutation.name.replaceAll(/[^a-z]+/gi, '-')}-evidence.json`);
        const parityPath = join(dir, `${mutation.name.replaceAll(/[^a-z]+/gi, '-')}-parity.json`);
        const targetPolicyPath = join(dir, `${mutation.name.replaceAll(/[^a-z]+/gi, '-')}-target-policy.json`);
        writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
        writeFileSync(parityPath, `${JSON.stringify(parity, null, 2)}\n`);
        writeFileSync(targetPolicyPath, `${JSON.stringify(targetPolicy, null, 2)}\n`);

        for (const tool of TOOL_NAMES) {
          const result = runWithDocuments(tool, evidencePath, parityPath, targetPolicyPath);
          expect(result.status, `${tool} accepted ${mutation.name}`).not.toBe(0);
          expect(result.stderr, `${tool} wrong rejection for ${mutation.name}`).toMatch(mutation.expected);
        }
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
