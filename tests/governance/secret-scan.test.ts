import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
// @ts-expect-error committed Node scanner is intentionally plain .mjs; this test asserts its fixture surface.
import { platformKey, scanWith, validateContract } from '../../tools/secret-scan.mjs';
// @ts-expect-error committed prefetch helper is intentionally plain .mjs.
import { MANIFEST_NAME, parseAdvertisedRefs, renderManifest } from '../../tools/prefetch-secret-scan-refs.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const contract = JSON.parse(readFileSync(join(ROOT, 'tools/secret-scan-contract.json'), 'utf8'));

function git(root: string, argv: string[]) {
  return execFileSync('git', ['-C', root, ...argv], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function writeAdvertisedManifest(root: string, rows: Array<{ oid: string; ref: string }>) {
  const sorted = [...rows].sort((left, right) => left.ref.localeCompare(right.ref));
  writeFileSync(join(root, '.git', MANIFEST_NAME), renderManifest(sorted));
}

function executableFixture() {
  const root = mkdtempSync(join(tmpdir(), 'echo-context-secret-exec-'));
  const tools = join(root, 'tools');
  mkdirSync(tools);
  for (const name of ['secret-scan.sh', 'secret-scan.mjs', 'secret-scan-contract.json', 'prefetch-secret-scan-refs.mjs']) copyFileSync(join(ROOT, 'tools', name), join(tools, name));
  chmodSync(join(tools, 'secret-scan.sh'), 0o755);
  git(root, ['init', '-q']);
  git(root, ['config', 'user.name', 'Fixture']);
  git(root, ['config', 'user.email', 'fixture@example.invalid']);
  writeFileSync(join(root, 'tracked.txt'), 'safe\n');
  git(root, ['add', 'tracked.txt']);
  git(root, ['commit', '-q', '-m', 'fixture']);
  git(root, ['remote', 'add', 'origin', 'https://example.invalid/private.git']);
  git(root, ['update-ref', 'refs/echo-scan/heads/main', 'HEAD']);
  writeAdvertisedManifest(root, [{ oid: git(root, ['rev-parse', 'HEAD']), ref: 'refs/heads/main' }]);

  const binary = join(root, 'fixture-gitleaks');
  writeFileSync(binary, `#!/bin/sh
if [ "\${1-}" = version ]; then
  printf '%s\\n' 8.30.1
  exit 0
fi
report=
while [ "$#" -gt 0 ]; do
  if [ "$1" = --report-path ]; then
    shift
    report=$1
  fi
  shift
done
case "\${FIXTURE_SCAN_MODE-clean}" in
  leak)
    printf '%s\\n' '[{"File":"tracked.txt","RuleID":"fixture-rule","Secret":"FAKE_SECRET_MUST_NOT_PRINT"}]' > "$report"
    printf '%s\\n' FAKE_SECRET_MUST_NOT_PRINT
    printf '%s\\n' FAKE_SECRET_MUST_NOT_PRINT >&2
    exit 1
    ;;
  infrastructure)
    printf '%s\\n' FAKE_SECRET_MUST_NOT_PRINT >&2
    exit 2
    ;;
  *) exit 0 ;;
esac
`);
  chmodSync(binary, 0o755);
  const fixtureContract = JSON.parse(readFileSync(join(tools, 'secret-scan-contract.json'), 'utf8'));
  fixtureContract.binary_sha256[platformKey()] = createHash('sha256').update(readFileSync(binary)).digest('hex');
  writeFileSync(join(tools, 'secret-scan-contract.json'), `${JSON.stringify(fixtureContract, null, 2)}\n`);
  const run = (mode: string, extraEnv: Record<string, string> = {}) => spawnSync(join(tools, 'secret-scan.sh'), [], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, GITLEAKS_BIN: binary, FIXTURE_SCAN_MODE: mode, ...extraEnv },
  });
  return { root, tools, binary, run };
}

