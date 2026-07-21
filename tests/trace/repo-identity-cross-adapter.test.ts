// Held-out verification tests — R1: cross-adapter repo identity split.
//
// CONTRACT under test (independent oracle; written blind to any fix):
// For a SINGLE checkout that has a shared git remote, every repo-bearing
// source (claude_code, codex, git) must resolve the repo to the SAME canonical
// identity — the normalized remote URL — so that:
//   (1) atoms from different tools about the same repo, within one cluster
//       window, join into ONE connected component (membership, not a visible
//       edge — the repo artifact is scope-role and filtered from visible edges);
//   (2) derived file artifacts for the same relative path across tools share
//       the same canonical repo-id prefix (artifact-key equality);
//   (3) the identity is MACHINE-INDEPENDENT: same remote, different local path
//       / OS (POSIX vs Windows) still resolves to the same repo id and joins.
//
// Boundaries (deliberately NOT asserted as failures): a repo with NO remote
// may fall back to a local, same-machine-only identity.
//
// These tests drive the REAL normalize + cluster path. They are expected to be
// RED on current main, where codex emits the remote-URL identity while
// claude_code and git fall back to a local-path identity for the same checkout.

import { describe, expect, it } from 'vitest';
import {
  artifactKey,
  buildGraph,
  connectedComponents,
} from '../../src/trace/cluster.js';
import { normalizeRemoteUrl } from '../../src/normalize/artifacts.js';
import { normalizeEvents } from '../../src/context-adapters/normalization.js';
import type { ArtifactRef, NormalizedContextEvent } from '../../src/normalize/types.js';
import type { CaptureEvent } from '../../src/storage/interface.js';

// ---------------------------------------------------------------------------
// One checkout, one shared remote, three tools, one tight time window.
// ---------------------------------------------------------------------------

const SHARED_REMOTE = 'https://github.com/example/demo-repo.git';
const POSIX_ROOT = '/Users/dev/Desktop/demo-repo';
const SHARED_REL = 'src/reader.ts';
const POSIX_FILE = `${POSIX_ROOT}/${SHARED_REL}`;

// The window is small; all three timestamps fall inside the default 4h window.
const T_CC = '2026-05-07T06:03:42.830Z';
const T_CODEX = '2026-05-07T06:05:03.649Z';
const T_GIT = '2026-05-07T06:07:12.000Z';

// A claude_code turn for the checkout. The remote is supplied via several
// plausible metadata locations so the assertion targets the CONTRACT (same
// canonical id) rather than one specific field-plumbing choice. The brief
// notes the adapter already reads metadata.git_state.origin_url.
function claudeCodeEvent(overrides: Partial<CaptureEvent> = {}): CaptureEvent {
  return {
    id: 'evt_cc_repoid',
    source:
      'fs:/Users/dev/.claude/projects/-Users-dev-Desktop-demo-repo/aaaa-bbbb.jsonl',
    timestamp: T_CC,
    content:
      'USER: where does the reader live?\n\nASSISTANT: src/reader.ts holds the reader.',
    metadata: {
      session_id: 'cc-session-1',
      turn_index: 3,
      had_tool_use: true,
      repo_root: POSIX_ROOT,
      files_referenced: [POSIX_FILE],
      branch: 'main',
      origin_url: SHARED_REMOTE,
      git: { origin_url: SHARED_REMOTE, branch: 'main' },
      git_state: {
        head_sha: '3aba18ae4163490fb3fdeba9fed60f35c0afd1f5',
        captured_at: T_CC,
        branch: 'main',
        dirty_count: 0,
        fresh: true,
        origin_url: SHARED_REMOTE,
      },
    },
    ...overrides,
  };
}

// A codex turn for the same checkout. Codex already carries the remote under
// metadata.git.origin_url (today's behaviour) — this anchor establishes the
// canonical identity the others must match.
function codexEvent(overrides: Partial<CaptureEvent> = {}): CaptureEvent {
  return {
    id: 'evt_codex_repoid',
    source:
      'fs:/Users/dev/.codex/sessions/2026/05/07/rollout-2026-05-07T06-05-03-zzzz.jsonl',
    timestamp: T_CODEX,
    content:
      'USER: stream the reader\n\nASSISTANT: Done — src/reader.ts now streams.',
    metadata: {
      session_id: 'codex-session-1',
      turn_index: 7,
      cwd: POSIX_ROOT,
      repo_root: POSIX_ROOT,
      had_tool_use: true,
      files_referenced: [POSIX_FILE],
      git: {
        sha: 'b72be9555594790fc4289cdcfa70a7542851071c',
        branch: 'main',
        origin_url: SHARED_REMOTE,
      },
      codex: { source: 'cli', cli_version: '0.128.0', model_provider: 'openai', model: 'gpt-5.5' },
    },
    ...overrides,
  };
}

