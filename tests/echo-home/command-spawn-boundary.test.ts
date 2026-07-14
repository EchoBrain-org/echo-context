import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO = process.cwd();

function source(path: string): string {
  return readFileSync(join(REPO, path), 'utf8');
}

function typescriptSources(dir: string): string[] {
  return readdirSync(join(REPO, dir), { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return typescriptSources(path);
    return entry.isFile() && entry.name.endsWith('.ts') ? [path] : [];
  });
}

describe('command spawn security boundary', () => {
  it('pins the cross-platform launcher as a direct production dependency', () => {
    const manifest = JSON.parse(source('package.json')) as {
      dependencies?: Record<string, string>;
    };
    expect(manifest.dependencies?.['cross-spawn']).toBe('7.0.6');
  });

  it('keeps production command names literal and removes direct child_process sinks', () => {
    const registration = source('src/echo-home/adapters/claude-code-mcp.ts');
    const probe = source('src/echo-home/wizard/probe.ts');

    expect(registration).not.toContain("from 'node:child_process'");
    expect(registration).toContain("crossSpawn('claude', args");
    expect(probe).not.toMatch(
      /import\s*\{[^}]*\bspawn\b[^}]*\}\s*from\s*['"]node:child_process['"]/s,
    );
    expect(probe).toContain("crossSpawn('codex', args");
    expect(probe).toContain("crossSpawn('claude', args");
  });

  it('keeps the superseded command resolver unreachable from production code', () => {
    const imports = typescriptSources('src').filter(
      (path) => path !== 'src/util/subprocess.ts' && source(path).includes('util/subprocess'),
    );
    expect(imports).toEqual([]);
  });
});
