// Item 038 / AC5: tests for the shared fs-watcher exclusion helper, plus a
// CI grep-scan that fails if any future retrieval tool or internal module
// re-hardcodes the literal pattern. Closes the Bug B 2026-05-08 regression
// loop structurally — re-shipping `exclude_metadata_surface: ['fs']` inline
// somewhere new is now caught by this test, not by post-merge dogfooding.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { EXCLUDE_FS_SURFACE, withFsExclusion } from '../../../src/mcp/util/fs-exclusion.js';

describe('fs-exclusion helper', () => {
  it('EXCLUDE_FS_SURFACE matches the historic hardcoded shape', () => {
    expect([...EXCLUDE_FS_SURFACE]).toEqual(['fs']);
  });

  it('withFsExclusion adds the exclusion to an existing filter', () => {
    const f = withFsExclusion({ source_prefix: 'fs:foo', limit: 1 });
    expect(f.source_prefix).toBe('fs:foo');
    expect(f.limit).toBe(1);
    expect(f.exclude_metadata_surface).toEqual(['fs']);
  });

  it('withFsExclusion preserves existing fields without aliasing the readonly tuple', () => {
    const f = withFsExclusion({});
    f.exclude_metadata_surface.push('other'); // must not mutate the shared constant
    expect([...EXCLUDE_FS_SURFACE]).toEqual(['fs']);
  });
});

// CI grep-scan integration test. Scans every TypeScript file under src/mcp
// (excluding the helper itself) for any inline literal of the form
// `exclude_metadata_surface : [...` — single or double quoted, with or
// without whitespace, single- or multi-element. If a hit is found, the test
// fails with a pointer to the offending file + line so the author migrates
// to `withFsExclusion(...)` instead of re-hardcoding.
describe('AC5 — exclude_metadata_surface single source of truth', () => {
  it('no inline `exclude_metadata_surface: [...]` literal survives outside the helper file', () => {
    const HERE = dirname(fileURLToPath(import.meta.url));
    const MCP_ROOT = join(HERE, '..', '..', '..', 'src', 'mcp');
    const HELPER_REL = join('util', 'fs-exclusion.ts'); // path-suffix to exclude
    const PATTERN = /\bexclude_metadata_surface\s*:\s*\[/;
    const offenders: { path: string; line: number; text: string }[] = [];

    function walk(dir: string): void {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        const st = statSync(full);
        if (st.isDirectory()) {
          walk(full);
          continue;
        }
        if (!full.endsWith('.ts')) continue;
        if (full.endsWith(HELPER_REL)) continue;
        const src = readFileSync(full, 'utf8');
        const lines = src.split('\n');
        for (let i = 0; i < lines.length; i++) {
          if (PATTERN.test(lines[i]!)) {
            offenders.push({ path: full, line: i + 1, text: lines[i]!.trim() });
          }
        }
      }
    }
    walk(MCP_ROOT);

    if (offenders.length > 0) {
      const msg = offenders.map((o) => `  ${o.path}:${o.line}  ${o.text}`).join('\n');
      throw new Error(
        'AC5: inline `exclude_metadata_surface: [...]` literal found outside the helper file.\n' +
          'Migrate to `withFsExclusion(...)` from `src/mcp/util/fs-exclusion.ts`.\n' +
          offenders.length +
          ' offending site(s):\n' +
          msg,
      );
    }
    expect(offenders.length).toBe(0);
  });
});
