import { readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, normalize as pathNormalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { createLogger } from '../logging/index.js';

const log = createLogger('mcp.cursor-resolver');

const HOME = homedir();

// Defaults match the cursor extractor (`src/capture/extractors/cursor.ts`).
// Tests inject alternate paths via the explicit arguments.
export const DEFAULT_CURSOR_GLOBAL_DB_PATH = `${HOME}/Library/Application Support/Cursor/User/globalStorage/state.vscdb`;
export const DEFAULT_CURSOR_WORKSPACE_STORAGE_DIR = `${HOME}/Library/Application Support/Cursor/User/workspaceStorage/`;

export interface CursorComposerResolution {
  workspace_id: string;
  composer_id: string;
}

// Strip one trailing separator (mirrors `path.normalize` for paths with a
// trailing slash — Node's normalize keeps the slash). The resolver compares
// paths by exact string equality after decoding the workspace.json `folder`
// URL, so the inputs must be normalised the same way. Exported (item 037)
// so all four retrieval tools normalise `repo_path` to the same shape that
// capture writes to `metadata.repo_root` — without this, a caller-supplied
// `/path/` would silently miss the stored `/path`.
export function normaliseRepoPath(p: string): string {
  const n = pathNormalize(p);
  if (n.length > 1 && (n.endsWith('/') || n.endsWith('\\'))) {
    return n.slice(0, -1);
  }
  return n;
}

interface WorkspaceMatch {
  workspaceHash: string;
  workspaceDbPath: string;
  workspaceDbMtimeMs: number;
}

// Scan the workspaceStorage directory for the workspace whose `workspace.json`
// `folder` field URL-decodes to the target repo path. Returns the matching
// hash + path to that workspace's state.vscdb, or null when nothing matches.
//
// Skip-conditions (each logs a warn but never throws):
//   - missing / unreadable / non-JSON workspace.json
//   - missing `folder` field
//   - `folder` not starting with `file://` (remote, vscode-remote://, etc.)
//   - malformed `file://` URL (fileURLToPath rejection)
//
// Multi-match tiebreak: choose the workspace whose state.vscdb has the
// most-recently-touched mtime, then lexically-first by workspaceHash if
// mtimes tie. Bare workspaces (no state.vscdb on disk) are still candidates
// (treated as mtime=0); they only win when nothing else matches.
function findWorkspaceForRepoPath(
  normalisedRepoPath: string,
  workspaceStorageDir: string,
): WorkspaceMatch | null {
  let entries: string[];
  try {
    entries = readdirSync(workspaceStorageDir);
  } catch (err) {
    log.warn('workspace_storage_unreadable', {
      path: workspaceStorageDir,
      message: (err as Error).message,
    });
    return null;
  }

  const candidates: WorkspaceMatch[] = [];
  for (const entry of entries) {
    const workspaceJsonPath = join(workspaceStorageDir, entry, 'workspace.json');
    let raw: string;
    try {
      raw = readFileSync(workspaceJsonPath, 'utf8');
    } catch {
      // Missing / unreadable workspace.json is common — many workspaceStorage
      // entries are scratch dirs without a folder mapping. Quiet skip.
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      log.warn('workspace_json_not_json', {
        path: workspaceJsonPath,
        message: (err as Error).message,
      });
      continue;
    }
    if (typeof parsed !== 'object' || parsed === null) continue;
    const folder = (parsed as Record<string, unknown>)['folder'];
    if (typeof folder !== 'string') continue;
    // Validate the URL shape before fileURLToPath — remote workspaces
    // (`vscode-remote://`) and multi-root workspaces (no `folder`, often
    // a `configuration` field instead) reach here too. Skip non-`file:`
    // shapes silently — they're expected.
    if (!folder.startsWith('file://')) continue;
    let decoded: string;
    try {
      decoded = fileURLToPath(folder);
    } catch (err) {
      log.warn('workspace_folder_url_invalid', {
        path: workspaceJsonPath,
        folder,
        message: (err as Error).message,
      });
      continue;
    }
    const decodedNormalised = normaliseRepoPath(decoded);
    if (decodedNormalised !== normalisedRepoPath) continue;

    const workspaceDbPath = join(workspaceStorageDir, entry, 'state.vscdb');
    let mtimeMs = 0;
    try {
      mtimeMs = statSync(workspaceDbPath).mtimeMs;
    } catch {
      // No state.vscdb — keep the candidate at mtime=0 so a brand-new
      // workspace can still be picked when it's the only match. The next
      // step (allComposers query) handles a missing DB by returning null,
      // which surfaces as the "no composers" warning at AC4 step 1.
    }
    candidates.push({
      workspaceHash: entry,
      workspaceDbPath,
      workspaceDbMtimeMs: mtimeMs,
    });
  }

  if (candidates.length === 0) return null;
  candidates.sort((a, b) => {
    if (a.workspaceDbMtimeMs !== b.workspaceDbMtimeMs) {
      return b.workspaceDbMtimeMs - a.workspaceDbMtimeMs;
    }
    return a.workspaceHash < b.workspaceHash ? -1 : 1;
  });
  return candidates[0]!;
}

// Read the workspace's state.vscdb and return the list of composerIds the
// workspace currently knows about. The shape matches `refreshComposerWorkspaceMap`
// in the cursor extractor: ItemTable.key='composer.composerData', value=JSON
// with `allComposers: [{composerId: string, ...}, ...]`.
//
// Returns [] when the DB is absent, the table is missing, or the row/value
// is malformed (warn + continue). A non-existent workspace DB is not an
// error condition at this layer — it just means the workspace has not
// surfaced a composerData entry yet.
function listComposerIdsForWorkspace(workspaceDbPath: string): string[] {
  let db: Database.Database;
  try {
    db = new Database(workspaceDbPath, { readonly: true, fileMustExist: true });
  } catch (err) {
    log.warn('workspace_db_open_failed', {
      path: workspaceDbPath,
      message: (err as Error).message,
    });
    return [];
  }
  try {
    const tableExists = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='ItemTable'")
      .get();
    if (tableExists === undefined) return [];
    const row = db
      .prepare("SELECT value FROM ItemTable WHERE key = 'composer.composerData'")
      .get() as { value: string } | undefined;
    if (row === undefined) return [];
    let parsed: unknown;
    try {
      parsed = JSON.parse(row.value);
    } catch (err) {
      log.warn('workspace_composer_data_not_json', {
        path: workspaceDbPath,
        message: (err as Error).message,
      });
      return [];
    }
    if (typeof parsed !== 'object' || parsed === null) return [];
    // Cursor's workspace composer registry has two shapes empirically observed
    // in 2026:
    //   - Legacy:  `allComposers: [{composerId: string, ...}, ...]`
    //   - Current: `selectedComposerIds: string[]` + `lastFocusedComposerIds: string[]`
    //              with `hasMigratedMultipleComposers: true` as the migration marker.
    // 035's initial implementation only read the legacy shape; the AC6 dogfooding
    // on 2026-05-11 found Project_echo's workspace exclusively uses the current
    // shape, returning 0 composers and breaking the resolver's primary path. The
    // fix unions both shapes — workspaces written before the migration still
    // surface their legacy `allComposers[]`; post-migration workspaces (the common
    // case) surface via the selected/focused arrays. A workspace exposing both
    // shapes (theoretically possible mid-migration) gets the union.
    const ids = new Set<string>();
    const allComposers = (parsed as Record<string, unknown>)['allComposers'];
    if (Array.isArray(allComposers)) {
      for (const c of allComposers) {
        if (typeof c === 'object' && c !== null) {
          const id = (c as Record<string, unknown>)['composerId'];
          if (typeof id === 'string' && id.length > 0) ids.add(id);
        }
      }
    }
    for (const key of ['selectedComposerIds', 'lastFocusedComposerIds'] as const) {
      const arr = (parsed as Record<string, unknown>)[key];
      if (Array.isArray(arr)) {
        for (const id of arr) {
          if (typeof id === 'string' && id.length > 0) ids.add(id);
        }
      }
    }
    return [...ids];
  } finally {
    db.close();
  }
}

// Pick the most-recently-active composer among `composerIds` by reading
// `composerData:<id>` from the GLOBAL state.vscdb cursorDiskKV table and
// taking the entry with the largest `lastUpdatedAt` (falling back to
// `createdAt` when `lastUpdatedAt` is missing — same hedge the strategist
// used in the 2026-05-10 22:20 PDT SQLite probe).
//
// Returns null when none of the composer ids resolve to a parseable row.
function pickMostRecentlyActiveComposer(
  globalDbPath: string,
  composerIds: string[],
): string | null {
  if (composerIds.length === 0) return null;
  let db: Database.Database;
  try {
    db = new Database(globalDbPath, { readonly: true, fileMustExist: true });
  } catch (err) {
    log.warn('global_db_open_failed', {
      path: globalDbPath,
      message: (err as Error).message,
    });
    return null;
  }
  try {
    const tableExists = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='cursorDiskKV'")
      .get();
    if (tableExists === undefined) return null;
    const placeholders = composerIds.map(() => '?').join(',');
    const keys = composerIds.map((id) => `composerData:${id}`);
    const rows = db
      .prepare(`SELECT key, value FROM cursorDiskKV WHERE key IN (${placeholders})`)
      .all(...keys) as Array<{ key: string; value: string }>;

    let bestId: string | null = null;
    let bestTs = -Infinity;
    for (const row of rows) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(row.value);
      } catch {
        continue;
      }
      if (typeof parsed !== 'object' || parsed === null) continue;
      const rec = parsed as Record<string, unknown>;
      const lastUpdatedRaw = rec['lastUpdatedAt'];
      const createdRaw = rec['createdAt'];
      let ts: number = -Infinity;
      if (typeof lastUpdatedRaw === 'number' && Number.isFinite(lastUpdatedRaw)) {
        ts = lastUpdatedRaw;
      } else if (typeof createdRaw === 'number' && Number.isFinite(createdRaw)) {
        ts = createdRaw;
      } else {
        continue;
      }
      // Recover composerId from the key (`composerData:<id>`) so we don't
      // trust the JSON body (`rec.composerId`) to round-trip cleanly.
      const id = row.key.slice('composerData:'.length);
      if (ts > bestTs) {
        bestTs = ts;
        bestId = id;
      }
    }
    return bestId;
  } finally {
    db.close();
  }
}

