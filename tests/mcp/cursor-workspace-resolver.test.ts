import Database from 'better-sqlite3';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  normaliseRepoPath,
  resolveCursorComposerForRepoPath,
  resolveRepoRootForWorkspaceId,
} from '../../src/mcp/cursor-workspace-resolver.js';

// Build a temp-dir fixture that mirrors the real Cursor layout:
//
//   <workspaceStorageDir>/<hash>/workspace.json     ← { folder: 'file://...' }
//   <workspaceStorageDir>/<hash>/state.vscdb        ← ItemTable[composer.composerData]
//   <globalDbPath>                                  ← cursorDiskKV[composerData:<id>]
//
// All disk operations stay inside `tmp/`, so tests are hermetic and safe to
// run in parallel.
interface WorkspaceFixture {
  hash: string;
  workspaceJson: string | null; // raw bytes; null skips writing the file
  composers?: Array<{ composerId: string }>; // legacy `allComposers[]` shape; if undefined, no state.vscdb is created
  // Post-migration shape (2026-05-11 fix-up): explicit override of the
  // composer.composerData JSON value. When set, `composers` is ignored and
  // this raw object is written verbatim. Lets tests exercise the migrated
  // shape (`selectedComposerIds[]` / `lastFocusedComposerIds[]`) or any future
  // shape variation without re-baking the fixture builder.
  composerDataOverride?: Record<string, unknown>;
}

interface GlobalComposerFixture {
  composerId: string;
  lastUpdatedAt?: number;
  createdAt?: number;
}

interface Fixture {
  workspaceStorageDir: string;
  globalDbPath: string;
  cleanup: () => void;
}

