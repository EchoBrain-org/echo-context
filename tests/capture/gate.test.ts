import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { gate, type CandidateEvent } from '../../src/capture/gate.js';
import { CAPTURED_SOURCES } from '../../src/capture/sources.js';
import { resetAllowlist } from '../fixtures/allowlist.js';
import { captureStdout } from '../fixtures/stdout.js';

let writes: string[];
let restoreStdout: () => void;

function validEvent(overrides: Partial<CandidateEvent> = {}): CandidateEvent {
  return {
    source: 'fs:/tmp/test.txt',
    timestamp: '2026-04-30T12:00:00.000Z',
    content: 'hello',
    ...overrides,
  };
}

function parseLine(line: string): Record<string, unknown> {
  return JSON.parse(line.endsWith('\n') ? line.slice(0, -1) : line) as Record<string, unknown>;
}

describe('gate', () => {
  beforeEach(() => {
    ({ writes, restore: restoreStdout } = captureStdout());
  });

  afterEach(() => {
    restoreStdout();
    resetAllowlist();
  });

  describe('reject — well-formed but not in allowlist (current empty state)', () => {
    it('app source → unknown_app + warn log', () => {
      const r = gate(validEvent({ source: 'app:com.example.foo' }));
      expect(r).toEqual({ accepted: false, reason: 'unknown_app' });
      expect(writes).toHaveLength(1);
      const entry = parseLine(writes[0]!);
      expect(entry['level']).toBe('warn');
      expect(entry['source']).toBe('capture.gate');
      expect((entry['payload'] as Record<string, unknown>)['reason']).toBe('unknown_app');
      expect((entry['payload'] as Record<string, unknown>)['source']).toBe('app:com.example.foo');
    });

    it('domain source → unknown_domain', () => {
      const r = gate(validEvent({ source: 'domain:example.com' }));
      expect(r).toEqual({ accepted: false, reason: 'unknown_domain' });
      const entry = parseLine(writes[0]!);
      expect(entry['level']).toBe('warn');
      expect((entry['payload'] as Record<string, unknown>)['reason']).toBe('unknown_domain');
    });

    it('fs source → unknown_path', () => {
      const r = gate(validEvent({ source: 'fs:/etc/passwd' }));
      expect(r).toEqual({ accepted: false, reason: 'unknown_path' });
      const entry = parseLine(writes[0]!);
      expect((entry['payload'] as Record<string, unknown>)['reason']).toBe('unknown_path');
    });

    it('api source → unknown_api', () => {
      const r = gate(validEvent({ source: 'api:github' }));
      expect(r).toEqual({ accepted: false, reason: 'unknown_api' });
      const entry = parseLine(writes[0]!);
      expect((entry['payload'] as Record<string, unknown>)['reason']).toBe('unknown_api');
    });
  });

  describe('reject — malformed event', () => {
    const cases: { name: string; input: unknown }[] = [
      { name: 'null', input: null },
      { name: 'undefined', input: undefined },
      { name: 'number', input: 42 },
      { name: 'string', input: 'not an event' },
      { name: 'array', input: ['source', 'app:foo'] },
      { name: 'empty object', input: {} },
      { name: 'missing source', input: { timestamp: '2026-04-30T12:00:00Z', content: 'x' } },
      {
        name: 'missing timestamp',
        input: { source: 'app:foo', content: 'x' },
      },
      {
        name: 'missing content',
        input: { source: 'app:foo', timestamp: '2026-04-30T12:00:00Z' },
      },
      {
        name: 'wrong-type timestamp',
        input: { source: 'app:foo', timestamp: 1234, content: 'x' },
      },
      {
        name: 'wrong-type content',
        input: { source: 'app:foo', timestamp: '2026-04-30T12:00:00Z', content: 99 },
      },
      {
        name: 'empty source string',
        input: { source: '', timestamp: '2026-04-30T12:00:00Z', content: 'x' },
      },
      {
        name: 'unknown kind prefix',
        input: { source: 'usb:abc', timestamp: '2026-04-30T12:00:00Z', content: 'x' },
      },
      {
        name: 'no kind prefix (no colon)',
        input: { source: 'no-colon-here', timestamp: '2026-04-30T12:00:00Z', content: 'x' },
      },
      {
        name: 'colon at start',
        input: { source: ':no-kind', timestamp: '2026-04-30T12:00:00Z', content: 'x' },
      },
      {
        name: 'colon at end',
        input: { source: 'app:', timestamp: '2026-04-30T12:00:00Z', content: 'x' },
      },
      {
        name: 'wrong-type metadata',
        input: {
          source: 'app:foo',
          timestamp: '2026-04-30T12:00:00Z',
          content: 'x',
          metadata: 'oops',
        },
      },
    ];

    for (const c of cases) {
      it(`returns malformed_event for ${c.name}`, () => {
        const r = gate(c.input);
        expect(r).toEqual({ accepted: false, reason: 'malformed_event' });
        expect(writes).toHaveLength(1);
        const entry = parseLine(writes[0]!);
        expect(entry['level']).toBe('warn');
        expect((entry['payload'] as Record<string, unknown>)['reason']).toBe('malformed_event');
      });
    }
  });

  describe('accept — fixture-extended allowlist', () => {
    it('app: matching bundle id → accepted with info log', () => {
      const apps = CAPTURED_SOURCES.apps as Record<string, { name: string }>;
      apps['com.example.fixture'] = { name: 'Fixture' };
      const r = gate(validEvent({ source: 'app:com.example.fixture' }));
      expect(r).toEqual({ accepted: true, reason: 'allowlisted' });
      expect(writes).toHaveLength(1);
      const entry = parseLine(writes[0]!);
      expect(entry['level']).toBe('info');
      expect(entry['source']).toBe('capture.gate');
      expect(entry['message']).toBe('accepted');
      const payload = entry['payload'] as Record<string, unknown>;
      expect(payload['source']).toBe('app:com.example.fixture');
      expect(payload['timestamp']).toBe('2026-04-30T12:00:00.000Z');
    });

    it('domain: matching host → accepted', () => {
      const domains = CAPTURED_SOURCES.domains as Record<string, { surfaces: string[] }>;
      domains['example.com'] = { surfaces: ['extension'] };
      const r = gate(validEvent({ source: 'domain:example.com' }));
      expect(r).toEqual({ accepted: true, reason: 'allowlisted' });
    });

    it('fs: prefix-matching path → accepted', () => {
      const paths = CAPTURED_SOURCES.fs_paths as unknown as string[];
      paths.push('/var/echo/');
      const r = gate(validEvent({ source: 'fs:/var/echo/log.txt' }));
      expect(r).toEqual({ accepted: true, reason: 'allowlisted' });
    });

    it('api: matching name → accepted', () => {
      const apis = CAPTURED_SOURCES.apis as unknown as string[];
      apis.push('github');
      const r = gate(validEvent({ source: 'api:github' }));
      expect(r).toEqual({ accepted: true, reason: 'allowlisted' });
    });
  });

  describe('determinism', () => {
    it('same input produces same result across 100 calls (and 100 log lines)', () => {
      const event = validEvent({ source: 'app:com.never.allowed' });
      const results = Array.from({ length: 100 }, () => gate(event));
      expect(results.every((r) => r.accepted === false && r.reason === 'unknown_app')).toBe(true);
      expect(writes).toHaveLength(100);
      const reasons = writes.map((line) => {
        const entry = parseLine(line);
        return (entry['payload'] as Record<string, unknown>)['reason'];
      });
      expect(reasons.every((r) => r === 'unknown_app')).toBe(true);
    });
  });

  describe('purity / total function', () => {
    it('never throws regardless of input', () => {
      const evil: unknown[] = [
        null,
        undefined,
        Symbol('s'),
        () => 'function',
        new Map(),
        new Set(),
        Object.create(null),
        { source: { not: 'a string' }, timestamp: 'x', content: 'y' },
        { source: 'app:foo', timestamp: 'x', content: 'y', metadata: null },
      ];
      for (const v of evil) {
        expect(() => gate(v)).not.toThrow();
        const r = gate(v);
        expect(typeof r.accepted).toBe('boolean');
        expect(typeof r.reason).toBe('string');
      }
    });

    it('emits exactly one JSON line per gate call', () => {
      gate(validEvent({ source: 'app:not-allowed' }));
      expect(writes).toHaveLength(1);
      const line = writes[0]!;
      expect(line.endsWith('\n')).toBe(true);
      expect(line.indexOf('\n')).toBe(line.length - 1);
      expect(() => JSON.parse(line.slice(0, -1))).not.toThrow();
    });
  });
});
