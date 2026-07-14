import { describe, expect, it } from 'vitest';
import { fileArtifact, workspaceArtifact } from '../../src/normalize/artifacts.js';
import { normalizeEvent } from '../../src/normalize/index.js';
import type { NormalizedContextEvent } from '../../src/normalize/types.js';
import type { CaptureEvent } from '../../src/storage/interface.js';
import { artifactKey, buildGraph, connectedComponents } from '../../src/trace/cluster.js';

const ROOT = '/Users/dev/workspace-demo';
const SUBDIR = `${ROOT}/packages/app`;
const REMOTE = 'https://github.com/example/workspace-demo.git';
const GIT_ALIAS = 'https://github.com/example/workspace-demo';
const WORKSPACE_KEY = `local:workspace:${ROOT}`;
const WORKSPACE_ID = `workspace:${ROOT}`;
const SHA = '3aba18ae4163490fb3fdeba9fed60f35c0afd1f5';

function normalize(event: CaptureEvent): NormalizedContextEvent {
  const out = normalizeEvent(event);
  if (out === null) throw new Error(`expected ${event.source} to normalize`);
  return out;
}

function workspaceKey(event: NormalizedContextEvent): string {
  const workspace = event.artifacts.find((a) => a.type === 'workspace');
  if (workspace === undefined) throw new Error(`missing workspace artifact for ${event.id}`);
  return artifactKey(workspace);
}

function artifactIds(event: NormalizedContextEvent): string[] {
  return event.artifacts.map((a) => a.id);
}

function expectOneCluster(events: NormalizedContextEvent[]): void {
  const clusters = connectedComponents(buildGraph(events));
  expect(clusters).toHaveLength(1);
  expect(new Set(clusters[0]?.atom_ids)).toEqual(new Set(events.map((e) => e.id)));
}

function claudeCodeEvent(opts: {
  id: string;
  repoRoot: string;
  canonicalRoot: string;
  originUrl?: string;
  files?: string[];
}): CaptureEvent {
  const gitState: Record<string, unknown> = {
    head_sha: SHA,
    captured_at: '2026-06-07T18:00:01.000Z',
    branch: 'main',
    fresh: true,
  };
  if (opts.originUrl !== undefined) gitState['origin_url'] = opts.originUrl;
  return {
    id: opts.id,
    source:
      'fs:/Users/dev/.claude/projects/-Users-dev-workspace-demo/4e273691-aaaa-bbbb-cccc-ddddeeeeffff.jsonl',
    timestamp: '2026-06-07T18:00:00.000Z',
    content: 'USER: inspect the workspace\n\nASSISTANT: done',
    metadata: {
      session_id: '4e273691-aaaa-bbbb-cccc-ddddeeeeffff',
      turn_index: 1,
      repo_root: opts.repoRoot,
      canonical_root: opts.canonicalRoot,
      files_referenced: opts.files ?? [`${opts.canonicalRoot}/src/reader.ts`],
      git_state: gitState,
    },
  };
}

function codexEvent(opts: {
  id: string;
  cwd: string;
  canonicalRoot: string;
  originUrl?: string;
  files?: string[];
}): CaptureEvent {
  const git: Record<string, unknown> = { sha: SHA, branch: 'main' };
  if (opts.originUrl !== undefined) git['origin_url'] = opts.originUrl;
  return {
    id: opts.id,
    source:
      'fs:/Users/dev/.codex/sessions/2026/06/07/rollout-2026-06-07T18-00-00-019dff39-1891-74a1-aaaa-bbbbccccdddd.jsonl',
    timestamp: '2026-06-07T18:00:05.000Z',
    content: 'USER: edit the workspace\n\nASSISTANT: done',
    metadata: {
      session_id: '019dff39-1891-74a1-aaaa-bbbbccccdddd',
      turn_index: 2,
      cwd: opts.cwd,
      repo_root: opts.cwd,
      canonical_root: opts.canonicalRoot,
      files_referenced: opts.files ?? [`${opts.canonicalRoot}/src/reader.ts`],
      git,
    },
  };
}

function gitEvent(opts: {
  id: string;
  repoRoot: string;
  canonicalRoot: string;
  originUrl?: string;
  files?: string[];
}): CaptureEvent {
  const metadata: Record<string, unknown> = {
    sha: SHA,
    author: 'Dev',
    repo_root: opts.repoRoot,
    canonical_root: opts.canonicalRoot,
    parent_sha: '92d3b7e41dde9a28e34df241c1ace7614c906df7',
    branch: 'main',
    files_referenced: opts.files ?? [`${opts.canonicalRoot}/src/reader.ts`],
  };
  if (opts.originUrl !== undefined) metadata['origin_url'] = opts.originUrl;
  return {
    id: opts.id,
    source: `git:${opts.repoRoot}`,
    timestamp: '2026-06-07T18:00:10.000Z',
    content:
      'COMMIT 3aba18a: update reader\n\nUpdate reader.\n\n--- DIFF ---\ndiff --git a/src/reader.ts b/src/reader.ts\n+++ b/src/reader.ts\n@@\n+export const reader = true;',
    metadata,
  };
}

