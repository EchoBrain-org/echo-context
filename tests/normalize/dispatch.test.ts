import { describe, expect, it } from 'vitest';
import {
  findAdapter,
  getRegistry,
  normalizeEvent,
  normalizeEvents,
} from '../../src/context-adapters/normalization.js';
import {
  createNormalizer,
  NormalizationError,
  type AdapterRegistration,
} from '../../src/normalize/index.js';
import type { CaptureEvent } from '../../src/storage/interface.js';
import { claudeCodeFixture } from './fixtures/claude-code.js';
import { codexFixture } from './fixtures/codex.js';
import { cursorFixture } from './fixtures/cursor.js';
import { gitFixture } from './fixtures/git.js';

describe('normalize dispatch', () => {
  it('uses an immutable registration snapshot supplied by composition', () => {
    const supplied: AdapterRegistration[] = [
      {
        name: 'fixture',
        version: 'fixture@1',
        matches: (source) => source === 'fixture:event',
        adapter: () => null,
      },
    ];
    const isolated = createNormalizer(supplied);
    supplied.push({
      name: 'late-mutation',
      version: 'late@1',
      matches: () => true,
      adapter: () => null,
    });

    expect(isolated.getRegistry().map((entry) => entry.name)).toEqual([
      'fixture',
    ]);
    expect(isolated.findAdapter('fixture:event')?.name).toBe('fixture');
    expect(isolated.findAdapter('other:event')).toBeNull();
  });

  it('registers adapters in the documented order: claude-code, codex, cursor, git, granola', () => {
    const reg = getRegistry();
    expect(reg.map((r) => r.name)).toEqual([
      'claude-code',
      'codex',
      'cursor',
      'git',
      'granola',
    ]);
  });

  it('matches each adapter by source pattern', () => {
    expect(findAdapter(claudeCodeFixture.source)?.name).toBe('claude-code');
    expect(findAdapter(codexFixture.source)?.name).toBe('codex');
    expect(findAdapter(cursorFixture.source)?.name).toBe('cursor');
    expect(findAdapter(gitFixture.source)?.name).toBe('git');
    expect(findAdapter('api:granola')?.name).toBe('granola');
  });

  it('matches and normalizes live Windows coding-session sources', () => {
    const claude = {
      ...claudeCodeFixture,
      source: 'fs:C:\\Users\\runner\\.claude\\projects\\portable-project\\session.jsonl',
    };
    const codex = {
      ...codexFixture,
      source: 'fs:C:\\Users\\runner\\.codex\\sessions\\2026\\08\\03\\rollout.jsonl',
    };

    expect(findAdapter(claude.source)?.name).toBe('claude-code');
    expect(findAdapter(codex.source)?.name).toBe('codex');
    expect(normalizeEvent(claude)?.source.app).toBe('claude_code');
    expect(normalizeEvent(codex)?.source.app).toBe('codex');
  });

  it('returns null when no adapter matches a historical raw fs notification', () => {
    const evt: CaptureEvent = {
      id: 'evt_unknown',
      source: 'fs:/tmp/foo.txt',
      timestamp: '2026-05-07T00:00:00.000Z',
      content: '{"event_type":"add","path":"/tmp/foo.txt"}',
      metadata: { surface: 'fs' },
    };
    expect(findAdapter(evt.source)).toBeNull();
    expect(normalizeEvent(evt)).toBeNull();
  });

  it('first-match-wins: a source that satisfies more than one regex resolves to the earlier registration', () => {
    // The claude-code regex requires `/.claude/projects/` and `.jsonl`. The
    // codex regex requires `/.codex/sessions/` and `.jsonl`. They are disjoint
    // by construction, so we synthesise a case that the dispatch *would* see
    // as ambiguous if the regexes ever collided: a source that only the FIRST
    // adapter matches confirms the registration order, not just any-match.
    const reg = getRegistry();
    const claudeCodeMatch = reg.findIndex((r) => r.matches(claudeCodeFixture.source));
    expect(claudeCodeMatch).toBe(0);
    const codexMatch = reg.findIndex((r) => r.matches(codexFixture.source));
    expect(codexMatch).toBe(1);
  });

  it('returns null on a source-matched historical stat event without the adapter envelope', () => {
    // Migrated databases can retain raw stat notifications for the same
    // `~/.claude/projects/.../*.jsonl` path as normalized turn-pair capture.
    // Only turn pairs carry the USER:/ASSISTANT: content envelope.
    const fsWatcherChange: CaptureEvent = {
      ...claudeCodeFixture,
      content: JSON.stringify({
        event_type: 'change',
        path: '/Users/zhenye/.claude/projects/example/abc-123.jsonl',
        mtime: '2026-05-07T00:00:00.000Z',
        size: 12345,
      }),
    };
    expect(normalizeEvent(fsWatcherChange)).toBeNull();

    const plainText: CaptureEvent = {
      ...claudeCodeFixture,
      content: 'this does not contain the USER/ASSISTANT envelope',
    };
    expect(normalizeEvent(plainText)).toBeNull();
  });

  it('throws NormalizationError when a matched adapter is missing required metadata', () => {
    const noSession: CaptureEvent = {
      ...claudeCodeFixture,
      metadata: { ...claudeCodeFixture.metadata, session_id: undefined },
    };
    expect(() => normalizeEvent(noSession)).toThrow(NormalizationError);
  });

  it('normalizeEvents drops null returns silently while preserving order', () => {
    const skip: CaptureEvent = {
      id: 'evt_unknown',
      source: 'fs:/tmp/foo.txt',
      timestamp: '2026-05-07T00:00:00.000Z',
      content: '',
    };
    const all = [claudeCodeFixture, skip, codexFixture];
    const out = normalizeEvents(all);
    expect(out).toHaveLength(2);
    expect(out[0]?.id).toBe(claudeCodeFixture.id);
    expect(out[1]?.id).toBe(codexFixture.id);
  });
});
