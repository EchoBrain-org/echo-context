import { adaptClaudeCode, CLAUDE_CODE_VERSION, matchesClaudeCode } from './adapters/claude-code.js';
import { adaptCodex, CODEX_VERSION, matchesCodex } from './adapters/codex.js';
import { adaptCursor, CURSOR_VERSION, matchesCursor } from './adapters/cursor.js';
import { adaptGit, GIT_VERSION, matchesGit } from './adapters/git.js';
import { adaptGranola, GRANOLA_VERSION, matchesGranola } from './adapters/granola.js';
import type { AdapterRegistration } from './types.js';

const REGISTRY: AdapterRegistration[] = [
  {
    name: 'claude-code',
    version: CLAUDE_CODE_VERSION,
    matches: matchesClaudeCode,
    adapter: adaptClaudeCode,
  },
  {
    name: 'codex',
    version: CODEX_VERSION,
    matches: matchesCodex,
    adapter: adaptCodex,
  },
  {
    name: 'cursor',
    version: CURSOR_VERSION,
    matches: matchesCursor,
    adapter: adaptCursor,
  },
  {
    name: 'git',
    version: GIT_VERSION,
    matches: matchesGit,
    adapter: adaptGit,
  },
  {
    name: 'granola',
    version: GRANOLA_VERSION,
    matches: matchesGranola,
    adapter: adaptGranola,
  },
];

export function getRegistry(): readonly AdapterRegistration[] {
  return REGISTRY;
}

export function findAdapter(source: string): AdapterRegistration | null {
  for (const reg of REGISTRY) {
    if (reg.matches(source)) return reg;
  }
  return null;
}