describe('workspace identity normalization', () => {
  it('workspaceArtifact has the exact local workspace join tuple', () => {
    const artifact = workspaceArtifact(ROOT);
    expect(artifact).toMatchObject({
      provider: 'local',
      type: 'workspace',
      id: ROOT,
      locator: ROOT,
    });
    expect(artifactKey(artifact)).toBe(WORKSPACE_KEY);
  });

  it('joins pre-git-init and post-git-init atoms on the exact workspace key', () => {
    const before = normalize(
      claudeCodeEvent({
        id: 'evt_before_git_init',
        repoRoot: ROOT,
        canonicalRoot: ROOT,
      }),
    );
    const after = normalize(
      codexEvent({
        id: 'evt_after_git_init',
        cwd: ROOT,
        canonicalRoot: ROOT,
        originUrl: REMOTE,
      }),
    );

    expect([workspaceKey(before), workspaceKey(after)]).toEqual([WORKSPACE_KEY, WORKSPACE_KEY]);
    expectOneCluster([before, after]);
  });

  it('joins two tools in the same non-git folder on the exact workspace key', () => {
    const claude = normalize(
      claudeCodeEvent({
        id: 'evt_non_git_claude',
        repoRoot: ROOT,
        canonicalRoot: ROOT,
      }),
    );
    const codex = normalize(
      codexEvent({
        id: 'evt_non_git_codex',
        cwd: ROOT,
        canonicalRoot: ROOT,
      }),
    );

    expect([workspaceKey(claude), workspaceKey(codex)]).toEqual([WORKSPACE_KEY, WORKSPACE_KEY]);
    expectOneCluster([claude, codex]);
  });

  it('joins a subdir-launched tool with a root commit on the exact workspace key', () => {
    const codex = normalize(
      codexEvent({
        id: 'evt_subdir_codex',
        cwd: SUBDIR,
        canonicalRoot: ROOT,
        originUrl: REMOTE,
      }),
    );
    const git = normalize(
      gitEvent({
        id: 'evt_subdir_git',
        repoRoot: ROOT,
        canonicalRoot: ROOT,
        originUrl: REMOTE,
      }),
    );

    expect([workspaceKey(codex), workspaceKey(git)]).toEqual([WORKSPACE_KEY, WORKSPACE_KEY]);
    expectOneCluster([codex, git]);
  });

  it('keeps remote-backed claude_code, codex, and git joined on workspace while git_alias carries the remote', () => {
    const claude = normalize(
      claudeCodeEvent({
        id: 'evt_remote_claude',
        repoRoot: ROOT,
        canonicalRoot: ROOT,
        originUrl: REMOTE,
      }),
    );
    const codex = normalize(
      codexEvent({
        id: 'evt_remote_codex',
        cwd: ROOT,
        canonicalRoot: ROOT,
        originUrl: REMOTE,
      }),
    );
    const git = normalize(
      gitEvent({
        id: 'evt_remote_git',
        repoRoot: ROOT,
        canonicalRoot: ROOT,
        originUrl: REMOTE,
      }),
    );

    for (const event of [claude, codex, git]) {
      expect(workspaceKey(event)).toBe(WORKSPACE_KEY);
      expect(event.context?.ambient?.git_alias).toBe(GIT_ALIAS);
      expect(event.artifacts.some((a) => a.type === 'repo')).toBe(false);
      expect(event.artifacts.map(artifactKey)).not.toContain(`github:repo:${GIT_ALIAS}`);
    }
    expect(artifactIds(git)).toContain(`${WORKSPACE_ID}::${SHA}`);
    expect(artifactIds(git)).toContain(`${WORKSPACE_ID}::main`);
    expectOneCluster([claude, codex, git]);
  });

  it('keys files on workspace id and falls back to abs ids for outside-root paths', () => {
    const event = normalize(
      claudeCodeEvent({
        id: 'evt_files',
        repoRoot: ROOT,
        canonicalRoot: ROOT,
        files: [`${ROOT}/src/reader.ts`, '/tmp/outside.md', `${ROOT}/../outside-via-dotdot.md`],
      }),
    );

    const ids = artifactIds(event);
    expect(ids).toContain(`${WORKSPACE_ID}::src/reader.ts`);
    expect(ids).toContain('abs:/tmp/outside.md');
    expect(ids).toContain('abs:/Users/dev/outside-via-dotdot.md');
    expect(ids.some((id) => id.startsWith(`${WORKSPACE_ID}::..`))).toBe(false);
  });

  it('keeps fileArtifact(null, path) backward-compatible for parked Cursor calls', () => {
    expect(fileArtifact(null, '/tmp/scratch.md')).toMatchObject({
      provider: 'local_fs',
      type: 'file',
      id: 'abs:/tmp/scratch.md',
      locator: '/tmp/scratch.md',
    });
  });
});
