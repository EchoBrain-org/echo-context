import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const EXPECTED_SOURCE_SHA = '2971310441b69735cbe759293abd8c4d044bf347';

function sourceInputs(): { gitDir: string; sha: string } {
  const gitDir = process.env.ECHO_SOURCE_GIT_DIR;
  const sha = process.env.ECHO_SOURCE_SHA;
  if (!gitDir || !sha) throw new Error('operator replay requires explicit ECHO_SOURCE_GIT_DIR and ECHO_SOURCE_SHA');
  if (sha !== EXPECTED_SOURCE_SHA) throw new Error(`operator replay source SHA must equal ${EXPECTED_SOURCE_SHA}`);
  return { gitDir, sha };
}

function run(tool: string, args: string[]): string {
  return execFileSync(process.execPath, [join(ROOT, 'tools', tool), ...args], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
}

describe('operator — pinned Project_echo source replay', () => {
  it('recomputes the accepted source inventory and rewrite parity', () => {
    const source = sourceInputs();
    const args = ['--source-git-dir', source.gitDir, '--source-sha', source.sha, '--target', ROOT];
    expect(run('audit-pinned-extraction.mjs', args)).toMatch(/217 paths \(110 src, 107 test\)/);
    expect(run('check-parity.mjs', args)).toMatch(/ported=144 rewritten=7 duplicated=1 excluded=65/);
  }, 60_000);

  it('recomputes the accepted eight-tool parity aggregate', () => {
    const source = sourceInputs();
    const output = run('verify-context-tools.mjs', [
      '--source-git-dir', source.gitDir,
      '--source-sha', source.sha,
      '--target-root', ROOT,
      '--fixture', join(ROOT, 'tests/fixtures/context-tool-parity.v1.json'),
      '--evidence', join(ROOT, 'provenance/context-tool-parity.v1.json'),
      '--npm-cache', process.env.ECHO_NPM_CACHE ?? join(homedir(), '.npm'),
    ]);
    expect(output).toMatch(/source=15 tools \(7 ignored\), target=8, cases=10/);
    expect(output).toMatch(/6569b0472372ad666404aa22bcf5b1e0e0c716b573dec35c4b9212864420bba2/);
  }, 180_000);
});
