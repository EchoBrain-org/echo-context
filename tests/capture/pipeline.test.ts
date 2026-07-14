import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { canonicalizeTimestamp, processCandidate } from '../../src/capture/pipeline.js';
import { CAPTURED_SOURCES } from '../../src/capture/sources.js';
import { MemoryStorage } from '../../src/storage/memory.js';
import { resetAllowlist } from '../fixtures/allowlist.js';
import { captureStdout } from '../fixtures/stdout.js';

let restoreStdout: () => void;

function validEvent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    source: 'fs:/tmp/test.txt',
    timestamp: '2026-04-30T12:00:00.000Z',
    content: 'hello',
    ...overrides,
  };
}

describe('processCandidate', () => {
  let storage: MemoryStorage;

  beforeEach(() => {
    storage = new MemoryStorage();
    ({ restore: restoreStdout } = captureStdout());
  });

  afterEach(() => {
    restoreStdout();
    resetAllowlist();
  });

  describe('accept path', () => {
    it('appends to storage and returns the id when gate accepts', async () => {
      const apis = CAPTURED_SOURCES.apis as unknown as string[];
      apis.push('github');

      const before = await storage.count();
      const result = await processCandidate(
        validEvent({ source: 'api:github', content: '{"issue":234}' }),
        storage,
      );

      expect(result.accepted).toBe(true);
      if (!result.accepted) throw new Error('unreachable');
      expect(typeof result.id).toBe('string');
      expect(result.id.length).toBeGreaterThan(0);

      const after = await storage.count();
      expect(after).toBe(before + 1);

      const all = await storage.query({ order: 'asc' });
      expect(all).toHaveLength(1);
      expect(all[0]!.id).toBe(result.id);
      expect(all[0]!.source).toBe('api:github');
      expect(all[0]!.content).toBe('{"issue":234}');
    });

    it('preserves metadata through the pipeline', async () => {
      const apis = CAPTURED_SOURCES.apis as unknown as string[];
      apis.push('github');

      const result = await processCandidate(
        validEvent({
          source: 'api:github',
          metadata: { repo: 'echo', kind: 'issue' },
        }),
        storage,
      );

      expect(result.accepted).toBe(true);
      const [evt] = await storage.query({ order: 'asc' });
      expect(evt!.metadata).toEqual({ repo: 'echo', kind: 'issue' });
    });

    it('drops any caller-supplied id; storage assigns its own', async () => {
      const apis = CAPTURED_SOURCES.apis as unknown as string[];
      apis.push('github');

      const result = await processCandidate(
        validEvent({ source: 'api:github', id: 'caller-supplied-id' }),
        storage,
      );

      expect(result.accepted).toBe(true);
      if (!result.accepted) throw new Error('unreachable');
      expect(result.id).not.toBe('caller-supplied-id');
      const [evt] = await storage.query({ order: 'asc' });
      expect(evt!.id).toBe(result.id);
    });
  });

  describe('reject path — well-formed but not allowlisted', () => {
    it('does not touch storage and returns the gate rejection reason', async () => {
      const before = await storage.count();
      const result = await processCandidate(validEvent({ source: 'api:github' }), storage);

      expect(result).toEqual({ accepted: false, reason: 'unknown_api' });
      const after = await storage.count();
      expect(after).toBe(before);
      expect(after).toBe(0);
    });

    it('reuses every gate rejection reason verbatim', async () => {
      const cases: { source: string; reason: string }[] = [
        { source: 'app:com.example.foo', reason: 'unknown_app' },
        { source: 'domain:example.com', reason: 'unknown_domain' },
        { source: 'fs:/etc/passwd', reason: 'unknown_path' },
        { source: 'api:slack', reason: 'unknown_api' },
      ];
      for (const c of cases) {
        const r = await processCandidate(validEvent({ source: c.source }), storage);
        expect(r).toEqual({ accepted: false, reason: c.reason });
      }
      expect(await storage.count()).toBe(0);
    });
  });

  describe('reject path — malformed event', () => {
    const cases: { name: string; input: unknown }[] = [
      { name: 'null', input: null },
      { name: 'empty object', input: {} },
      { name: 'missing source', input: { timestamp: '2026-04-30T12:00:00Z', content: 'x' } },
      { name: 'unknown kind prefix', input: { source: 'usb:abc', timestamp: 't', content: 'x' } },
    ];

    for (const c of cases) {
      it(`returns malformed_event without touching storage (${c.name})`, async () => {
        const before = await storage.count();
        const r = await processCandidate(c.input, storage);
        expect(r).toEqual({ accepted: false, reason: 'malformed_event' });
        const after = await storage.count();
        expect(after).toBe(before);
        expect(after).toBe(0);
      });
    }
  });

  describe('storage is dependency-injected', () => {
    it('two distinct storage instances do not share state', async () => {
      const apis = CAPTURED_SOURCES.apis as unknown as string[];
      apis.push('github');

      const a = new MemoryStorage();
      const b = new MemoryStorage();

      await processCandidate(validEvent({ source: 'api:github' }), a);
      expect(await a.count()).toBe(1);
      expect(await b.count()).toBe(0);
    });
  });

  describe('timestamp canonicalization at the chokepoint (item 022 Bug A)', () => {
    beforeEach(() => {
      const apis = CAPTURED_SOURCES.apis as unknown as string[];
      apis.push('github');
    });

    it('Z-suffixed input is stored unchanged', async () => {
      await processCandidate(
        validEvent({ source: 'api:github', timestamp: '2026-05-08T07:00:00.000Z' }),
        storage,
      );
      const [evt] = await storage.query();
      expect(evt!.timestamp).toBe('2026-05-08T07:00:00.000Z');
    });

    it('+07:00 offset input is converted to canonical Z form', async () => {
      await processCandidate(
        validEvent({ source: 'api:github', timestamp: '2026-05-08T14:00:00.000+07:00' }),
        storage,
      );
      const [evt] = await storage.query();
      expect(evt!.timestamp).toBe('2026-05-08T07:00:00.000Z');
    });

    it('-07:00 offset input is converted to canonical Z form (the git-watcher case)', async () => {
      await processCandidate(
        validEvent({ source: 'api:github', timestamp: '2026-05-08T00:00:00.000-07:00' }),
        storage,
      );
      const [evt] = await storage.query();
      expect(evt!.timestamp).toBe('2026-05-08T07:00:00.000Z');
    });

    it('preserves millisecond precision through canonicalization', async () => {
      await processCandidate(
        validEvent({ source: 'api:github', timestamp: '2026-05-08T00:18:26.123-07:00' }),
        storage,
      );
      const [evt] = await storage.query();
      expect(evt!.timestamp).toBe('2026-05-08T07:18:26.123Z');
    });

    it('naive (TZ-less) input is canonicalized assuming UTC (N1 policy)', async () => {
      await processCandidate(
        validEvent({ source: 'api:github', timestamp: '2026-05-08T07:00:00' }),
        storage,
      );
      const [evt] = await storage.query();
      expect(evt!.timestamp).toBe('2026-05-08T07:00:00.000Z');
    });
  });

  describe('reject path — unparseable timestamp (Bug B)', () => {
    beforeEach(() => {
      const apis = CAPTURED_SOURCES.apis as unknown as string[];
      apis.push('github');
    });

    it('rejects with invalid_timestamp instead of throwing; storage untouched', async () => {
      // Gate only requires a non-empty string, so "n/a" passes the gate but
      // cannot be canonicalized. Pre-fix this threw RangeError AFTER
      // gate-accept, poisoning the extractor loops (Bug A) and the watcher
      // emit paths (Bug C).
      const result = await processCandidate(
        validEvent({ source: 'api:github', timestamp: 'n/a' }),
        storage,
      );

      expect(result).toEqual({ accepted: false, reason: 'invalid_timestamp' });
      expect(await storage.count()).toBe(0);
    });

    it('logs a warn line naming the rejection reason and source', async () => {
      const captured = captureStdout();
      try {
        await processCandidate(validEvent({ source: 'api:github', timestamp: 'n/a' }), storage);
      } finally {
        captured.restore();
      }
      const out = captured.writes.join('');
      expect(out).toContain('invalid_timestamp');
      expect(out).toContain('api:github');
    });
  });
});

describe('canonicalizeTimestamp (pure helper)', () => {
  it('returns Z-form unchanged', () => {
    expect(canonicalizeTimestamp('2026-05-08T07:00:00.000Z')).toBe('2026-05-08T07:00:00.000Z');
  });

  it('converts +HH:MM offset to Z', () => {
    expect(canonicalizeTimestamp('2026-05-08T14:00:00.000+07:00')).toBe(
      '2026-05-08T07:00:00.000Z',
    );
  });

  it('converts -HH:MM offset to Z', () => {
    expect(canonicalizeTimestamp('2026-05-08T00:00:00.000-07:00')).toBe(
      '2026-05-08T07:00:00.000Z',
    );
  });

  it('preserves millisecond precision', () => {
    expect(canonicalizeTimestamp('2026-05-08T00:18:26.123-07:00')).toBe(
      '2026-05-08T07:18:26.123Z',
    );
  });

  it('treats naive (TZ-less) input as UTC', () => {
    expect(canonicalizeTimestamp('2026-05-08T07:00:00')).toBe('2026-05-08T07:00:00.000Z');
  });
});
