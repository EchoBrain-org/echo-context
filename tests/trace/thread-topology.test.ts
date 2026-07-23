import { describe, expect, it } from 'vitest';
import { buildGraph, connectedComponents } from '../../src/trace/cluster.js';
import { makeAtom } from './fixtures/atoms.js';

const PROJECT_A = { key: 'local:workspace:/repo-a', canonical_root: '/repo-a' };
const PROJECT_B = { key: 'local:workspace:/repo-b', canonical_root: '/repo-b' };

function threadAtom(input: {
  id: string;
  time: string;
  root?: string;
  thread?: string;
  parent?: string;
  project?: typeof PROJECT_A;
  artifact?: { provider: string; type: string; id: string };
  artifacts?: { provider: string; type: string; id: string }[];
  app?: string;
  provider?: string;
}) {
  return makeAtom({
    id: input.id,
    app: input.app ?? 'codex',
    occurred_at: input.time,
    project: input.project ?? PROJECT_A,
    artifacts: input.artifacts ?? (input.artifact === undefined ? [] : [input.artifact]),
    ...(input.root !== undefined
      ? {
          conversation: {
            provider: input.provider ?? 'codex',
            session_id: input.thread ?? input.root,
            thread_id: input.thread ?? input.root,
            root_thread_id: input.root,
            ...(input.parent !== undefined ? { parent_thread_id: input.parent } : {}),
            thread_kind: input.thread === undefined || input.thread === input.root
              ? ('root' as const)
              : ('subagent' as const),
          },
        }
      : {}),
  });
}

