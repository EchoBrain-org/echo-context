import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startMcpServer, type McpServerHandle } from '../../src/mcp/server.js';
import { MemoryStorage } from '../../src/storage/memory.js';
import { captureStdout } from '../fixtures/stdout.js';

interface PingResult {
  pong: boolean;
  received: string | undefined;
  ts: string;
}

interface ToolContent {
  type: string;
  text: string;
}

interface CallToolResultLike {
  content?: ToolContent[];
}

async function withClient<T>(url: string, fn: (client: Client) => Promise<T>): Promise<T> {
  const transport = new StreamableHTTPClientTransport(new URL(url));
  const client = new Client({ name: 'echo-test', version: '0.0.0' });
  await client.connect(transport);
  try {
    return await fn(client);
  } finally {
    await client.close();
  }
}

describe('startMcpServer', () => {
  let handle: McpServerHandle | null = null;
  let restoreStdout: () => void;

  beforeEach(() => {
    ({ restore: restoreStdout } = captureStdout());
  });

  afterEach(async () => {
    if (handle !== null) {
      await handle.stop();
      handle = null;
    }
    restoreStdout();
  });

  it('boots on an ephemeral port and exposes a stable url shape', async () => {
    const storage = new MemoryStorage();
    handle = await startMcpServer(storage, { port: 0 });

    expect(handle.port).toBeGreaterThan(0);
    expect(handle.url).toBe(`http://127.0.0.1:${handle.port}/mcp`);
  });

  it('binds only to 127.0.0.1 (no 0.0.0.0)', async () => {
    const storage = new MemoryStorage();
    handle = await startMcpServer(storage, { port: 0 });
    expect(handle.url.startsWith('http://127.0.0.1:')).toBe(true);
  });

  it('lists echo_ping via tools/list', async () => {
    const storage = new MemoryStorage();
    handle = await startMcpServer(storage, { port: 0 });

    const tools = await withClient(handle.url, async (client) => client.listTools());

    const found = tools.tools.find((t) => t.name === 'echo_ping');
    expect(found).toBeDefined();
    expect(found?.description).toContain('Connectivity check');
  });

  it('echo_ping returns pong + received message + iso timestamp', async () => {
    const storage = new MemoryStorage();
    handle = await startMcpServer(storage, { port: 0 });

    const result = (await withClient(handle.url, async (client) =>
      client.callTool({
        name: 'echo_ping',
        arguments: { message: 'hello' },
      }),
    )) as CallToolResultLike;

    const content = result.content?.[0];
    expect(content).toBeDefined();
    expect(content?.type).toBe('text');
    const parsed = JSON.parse(content!.text) as PingResult;
    expect(parsed.pong).toBe(true);
    expect(parsed.received).toBe('hello');
    expect(parsed.ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  it('echo_ping handles a missing message argument', async () => {
    const storage = new MemoryStorage();
    handle = await startMcpServer(storage, { port: 0 });

    const result = (await withClient(handle.url, async (client) =>
      client.callTool({
        name: 'echo_ping',
        arguments: {},
      }),
    )) as CallToolResultLike;

    const content = result.content?.[0];
    expect(content).toBeDefined();
    const parsed = JSON.parse(content!.text) as PingResult;
    expect(parsed.pong).toBe(true);
    expect(parsed.received).toBeUndefined();
  });

  it('tools/call find_clusters view=compact passes structuredContent validation', async () => {
    const storage = new MemoryStorage();
    for (let i = 0; i < 2; i++) {
      await storage.append({
        source: `fs:/Users/redacted/.claude/projects/demo/session.jsonl`,
        timestamp: `2026-05-20T10:0${i}:00.000Z`,
        content: `USER: q${i}\n\nASSISTANT: a${i}`,
        metadata: {
          session_id: 'sess_compact',
          turn_index: i,
          files_referenced: ['/repo/a.ts'],
        },
      });
    }
    handle = await startMcpServer(storage, { port: 0 });

    const result = (await withClient(handle.url, async (client) =>
      client.callTool({
        name: 'find_clusters',
        arguments: {
          since: '2026-05-20T09:00:00.000Z',
          until: '2026-05-20T11:00:00.000Z',
          view: 'compact',
        },
      }),
    )) as CallToolResultLike & { structuredContent?: Record<string, unknown>; isError?: boolean };

    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toBeDefined();
    expect(result.structuredContent?.['query']).toBeDefined();
    expect(result.structuredContent?.['result_caps']).toBeDefined();
    expect(result.structuredContent?.['clusters']).toBeDefined();
  });

  it('tools/call find_clusters group_by=project validates the grouped union shape', async () => {
    const storage = new MemoryStorage();
    await storage.append({
      source: 'fs:/repo/.codex/sessions/2026/05/20/rollout.jsonl',
      timestamp: '2026-05-20T10:00:00.000Z',
      content: 'USER: q\n\nASSISTANT: a',
      metadata: {
        session_id: 'sess',
        logical_turn_id: 'turn',
        observation_kind: 'original',
        occurred_at: '2026-05-20T10:00:00.000Z',
        root_thread_id: 'root',
        thread_id: 'root',
        repo_root: '/repo',
        canonical_root: '/repo',
        project_key: 'local:workspace:/repo',
      },
    });
    handle = await startMcpServer(storage, { port: 0 });

    const result = (await withClient(handle.url, async (client) =>
      client.callTool({
        name: 'find_clusters',
        arguments: {
          since: '2026-05-20T09:00:00.000Z',
          until: '2026-05-20T11:00:00.000Z',
          group_by: 'project',
        },
      }),
    )) as CallToolResultLike & {
      structuredContent?: Record<string, unknown>;
      isError?: boolean;
    };

    expect(result.isError).not.toBe(true);
    expect(result.structuredContent?.['mode']).toBe('groups');
    expect(result.structuredContent?.['clusters']).toEqual([]);
    expect(result.structuredContent?.['groups']).toEqual([
      expect.objectContaining({
        project_key: 'local:workspace:/repo',
        unique_turn_count: 1,
        raw_observation_count: 1,
      }),
    ]);
    expect(result.structuredContent?.['next_cursor']).toBeNull();
  });

  it('tools/call get_atoms view=compact passes structuredContent validation', async () => {
    const storage = new MemoryStorage();
    const id = await storage.append({
      source: 'fs:/Users/dev/.codex/sessions/2026/05/20/rollout.jsonl',
      timestamp: '2026-05-20T10:00:00.000Z',
      content: 'USER: q\n\nASSISTANT: a',
      metadata: {
        session_id: 'sess_codex',
        repo_root: '/repo',
        tool_calls: [{ name: 'exec_command', args: 'x'.repeat(2_000), output: 'y'.repeat(2_000) }],
        tool_call_total: 1,
        codex: { model: 'gpt-5.5', reasoning_effort: 'xhigh', sandbox_policy_type: 'read-only' },
        git: { branch: 'agent/compact', sha: 'abc' },
      },
    });
    handle = await startMcpServer(storage, { port: 0 });

    const result = (await withClient(handle.url, async (client) =>
      client.callTool({
        name: 'get_atoms',
        arguments: { atom_ids: [id], view: 'compact' },
      }),
    )) as CallToolResultLike & { structuredContent?: Record<string, unknown>; isError?: boolean };

    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toBeDefined();
    expect(result.structuredContent?.['atoms']).toBeDefined();
    expect(result.structuredContent?.['atoms_dropped']).toBe(0);
    expect(result.structuredContent?.['atoms_missing']).toBe(0);
    expect(result.structuredContent?.['atoms_deferred']).toBe(0);
    expect(result.structuredContent?.['next_cursor']).toBeNull();
    expect(result.structuredContent?.['warnings']).toEqual([]);
  });

  it('stop() closes the listener so subsequent connections fail', async () => {
    const storage = new MemoryStorage();
    handle = await startMcpServer(storage, { port: 0 });
    const url = handle.url;
    await handle.stop();
    handle = null;

    let failed = false;
    try {
      await withClient(url, async (client) => client.listTools());
    } catch {
      failed = true;
    }
    expect(failed).toBe(true);
  });

  it('logs `started` with port + url + host', async () => {
    const { writes, restore } = captureStdout();
    try {
      const storage = new MemoryStorage();
      handle = await startMcpServer(storage, { port: 0 });
      const startedLine = writes.find((line) => {
        try {
          const entry = JSON.parse(line.trim()) as Record<string, unknown>;
          return entry['source'] === 'mcp.server' && entry['message'] === 'started';
        } catch {
          return false;
        }
      });
      expect(startedLine).toBeDefined();
      const entry = JSON.parse(startedLine!.trim()) as Record<string, unknown>;
      const payload = entry['payload'] as Record<string, unknown>;
      expect(payload['host']).toBe('127.0.0.1');
      expect(typeof payload['port']).toBe('number');
      expect(typeof payload['url']).toBe('string');
    } finally {
      restore();
    }
  });

  // --- Stateless transport regression tests (item 027) ----------------------
  //
  // These pin ECHO's MCP HTTP behavior to the documented stateless mode of
  // StreamableHTTPServerTransport (sessionIdGenerator: undefined,
  // enableJsonResponse: true). The motivating failure is Codex's RMCP client
  // continuing to send a stale `Mcp-Session-Id` header after the ECHO daemon
  // restarts. Pre-fix that produced HTTP 400 `no active session`, which Codex
  // surfaced as `Deserialize error: data did not match any variant of untagged
  // enum JsonRpcMessage`. Post-fix the server has no session memory at all,
  // so a stale header is ignored and the request succeeds.

  async function rawPost(
    url: string,
    body: object,
    extraHeaders: Record<string, string> = {},
  ): Promise<{ status: number; headers: Headers; text: string }> {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Accept: 'application/json, text/event-stream',
        'Content-Type': 'application/json',
        ...extraHeaders,
      },
      body: JSON.stringify(body),
    });
    return { status: res.status, headers: res.headers, text: await res.text() };
  }

  it('tools/call echo_ping with a stale Mcp-Session-Id and no prior initialize succeeds (HTTP 200)', async () => {
    // Root-cause regression test: simulates Codex's exact failure path after
    // an ECHO daemon restart. The new process has no session map, so a stale
    // session header from a long-lived client must NOT trigger the old
    // "no active session" 400. With stateless transport the header is ignored.
    const storage = new MemoryStorage();
    handle = await startMcpServer(storage, { port: 0 });

    const resp = await rawPost(
      handle.url,
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'echo_ping', arguments: { message: 'after-restart' } },
      },
      { 'Mcp-Session-Id': 'stale-codex-session' },
    );

    expect(resp.status).toBe(200);
    // Stateless mode advertises no session header on responses.
    expect(resp.headers.get('mcp-session-id')).toBeNull();

    // JSON response mode: content-type is application/json, body is a single
    // JSON-RPC envelope (not an SSE stream).
    expect(resp.headers.get('content-type')).toMatch(/application\/json/);
    const env = JSON.parse(resp.text) as {
      jsonrpc: string;
      id: number;
      result?: { content?: { type: string; text: string }[] };
      error?: unknown;
    };
    expect(env.jsonrpc).toBe('2.0');
    expect(env.error).toBeUndefined();
    const text = env.result?.content?.[0]?.text;
    expect(typeof text).toBe('string');
    const parsed = JSON.parse(text!) as { pong: boolean; received?: string };
    expect(parsed.pong).toBe(true);
    expect(parsed.received).toBe('after-restart');
  });

  it('initialize over raw HTTP returns application/json and no Mcp-Session-Id header', async () => {
    const storage = new MemoryStorage();
    handle = await startMcpServer(storage, { port: 0 });

    const resp = await rawPost(handle.url, {
      jsonrpc: '2.0',
      id: 0,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'echo-test', version: '0.0.0' },
      },
    });

    expect(resp.status).toBe(200);
    expect(resp.headers.get('content-type')).toMatch(/application\/json/);
    expect(resp.headers.get('mcp-session-id')).toBeNull();
    const env = JSON.parse(resp.text) as {
      jsonrpc: string;
      id: number;
      result?: { protocolVersion: string };
      error?: unknown;
    };
    expect(env.jsonrpc).toBe('2.0');
    expect(env.error).toBeUndefined();
    expect(env.result?.protocolVersion).toBeDefined();
  });

  it('GET /mcp returns 405 with Allow: POST and a JSON-RPC-style error body', async () => {
    const storage = new MemoryStorage();
    handle = await startMcpServer(storage, { port: 0 });

    for (const headers of [undefined, { 'Mcp-Session-Id': 'whatever' } as Record<string, string>]) {
      const res = await fetch(handle.url, {
        method: 'GET',
        headers,
      });
      expect(res.status).toBe(405);
      expect(res.headers.get('allow')).toBe('POST');
      const body = JSON.parse(await res.text()) as {
        jsonrpc: string;
        error: { code: number; message: string };
      };
      expect(body.jsonrpc).toBe('2.0');
      expect(body.error.code).toBe(-32000);
      expect(body.error.message.toLowerCase()).toContain('not allowed');
    }
  });

  it('DELETE /mcp returns 405 with Allow: POST and a JSON-RPC-style error body', async () => {
    const storage = new MemoryStorage();
    handle = await startMcpServer(storage, { port: 0 });

    for (const headers of [undefined, { 'Mcp-Session-Id': 'whatever' } as Record<string, string>]) {
      const res = await fetch(handle.url, {
        method: 'DELETE',
        headers,
      });
      expect(res.status).toBe(405);
      expect(res.headers.get('allow')).toBe('POST');
      const body = JSON.parse(await res.text()) as {
        jsonrpc: string;
        error: { code: number; message: string };
      };
      expect(body.jsonrpc).toBe('2.0');
      expect(body.error.code).toBe(-32000);
      expect(body.error.message.toLowerCase()).toContain('not allowed');
    }
  });

  it('advertised URL is http://127.0.0.1:<port>/mcp (loopback only)', async () => {
    const storage = new MemoryStorage();
    handle = await startMcpServer(storage, { port: 0 });
    expect(handle.url).toBe(`http://127.0.0.1:${handle.port}/mcp`);
  });
});
