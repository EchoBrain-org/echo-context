import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

describe('context adapter runtime boundary', () => {
  it('keeps provider-specific lifecycle wiring out of the runtime', () => {
    const runtime = readFileSync(
      join(ROOT, 'src', 'runtime', 'context-runtime.ts'),
      'utf8',
    );

    expect(runtime).not.toMatch(/startCodexExtractor|startClaudeCodeExtractor/);
    expect(runtime).not.toMatch(/capture\.(?:codex|claudeCode)/);
    expect(runtime).toContain(
      'createCaptureAdapterRegistrations(config.capture)',
    );
    expect(runtime).toContain('captureRunner.start(startupStorage, health)');
  });
});
