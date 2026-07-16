import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Ajv } from 'ajv';
import { describe, expect, it } from 'vitest';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const BASELINE = '0cf7b006eba665c0bf55e82ff04da70f19f01ebb';
const TREE = '70c5cf8352652b3c4c1dce68cd1a5e40d44e4b05';
const V1_SHA = '29512b101dc672aec83102f147b60c04dd694b1602479024299b228becf95caf';

describe('AC2 — repository authority', () => {
  it('validates the frozen baseline, successor ancestry, and false authority boundary', () => {
    const result = spawnSync(process.execPath, [
      join(ROOT, 'tools/check-repository-authority.mjs'), '--git-dir', join(ROOT, '.git'), '--commit', 'HEAD',
    ], { cwd: ROOT, encoding: 'utf8' });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toMatch(/repository-authority OK/);
    const authority = JSON.parse(readFileSync(join(ROOT, 'provenance/repository-authority.v1.json'), 'utf8'));
    expect(authority).toMatchObject({
      canonical_repository: 'https://github.com/zhenye0616/echo-context',
      default_branch: 'main',
      source_authority: 'echo-context/main',
      artifact_authority: 'versioned-source-artifact',
      extraction_baseline: { commit: BASELINE, tree: TREE },
      runtime_authority: false,
      state_authority: false,
      installed: false,
      maturity: 'DEV',
    });
  });

  it('keeps item-135 runtime-inventory.v1 byte-identical and validates successor v2', () => {
    expect(createHash('sha256').update(readFileSync(join(ROOT, 'provenance/runtime-inventory.v1.json'))).digest('hex')).toBe(V1_SHA);
    const verify = spawnSync(process.execPath, [
      join(ROOT, 'tools/check-runtime-inventory.mjs'), '--git-dir', join(ROOT, '.git'), '--commit', 'HEAD', '--manifest', join(ROOT, 'provenance/runtime-inventory.v2.json'),
    ], { cwd: ROOT, encoding: 'utf8' });
    expect(verify.status, verify.stderr).toBe(0);
    const packageJson = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
    expect(packageJson.scripts['verify:inventory']).toContain('runtime-inventory.v2.json');
    expect(readFileSync(join(ROOT, 'tools/check-runtime-inventory.mjs'), 'utf8')).toContain("schema: 'runtime-inventory.v2'");
  });

  it('rejects wrong canonical repository and baseline fixtures', () => {
    const schema = JSON.parse(readFileSync(join(ROOT, 'schemas/repository-authority.v1.schema.json'), 'utf8'));
    const baseline = JSON.parse(readFileSync(join(ROOT, 'provenance/repository-authority.v1.json'), 'utf8'));
    const validate = new Ajv({ strict: false }).compile(schema);
    expect(validate({ ...baseline, canonical_repository: 'https://github.com/foreign/echo-context' })).toBe(false);
    expect(validate({ ...baseline, extraction_baseline: { ...baseline.extraction_baseline, commit: '0'.repeat(40) } })).toBe(false);
    expect(execFileSync('git', ['-C', ROOT, 'rev-parse', `${BASELINE}^{tree}`], { encoding: 'utf8' }).trim()).toBe(TREE);
  });
});
