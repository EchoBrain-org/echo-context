import { describe, expect, it } from 'vitest';
import { normalizeEvent } from '../../../src/context-adapters/normalization.js';
import { cursorFixture, cursorFixtureNoContext } from '../fixtures/cursor.js';

describe('cursor adapter', () => {
  const out = normalizeEvent(cursorFixture);
  if (out === null) throw new Error('expected adapter to match');

  it('source.app=cursor, surface=composer', () => {
    expect(out.source.app).toBe('cursor');
    expect(out.source.surface).toBe('composer');
  });

  it('actors are user + assistant with provider=cursor', () => {
    expect(out.actors[0]).toEqual({ role: 'user' });
    expect(out.actors[1]).toMatchObject({ role: 'assistant', provider: 'cursor' });
  });

  it('conversation artifact uses provider=cursor and composer_id as session id', () => {
    const conv = out.artifacts.find((a) => a.type === 'conversation');
    expect(conv?.id).toBe('cursor:3ce99c8c-aaaa-bbbb-cccc-ddddeeeeffff');
  });

  it('attached_files map into context.visible[]', () => {
    expect(out.context?.visible).toEqual([
      '/Users/dev/Desktop/demo-repo/src/main.tsx',
    ]);
  });

  it('referenced_files (and deleted_files) become file artifacts in artifacts[]', () => {
    const fileIds = out.artifacts.filter((a) => a.type === 'file').map((a) => a.id);
    expect(fileIds).toContain('abs:/Users/dev/Desktop/demo-repo/src/main.tsx');
    expect(fileIds).toContain('abs:/Users/dev/Desktop/demo-repo/src/main.test.tsx');
    expect(fileIds).toContain('abs:/Users/dev/Desktop/demo-repo/src/legacy.tsx');
  });

  it('workspace_id flows into context.ambient.workspace_id', () => {
    expect(out.context?.ambient?.workspace_id).toBe('ws_demo_hash');
  });

  it('provenance.extractor_version is cursor@2', () => {
    expect(out.provenance.extractor_version).toBe('cursor@2');
  });

  it('treats a composer as an explicit root thread', () => {
    expect(out.conversation).toMatchObject({
      thread_id: '3ce99c8c-aaaa-bbbb-cccc-ddddeeeeffff',
      root_thread_id: '3ce99c8c-aaaa-bbbb-cccc-ddddeeeeffff',
      thread_kind: 'root',
    });
  });

  it('action input/output split correctly', () => {
    expect(out.action.input).toBe('please add a null check to handleClick in main.tsx');
    expect(out.action.output).toBe(
      'Done — added the null check and a regression test.',
    );
  });

  it('omits context entirely when no attached / referenced / deleted files and no workspace_id', () => {
    const out2 = normalizeEvent(cursorFixtureNoContext);
    if (out2 === null) throw new Error('expected adapter to match');
    expect(out2.context).toBeUndefined();
    expect(out2.artifacts.filter((a) => a.type === 'file')).toHaveLength(0);
  });

  it('open_loop_hints picks up trailing question mark in user input', () => {
    const out2 = normalizeEvent(cursorFixtureNoContext);
    if (out2 === null) throw new Error('expected adapter to match');
    expect(out2.open_loop_hints).toContain('ends_with_question');
  });
});
