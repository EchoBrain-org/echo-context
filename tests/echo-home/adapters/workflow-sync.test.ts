import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { syncDefaultWorkflows } from '../../../src/echo-home/adapters/workflow-sync.js';

let tmpRoot: string;

const WORKFLOWS = ['change-review.toml', 'daily-review.toml', 'ship-check.toml'];

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'echo-075-workflows-'));
});

afterEach(() => {
  try {
    chmodSync(join(tmpRoot, 'locked'), 0o700);
  } catch {
    // best-effort cleanup support for chmod tests
  }
  rmSync(tmpRoot, { recursive: true, force: true });
});

function setupSource(names: readonly string[] = WORKFLOWS): string {
  const dir = join(tmpRoot, 'src-workflows');
  mkdirSync(dir);
  for (const name of names) writeFileSync(join(dir, name), `# ${name}\nbody\n`);
  return dir;
}

describe('syncDefaultWorkflows', () => {
  it('source missing -> source-missing and no file written', () => {
    const src = setupSource(['other.toml']);
    const tgt = join(tmpRoot, 'tgt');
    const result = syncDefaultWorkflows({
      sourceDir: src,
      targetDir: tgt,
      defaults: ['change-review.toml'],
    });

    expect(result.results).toEqual([{ workflow: 'change-review.toml', action: 'source-missing' }]);
    expect(result.workflowsErrors).toHaveLength(0);
  });

  it('target absent -> copied and byte-equals source', () => {
    const src = setupSource(['change-review.toml']);
    const tgt = join(tmpRoot, 'tgt');
    const result = syncDefaultWorkflows({
      sourceDir: src,
      targetDir: tgt,
      defaults: ['change-review.toml'],
    });

    expect(result.results[0]).toEqual({ workflow: 'change-review.toml', action: 'copied' });
    expect(readFileSync(join(tgt, 'change-review.toml'))).toEqual(
      readFileSync(join(src, 'change-review.toml')),
    );
  });

  it('target byte-equal -> noop and target file unchanged', () => {
    const src = setupSource(['change-review.toml']);
    const tgt = join(tmpRoot, 'tgt');
    mkdirSync(tgt);
    writeFileSync(join(tgt, 'change-review.toml'), '# change-review.toml\nbody\n');
    const before = statSync(join(tgt, 'change-review.toml'));

    const result = syncDefaultWorkflows({
      sourceDir: src,
      targetDir: tgt,
      defaults: ['change-review.toml'],
    });

    expect(result.results[0]).toEqual({ workflow: 'change-review.toml', action: 'noop' });
    expect(statSync(join(tgt, 'change-review.toml')).mtimeMs).toBe(before.mtimeMs);
    expect(readFileSync(join(tgt, 'change-review.toml'), 'utf8')).toBe(
      '# change-review.toml\nbody\n',
    );
  });

  it('target differs -> user-modified and target file unchanged', () => {
    const src = setupSource(['change-review.toml']);
    const tgt = join(tmpRoot, 'tgt');
    mkdirSync(tgt);
    writeFileSync(join(tgt, 'change-review.toml'), 'user edit\n');

    const result = syncDefaultWorkflows({
      sourceDir: src,
      targetDir: tgt,
      defaults: ['change-review.toml'],
    });

    const entry = result.results[0]!;
    expect(entry.action).toBe('user-modified');
    if (entry.action === 'user-modified') {
      expect(entry.conflict.sourceBytes?.toString('utf8')).toBe('# change-review.toml\nbody\n');
      expect(entry.conflict.userBytes?.toString('utf8')).toBe('user edit\n');
    }
    expect(readFileSync(join(tgt, 'change-review.toml'), 'utf8')).toBe('user edit\n');
  });

  it('target symlink -> user-modified without following the link', () => {
    const src = setupSource(['change-review.toml']);
    const tgt = join(tmpRoot, 'tgt');
    mkdirSync(tgt);
    const external = join(tmpRoot, 'external.toml');
    writeFileSync(external, 'external\n');
    symlinkSync(external, join(tgt, 'change-review.toml'));

    const result = syncDefaultWorkflows({
      sourceDir: src,
      targetDir: tgt,
      defaults: ['change-review.toml'],
    });

    const entry = result.results[0]!;
    expect(entry.action).toBe('user-modified');
    if (entry.action === 'user-modified') {
      expect(entry.conflict.targetIsSymlink).toBe(true);
      expect(entry.conflict.sourceBytes).toBeNull();
      expect(entry.conflict.userBytes).toBeNull();
    }
    expect(lstatSync(join(tgt, 'change-review.toml')).isSymbolicLink()).toBe(true);
    expect(readFileSync(external, 'utf8')).toBe('external\n');
  });

  it('mkdir failure -> each default gets error and workflowsErrors records it', () => {
    const src = setupSource(['change-review.toml', 'daily-review.toml']);
    const locked = join(tmpRoot, 'locked');
    mkdirSync(locked);
    chmodSync(locked, 0o000);

    const result = syncDefaultWorkflows({
      sourceDir: src,
      targetDir: join(locked, 'workflows'),
      defaults: ['change-review.toml', 'daily-review.toml'],
    });

    expect(result.results).toHaveLength(2);
    expect(result.results.every((entry) => entry.action === 'error')).toBe(true);
    expect(result.workflowsErrors).toHaveLength(1);
  });

  it('multiple defaults preserve declared order and isolate mixed actions', () => {
    const src = setupSource(WORKFLOWS);
    rmSync(join(src, 'ship-check.toml'));
    const tgt = join(tmpRoot, 'tgt');
    mkdirSync(tgt);
    writeFileSync(join(tgt, 'daily-review.toml'), '# daily-review.toml\nbody\n');

    const result = syncDefaultWorkflows({
      sourceDir: src,
      targetDir: tgt,
      defaults: WORKFLOWS,
    });

    expect(result.results.map((entry) => [entry.workflow, entry.action])).toEqual([
      ['change-review.toml', 'copied'],
      ['daily-review.toml', 'noop'],
      ['ship-check.toml', 'source-missing'],
    ]);
  });
});
