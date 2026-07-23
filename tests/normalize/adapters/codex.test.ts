import { describe, expect, it } from 'vitest';
import { normalizeEvent } from '../../../src/context-adapters/normalization.js';
import { codexFixture } from '../fixtures/codex.js';

describe('codex adapter', () => {
  const out = normalizeEvent(codexFixture);
  if (out === null) throw new Error('expected adapter to match');

  it('source.app=codex, surface=jsonl', () => {
    expect(out.source.app).toBe('codex');
    expect(out.source.surface).toBe('jsonl');
  });

  it('assistant actor uses provider=openai (from codex.model_provider) and the codex-reported model', () => {
    expect(out.actors[1]).toMatchObject({
      role: 'assistant',
      provider: 'openai',
      model: 'gpt-5.5',
    });
  });

  it('conversation artifact uses provider="codex"', () => {
    const conv = out.artifacts.find((a) => a.type === 'conversation');
    expect(conv?.provider).toBe('codex');
    expect(conv?.id).toBe('codex:019dff39-1891-74a1-aaaa-bbbbccccdddd');
  });

  it('repo artifact uses the normalized origin_url (.git stripped, host lowercased)', () => {
    const repo = out.artifacts.find((a) => a.type === 'repo');
    expect(repo?.id).toBe('https://github.com/example/demo-repo');
    expect(repo?.provider).toBe('github');
  });

  it('files_referenced become file artifacts joined under repo_id', () => {
    const ids = out.artifacts.map((a) => a.id);
    expect(ids).toContain('https://github.com/example/demo-repo::src/reader.ts');
    expect(ids).toContain('https://github.com/example/demo-repo::src/reader.test.ts');
  });

  it('action input/output split correctly when assistant text contains blank lines', () => {
    expect(out.action.input).toBe('refactor the file reader so it streams');
    expect(out.action.output).toContain('streaming implementation');
    expect(out.action.output).toContain('Let me know if you want me to add tests.');
  });

  it('context.ambient surfaces the codex turn config (sandbox, approval, branch)', () => {
    expect(out.context?.ambient?.had_tool_use).toBe('true');
    expect(out.context?.ambient?.branch).toBe('main');
    expect(out.context?.ambient?.sandbox_policy_type).toBe('workspace-write');
    expect(out.context?.ambient?.approval_policy).toBe('on-request');
  });

  it('provenance.extractor_version is codex@2', () => {
    expect(out.provenance.extractor_version).toBe('codex@2');
  });

  it('normalizes fork lineage, initiator, clocks, and canonical project identity', () => {
    const event = {
      ...codexFixture,
      id: 'evt_codex_lineage',
      metadata: {
        ...codexFixture.metadata,
        logical_turn_id: 'turn-a1',
        parent_logical_turn_id: 'turn-u1',
        thread_id: 'child-thread',
        root_thread_id: 'root-thread',
        parent_thread_id: 'parent-thread',
        thread_kind: 'subagent',
        agent_path: 'reviewer/child',
        agent_depth: 2,
        initiator: 'agent',
        observation_kind: 'original',
        occurred_at: '2026-05-07T05:40:00.000Z',
        observed_at: '2026-05-07T05:42:03.649Z',
        canonical_root: '/Users/dev/Desktop/demo-repo',
        project_key: 'local:workspace:/Users/dev/Desktop/demo-repo',
      },
    };
    const normalized = normalizeEvent(event);
    if (normalized === null) throw new Error('expected adapter to match');

    expect(normalized.time).toEqual({
      occurred_at: '2026-05-07T05:40:00.000Z',
      observed_at: '2026-05-07T05:42:03.649Z',
    });
    expect(normalized.actors[0]).toEqual({ role: 'agent' });
    expect(normalized.conversation).toMatchObject({
      logical_turn_id: 'turn-a1',
      parent_logical_turn_id: 'turn-u1',
      thread_id: 'child-thread',
      root_thread_id: 'root-thread',
      parent_thread_id: 'parent-thread',
      thread_kind: 'subagent',
      agent_path: 'reviewer/child',
      agent_depth: 2,
      initiator: 'agent',
      observation_kind: 'original',
    });
    expect(normalized.project).toEqual({
      key: 'local:workspace:/Users/dev/Desktop/demo-repo',
      canonical_root: '/Users/dev/Desktop/demo-repo',
      observed_root: '/Users/dev/Desktop/demo-repo',
    });
  });

  it('ignores malformed lineage enums and agent depth instead of inventing topology', () => {
    const event = {
      ...codexFixture,
      id: 'evt_codex_malformed_lineage',
      metadata: {
        ...codexFixture.metadata,
        thread_kind: 'forked-ish',
        initiator: 'robot',
        observation_kind: 'copied-ish',
        agent_depth: -1.5,
      },
    };
    const normalized = normalizeEvent(event);
    if (normalized === null) throw new Error('expected adapter to match');

    expect(normalized.actors[0]).toEqual({ role: 'user' });
    expect(normalized.conversation).not.toHaveProperty('thread_kind');
    expect(normalized.conversation).not.toHaveProperty('initiator');
    expect(normalized.conversation).not.toHaveProperty('observation_kind');
    expect(normalized.conversation).not.toHaveProperty('agent_depth');
  });

  it('drops malformed logical ids instead of admitting them into projection keys', () => {
    const event = {
      ...codexFixture,
      id: 'evt_codex_malformed_logical_ids',
      metadata: {
        ...codexFixture.metadata,
        logical_turn_id: '   ',
        parent_logical_turn_id: 'bad parent',
        observation_kind: 'original',
      },
    };
    const normalized = normalizeEvent(event);
    if (normalized === null) throw new Error('expected adapter to match');

    expect(normalized.conversation).not.toHaveProperty('logical_turn_id');
    expect(normalized.conversation).not.toHaveProperty('parent_logical_turn_id');
  });
});
