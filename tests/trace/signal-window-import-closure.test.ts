// 113 AC6 — import-closure guard. The signal-window module's transitive
// relative-import set must contain NO `src/mcp/internal` path (the wire-shape
// caps live there and must never leak into the seam) and NO `runBrain` symbol
// (nothing inside the plumbing calls an AI — decision 19). This is a static
// check over the TypeScript source, independent of the runtime full-fidelity
// assertion in signal-window.test.ts.

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import * as ts from 'typescript';
import { describe, expect, it } from 'vitest';

const repoRoot = resolve(new URL('../..', import.meta.url).pathname);
const ENTRY = join(repoRoot, 'src/trace/signal-window.ts');

interface ParsedImports {
  relativeSpecifiers: string[];
  namedSymbols: string[];
}

function parseImports(filePath: string, sourceText: string): ParsedImports {
  const sourceFile = ts.createSourceFile(
    filePath,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const relativeSpecifiers: string[] = [];
  const namedSymbols: string[] = [];

  function visit(node: ts.Node): void {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      const specifier = node.moduleSpecifier;
      if (specifier !== undefined && ts.isStringLiteral(specifier)) {
        if (specifier.text.startsWith('.')) relativeSpecifiers.push(specifier.text);
      }
    }
    if (ts.isImportDeclaration(node) && node.importClause?.namedBindings !== undefined) {
      const bindings = node.importClause.namedBindings;
      if (ts.isNamedImports(bindings)) {
        for (const el of bindings.elements) namedSymbols.push(el.name.text);
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return { relativeSpecifiers, namedSymbols };
}

function resolveTsImport(importerPath: string, specifier: string): string | null {
  const noJs = specifier.replace(/\.js$/, '');
  const base = resolve(dirname(importerPath), noJs);
  const candidates = [`${base}.ts`, join(base, 'index.ts')];
  return candidates.find((c) => existsSync(c)) ?? null;
}

function transitiveClosure(entry: string): { files: Set<string>; namedSymbols: Set<string> } {
  const files = new Set<string>();
  const namedSymbols = new Set<string>();
  const queue = [entry];
  while (queue.length > 0) {
    const current = queue.pop()!;
    if (files.has(current)) continue;
    files.add(current);
    const parsed = parseImports(current, readFileSync(current, 'utf8'));
    for (const sym of parsed.namedSymbols) namedSymbols.add(sym);
    for (const spec of parsed.relativeSpecifiers) {
      const resolved = resolveTsImport(current, spec);
      if (resolved !== null && !files.has(resolved)) queue.push(resolved);
    }
  }
  return { files, namedSymbols };
}

describe('113 AC6 — signal-window import closure', () => {
  const { files, namedSymbols } = transitiveClosure(ENTRY);

  it('reaches a non-trivial transitive import set (sanity)', () => {
    expect(files.size).toBeGreaterThan(1);
    expect(files.has(ENTRY)).toBe(true);
  });

  it('contains no src/mcp/internal path', () => {
    const offenders = [...files].filter((f) => f.replace(/\\/g, '/').includes('/src/mcp/internal/'));
    expect(offenders).toEqual([]);
  });

  it('contains no runBrain symbol and does not reach the brain module', () => {
    expect(namedSymbols.has('runBrain')).toBe(false);
    const brainReached = [...files].filter((f) =>
      f.replace(/\\/g, '/').includes('/src/brain/brain.ts'),
    );
    expect(brainReached).toEqual([]);
  });
});
