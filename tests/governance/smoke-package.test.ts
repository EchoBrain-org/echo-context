import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('package smoke failure reporting', () => {
  it('preserves the original pre-install error instead of masking it in teardown', () => {
    const scratch = mkdtempSync(join(tmpdir(), 'echo-context-smoke-failure-'));
    const artifact = join(scratch, 'invalid.tgz');
    writeFileSync(artifact, 'not a tarball');

    try {
      const result = spawnSync(
        process.execPath,
        [resolve('tools/smoke-package.mjs'), artifact],
        { encoding: 'utf8' },
      );

      expect(result.status).not.toBe(0);
      expect(result.stderr).not.toContain('ReferenceError: stderr is not defined');
      expect(result.stderr).toContain('Error:');
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });
});
