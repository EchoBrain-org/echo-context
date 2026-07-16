import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const BASELINE = '0cf7b006eba665c0bf55e82ff04da70f19f01ebb';
const TREE = '70c5cf8352652b3c4c1dce68cd1a5e40d44e4b05';
const gitText = (args: string[]) => execFileSync('git', ['-C', ROOT, ...args], {
  encoding: 'utf8',
  maxBuffer: 128 * 1024 * 1024,
  env: { ...process.env, GIT_NO_REPLACE_OBJECTS: '1', GIT_OPTIONAL_LOCKS: '0' },
});
const gitBytes = (args: string[]) => execFileSync('git', ['-C', ROOT, ...args], {
  maxBuffer: 128 * 1024 * 1024,
  env: { ...process.env, GIT_NO_REPLACE_OBJECTS: '1', GIT_OPTIONAL_LOCKS: '0' },
});

describe('AC2 — frozen extraction object closure', () => {
  it('keeps the accepted commit/tree and makes it an ancestor of successor HEAD', () => {
    expect(gitText(['rev-parse', `${BASELINE}^{tree}`]).trim()).toBe(TREE);
    expect(spawnSync('git', ['-C', ROOT, 'merge-base', '--is-ancestor', BASELINE, 'HEAD']).status).toBe(0);
    expect(() => gitText(['fsck', '--full'])).not.toThrow();
  });

  it('binds the exact 190 baseline paths to their Git modes, blobs, sizes, and bytes', () => {
    const record = JSON.parse(readFileSync(join(ROOT, 'provenance/extraction-baseline.v1.json'), 'utf8')) as {
      baseline_commit: string;
      baseline_tree: string;
      path_count: number;
      inventory_sha256: string;
      paths: Array<{ path: string; mode: string; blob_oid: string; size: number; content_sha256: string }>;
    };
    expect(record).toMatchObject({ baseline_commit: BASELINE, baseline_tree: TREE, path_count: 190 });
    const rows = gitBytes(['ls-tree', '-r', '-z', '--long', BASELINE]).toString('utf8').split('\0').filter(Boolean).map((line) => {
      const match = /^(100644|100755) blob ([0-9a-f]{40})\s+(\d+)\t(.+)$/.exec(line);
      if (!match) throw new Error(`unsupported baseline row: ${line}`);
      const [, mode, blob_oid, sizeText, path] = match;
      const bytes = gitBytes(['cat-file', 'blob', blob_oid]);
      return {
        path,
        mode,
        blob_oid,
        size: Number(sizeText),
        content_sha256: createHash('sha256').update(bytes).digest('hex'),
      };
    }).sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)));
    expect(rows).toEqual(record.paths);
    const serialized = rows.map((row) => `${row.path}\0${row.mode}\0${row.blob_oid}\0${row.size}\0${row.content_sha256}\n`).join('');
    expect(createHash('sha256').update(serialized).digest('hex')).toBe(record.inventory_sha256);
  });

  it('preserves the historic target-only plus source-extraction partition at the baseline object', () => {
    const tracked = new Set(gitText(['ls-tree', '-r', '--name-only', BASELINE]).trim().split('\n'));
    const readBaselineJson = (path: string) => JSON.parse(gitText(['show', `${BASELINE}:${path}`]));
    const policy = readBaselineJson('provenance/target-only-policy.v1.json') as { target_only_paths: string[] };
    const extraction = readBaselineJson('provenance/source-extraction.v1.json') as { rows: { path: string }[] };
    const allowed = new Set([...policy.target_only_paths, ...extraction.rows.map((row) => row.path)]);
    expect([...tracked].filter((path) => !allowed.has(path))).toEqual([]);
    expect([...allowed].filter((path) => !tracked.has(path))).toEqual([]);
    expect(tracked.size).toBe(190);
  });
});
