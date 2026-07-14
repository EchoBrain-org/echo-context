import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resetRecentMcpCallLogForTests } from '../../src/mcp/request-log.js';
import { startMcpServer, type McpServerHandle } from '../../src/mcp/server.js';
import { MemoryStorage } from '../../src/storage/memory.js';
import { captureStdout } from '../fixtures/stdout.js';

interface JsonRpcEnvelope {
  jsonrpc: string;
  id: number;
  result?: { isError?: boolean };
  error?: unknown;
}

interface RecentCallsResponse {
  calls: {
    ts: number;
    tool: string;
    args_shape: Record<string, unknown>;
    result_shape: Record<string, unknown>;
    duration_ms: number | null;
    status: 'pending' | 'ok' | 'error';
  }[];
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

async function rawPost(url: string, body: object): Promise<{ status: number; text: string }> {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Accept: 'application/json, text/event-stream',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  return { status: res.status, text: await res.text() };
}

async function recentCalls(baseUrl: string, since: number): Promise<RecentCallsResponse> {
  const res = await fetch(`${baseUrl}/mcp/recent-calls?since=${since}`);
  expect(res.status).toBe(200);
  return (await res.json()) as RecentCallsResponse;
}

function minimalArgs(tool: string): Record<string, unknown> {
  switch (tool) {
    case 'echo_ping':
      return { message: 'audit-smoke' };
    case 'search_memories':
      return { query: 'no-match', limit: 1 };
    case 'get_recent_work_context':
      return { limit: 1, format: 'skeleton' };
    case 'find_clusters':
      return {};
    case 'get_atoms':
      return { atom_ids: ['missing'], format: 'minimal' };
    case 'wait_for_new_turns':
      return { source_prefix: 'test:', since: new Date().toISOString(), timeout: 0 };
    case 'get_atom':
      return { id: 'missing' };
    case 'echo_resolve_mru':
      return { sources: ['codex'] };
    case 'get_role_state':
      return { task_id: 'missing', role: 'builder' };
    case 'list_task_states':
      return {};
    case 'pending_decisions':
      return { repo_path: '/tmp' };
    case 'coord_emit':
      return {
        event_type: 'tick_start',
        schema_version: 1,
        subject_role: 'codex',
        tick_run_id: 'audit-test',
        emitted_at: new Date().toISOString(),
      };
    case 'propose_decision':
      return { subject: 'smoke', decision: 'smoke decision', source_app: 'codex' };
    default:
      throw new Error(`No recent-calls smoke args for registered tool '${tool}'`);
  }
}

describe('GET /mcp/recent-calls', () => {
  let handle: McpServerHandle | null = null;
  let restoreStdout: () => void;

  beforeEach(() => {
    resetRecentMcpCallLogForTests();
    ({ restore: restoreStdout } = captureStdout());
  });

  afterEach(async () => {
    if (handle !== null) {
      await handle.stop();
      handle = null;
    }
    restoreStdout();
    resetRecentMcpCallLogForTests();
  });

  it('logs every runtime-registered tool through the wrapper', async () => {
    handle = await startMcpServer(new MemoryStorage(), { port: 0 });
    const baseUrl = new URL(handle.url).origin;
    const tools = await withClient(handle.url, async (client) => client.listTools());
    const toolNames = tools.tools.map((tool) => tool.name).sort();
    const seen = new Set<string>();

    for (const tool of toolNames) {
      await new Promise((resolve) => setTimeout(resolve, 2));
      const since = Date.now();
      const resp = await rawPost(handle.url, {
        jsonrpc: '2.0',
        id: toolNames.indexOf(tool) + 1,
        method: 'tools/call',
        params: { name: tool, arguments: minimalArgs(tool) },
      });
      expect(resp.status).toBe(200);
      const envelope = JSON.parse(resp.text) as JsonRpcEnvelope;
      expect(envelope.jsonrpc).toBe('2.0');
      expect(envelope.error).toBeUndefined();
      expect(envelope.result).toBeDefined();

      const audit = await recentCalls(baseUrl, since);
      const entries = audit.calls.filter((entry) => entry.tool === tool);
      expect(entries).toHaveLength(1);
      const entry = entries[0]!;
      expect(entry.ts).toBeGreaterThanOrEqual(since);
      expect(entry.duration_ms).toEqual(expect.any(Number));
      expect(entry.args_shape).toEqual(expect.objectContaining({ arg_keys: expect.any(Array) }));
      expect(entry.result_shape).toEqual(expect.any(Object));
      expect(entry.status).toBe(envelope.result?.isError === true ? 'error' : 'ok');
      seen.add(tool);
    }

    expect([...seen].sort()).toEqual(toolNames);
  }, 15_000);

  it('filters recent calls by status and keeps HEAD /mcp as method-not-allowed', async () => {
    handle = await startMcpServer(new MemoryStorage(), { port: 0 });
    const baseUrl = new URL(handle.url).origin;

    const head = await fetch(handle.url, { method: 'HEAD' });
    expect(head.status).toBe(405);

    await rawPost(handle.url, {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'search_memories',
        // conflicting repo_path + metadata_match.repo_root is a documented isError path
        arguments: { query: 'x', repo_path: '/a', metadata_match: { repo_root: '/b' } },
      },
    });

    const errors = await fetch(`${baseUrl}/mcp/recent-calls?since=0&status=error`);
    expect(errors.status).toBe(200);
    const body = (await errors.json()) as RecentCallsResponse;
    expect(body.calls.map((call) => call.tool)).toEqual(['search_memories']);
  });
});
