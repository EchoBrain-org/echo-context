import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { syncDefaultRoles } from '../../../src/echo-home/adapters/role-sync.js';

let tmpRoot: string;

const ROLES = ['builder.toml', 'reviewer.toml', 'strategist.toml'];

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'echo-072-roles-'));
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

function setupSource(): string {
  const dir = join(tmpRoot, 'src-roles');
  mkdirSync(dir);
  for (const r of ROLES) writeFileSync(join(dir, r), `# ${r}\nbody\n`);
  return dir;
}

describe('syncDefaultRoles', () => {
  it('target dir empty → all three default roles copied', () => {
    const src = setupSource();
    const tgt = join(tmpRoot, 'tgt');
    const r = syncDefaultRoles({ sourceDir: src, targetDir: tgt, defaults: ROLES });
    expect(r.results).toHaveLength(3);
    for (const result of r.results) {
      expect(result.action).toBe('copied');
    }
    for (const role of ROLES) {
      expect(readFileSync(join(tgt, role), 'utf8')).toBe(`# ${role}\nbody\n`);
    }
  });

  it('target dir has all three roles byte-identical → all noop', () => {
    const src = setupSource();
    const tgt = join(tmpRoot, 'tgt');
    mkdirSync(tgt);
    for (const r of ROLES) writeFileSync(join(tgt, r), `# ${r}\nbody\n`);
    const r = syncDefaultRoles({ sourceDir: src, targetDir: tgt, defaults: ROLES });
    for (const result of r.results) {
      expect(result.action).toBe('noop');
    }
  });

  it('user-edited reviewer.toml → user-modified; file NOT overwritten', () => {
    const src = setupSource();
    const tgt = join(tmpRoot, 'tgt');
    mkdirSync(tgt);
    writeFileSync(join(tgt, 'reviewer.toml'), 'user-edit\n');
    const r = syncDefaultRoles({ sourceDir: src, targetDir: tgt, defaults: ROLES });
    const reviewer = r.results.find((x) => x.role === 'reviewer.toml')!;
    expect(reviewer.action).toBe('user-modified');
    expect(readFileSync(join(tgt, 'reviewer.toml'), 'utf8')).toBe('user-edit\n');
    const builder = r.results.find((x) => x.role === 'builder.toml')!;
    expect(builder.action).toBe('copied');
  });

  it('source dir missing builder.toml → source-missing for builder only', () => {
    const src = setupSource();
    // Remove builder source.
    rmSync(join(src, 'builder.toml'));
    const tgt = join(tmpRoot, 'tgt');
    const r = syncDefaultRoles({ sourceDir: src, targetDir: tgt, defaults: ROLES });
    const builder = r.results.find((x) => x.role === 'builder.toml')!;
    expect(builder.action).toBe('source-missing');
    const reviewer = r.results.find((x) => x.role === 'reviewer.toml')!;
    expect(reviewer.action).toBe('copied');
  });
});
