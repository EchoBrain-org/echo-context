import { describe, expect, it } from 'vitest';
import { resolveContextRuntimeConfig } from '../../src/runtime/config.js';

describe('context runtime configuration', () => {
  it('is standalone and defaults to only the three coding-session adapters', () => {
    const config = resolveContextRuntimeConfig({});
    expect(config.host).toBe('127.0.0.1');
    expect(config.port).toBe(38478);
    expect(config.dbPath).toContain('.echo-context');
    expect(config.capture.codex).toBe(true);
    expect(config.capture.claudeCode).toBe(true);
    expect(config.capture.cursor).toBe(true);
    expect(JSON.stringify(config)).not.toMatch(/slack|coord|backlog|enrich/i);
  });

  it('supports isolated founder-live lanes through environment overrides', () => {
    const config = resolveContextRuntimeConfig({
      ECHO_CONTEXT_HOME: '/tmp/echo-context-founder-live',
      ECHO_CONTEXT_DB_PATH: '/tmp/echo-context-founder-live/candidate.db',
      ECHO_CONTEXT_HOST: 'localhost',
      ECHO_CONTEXT_PORT: '39478',
      ECHO_CONTEXT_CAPTURE_CURSOR: 'false',
    });
    expect(config.home).toBe('/tmp/echo-context-founder-live');
    expect(config.dbPath).toBe('/tmp/echo-context-founder-live/candidate.db');
    expect(config.port).toBe(39478);
    expect(config.capture.cursor).toBe(false);
  });

  it('refuses a non-loopback bind', () => {
    expect(() => resolveContextRuntimeConfig({ ECHO_CONTEXT_HOST: '0.0.0.0' })).toThrow(
      /loopback/,
    );
  });

  it('refuses the undiscoverable runtime port 0', () => {
    expect(() => resolveContextRuntimeConfig({ ECHO_CONTEXT_PORT: '0' })).toThrow(/between 1/);
  });

  it('reads the promotion receipt digest as part of exact identity', () => {
    const config = resolveContextRuntimeConfig({
      ECHO_CONTEXT_PROMOTION_RECEIPT_DIGEST: 'a'.repeat(64),
    });
    expect(config.identity.promotionReceiptDigest).toBe('a'.repeat(64));
  });
});