describe('AC1/AC4 — secret scan contract', () => {
  it('pins every supported platform and the exact full-history redacted argv', () => {
    expect(() => validateContract(contract)).not.toThrow();
    expect(Object.keys(contract.binary_sha256).sort()).toEqual(['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64']);
    expect(contract.invocation.argv).toEqual(['detect', '--source', '.', '--log-opts=--all', '--redact=100', '--no-banner', '--no-color', '--report-format', 'json', '--report-path', '<temporary-report>']);
  });

  it('installs the scanner for the Node runtime architecture, including translated shells', () => {
    const installer = readFileSync(join(ROOT, 'tools', 'install-gitleaks.sh'), 'utf8');
    expect(installer).toContain("os=$(node -p 'process.platform')");
    expect(installer).toContain("machine=$(node -p 'process.arch')");
    expect(installer).not.toContain('uname -m');
  });

  it('parses a strict sorted unique advertised-ref manifest without peeled pseudo-refs', () => {
    const main = '1'.repeat(40);
    const tag = '2'.repeat(40);
    const rows = parseAdvertisedRefs(`${tag}\trefs/tags/v1\n${main}\trefs/heads/main\n`);
    expect(renderManifest(rows)).toBe(`${MANIFEST_NAME}\n${main}\trefs/heads/main\n${tag}\trefs/tags/v1\n`);
    expect(() => parseAdvertisedRefs(`${main}\trefs/heads/main\n${tag}\trefs/heads/main\n`)).toThrow(/duplicate/);
    expect(() => parseAdvertisedRefs(`${main}\trefs/tags/v1^{}\n`)).toThrow(/malformed/);
  });

  it('fails closed for unsupported and digest-mismatched binaries', () => {
    const directory = mkdtempSync(join(tmpdir(), 'echo-context-scan-'));
    try {
      const binary = join(directory, 'gitleaks');
      writeFileSync(binary, 'fixture');
      expect(() => scanWith({ binary, contract, reportPath: join(directory, 'report.json') })).toThrow(/digest mismatch/);
      expect(() => platformKey('win32', 'x64')).toThrow(/unsupported/);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('preserves real top-level leak and infrastructure failures without printing secret values', () => {
    const fixture = executableFixture();
    try {
      const leak = fixture.run('leak');
      expect(leak.status).not.toBe(0);
      expect(`${leak.stdout}${leak.stderr}`).toContain('File=tracked.txt\tRuleID=fixture-rule');
      expect(`${leak.stdout}${leak.stderr}`).not.toContain('FAKE_SECRET_MUST_NOT_PRINT');

      const infrastructure = fixture.run('infrastructure');
      expect(infrastructure.status).not.toBe(0);
      expect(`${infrastructure.stdout}${infrastructure.stderr}`).toContain('scanner infrastructure failed');
      expect(`${infrastructure.stdout}${infrastructure.stderr}`).not.toContain('FAKE_SECRET_MUST_NOT_PRINT');
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it('fails the top-level result path for shallow, incomplete-ref, and digest-mismatched inputs', () => {
    const fixture = executableFixture();
    try {
      const head = git(fixture.root, ['rev-parse', 'HEAD']);
      writeFileSync(join(fixture.root, '.git', 'shallow'), `${head}\n`);
      const shallow = fixture.run('clean');
      expect(shallow.status).not.toBe(0);
      expect(shallow.stderr).toContain('shallow checkout');
      rmSync(join(fixture.root, '.git', 'shallow'));

      git(fixture.root, ['update-ref', '-d', 'refs/echo-scan/heads/main']);
      const incomplete = fixture.run('clean');
      expect(incomplete.status).not.toBe(0);
      expect(incomplete.stderr).toContain('names/OIDs differ');
      git(fixture.root, ['update-ref', 'refs/echo-scan/heads/main', 'HEAD']);

      writeFileSync(fixture.binary, `${readFileSync(fixture.binary, 'utf8')}# digest drift\n`);
      const mismatch = fixture.run('clean');
      expect(mismatch.status).not.toBe(0);
      expect(mismatch.stderr).toContain('digest mismatch');
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it.each([
    ['branch', 'refs/heads/secret-branch', 'refs/echo-scan/heads/secret-branch'],
    ['tag', 'refs/tags/secret-tag', 'refs/echo-scan/tags/secret-tag'],
  ])('rejects an advertised secret-bearing %s omitted from the local snapshot', (_kind, advertisedRef, snapshotRef) => {
    const fixture = executableFixture();
    try {
      const head = git(fixture.root, ['rev-parse', 'HEAD']);
      writeFileSync(join(fixture.root, 'secret-only.txt'), 'FAKE_OMITTED_REF_SECRET\n');
      git(fixture.root, ['add', 'secret-only.txt']);
      git(fixture.root, ['commit', '-q', '-m', 'secret-only history']);
      const secretCommit = git(fixture.root, ['rev-parse', 'HEAD']);
      git(fixture.root, ['reset', '--hard', '-q', head]);
      writeAdvertisedManifest(fixture.root, [
        { oid: head, ref: 'refs/heads/main' },
        { oid: secretCommit, ref: advertisedRef },
      ]);
      const omitted = fixture.run('clean');
      expect(omitted.status).not.toBe(0);
      expect(omitted.stderr).toContain('names/OIDs differ');

      git(fixture.root, ['update-ref', snapshotRef, secretCommit]);
      expect(fixture.run('clean').status).toBe(0);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it('rejects an extra or OID-mismatched local snapshot ref absent from the advertisement', () => {
    const fixture = executableFixture();
    try {
      git(fixture.root, ['update-ref', 'refs/echo-scan/tags/foreign', 'HEAD']);
      const extra = fixture.run('clean');
      expect(extra.status).not.toBe(0);
      expect(extra.stderr).toContain('names/OIDs differ');

      git(fixture.root, ['update-ref', '-d', 'refs/echo-scan/tags/foreign']);
      writeFileSync(join(fixture.root, 'second.txt'), 'second\n');
      git(fixture.root, ['add', 'second.txt']);
      git(fixture.root, ['commit', '-q', '-m', 'second']);
      git(fixture.root, ['update-ref', 'refs/echo-scan/heads/main', 'HEAD']);
      const mismatch = fixture.run('clean');
      expect(mismatch.status).not.toBe(0);
      expect(mismatch.stderr).toContain('names/OIDs differ');
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
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
