import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { captureStdout } from '../fixtures/stdout.js';

type LoggerModule = typeof import('../../src/logging/index.js');

let writes: string[];
let restoreStdout: () => void;
let originalEnvLevel: string | undefined;

async function loadLogger(level: string | undefined): Promise<LoggerModule> {
  if (level === undefined) {
    delete process.env.ECHO_LOG_LEVEL;
  } else {
    process.env.ECHO_LOG_LEVEL = level;
  }
  vi.resetModules();
  return import('../../src/logging/index.js');
}

describe('logger', () => {
  beforeEach(() => {
    originalEnvLevel = process.env.ECHO_LOG_LEVEL;
    ({ writes, restore: restoreStdout } = captureStdout());
  });

  afterEach(() => {
    restoreStdout();
    if (originalEnvLevel === undefined) {
      delete process.env.ECHO_LOG_LEVEL;
    } else {
      process.env.ECHO_LOG_LEVEL = originalEnvLevel;
    }
  });

  it('emits each level when threshold is debug', async () => {
    const { createLogger } = await loadLogger('debug');
    const log = createLogger('test');
    log.debug('d');
    log.info('i');
    log.warn('w');
    log.error('e');
    expect(writes).toHaveLength(4);
    const levels = writes.map((line) => (JSON.parse(line) as { level: string }).level);
    expect(levels).toEqual(['debug', 'info', 'warn', 'error']);
  });

  it('suppresses below-threshold entries when ECHO_LOG_LEVEL=warn', async () => {
    const { createLogger } = await loadLogger('warn');
    const log = createLogger('test');
    log.debug('d');
    log.info('i');
    log.warn('w');
    log.error('e');
    expect(writes).toHaveLength(2);
    const levels = writes.map((line) => (JSON.parse(line) as { level: string }).level);
    expect(levels).toEqual(['warn', 'error']);
  });

  it('defaults to info when ECHO_LOG_LEVEL is unset', async () => {
    const { createLogger } = await loadLogger(undefined);
    const log = createLogger('test');
    log.debug('d');
    log.info('i');
    log.warn('w');
    log.error('e');
    expect(writes).toHaveLength(3);
    const levels = writes.map((line) => (JSON.parse(line) as { level: string }).level);
    expect(levels).toEqual(['info', 'warn', 'error']);
  });

  it('falls back to info when ECHO_LOG_LEVEL is malformed', async () => {
    const { createLogger } = await loadLogger('not-a-level');
    const log = createLogger('test');
    log.debug('d');
    log.info('i');
    expect(writes).toHaveLength(1);
    expect((JSON.parse(writes[0]!) as { level: string }).level).toBe('info');
  });

  it('attributes the source from createLogger argument', async () => {
    const { createLogger } = await loadLogger('debug');
    createLogger('capture.gate').info('hello');
    const entry = JSON.parse(writes[0]!) as { source: string };
    expect(entry.source).toBe('capture.gate');
  });

  it('preserves nested payload values through JSON', async () => {
    const { createLogger } = await loadLogger('debug');
    const payload = {
      nested: { arr: [1, 2, 3], s: 'str', b: true, n: null },
      flag: false,
    };
    createLogger('test').info('msg', payload);
    const entry = JSON.parse(writes[0]!) as { payload: Record<string, unknown> };
    expect(entry.payload).toEqual(payload);
  });

  it('emits exactly one JSON object per call, terminated by a newline', async () => {
    const { createLogger } = await loadLogger('debug');
    createLogger('test').info('msg');
    expect(writes).toHaveLength(1);
    const line = writes[0]!;
    expect(line.endsWith('\n')).toBe(true);
    expect(line.indexOf('\n')).toBe(line.length - 1);
    const parsed = JSON.parse(line.slice(0, -1)) as Record<string, unknown>;
    expect(parsed['message']).toBe('msg');
    expect(parsed['source']).toBe('test');
    expect(parsed['level']).toBe('info');
    expect(parsed['payload']).toBeUndefined();
  });

  it('stamps a UTC ISO 8601 timestamp', async () => {
    const { createLogger } = await loadLogger('debug');
    createLogger('test').info('msg');
    const entry = JSON.parse(writes[0]!) as { timestamp: string };
    expect(entry.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/);
    expect(Number.isNaN(Date.parse(entry.timestamp))).toBe(false);
  });

  it('omits the payload key when no payload is supplied', async () => {
    const { createLogger } = await loadLogger('debug');
    createLogger('test').info('msg');
    const parsed = JSON.parse(writes[0]!) as Record<string, unknown>;
    expect(Object.prototype.hasOwnProperty.call(parsed, 'payload')).toBe(false);
  });
});
