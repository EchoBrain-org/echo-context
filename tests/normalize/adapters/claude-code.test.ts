import { describe, expect, it } from 'vitest';
import { normalizeEvent } from '../../../src/context-adapters/normalization.js';
import { claudeCodeFixture } from '../fixtures/claude-code.js';

describe('claude-code adapter', () => {
  const out = normalizeEvent(claudeCodeFixture);
  if (out === null) throw new Error('expected adapter to match');

  it('schema_version is 1', () => {
    expect(out.schema_version).toBe(1);
  });

  it('id matches the source event id', () => {
    expect(out.id).toBe(claudeCodeFixture.id);
  });

  it('time.occurred_at sources from event.timestamp (no clock reads)', () => {
    expect(out.time.occurred_at).toBe(claudeCodeFixture.timestamp);
    expect(out.time.observed_at).toBeUndefined();
  });

  it('source carries app/surface and the raw_pointer audit-back', () => {
    expect(out.source.app).toBe('claude_code');
    expect(out.source.surface).toBe('jsonl');
    expect(out.source.raw_pointer).toBe(claudeCodeFixture.source);
  });

  it('actors are user + assistant with model + provider=anthropic', () => {
    expect(out.actors).toHaveLength(2);
    expect(out.actors[0]).toEqual({ role: 'user' });
    expect(out.actors[1]).toMatchObject({
      role: 'assistant',
      provider: 'anthropic',
      model: 'claude-opus-4-7',
    });
  });

  it('action.kind=message; input/output split from USER:/ASSISTANT: envelope', () => {
    expect(out.action.kind).toBe('message');
    expect(out.action.input).toBe('how many items are in the demo backlog?');
    expect(out.action.output).toBe('There are 16 total items in the demo backlog.');
  });

  it('artifacts include conversation + repo + each referenced file with canonical ids', () => {
    const ids = out.artifacts.map((a) => a.id);
    expect(ids).toContain('claude_code:4e273691-aaaa-bbbb-cccc-ddddeeeeffff');
    expect(ids).toContain('local:/Users/dev/Desktop/demo-repo');
    expect(ids).toContain('local:/Users/dev/Desktop/demo-repo::src/index.ts');
    expect(ids).toContain('abs:/tmp/scratchpad.md');
  });

  it('conversation captures provider, session_id, turn_index', () => {
    expect(out.conversation).toEqual({
      provider: 'claude_code',
      session_id: '4e273691-aaaa-bbbb-cccc-ddddeeeeffff',
      turn_index: 9,
    });
  });

  it('context.ambient.had_tool_use is "true" (string), branch + cli_version + permission_mode flow through', () => {
    expect(out.context?.ambient?.had_tool_use).toBe('true');
    expect(out.context?.ambient?.branch).toBe('main');
    expect(out.context?.ambient?.cli_version).toBe('2.1.119');
    expect(out.context?.ambient?.permission_mode).toBe('auto');
  });

  it('open_loop_hints picks up the trailing question mark in the user input', () => {
    expect(out.open_loop_hints).toContain('ends_with_question');
  });

  it('byte_offset is NOT carried into the normalized atom (per spec)', () => {
    const json = JSON.stringify(out);
    expect(json).not.toContain('byte_offset');
    expect(json).not.toContain('848272');
  });

  it('provenance carries source_event_id, raw_payload_hash (sha256 hex), extractor_version', () => {
    expect(out.provenance.source_event_id).toBe(claudeCodeFixture.id);
    expect(out.provenance.extractor_version).toBe('claude-code@1');
    expect(out.provenance.raw_payload_hash).toMatch(/^[0-9a-f]{64}$/);
  });
});
