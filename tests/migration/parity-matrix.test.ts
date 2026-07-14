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

  it('check-parity verifies ported bytes, rewritten hashes, and exclusions', () => {
    expect(run('check-parity.mjs')).toMatch(/check-parity OK: 217 source-evidence rows; ported=144 rewritten=8 excluded=65/);
  }, 30000);

  it('the disposition counts partition the full 217-path inventory', () => {
    const pm = JSON.parse(readFileSync(join(ROOT, 'provenance/parity-matrix.v1.json'), 'utf8')) as {
      counts: { ported: number; rewritten: number; excluded: number; total: number };
    };
    expect(pm.counts.ported + pm.counts.rewritten + pm.counts.excluded).toBe(217);
    expect(pm.counts).toMatchObject({ ported: 144, rewritten: 8, excluded: 65, total: 217 });
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