describe('thread topology', () => {
  it('groups root and descendant-agent work by explicit root lineage', () => {
    const graph = buildGraph([
      threadAtom({ id: 'root', time: '2026-07-22T18:00:00Z', root: 'r1' }),
      threadAtom({
        id: 'child',
        time: '2026-07-22T18:05:00Z',
        root: 'r1',
        thread: 'c1',
        parent: 'r1',
      }),
      threadAtom({
        id: 'grandchild',
        time: '2026-07-22T18:10:00Z',
        root: 'r1',
        thread: 'c2',
        parent: 'c1',
      }),
    ]);
    expect(connectedComponents(graph)).toHaveLength(1);
    expect(graph.edges).toHaveLength(2);
  });

  it('orders mixed-offset clocks by instant before building adjacency', () => {
    const graph = buildGraph(
      [
        threadAtom({
          id: 'fifteen-z',
          time: '2026-07-22T20:00:00+05:00',
          root: 'r1',
        }),
        threadAtom({
          id: 'seventeen-z',
          time: '2026-07-22T10:00:00-07:00',
          root: 'r1',
        }),
        threadAtom({
          id: 'nineteen-z',
          time: '2026-07-22T19:00:00Z',
          root: 'r1',
        }),
      ],
      3,
    );

    expect(connectedComponents(graph)).toHaveLength(1);
    expect(graph.edges).toHaveLength(2);
  });

  it('does not leak synthetic lineage keys into shared-artifact evidence', () => {
    const file = { provider: 'local_fs', type: 'file', id: 'same.ts' };
    const graph = buildGraph([
      threadAtom({ id: 'a', time: '2026-07-22T18:00:00Z', root: 'r1', artifact: file }),
      threadAtom({ id: 'b', time: '2026-07-22T18:01:00Z', root: 'r1', artifact: file }),
    ]);

    expect(graph.edges).toHaveLength(1);
    expect(graph.edges[0]!.artifact_ids).toEqual(['local_fs:file:same.ts']);
  });

  it('keeps legacy turns grouped by provider-scoped session identity', () => {
    const legacy = (id: string, provider: string, session: string, minute: string) =>
      makeAtom({
        id,
        app: provider,
        occurred_at: `2026-07-22T18:${minute}:00Z`,
        project: PROJECT_A,
        artifacts: [],
        conversation: { provider, session_id: session },
      });
    const components = connectedComponents(
      buildGraph([
        legacy('a1', 'codex', 'legacy-a', '00'),
        legacy('a2', 'codex', 'legacy-a', '01'),
        legacy('b1', 'codex', 'legacy-b', '02'),
      ]),
    );
    expect(components).toHaveLength(2);
    expect(components.find((component) => component.atom_ids.includes('a1'))!.atom_ids).toEqual([
      'a1',
      'a2',
    ]);
  });

  it('does not merge identical opaque root ids across providers', () => {
    const components = connectedComponents(
      buildGraph([
        threadAtom({
          id: 'codex-root',
          time: '2026-07-22T18:00:00Z',
          root: 'same-id',
          provider: 'codex',
        }),
        threadAtom({
          id: 'claude-root',
          time: '2026-07-22T18:01:00Z',
          root: 'same-id',
          provider: 'claude_code',
          app: 'claude_code',
        }),
      ]),
    );
    expect(components).toHaveLength(2);
  });

  it('does not merge distinct roots that touch the same weak file', () => {
    const file = { provider: 'local_fs', type: 'file', id: 'shared.ts' };
    const components = connectedComponents(
      buildGraph([
        threadAtom({ id: 'a', time: '2026-07-22T18:00:00Z', root: 'r1', artifact: file }),
        threadAtom({ id: 'b', time: '2026-07-22T18:01:00Z', root: 'r2', artifact: file }),
      ]),
    );
    expect(components).toHaveLength(2);
  });

  it('allows a strong task artifact to intentionally join roots', () => {
    const task = { provider: 'linear', type: 'task', id: 'ENG-42' };
    const components = connectedComponents(
      buildGraph([
        threadAtom({ id: 'a', time: '2026-07-22T18:00:00Z', root: 'r1', artifact: task }),
        threadAtom({ id: 'b', time: '2026-07-22T18:01:00Z', root: 'r2', artifact: task }),
      ]),
    );
    expect(components).toHaveLength(1);
  });

  it('never joins matching artifacts across canonical projects', () => {
    const task = { provider: 'linear', type: 'task', id: 'ENG-42' };
    const components = connectedComponents(
      buildGraph([
        threadAtom({ id: 'a', time: '2026-07-22T18:00:00Z', root: 'r1', artifact: task }),
        threadAtom({
          id: 'b',
          time: '2026-07-22T18:01:00Z',
          root: 'r1',
          artifact: task,
          project: PROJECT_B,
        }),
      ]),
    );
    expect(components).toHaveLength(2);
  });

  it('does not recover a rejected project identity from scope artifacts', () => {
    const workspace = { provider: 'local', type: 'workspace', id: '/repo-a' };
    const file = { provider: 'local_fs', type: 'file', id: 'workspace:/repo-a::same.ts' };
    const conversation = {
      provider: 'codex',
      session_id: 'shared-session',
      thread_id: 'shared-session',
      root_thread_id: 'shared-session',
      thread_kind: 'root' as const,
    };
    const valid = makeAtom({
      id: 'valid-project',
      app: 'codex',
      occurred_at: '2026-07-22T18:00:00Z',
      project: PROJECT_A,
      artifacts: [workspace, file],
      conversation,
    });
    // This is the normalized shape produced when an authoritative project_key
    // was explicitly present but malformed: project is absent, while capture
    // evidence may still retain workspace/file artifacts for observability.
    const malformed = makeAtom({
      id: 'malformed-project',
      app: 'codex',
      occurred_at: '2026-07-22T18:01:00Z',
      artifacts: [workspace, file],
      conversation,
    });

    expect(connectedComponents(buildGraph([valid, malformed]))).toHaveLength(2);
  });

  it('attaches unlineaged git work to the nearest eligible root', () => {
    const file = { provider: 'local_fs', type: 'file', id: 'shared.ts' };
    const components = connectedComponents(
      buildGraph([
        threadAtom({ id: 'root-a', time: '2026-07-22T18:00:00Z', root: 'r1', artifact: file }),
        threadAtom({
          id: 'git',
          time: '2026-07-22T18:02:00Z',
          artifact: file,
          app: 'git',
        }),
        threadAtom({ id: 'root-b', time: '2026-07-22T18:20:00Z', root: 'r2', artifact: file }),
      ]),
    );
    expect(components).toHaveLength(2);
    expect(components.find((component) => component.atom_ids.includes('git'))!.atom_ids).toEqual([
      'git',
      'root-a',
    ]);
  });

  it('does not let a shared branch chain unrelated git commits onto one root', () => {
    const branch = { provider: 'git', type: 'branch', id: 'main' };
    const fileA = { provider: 'local_fs', type: 'file', id: 'a.ts' };
    const fileB = { provider: 'local_fs', type: 'file', id: 'b.ts' };
    const components = connectedComponents(
      buildGraph([
        threadAtom({ id: 'root-a', time: '2026-07-22T18:00:00Z', root: 'r1', artifact: fileA }),
        threadAtom({
          id: 'git-a',
          time: '2026-07-22T18:10:00Z',
          app: 'git',
          artifacts: [branch, fileA],
        }),
        threadAtom({
          id: 'git-b',
          time: '2026-07-22T18:11:00Z',
          app: 'git',
          artifacts: [branch, fileB],
        }),
        threadAtom({ id: 'root-b', time: '2026-07-22T18:21:00Z', root: 'r2', artifact: fileB }),
      ]),
    );

    expect(components).toHaveLength(2);
    expect(components.find((component) => component.atom_ids.includes('root-a'))!.atom_ids).toEqual([
      'git-a',
      'root-a',
    ]);
    expect(components.find((component) => component.atom_ids.includes('root-b'))!.atom_ids).toEqual([
      'git-b',
      'root-b',
    ]);
  });

  it('a dense first project cannot starve a later project', () => {
    const dense = Array.from({ length: 1_000 }, (_, index) =>
      threadAtom({
        id: `dense-${index}`,
        time: `2026-07-22T18:${String(index % 60).padStart(2, '0')}:00Z`,
        artifact: { provider: 'local_fs', type: 'file', id: 'dense.ts' },
      }),
    );
    const later = [
      threadAtom({
        id: 'later-a',
        time: '2026-07-22T19:00:00Z',
        project: PROJECT_B,
        artifact: { provider: 'local_fs', type: 'file', id: 'later.ts' },
      }),
      threadAtom({
        id: 'later-b',
        time: '2026-07-22T19:01:00Z',
        project: PROJECT_B,
        artifact: { provider: 'local_fs', type: 'file', id: 'later.ts' },
      }),
    ];
    const graph = buildGraph([...dense, ...later]);
    expect(connectedComponents(graph)).toHaveLength(2);
    expect(graph.edges.some((edge) => edge.from === 'later-a' && edge.to === 'later-b')).toBe(true);
  });
});
