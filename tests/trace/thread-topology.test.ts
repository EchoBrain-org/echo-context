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
  app?: string;
}) {
  return makeAtom({
    id: input.id,
    app: input.app ?? 'codex',
    occurred_at: input.time,
    project: input.project ?? PROJECT_A,
    artifacts: input.artifact === undefined ? [] : [input.artifact],
    ...(input.root !== undefined
      ? {
          conversation: {
            provider: 'codex',
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
    expect(graph.truncated).toBeUndefined();
    expect(connectedComponents(graph)).toHaveLength(2);
    expect(graph.edges.some((edge) => edge.from === 'later-a' && edge.to === 'later-b')).toBe(true);
  });
});
