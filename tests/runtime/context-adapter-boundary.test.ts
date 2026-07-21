import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

function typescriptFiles(path: string): string[] {
  return readdirSync(path, { withFileTypes: true }).flatMap((entry) => {
    const child = join(path, entry.name);
    if (entry.isDirectory()) return typescriptFiles(child);
    return entry.isFile() && entry.name.endsWith('.ts') ? [child] : [];
  });
}

function staticImports(source: string): string[] {
  const fromSpecifiers = Array.from(
    source.matchAll(
      /(?:^|\n)\s*(?:import|export)\s+(?:type\s+)?[^;]*?\sfrom\s+['"]([^'"]+)['"]\s*;/g,
    ),
    (match) => match[1] as string,
  );
  const sideEffectSpecifiers = Array.from(
    source.matchAll(/(?:^|\n)\s*import\s+['"]([^'"]+)['"]\s*;/g),
    (match) => match[1] as string,
  );
  return [...fromSpecifiers, ...sideEffectSpecifiers];
}

describe('context adapter runtime boundary', () => {
  it('keeps provider-specific lifecycle wiring out of the runtime', () => {
    const runtime = readFileSync(
      join(ROOT, 'src', 'runtime', 'context-runtime.ts'),
      'utf8',
    );

    expect(runtime).not.toMatch(/startCodexExtractor|startClaudeCodeExtractor/);
    expect(runtime).not.toMatch(/capture\.(?:codex|claudeCode)/);
    expect(runtime).toContain('createCaptureAdapterRegistrations');
    expect(runtime).toContain('const captureRegistrations');
    expect(runtime.indexOf('const captureRegistrations')).toBeLessThan(
      runtime.indexOf('const pidLock'),
    );
    expect(runtime).toContain('captureRunner.start(startupStorage, health)');
  });

  it('keeps normalization core inward-facing and registration-injected', () => {
    const normalizeRoot = join(ROOT, 'src', 'normalize');
    for (const path of typescriptFiles(normalizeRoot)) {
      const imports = staticImports(readFileSync(path, 'utf8'));
      expect(
        imports.filter((specifier) =>
          /(?:^|\/)(?:context-adapters|capture|runtime)(?:\/|$)/.test(
            specifier,
          ),
        ),
        `${path} crosses the normalization boundary`,
      ).toEqual([]);
    }

    const dispatch = readFileSync(
      join(normalizeRoot, 'dispatch.ts'),
      'utf8',
    );
    expect(dispatch).toContain('createNormalizer');
    expect(dispatch).not.toContain('getNormalizationAdapterRegistry');
  });

  it('does not eagerly load concrete extractors for normalization', () => {
    const registry = readFileSync(
      join(ROOT, 'src', 'context-adapters', 'registry.ts'),
      'utf8',
    );
    expect(staticImports(registry)).not.toEqual(
      expect.arrayContaining([
        expect.stringMatching(/capture\/extractors\//),
      ]),
    );

    const contracts = readFileSync(
      join(ROOT, 'src', 'context-adapters', 'contracts.ts'),
      'utf8',
    );
    expect(staticImports(contracts)).not.toEqual(
      expect.arrayContaining([
        expect.stringMatching(/capture\/extractors\//),
      ]),
    );
  });
});
