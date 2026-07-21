import { describe, expect, it } from 'vitest';
import { normalizeEvent } from '../../src/context-adapters/normalization.js';
import { claudeCodeFixture } from './fixtures/claude-code.js';
import { codexFixture } from './fixtures/codex.js';
import { cursorFixture } from './fixtures/cursor.js';
import { gitFixture } from './fixtures/git.js';

describe('JSON round-trip', () => {
  it.each([
    ['claude-code', claudeCodeFixture],
    ['codex', codexFixture],
    ['cursor', cursorFixture],
    ['git', gitFixture],
  ])('%s adapter atom round-trips through JSON.parse(JSON.stringify(...))', (_name, fixture) => {
    const atom = normalizeEvent(fixture);
    if (atom === null) throw new Error('expected adapter to match');
    const round = JSON.parse(JSON.stringify(atom));
    expect(round).toEqual(atom);
  });
});
