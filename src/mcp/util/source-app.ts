// Shared source-app vocabulary + FS-prefix mapping for MCP retrieval tools.
//
// Originally lived in multiple per-tool modules with identical path layouts.
// Drift-risk if (e.g.) the codex sessions path moved without updating both
// sites. Lifted here so every source_app-bearing tool (search_memories,
// wait_for_new_turns, echo_resolve_mru, etc.) shares one source of truth.

import { homedir } from 'node:os';

export const SOURCE_APP_VALUES = ['cursor', 'claude_code', 'codex', 'git', 'granola'] as const;
export type SourceApp = (typeof SOURCE_APP_VALUES)[number];

// Logical app names → literal stored-source prefixes. Cursor remains here as
// historical compatibility for migrated atoms even though the bundled runtime
// no longer captures it. `git` is path-prefix `git:` because git commits are
// stored with that scheme, not under any homedir path. `granola` is an API
// surface.
export function buildSourceAppMap(): Record<SourceApp, string> {
  const HOME = homedir();
  return {
    cursor: `fs:${HOME}/Library/Application Support/Cursor/`,
    claude_code: `fs:${HOME}/.claude/projects/`,
    codex: `fs:${HOME}/.codex/sessions/`,
    git: 'git:',
    granola: 'api:granola',
  };
}
