import {
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  BEGIN_MARKER,
  END_MARKER,
  mergeWithMarkers,
} from '../../../src/echo-home/adapters/markers.js';

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'echo-072-markers-'));
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe('mergeWithMarkers', () => {
  it('appends to a fresh (non-existent) file', () => {
    const target = join(tmpRoot, 'AGENTS.md');
    const result = mergeWithMarkers({ filePath: target, echoSection: 'echo body' });
    expect(result.action).toBe('append');
    const content = readFileSync(target, 'utf8');
    expect(content).toBe(`${BEGIN_MARKER}\necho body\n${END_MARKER}\n`);
  });

  it('replaces the inside-markers content when previous matches', () => {
    const target = join(tmpRoot, 'AGENTS.md');
    const preamble = '# Existing user content\nLine two\n';
    writeFileSync(target, `${preamble}${BEGIN_MARKER}\nold body\n${END_MARKER}\n`);
    const result = mergeWithMarkers({
      filePath: target,
      echoSection: 'new body',
      previousEchoSection: 'old body',
    });
    expect(result.action).toBe('replace');
    const content = readFileSync(target, 'utf8');
    expect(content).toBe(`${preamble}${BEGIN_MARKER}\nnew body\n${END_MARKER}\n`);
  });

  it('returns noop when content already matches (idempotent re-run)', () => {
    const target = join(tmpRoot, 'AGENTS.md');
    const original = `${BEGIN_MARKER}\nsame body\n${END_MARKER}\n`;
    writeFileSync(target, original);
    const beforeBytes = readFileSync(target);
    const result = mergeWithMarkers({ filePath: target, echoSection: 'same body' });
    expect(result.action).toBe('noop');
    expect(readFileSync(target).equals(beforeBytes)).toBe(true);
  });

  it('returns conflict when inside differs from both previous and new', () => {
    const target = join(tmpRoot, 'AGENTS.md');
    writeFileSync(target, `${BEGIN_MARKER}\nuser hand-edited\n${END_MARKER}\n`);
    const result = mergeWithMarkers({
      filePath: target,
      echoSection: 'new body',
      previousEchoSection: 'old body',
    });
    expect(result.action).toBe('conflict');
    if (result.action !== 'conflict') return;
    expect(result.conflict.kind).toBe('marker');
    if (result.conflict.kind !== 'marker') return;
    expect(result.conflict.currentInside).toBe('user hand-edited');
    expect(result.conflict.expectedInside).toBe('old body');
    expect(result.conflict.proposedInside).toBe('new body');
    expect(result.conflict.unifiedDiff.length).toBeGreaterThan(0);
  });

  it('force-replaces inside-markers content that would otherwise conflict', () => {
    const target = join(tmpRoot, 'AGENTS.md');
    const above = '# Top\n';
    const below = '\n# Bottom\n';
    writeFileSync(target, `${above}${BEGIN_MARKER}\nuser hand-edited\n${END_MARKER}${below}`);
    const result = mergeWithMarkers({
      filePath: target,
      echoSection: 'new body',
      previousEchoSection: 'old body',
      force: true,
    });
    expect(result.action).toBe('replace');
    expect(readFileSync(target, 'utf8')).toBe(
      `${above}${BEGIN_MARKER}\nnew body\n${END_MARKER}${below}`,
    );
  });

  it('preserves content above and below markers byte-for-byte across replace', () => {
    const target = join(tmpRoot, 'AGENTS.md');
    const above = '# Top of file\nLine 2\n\n';
    const below = '\n## After ECHO\nMore user content\n';
    writeFileSync(target, `${above}${BEGIN_MARKER}\nold body\n${END_MARKER}${below}`);
    mergeWithMarkers({
      filePath: target,
      echoSection: 'new body',
      previousEchoSection: 'old body',
    });
    const content = readFileSync(target, 'utf8');
    expect(content.startsWith(above)).toBe(true);
    expect(content.endsWith(below)).toBe(true);
    expect(content).toBe(`${above}${BEGIN_MARKER}\nnew body\n${END_MARKER}${below}`);
  });

  it('malformed markers → conflict; second run is convergent (no growth)', () => {
    const target = join(tmpRoot, 'AGENTS.md');
    // BEGIN present, END missing.
    const malformed = `# Header\n${BEGIN_MARKER}\nbroken inside\n`;
    writeFileSync(target, malformed);
    const before = readFileSync(target);
    const r1 = mergeWithMarkers({ filePath: target, echoSection: 'x' });
    expect(r1.action).toBe('conflict');
    if (r1.action !== 'conflict') return;
    expect(r1.conflict.kind).toBe('malformed-marker');
    expect(readFileSync(target).equals(before)).toBe(true);
    const r2 = mergeWithMarkers({ filePath: target, echoSection: 'x' });
    expect(r2.action).toBe('conflict');
    if (r2.action !== 'conflict') return;
    expect(r2.conflict.kind).toBe('malformed-marker');
    expect(readFileSync(target).equals(before)).toBe(true);
  });

  it('target symlink → conflict with kind target-symlink; never reads the link target', () => {
    const realPath = join(tmpRoot, 'real-CLAUDE.md');
    writeFileSync(realPath, 'symlink-target-secret');
    const link = join(tmpRoot, 'CLAUDE.md');
    symlinkSync(realPath, link);
    const result = mergeWithMarkers({ filePath: link, echoSection: 'attempted' });
    expect(result.action).toBe('conflict');
    if (result.action !== 'conflict') return;
    expect(result.conflict.kind).toBe('target-symlink');
    if (result.conflict.kind !== 'target-symlink') return;
    expect(result.conflict.targetIsSymlink).toBe(true);
    // The real target was never modified.
    expect(readFileSync(realPath, 'utf8')).toBe('symlink-target-secret');
  });

  it('appends to existing user content when no markers present', () => {
    const target = join(tmpRoot, 'AGENTS.md');
    writeFileSync(target, '# Existing\nuser content\n');
    const result = mergeWithMarkers({ filePath: target, echoSection: 'echo body' });
    expect(result.action).toBe('append');
    const content = readFileSync(target, 'utf8');
    expect(content).toBe(
      `# Existing\nuser content\n\n${BEGIN_MARKER}\necho body\n${END_MARKER}\n`,
    );
  });
});
