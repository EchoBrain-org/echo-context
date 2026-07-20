import { afterEach, describe, expect, it } from 'vitest';
import { startMcpServer, type McpServerHandle } from '../../src/mcp/server.js';
import { HealthTracker, type HealthStatus } from '../../src/runtime/health.js';
import { MemoryStorage } from '../../src/storage/memory.js';

describe('GET /healthz', () => {
  let handle: McpServerHandle | null = null;

  afterEach(async () => {
    if (handle !== null) {
      await handle.stop();
      handle = null;
    }
  });

  it('is healthy by default for existing in-process callers', async () => {
    handle = await startMcpServer(new MemoryStorage(), { port: 0 });
    const response = await fetch(`${new URL(handle.url).origin}/healthz`);

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toMatchObject({
      schema_version: 1,
      status: 'healthy',
      components: {},
    });
  });

  it.each<HealthStatus>(['starting', 'catching_up', 'stopping', 'unhealthy'])(
    'returns 503 while the injected runtime status is %s',
    async (status) => {
      const tracker = new HealthTracker({ initialStatus: status });
      tracker.setComponent('extractors', status, {
        details: { queueDepth: status === 'catching_up' ? 3 : 0 },
      });
      handle = await startMcpServer(new MemoryStorage(), {
        port: 0,
        healthSnapshotProvider: () => tracker.snapshot(),
      });

      const response = await fetch(`${new URL(handle.url).origin}/healthz`);
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({
        status,
        components: {
          extractors: {
            status,
            details: { queueDepth: status === 'catching_up' ? 3 : 0 },
          },
        },
      });
    },
  );

  it('reflects later transitions from an injected tracker', async () => {
    const tracker = new HealthTracker();
    handle = await startMcpServer(new MemoryStorage(), {
      port: 0,
      healthSnapshotProvider: () => tracker.snapshot(),
    });
    const healthz = `${new URL(handle.url).origin}/healthz`;

    expect((await fetch(healthz)).status).toBe(503);
    tracker.transition('catching_up');
    expect((await fetch(healthz)).status).toBe(503);
    tracker.transition('healthy');
    expect((await fetch(healthz)).status).toBe(200);
  });

  it('fails closed when the snapshot provider throws', async () => {
    handle = await startMcpServer(new MemoryStorage(), {
      port: 0,
      healthSnapshotProvider: () => {
        throw new Error('provider failure');
      },
    });

    const response = await fetch(`${new URL(handle.url).origin}/healthz`);
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      status: 'unhealthy',
      components: {
        health_snapshot_provider: {
          status: 'unhealthy',
          message: 'health snapshot unavailable',
        },
      },
    });
  });

  it('allows only GET without changing the MCP route contract', async () => {
    handle = await startMcpServer(new MemoryStorage(), { port: 0 });
    const origin = new URL(handle.url).origin;

    const healthPost = await fetch(`${origin}/healthz`, { method: 'POST' });
    expect(healthPost.status).toBe(405);
    expect(healthPost.headers.get('allow')).toBe('GET');

    const mcpGet = await fetch(handle.url);
    expect(mcpGet.status).toBe(405);
    expect(mcpGet.headers.get('allow')).toBe('POST');
  });

  it('formats the accepted IPv6 loopback host as a valid URL', async () => {
    handle = await startMcpServer(new MemoryStorage(), { host: '::1', port: 0 });
    expect(handle.url).toMatch(/^http:\/\/\[::1\]:\d+\/mcp$/);
    const response = await fetch(`${new URL(handle.url).origin}/healthz`);
    expect(response.status).toBe(200);
  });
});