/**
 * Resolve the most-recently-active Cursor composer for the given repo path,
 * by reading Cursor's OWN storage (workspaceStorage + globalStorage) rather
 * than relying on ECHO's optional `metadata.workspace_id` (which can be
 * absent on atoms captured before the extractor's chokidar workspace-watch
 * fired — see R1 Finding 1 / Codex HIGH #1 in 2026-05-10-035).
 *
 * Returns `{workspace_id, composer_id}` on success, or `null` when:
 *   - no `workspace.json` `folder` matches the repo path, OR
 *   - the matching workspace has no composers listed, OR
 *   - the composers exist but none resolves to a parseable row in the
 *     global cursorDiskKV.
 *
 * `globalDbPath` and `workspaceStorageDir` are injected for testability
 * (mirrors the cursor extractor's `globalDbPath` injection pattern).
 */
export function resolveCursorComposerForRepoPath(
  repoPath: string,
  globalDbPath: string = DEFAULT_CURSOR_GLOBAL_DB_PATH,
  workspaceStorageDir: string = DEFAULT_CURSOR_WORKSPACE_STORAGE_DIR,
): CursorComposerResolution | null {
  const normalised = normaliseRepoPath(repoPath);
  const ws = findWorkspaceForRepoPath(normalised, workspaceStorageDir);
  if (ws === null) return null;
  const composerIds = listComposerIdsForWorkspace(ws.workspaceDbPath);
  if (composerIds.length === 0) return null;
  const picked = pickMostRecentlyActiveComposer(globalDbPath, composerIds);
  if (picked === null) return null;
  return { workspace_id: ws.workspaceHash, composer_id: picked };
}

