import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
// @ts-expect-error committed Node scanner is intentionally plain .mjs; this test asserts its fixture surface.
import { platformKey, scanWith, validateContract } from '../../tools/secret-scan.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const contract = JSON.parse(readFileSync(join(ROOT, 'tools/secret-scan-contract.json'), 'utf8'));

describe('AC1/AC4 — secret scan contract', () => {
  it('pins every supported platform and the exact full-history redacted argv', () => {
    expect(() => validateContract(contract)).not.toThrow();
    expect(Object.keys(contract.binary_sha256).sort()).toEqual(['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64']);
    expect(contract.invocation.argv).toEqual(['detect', '--source', '.', '--log-opts=--all', '--redact=100', '--no-banner', '--no-color', '--report-format', 'json', '--report-path', '<temporary-report>']);
  });

  it('fails closed for unsupported and digest-mismatched binaries', () => {
    const directory = mkdtempSync(join(tmpdir(), 'echo-context-scan-'));
    try {
      const binary = join(directory, 'gitleaks');
      writeFileSync(binary, 'fixture');
      expect(() => scanWith({ binary, contract, reportPath: join(directory, 'report.json') })).toThrow(/digest mismatch/);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('preserves scanner failure and returns only File/RuleID from a leak report', () => {
    const directory = mkdtempSync(join(tmpdir(), 'echo-context-scan-fixture-'));
    try {
      const binary = join(directory, 'gitleaks');
      const bytes = Buffer.from('fixture-binary');
      writeFileSync(binary, bytes);
      const fixtureContract = structuredClone(contract);
      fixtureContract.binary_sha256[platformKey()] = createHash('sha256').update(bytes).digest('hex');
      let calls = 0;
      const spawn = (_binary: string, argv: string[]) => {
        calls += 1;
        if (argv[0] === 'version') return { status: 0, stdout: '8.30.1\n', stderr: '' };
        const reportPath = argv.at(-1)!;
        writeFileSync(reportPath, JSON.stringify([{ File: 'safe/path.ts', RuleID: 'fixture-rule', Secret: 'FAKE_SECRET_MUST_NOT_PRINT' }]));
        return { status: 1, stdout: 'FAKE_SECRET_MUST_NOT_PRINT', stderr: 'FAKE_SECRET_MUST_NOT_PRINT' };
      };
      const result = scanWith({ binary, contract: fixtureContract, reportPath: join(directory, 'report.json'), spawn });
      expect(calls).toBe(2);
      expect(result.findings).toEqual([{ File: 'safe/path.ts', RuleID: 'fixture-rule' }]);
      expect(JSON.stringify(result)).not.toContain('FAKE_SECRET_MUST_NOT_PRINT');

      expect(() => scanWith({
        binary,
        contract: fixtureContract,
        reportPath: join(directory, 'missing.json'),
        spawn: (_file: string, argv: string[]) => argv[0] === 'version'
          ? { status: 0, stdout: '8.30.1\n', stderr: '' }
          : { status: 2, stdout: '', stderr: 'infrastructure failed' },
      })).toThrow(/infrastructure failed/);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
