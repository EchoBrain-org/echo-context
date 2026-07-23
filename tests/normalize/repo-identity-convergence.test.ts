import { describe, expect, it } from 'vitest';
import { normalizeEvent } from '../../src/context-adapters/normalization.js';
import type { NormalizedContextEvent } from '../../src/normalize/types.js';
import type { CaptureEvent } from '../../src/storage/interface.js';
import { buildGraph, connectedComponents } from '../../src/trace/cluster.js';

const REMOTE = 'https://github.com/example/demo-repo.git';
const CANONICAL_REPO_ID = 'https://github.com/example/demo-repo';
const POSIX_ROOT = '/Users/dev/Desktop/demo-repo';

function normalize(event: CaptureEvent): NormalizedContextEvent {
  const out = normalizeEvent(event);
  if (out === null) throw new Error(`expected ${event.source} to normalize`);
  return out;
}

function repoId(event: NormalizedContextEvent): string {
  const repo = event.artifacts.find((a) => a.type === 'repo');
  if (repo === undefined) throw new Error(`missing repo artifact for ${event.id}`);
  return repo.id;
}

function eventIds(event: NormalizedContextEvent): string[] {
  return event.artifacts.map((a) => a.id);
}

function claudeCodeEvent(root: string, originUrl: string | undefined): CaptureEvent {
  const gitState: Record<string, unknown> = {
    head_sha: '3aba18ae4163490fb3fdeba9fed60f35c0afd1f5',
    captured_at: '2026-06-06T18:00:01.000Z',
    branch: 'main',
    dirty_count: 0,
    fresh: true,
  };
  if (originUrl !== undefined) gitState['origin_url'] = originUrl;
  return {
    id: `evt_cc_${root}`,
    source:
      'fs:/Users/dev/.claude/projects/-Users-dev-Desktop-demo-repo/4e273691-aaaa-bbbb-cccc-ddddeeeeffff.jsonl',
    timestamp: '2026-06-06T18:00:00.000Z',
    content: 'USER: inspect src/reader.ts\n\nASSISTANT: done',
    metadata: {
      session_id: '4e273691-aaaa-bbbb-cccc-ddddeeeeffff',
      turn_index: 1,
      repo_root: root,
      files_referenced: [`${root}/src/reader.ts`],
      git_state: gitState,
    },
  };
}

function codexEvent(root: string): CaptureEvent {
  return {
    id: 'evt_codex_remote',
    source:
      'fs:/Users/dev/.codex/sessions/2026/06/06/rollout-2026-06-06T18-00-00-019dff39-1891-74a1-aaaa-bbbbccccdddd.jsonl',
    timestamp: '2026-06-06T18:00:05.000Z',
    content: 'USER: edit src/reader.ts\n\nASSISTANT: done',
    metadata: {
      session_id: '019dff39-1891-74a1-aaaa-bbbbccccdddd',
      turn_index: 2,
      cwd: root,
      repo_root: root,
      files_referenced: [`${root}/src/reader.ts`],
      git: {
        sha: 'b72be9555594790fc4289cdcfa70a7542851071c',
        branch: 'main',
        origin_url: REMOTE,
      },
    },
  };
}

function gitEvent(root: string, originUrl: string | undefined): CaptureEvent {
  const metadata: Record<string, unknown> = {
    sha: '3aba18ae4163490fb3fdeba9fed60f35c0afd1f5',
    author: 'Dev',
    repo_root: root,
    parent_sha: '92d3b7e41dde9a28e34df241c1ace7614c906df7',
    branch: 'main',
    files_referenced: [`${root}/src/reader.ts`],
  };
  if (originUrl !== undefined) metadata['origin_url'] = originUrl;
  return {
    id: `evt_git_${root}`,
    source: `git:${root}`,
    timestamp: '2026-06-06T18:00:10.000Z',
    content:
      'COMMIT 3aba18a: update reader\n\nUpdate reader.\n\n--- DIFF ---\ndiff --git a/src/reader.ts b/src/reader.ts\n+++ b/src/reader.ts\n@@\n+export const reader = true;',
    metadata,
  };
}

describe('repo identity convergence', () => {
  it('normalizes one remote-backed repo id without collapsing explicit coding roots', () => {
    const claude = normalize(claudeCodeEvent(POSIX_ROOT, REMOTE));
    const codex = normalize(codexEvent(POSIX_ROOT));
    const git = normalize(gitEvent(POSIX_ROOT, REMOTE));

    expect([repoId(claude), repoId(codex), repoId(git)]).toEqual([
      CANONICAL_REPO_ID,
      CANONICAL_REPO_ID,
      CANONICAL_REPO_ID,
    ]);
    for (const event of [claude, codex, git]) {
      expect(eventIds(event)).toContain(`${CANONICAL_REPO_ID}::src/reader.ts`);
    }
    expect(eventIds(git)).toContain(
      `${CANONICAL_REPO_ID}::3aba18ae4163490fb3fdeba9fed60f35c0afd1f5`,
    );

    const clusters = connectedComponents(buildGraph([claude, codex, git]));
    expect(clusters).toHaveLength(2);
    expect(clusters.map((cluster) => new Set(cluster.atom_ids))).toEqual(
      expect.arrayContaining([
        new Set([claude.id]),
        new Set([codex.id, git.id]),
      ]),
    );
  });

  it('keeps remote-backed repo identity independent of local checkout path', () => {
    const posix = normalize(claudeCodeEvent('/Users/dev/Desktop/demo-repo', REMOTE));
    const windows = normalize(claudeCodeEvent(String.raw`C:\Users\dev\demo-repo`, REMOTE));

    expect(repoId(posix)).toBe(CANONICAL_REPO_ID);
    expect(repoId(windows)).toBe(CANONICAL_REPO_ID);
    expect(posix.artifacts.find((a) => a.type === 'repo')?.locator).not.toBe(
      windows.artifacts.find((a) => a.type === 'repo')?.locator,
    );
  });

  it('preserves local fallback for remote-less repos', () => {
    const claude = normalize(claudeCodeEvent(POSIX_ROOT, undefined));
    const git = normalize(gitEvent(POSIX_ROOT, undefined));

    expect(repoId(claude)).toBe(`local:${POSIX_ROOT}`);
    expect(repoId(git)).toBe(`local:${POSIX_ROOT}`);
    expect(eventIds(claude)).toContain(`local:${POSIX_ROOT}::src/reader.ts`);
    expect(eventIds(git)).toContain(`local:${POSIX_ROOT}::src/reader.ts`);
  });
});