// A git commit on the same checkout. The remote is supplied under several
// plausible metadata keys so the contract (same canonical id) is what's tested,
// not the specific field a fix chooses to read.
function gitEvent(overrides: Partial<CaptureEvent> = {}): CaptureEvent {
  return {
    id: 'evt_git_repoid',
    source: `git:${POSIX_ROOT}`,
    timestamp: T_GIT,
    content:
      'COMMIT 3aba18a: refactor reader\n\nExtract reader.\n\n--- DIFF ---\ndiff --git a/src/reader.ts b/src/reader.ts\n@@\n+export function read(p){return p;}',
    metadata: {
      sha: '3aba18ae4163490fb3fdeba9fed60f35c0afd1f5',
      author: 'Dev',
      files_changed: 1,
      additions: 1,
      deletions: 0,
      repo_root: POSIX_ROOT,
      branch: 'main',
      files_referenced: [POSIX_FILE],
      origin_url: SHARED_REMOTE,
      remote_url: SHARED_REMOTE,
      git: { origin_url: SHARED_REMOTE },
      git_state: { origin_url: SHARED_REMOTE, captured_at: T_GIT, fresh: true },
    },
    ...overrides,
  };
}

function repoArtifactOf(atom: NormalizedContextEvent): ArtifactRef {
  const repo = atom.artifacts.find((a) => a.type === 'repo');
  if (repo === undefined) {
    throw new Error(`atom ${atom.id} has no repo artifact`);
  }
  return repo;
}

function fileArtifactsOf(atom: NormalizedContextEvent): ArtifactRef[] {
  return atom.artifacts.filter((a) => a.type === 'file');
}

// The canonical repo id every source must agree on for a remote-bearing repo.
const CANONICAL_REPO_ID = normalizeRemoteUrl(SHARED_REMOTE);

describe('R1 — cross-adapter repo identity (shared remote → one identity)', () => {
  it('all three sources resolve the same checkout to the SAME canonical repo id', () => {
    const atoms = normalizeEvents([claudeCodeEvent(), codexEvent(), gitEvent()]);
    expect(atoms).toHaveLength(3);

    const repoIds = atoms.map((a) => repoArtifactOf(a).id);
    // All equal to one another...
    expect(new Set(repoIds).size).toBe(1);
    // ...and equal to the normalized-remote canonical identity.
    for (const id of repoIds) {
      expect(id).toBe(CANONICAL_REPO_ID);
    }
  });

  it('the three atoms join into ONE connected component (cluster membership)', () => {
    const atoms = normalizeEvents([claudeCodeEvent(), codexEvent(), gitEvent()]);
    const graph = buildGraph(atoms, 4);
    const components = connectedComponents(graph);

    expect(components).toHaveLength(1);
    expect(new Set(components[0]!.atom_ids)).toEqual(
      new Set(['evt_cc_repoid', 'evt_codex_repoid', 'evt_git_repoid']),
    );
  });

  it('derived file artifacts for the same relative path share one repo-id prefix across tools', () => {
    const atoms = normalizeEvents([claudeCodeEvent(), codexEvent(), gitEvent()]);

    // Collect the artifact key of the shared file from each repo-bearing source.
    const fileKeys = atoms.map((atom) => {
      const files = fileArtifactsOf(atom);
      const match = files.find((f) => f.label === SHARED_REL || f.id.endsWith(`::${SHARED_REL}`));
      if (match === undefined) {
        throw new Error(`atom ${atom.id} has no file artifact for ${SHARED_REL}`);
      }
      return artifactKey(match);
    });

    // The same relative path under the same repo must produce one identical key.
    expect(new Set(fileKeys).size).toBe(1);
    // And that key must be repo-scoped on the canonical repo id, not an
    // absolute-path fallback.
    expect(fileKeys[0]).toContain(`${CANONICAL_REPO_ID}::${SHARED_REL}`);
  });

  it('machine independence: same remote, different local roots / OS still resolve to one identity and join', () => {
    // Same remote, but the three sessions live on different checkouts: a POSIX
    // path and a Windows path. Identity must follow the REMOTE, not the local
    // path, so all atoms resolve to the same repo id and land in one component.
    const WINDOWS_ROOT = 'C:\\Users\\other\\repos\\demo-repo';
    const WINDOWS_FILE = `${WINDOWS_ROOT}\\src\\reader.ts`;

    // claude_code + git on the POSIX machine; codex on the Windows machine.
    const cc = claudeCodeEvent();
    const git = gitEvent();
    const codexOtherMachine = codexEvent({
      id: 'evt_codex_windows',
      metadata: {
        session_id: 'codex-session-win',
        turn_index: 2,
        cwd: WINDOWS_ROOT,
        repo_root: WINDOWS_ROOT,
        had_tool_use: true,
        files_referenced: [WINDOWS_FILE],
        git: { branch: 'main', origin_url: SHARED_REMOTE },
        codex: { source: 'cli', model_provider: 'openai', model: 'gpt-5.5' },
      },
    });

    const atoms = normalizeEvents([cc, git, codexOtherMachine]);
    expect(atoms).toHaveLength(3);

    // Same canonical repo id despite different local roots / OS.
    const ids = atoms.map((a) => repoArtifactOf(a).id);
    expect(new Set(ids)).toEqual(new Set([CANONICAL_REPO_ID]));

    // And they still cluster together into one component.
    const components = connectedComponents(buildGraph(atoms, 4));
    expect(components).toHaveLength(1);
    expect(new Set(components[0]!.atom_ids)).toEqual(
      new Set(['evt_cc_repoid', 'evt_git_repoid', 'evt_codex_windows']),
    );
  });
});
