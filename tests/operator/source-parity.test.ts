import { execFile, execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const EXPECTED_SOURCE_SHA = '2971310441b69735cbe759293abd8c4d044bf347';
const ACCEPTED_TARGET_SHA = '0cf7b006eba665c0bf55e82ff04da70f19f01ebb';
const ACCEPTED_TARGET_TREE = '70c5cf8352652b3c4c1dce68cd1a5e40d44e4b05';
const ACCEPTED_TARGET_PATHS = 190;
const GIT_ENV = {
  ...process.env,
  GIT_NO_REPLACE_OBJECTS: '1',
  GIT_OPTIONAL_LOCKS: '0',
};
const execFileP = promisify(execFile);

function sourceInputs(): { gitDir: string; sha: string } {
  const gitDir = process.env.ECHO_SOURCE_GIT_DIR;
  const sha = process.env.ECHO_SOURCE_SHA;
  if (!gitDir || !sha)
    throw new Error(
      'operator replay requires explicit ECHO_SOURCE_GIT_DIR and ECHO_SOURCE_SHA',
    );
  if (sha !== EXPECTED_SOURCE_SHA)
    throw new Error(
      `operator replay source SHA must equal ${EXPECTED_SOURCE_SHA}`,
    );
  return { gitDir, sha };
}

async function run(tool: string, args: string[]): Promise<string> {
  const { stdout } = await execFileP(
    process.execPath,
    [join(ROOT, 'tools', tool), ...args],
    {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    },
  );
  return stdout;
}

function targetGit(args: string[], input?: Buffer): Buffer {
  return execFileSync('git', ['--git-dir', join(ROOT, '.git'), ...args], {
    env: GIT_ENV,
    input,
    maxBuffer: 128 * 1024 * 1024,
  });
}

function targetGitText(args: string[]): string {
  return targetGit(args).toString('utf8').trim();
}

function materializeAcceptedTarget(): string {
  const resolved = targetGitText([
    'rev-parse',
    '--verify',
    `${ACCEPTED_TARGET_SHA}^{commit}`,
  ]);
  if (resolved !== ACCEPTED_TARGET_SHA) {
    throw new Error(`accepted target resolves to ${resolved}`);
  }
  const tree = targetGitText(['rev-parse', `${ACCEPTED_TARGET_SHA}^{tree}`]);
  if (tree !== ACCEPTED_TARGET_TREE) {
    throw new Error(`accepted target tree ${tree} != ${ACCEPTED_TARGET_TREE}`);
  }

  const target = mkdtempSync(join(tmpdir(), 'echo-context-accepted-target-'));
  try {
    const listing = targetGit(['ls-tree', '-r', '-z', ACCEPTED_TARGET_SHA]);
    const records = listing
      .subarray(0, listing.length - 1)
      .toString('utf8')
      .split('\0');
    if (listing.at(-1) !== 0 || records.length !== ACCEPTED_TARGET_PATHS) {
      throw new Error(
        `accepted target tree has ${records.length} malformed or unexpected paths`,
      );
    }
    const rows = records.map((row) => {
      const match = /^(100644|100755) blob ([0-9a-f]{40})\t(.+)$/u.exec(row);
      if (!match) throw new Error(`unsupported accepted target row: ${row}`);
      const [, mode, oid, path] = match;
      const destination = resolve(target, path);
      if (!destination.startsWith(`${target}${sep}`)) {
        throw new Error(
          `accepted target path escapes materialization root: ${path}`,
        );
      }
      return { mode, oid, destination };
    });
    const batch = targetGit(
      ['cat-file', '--batch'],
      Buffer.from(rows.map(({ oid }) => `${oid}\n`).join(''), 'ascii'),
    );
    let cursor = 0;
    for (const { mode, oid, destination } of rows) {
      const headerEnd = batch.indexOf(0x0a, cursor);
      const header = batch.subarray(cursor, headerEnd).toString('ascii');
      const match = /^([0-9a-f]{40}) blob (\d+)$/u.exec(header);
      if (!match || match[1] !== oid)
        throw new Error(`unexpected accepted target blob: ${header}`);
      const contentStart = headerEnd + 1;
      const contentEnd = contentStart + Number(match[2]);
      if (batch[contentEnd] !== 0x0a)
        throw new Error(`malformed accepted target blob: ${oid}`);
      mkdirSync(dirname(destination), { recursive: true });
      writeFileSync(destination, batch.subarray(contentStart, contentEnd), {
        mode: mode === '100755' ? 0o755 : 0o644,
      });
      cursor = contentEnd + 1;
    }
    if (cursor !== batch.length)
      throw new Error('accepted target blob batch has trailing bytes');
    return realpathSync(target);
  } catch (error) {
    rmSync(target, { recursive: true, force: true });
    throw error;
  }
}

describe('operator — pinned Project_echo source replay', () => {
  it('recomputes the source inventory and replays target parity at the accepted baseline object', async () => {
    const source = sourceInputs();
    const acceptedTarget = materializeAcceptedTarget();
    try {
      const args = [
        '--source-git-dir',
        source.gitDir,
        '--source-sha',
        source.sha,
        '--target',
        acceptedTarget,
      ];
      const [audit, parity] = await Promise.all([
        run('audit-pinned-extraction.mjs', args),
        run('check-parity.mjs', args),
      ]);
      expect(audit).toMatch(/217 paths \(110 src, 107 test\)/);
      expect(parity).toMatch(/ported=144 rewritten=7 duplicated=1 excluded=65/);
    } finally {
      rmSync(acceptedTarget, { recursive: true, force: true });
    }
  }, 60_000);

  it('recomputes the accepted eight-tool parity aggregate at the baseline object', async () => {
    const source = sourceInputs();
    const acceptedTarget = materializeAcceptedTarget();
    try {
      symlinkSync(
        join(ROOT, 'node_modules'),
        join(acceptedTarget, 'node_modules'),
        'dir',
      );
      const output = await run('verify-context-tools.mjs', [
        '--source-git-dir',
        source.gitDir,
        '--source-sha',
        source.sha,
        '--target-root',
        acceptedTarget,
        '--fixture',
        join(acceptedTarget, 'tests/fixtures/context-tool-parity.v1.json'),
        '--evidence',
        join(acceptedTarget, 'provenance/context-tool-parity.v1.json'),
        '--npm-cache',
        process.env.ECHO_NPM_CACHE ?? join(homedir(), '.npm'),
      ]);
      expect(output).toMatch(
        /source=15 tools \(7 ignored\), target=8, cases=10/,
      );
      expect(output).toMatch(
        /6569b0472372ad666404aa22bcf5b1e0e0c716b573dec35c4b9212864420bba2/,
      );
    } finally {
      rmSync(acceptedTarget, { recursive: true, force: true });
    }
  }, 180_000);
});