/**
 * Item 037 / AC1 — INVERSE of `resolveCursorComposerForRepoPath`.
 *
 * Given a workspace_id (the workspaceStorage subdir hash that the Cursor
 * extractor already maps composers to via `refreshComposerWorkspaceMap`),
 * read `<workspaceStorageDir>/<workspace_id>/workspace.json` and return its
 * `folder` URI decoded to an absolute filesystem path (normalised — no
 * trailing slash). Mirrors Claude Code's `metadata.repo_root` shape (no
 * `file://` prefix, no trailing slash) so a single `metadata_match` key
 * works across all source_apps.
 *
 * Returns `null` when:
 *   - the workspace subdir doesn't exist, OR
 *   - workspace.json is missing / unreadable / non-JSON / lacks a `folder`
 *     field, OR
 *   - `folder` doesn't start with `file://` (remote / multi-root workspaces),
 *     OR
 *   - the URL is malformed (`fileURLToPath` throws).
 *
 * Each failure mode warn-logs through the same `mcp.cursor-resolver` channel
 * as `findWorkspaceForRepoPath` so debugging is uniform.
 */
export function resolveRepoRootForWorkspaceId(
  workspace_id: string,
  workspaceStorageDir: string = DEFAULT_CURSOR_WORKSPACE_STORAGE_DIR,
): string | null {
  const workspaceJsonPath = join(workspaceStorageDir, workspace_id, 'workspace.json');
  let raw: string;
  try {
    raw = readFileSync(workspaceJsonPath, 'utf8');
  } catch {
    // Missing / unreadable workspace.json — silent (matches
    // findWorkspaceForRepoPath's quiet-skip discipline; many entries are
    // legitimately scratch dirs without a folder mapping).
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    log.warn('workspace_json_not_json', {
      path: workspaceJsonPath,
      message: (err as Error).message,
    });
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const folder = (parsed as Record<string, unknown>)['folder'];
  if (typeof folder !== 'string') return null;
  if (!folder.startsWith('file://')) return null;
  let decoded: string;
  try {
    decoded = fileURLToPath(folder);
  } catch (err) {
    log.warn('workspace_folder_url_invalid', {
      path: workspaceJsonPath,
      folder,
      message: (err as Error).message,
    });
    return null;
  }
  return normaliseRepoPath(decoded);
}
