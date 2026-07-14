import { describe, expect, it } from 'vitest';
import { normalizeEvent } from '../../../src/normalize/index.js';
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

  it('provenance.extractor_version is codex@1', () => {
    expect(out.provenance.extractor_version).toBe('codex@1');
  });
});
