import { describe, expect, it } from 'vitest';
import { normalizeEvent } from '../../../src/context-adapters/normalization.js';
import { gitFixture } from '../fixtures/git.js';

describe('git adapter', () => {
  const out = normalizeEvent(gitFixture);
  if (out === null) throw new Error('expected adapter to match');

  it('source.app=git, surface=commit', () => {
    expect(out.source.app).toBe('git');
    expect(out.source.surface).toBe('commit');
  });

  it('actors carry the commit author name', () => {
    expect(out.actors).toEqual([{ role: 'user', name: 'Dev' }]);
  });

  it('action.kind=commit; input is subject+body, output is the diff', () => {
    expect(out.action.kind).toBe('commit');
    expect(out.action.input).toContain('refactor: extract reader helper');
    expect(out.action.input).toContain('Move reader logic into its own module');
    expect(out.action.output).toContain('diff --git a/src/reader.ts');
    expect(out.action.output).toContain('+export function read');
  });

  it('artifacts include repo + commit + branch + every file touched', () => {
    const ids = out.artifacts.map((a) => a.id);
    expect(ids).toContain('local:/Users/dev/Desktop/demo-repo');
    expect(ids).toContain(
      'local:/Users/dev/Desktop/demo-repo::3aba18ae4163490fb3fdeba9fed60f35c0afd1f5',
    );
    expect(ids).toContain('local:/Users/dev/Desktop/demo-repo::main');
    expect(ids).toContain('local:/Users/dev/Desktop/demo-repo::src/reader.ts');
    expect(ids).toContain('local:/Users/dev/Desktop/demo-repo::src/index.ts');
  });

  it('state.delta references the commit artifact and carries shortstat detail', () => {
    expect(out.state).toBeDefined();
    const delta = out.state?.delta;
    if (delta === undefined) throw new Error('expected state.delta');
    expect(delta.kind).toBe('commit');
    expect(delta.artifact_id).toBe(
      'local:/Users/dev/Desktop/demo-repo::3aba18ae4163490fb3fdeba9fed60f35c0afd1f5',
    );
    expect(delta.detail).toContain('2 files changed');
    expect(delta.detail).toContain('+4');
    expect(delta.detail).toContain('-1');
  });

  it('context.ambient carries parent_sha + counters', () => {
    expect(out.context?.ambient?.parent_sha).toBe(
      '92d3b7e41dde9a28e34df241c1ace7614c906df7',
    );
    expect(out.context?.ambient?.files_changed).toBe('2');
    expect(out.context?.ambient?.additions).toBe('4');
    expect(out.context?.ambient?.deletions).toBe('1');
  });

  it('git commits do not carry a conversation', () => {
    expect(out.conversation).toBeUndefined();
  });

  it('provenance.extractor_version is git@2', () => {
    expect(out.provenance.extractor_version).toBe('git@2');
  });
});