function buildFixture(opts: {
  workspaces: WorkspaceFixture[];
  globalComposers: GlobalComposerFixture[];
}): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'echo-cursor-resolver-'));
  const workspaceStorageDir = join(root, 'workspaceStorage');
  mkdirSync(workspaceStorageDir, { recursive: true });

  for (const ws of opts.workspaces) {
    const dir = join(workspaceStorageDir, ws.hash);
    mkdirSync(dir, { recursive: true });
    if (ws.workspaceJson !== null) {
      writeFileSync(join(dir, 'workspace.json'), ws.workspaceJson);
    }
    if (ws.composers !== undefined || ws.composerDataOverride !== undefined) {
      const db = new Database(join(dir, 'state.vscdb'));
      try {
        db.prepare('CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value TEXT)').run();
        const composerDataValue =
          ws.composerDataOverride ?? { allComposers: ws.composers };
        db.prepare('INSERT INTO ItemTable (key, value) VALUES (?, ?)').run(
          'composer.composerData',
          JSON.stringify(composerDataValue),
        );
      } finally {
        db.close();
      }
    }
  }

  const globalDbPath = join(root, 'globalStorage', 'state.vscdb');
  mkdirSync(join(root, 'globalStorage'), { recursive: true });
  const gdb = new Database(globalDbPath);
  try {
    gdb.prepare('CREATE TABLE cursorDiskKV (key TEXT PRIMARY KEY, value TEXT)').run();
    const stmt = gdb.prepare('INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)');
    for (const c of opts.globalComposers) {
      const body: Record<string, unknown> = { composerId: c.composerId };
      if (c.lastUpdatedAt !== undefined) body['lastUpdatedAt'] = c.lastUpdatedAt;
      if (c.createdAt !== undefined) body['createdAt'] = c.createdAt;
      stmt.run(`composerData:${c.composerId}`, JSON.stringify(body));
    }
  } finally {
    gdb.close();
  }

  return {
    workspaceStorageDir: workspaceStorageDir + '/',
    globalDbPath,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

describe('resolveCursorComposerForRepoPath', () => {
  let fixture: Fixture | undefined;

  afterEach(() => {
    fixture?.cleanup();
    fixture = undefined;
  });

  it('returns the workspace hash + the composer with max lastUpdatedAt', () => {
    fixture = buildFixture({
      workspaces: [
        {
          hash: 'WS-OTHER-A',
          workspaceJson: JSON.stringify({ folder: 'file:///tmp/other-a' }),
          composers: [{ composerId: 'OUT-A' }],
        },
        {
          hash: 'WS-TARGET',
          workspaceJson: JSON.stringify({ folder: 'file:///tmp/test-repo' }),
          composers: [{ composerId: 'C1' }, { composerId: 'C2' }],
        },
        {
          hash: 'WS-OTHER-B',
          workspaceJson: JSON.stringify({ folder: 'file:///tmp/other-b' }),
          composers: [{ composerId: 'OUT-B' }],
        },
      ],
      globalComposers: [
        { composerId: 'C1', lastUpdatedAt: 100 },
        { composerId: 'C2', lastUpdatedAt: 200 },
        { composerId: 'OUT-A', lastUpdatedAt: 99999 },
        { composerId: 'OUT-B', lastUpdatedAt: 99999 },
      ],
    });

    const resolved = resolveCursorComposerForRepoPath(
      '/tmp/test-repo',
      fixture.globalDbPath,
      fixture.workspaceStorageDir,
    );
    expect(resolved).toEqual({ workspace_id: 'WS-TARGET', composer_id: 'C2' });
  });

  it('returns null when no workspace.json folder matches the repo path', () => {
    fixture = buildFixture({
      workspaces: [
        {
          hash: 'WS-A',
          workspaceJson: JSON.stringify({ folder: 'file:///tmp/other-a' }),
          composers: [{ composerId: 'A' }],
        },
      ],
      globalComposers: [{ composerId: 'A', lastUpdatedAt: 1 }],
    });
    const resolved = resolveCursorComposerForRepoPath(
      '/tmp/no-such-repo',
      fixture.globalDbPath,
      fixture.workspaceStorageDir,
    );
    expect(resolved).toBeNull();
  });

  it('URL-decodes the workspace folder so percent-encoded paths match (R1 findings)', () => {
    fixture = buildFixture({
      workspaces: [
        {
          hash: 'WS-SPACES',
          workspaceJson: JSON.stringify({ folder: 'file:///tmp/My%20Project' }),
          composers: [{ composerId: 'SP1' }],
        },
      ],
      globalComposers: [{ composerId: 'SP1', lastUpdatedAt: 1 }],
    });
    const resolved = resolveCursorComposerForRepoPath(
      '/tmp/My Project',
      fixture.globalDbPath,
      fixture.workspaceStorageDir,
    );
    expect(resolved).toEqual({ workspace_id: 'WS-SPACES', composer_id: 'SP1' });
  });

  it('skips non-`file:` workspace.json folders (vscode-remote://, etc.)', () => {
    fixture = buildFixture({
      workspaces: [
        {
          hash: 'WS-REMOTE',
          workspaceJson: JSON.stringify({
            folder: 'vscode-remote://ssh-remote+box/tmp/test-repo',
          }),
          composers: [{ composerId: 'REMOTE-1' }],
        },
      ],
      globalComposers: [{ composerId: 'REMOTE-1', lastUpdatedAt: 1 }],
    });
    const resolved = resolveCursorComposerForRepoPath(
      '/tmp/test-repo',
      fixture.globalDbPath,
      fixture.workspaceStorageDir,
    );
    expect(resolved).toBeNull();
  });

  it('skips malformed-JSON or folder-less workspace.json entries (no crash)', () => {
    fixture = buildFixture({
      workspaces: [
        {
          hash: 'WS-BAD-JSON',
          workspaceJson: '{not valid json',
          composers: [{ composerId: 'BAD' }],
        },
        {
          hash: 'WS-NO-FOLDER',
          workspaceJson: JSON.stringify({ otherKey: 'present' }),
          composers: [{ composerId: 'NF' }],
        },
        {
          hash: 'WS-OK',
          workspaceJson: JSON.stringify({ folder: 'file:///tmp/ok' }),
          composers: [{ composerId: 'OK' }],
        },
      ],
      globalComposers: [
        { composerId: 'BAD', lastUpdatedAt: 1 },
        { composerId: 'NF', lastUpdatedAt: 1 },
        { composerId: 'OK', lastUpdatedAt: 1 },
      ],
    });
    const resolved = resolveCursorComposerForRepoPath(
      '/tmp/ok',
      fixture.globalDbPath,
      fixture.workspaceStorageDir,
    );
    expect(resolved).toEqual({ workspace_id: 'WS-OK', composer_id: 'OK' });
  });

  it('returns null when the workspace exists but allComposers[] is empty', () => {
    fixture = buildFixture({
      workspaces: [
        {
          hash: 'WS-EMPTY',
          workspaceJson: JSON.stringify({ folder: 'file:///tmp/empty-workspace' }),
          composers: [],
        },
      ],
      globalComposers: [],
    });
    const resolved = resolveCursorComposerForRepoPath(
      '/tmp/empty-workspace',
      fixture.globalDbPath,
      fixture.workspaceStorageDir,
    );
    expect(resolved).toBeNull();
  });

  it('falls back to createdAt when lastUpdatedAt is missing', () => {
    fixture = buildFixture({
      workspaces: [
        {
          hash: 'WS-FB',
          workspaceJson: JSON.stringify({ folder: 'file:///tmp/fallback' }),
          composers: [{ composerId: 'FB1' }, { composerId: 'FB2' }],
        },
      ],
      globalComposers: [
        { composerId: 'FB1', createdAt: 50 },
        { composerId: 'FB2', createdAt: 75 },
      ],
    });
    const resolved = resolveCursorComposerForRepoPath(
      '/tmp/fallback',
      fixture.globalDbPath,
      fixture.workspaceStorageDir,
    );
    expect(resolved).toEqual({ workspace_id: 'WS-FB', composer_id: 'FB2' });
  });

  it('normalises trailing slash on the input repo path', () => {
    fixture = buildFixture({
      workspaces: [
        {
          hash: 'WS-NORM',
          workspaceJson: JSON.stringify({ folder: 'file:///tmp/norm-repo' }),
          composers: [{ composerId: 'N1' }],
        },
      ],
      globalComposers: [{ composerId: 'N1', lastUpdatedAt: 1 }],
    });
    const resolved = resolveCursorComposerForRepoPath(
      '/tmp/norm-repo/',
      fixture.globalDbPath,
      fixture.workspaceStorageDir,
    );
    expect(resolved).toEqual({ workspace_id: 'WS-NORM', composer_id: 'N1' });
  });

  // 2026-05-11 fix-up: Cursor's current workspace composer registry shape
  // is `selectedComposerIds[]` + `lastFocusedComposerIds[]` with a migration
  // flag — `allComposers[]` is the legacy shape. The resolver must read both.
  // Surfaced during 035 AC6 dogfooding when Project_echo's workspace
  // (`hasMigratedMultipleComposers: true`) returned 0 composers.
  it('reads the post-migration shape (selectedComposerIds[] / lastFocusedComposerIds[])', () => {
    fixture = buildFixture({
      workspaces: [
        {
          hash: 'WS-MIGRATED',
          workspaceJson: JSON.stringify({ folder: 'file:///tmp/migrated-repo' }),
          composerDataOverride: {
            selectedComposerIds: ['MIG-1'],
            lastFocusedComposerIds: ['MIG-1'],
            hasMigratedComposerData: true,
            hasMigratedMultipleComposers: true,
          },
        },
      ],
      globalComposers: [{ composerId: 'MIG-1', lastUpdatedAt: 100 }],
    });
    const resolved = resolveCursorComposerForRepoPath(
      '/tmp/migrated-repo',
      fixture.globalDbPath,
      fixture.workspaceStorageDir,
    );
    expect(resolved).toEqual({ workspace_id: 'WS-MIGRATED', composer_id: 'MIG-1' });
  });

  it('unions allComposers[] with the migrated arrays (defense-in-depth)', () => {
    // A mid-migration workspace could theoretically expose both shapes
    // simultaneously. The resolver should treat the composer id set as a
    // union — every id from either shape is a valid candidate; the picker
    // then chooses max lastUpdatedAt across the union.
    fixture = buildFixture({
      workspaces: [
        {
          hash: 'WS-MIXED',
          workspaceJson: JSON.stringify({ folder: 'file:///tmp/mixed-repo' }),
          composerDataOverride: {
            allComposers: [{ composerId: 'LEGACY-1' }],
            selectedComposerIds: ['MIG-2'],
            lastFocusedComposerIds: ['MIG-2', 'LEGACY-1'],
          },
        },
      ],
      globalComposers: [
        { composerId: 'LEGACY-1', lastUpdatedAt: 50 },
        { composerId: 'MIG-2', lastUpdatedAt: 200 },
      ],
    });
    const resolved = resolveCursorComposerForRepoPath(
      '/tmp/mixed-repo',
      fixture.globalDbPath,
      fixture.workspaceStorageDir,
    );
    expect(resolved).toEqual({ workspace_id: 'WS-MIXED', composer_id: 'MIG-2' });
  });
});

// Item 037 / AC1 — the INVERSE direction (`workspace_id → repo_root`) needed
// by the Cursor extractor to write `metadata.repo_root` at capture time.
// Reuses the same `buildFixture` workspaceStorage layout from above.
describe('resolveRepoRootForWorkspaceId (item 037 / AC1)', () => {
  let fixture: Fixture | undefined;

  afterEach(() => {
    fixture?.cleanup();
    fixture = undefined;
  });

  it('returns the absolute folder path for a workspace_id with a valid file:// folder URI', () => {
    fixture = buildFixture({
      workspaces: [
        {
          hash: 'WS-TARGET',
          workspaceJson: JSON.stringify({ folder: 'file:///tmp/echo-test-repo' }),
          composers: [{ composerId: 'C1' }],
        },
      ],
      globalComposers: [{ composerId: 'C1', lastUpdatedAt: 1 }],
    });
    const resolved = resolveRepoRootForWorkspaceId('WS-TARGET', fixture.workspaceStorageDir);
    expect(resolved).toBe('/tmp/echo-test-repo');
  });

  it('URL-decodes percent-encoded folder paths (parity with the forward direction)', () => {
    fixture = buildFixture({
      workspaces: [
        {
          hash: 'WS-SPACES',
          workspaceJson: JSON.stringify({ folder: 'file:///tmp/My%20Project' }),
          composers: [{ composerId: 'SP1' }],
        },
      ],
      globalComposers: [{ composerId: 'SP1', lastUpdatedAt: 1 }],
    });
    expect(resolveRepoRootForWorkspaceId('WS-SPACES', fixture.workspaceStorageDir)).toBe(
      '/tmp/My Project',
    );
  });

  it('returns null when the workspace_id has no workspace.json on disk', () => {
    fixture = buildFixture({
      workspaces: [
        {
          hash: 'WS-A',
          workspaceJson: JSON.stringify({ folder: 'file:///tmp/A' }),
          composers: [{ composerId: 'A' }],
        },
      ],
      globalComposers: [{ composerId: 'A', lastUpdatedAt: 1 }],
    });
    expect(resolveRepoRootForWorkspaceId('WS-NONEXISTENT', fixture.workspaceStorageDir)).toBeNull();
  });

  it('returns null when workspace.json has no folder field', () => {
    fixture = buildFixture({
      workspaces: [
        {
          hash: 'WS-NO-FOLDER',
          workspaceJson: JSON.stringify({ otherField: 1 }),
          composers: [{ composerId: 'A' }],
        },
      ],
      globalComposers: [{ composerId: 'A', lastUpdatedAt: 1 }],
    });
    expect(resolveRepoRootForWorkspaceId('WS-NO-FOLDER', fixture.workspaceStorageDir)).toBeNull();
  });

  it('returns null when folder is non-file:// (remote workspace)', () => {
    fixture = buildFixture({
      workspaces: [
        {
          hash: 'WS-REMOTE',
          workspaceJson: JSON.stringify({ folder: 'vscode-remote://ssh-remote+host/x' }),
          composers: [{ composerId: 'A' }],
        },
      ],
      globalComposers: [{ composerId: 'A', lastUpdatedAt: 1 }],
    });
    expect(resolveRepoRootForWorkspaceId('WS-REMOTE', fixture.workspaceStorageDir)).toBeNull();
  });

  it('strips the trailing slash so the result matches `metadata.repo_root` shape', () => {
    fixture = buildFixture({
      workspaces: [
        {
          hash: 'WS-TRAILING',
          // workspace.json writers occasionally include a trailing slash; the
          // resolver normalises so retrieval-side path-equality holds.
          workspaceJson: JSON.stringify({ folder: 'file:///tmp/trailing-repo/' }),
          composers: [{ composerId: 'T1' }],
        },
      ],
      globalComposers: [{ composerId: 'T1', lastUpdatedAt: 1 }],
    });
    expect(resolveRepoRootForWorkspaceId('WS-TRAILING', fixture.workspaceStorageDir)).toBe(
      '/tmp/trailing-repo',
    );
  });
});

// Item 037 / AC6 (R2 normalization): `normaliseRepoPath` is the shared
// helper used by all four retrieval tools and the extractor. The forward
// resolver already relies on it (since its first ship); the export is new.
describe('normaliseRepoPath (item 037 export)', () => {
  it('strips a single trailing slash', () => {
    expect(normaliseRepoPath('/Users/zhenye/Desktop/Project_echo/')).toBe(
      '/Users/zhenye/Desktop/Project_echo',
    );
  });

  it('is a no-op for paths without a trailing slash', () => {
    expect(normaliseRepoPath('/Users/zhenye/Desktop/Project_echo')).toBe(
      '/Users/zhenye/Desktop/Project_echo',
    );
  });

  it('preserves the root "/" (does not strip it to empty)', () => {
    expect(normaliseRepoPath('/')).toBe('/');
  });
});
