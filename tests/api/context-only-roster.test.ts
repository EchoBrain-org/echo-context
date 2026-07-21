import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { homedir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { startMcpServer, type McpServerHandle } from '../../src/mcp/server.js';
import { MemoryStorage } from '../../src/storage/memory.js';

// AC3: the standalone echo-context MCP roster is EXACTLY these eight read-only
// context tools — no coord/product/loop extras, and capture is service-only.
const EXPECTED_TOOLS = [
  'echo_ping',
  'echo_resolve_mru',
  'find_clusters',
  'get_atom',
  'get_atoms',
  'get_recent_work_context',
  'search_memories',
  'wait_for_new_turns',
];

let handle: McpServerHandle | undefined;

afterEach(async () => {
  await handle?.stop();
  handle = undefined;
});

async function listToolNames(url: string): Promise<string[]> {
  return withClient(url, async (client) => {
    const { tools } = await client.listTools();
    return tools.map((t) => t.name).sort();
  });
}

async function withClient<T>(url: string, use: (client: Client) => Promise<T>): Promise<T> {
  const transport = new StreamableHTTPClientTransport(new URL(url));
  const client = new Client({ name: 'roster-test', version: '0.0.0' });
  await client.connect(transport);
  try {
    return await use(client);
  } finally {
    await client.close();
  }
}

describe('AC3 — context-only MCP roster', () => {
  it('exposes exactly the eight context tools and no product/loop tools', async () => {
    handle = await startMcpServer(new MemoryStorage(), { port: 0 });
    const names = await listToolNames(handle.url);
    expect(names).toEqual(EXPECTED_TOOLS);
  });

  it('registers no coord/product/loop tool', async () => {
    handle = await startMcpServer(new MemoryStorage(), { port: 0 });
    const names = await listToolNames(handle.url);
    for (const forbidden of [
      'coord_emit',
      'coord_invoke',
      'coord_status',
      'get_role_state',
      'list_task_states',
      'pending_decisions',
      'propose_decision',
    ]) {
      expect(names).not.toContain(forbidden);
    }
  });

  it('executes every current context tool through the live server', async () => {
    const storage = new MemoryStorage();
    const source = `fs:${homedir()}/.codex/sessions/2026/07/21/rollout-current-contract.jsonl`;
    const atomId = await storage.append({
      source,
      timestamp: '2026-07-21T12:00:00.000Z',
      content: 'USER: alpha work\n\nASSISTANT: current runtime contract',
      metadata: {
        cwd: '/fixture/repo',
        repo_root: '/fixture/repo',
        session_id: 'current-contract',
        turn_index: 0,
      },
    });
    handle = await startMcpServer(storage, { port: 0 });
    const calls = [
      { name: 'echo_ping', arguments: { message: 'current-contract' } },
      { name: 'echo_resolve_mru', arguments: { sources: ['codex'] } },
      {
        name: 'find_clusters',
        arguments: { since: '2026-07-21T11:00:00.000Z', until: '2026-07-21T13:00:00.000Z' },
      },
      { name: 'get_atom', arguments: { id: atomId } },
      { name: 'get_atoms', arguments: { atom_ids: [atomId], format: 'minimal' } },
      {
        name: 'get_recent_work_context',
        arguments: {
          since: '2026-07-21T11:00:00.000Z',
          until: '2026-07-21T13:00:00.000Z',
          limit: 10,
          format: 'minimal',
        },
      },
      { name: 'search_memories', arguments: { query: 'alpha', limit: 10 } },
      {
        name: 'wait_for_new_turns',
        arguments: { sources: ['codex'], since: '2026-07-21T11:00:00.000Z', timeout: 0 },
      },
    ];

    const results = await withClient(handle.url, async (client) => {
      const observed = new Map<string, Record<string, unknown>>();
      for (const call of calls) {
        const result = await client.callTool(call);
        expect(result.isError).not.toBe(true);
        const content = result.content;
        expect(Array.isArray(content)).toBe(true);
        if (!Array.isArray(content) || content[0]?.type !== 'text') {
          throw new Error(`${call.name} returned no text content`);
        }
        observed.set(
          call.name,
          JSON.parse(content[0].text) as Record<string, unknown>,
        );
      }
      return observed;
    });

    expect(calls.map((call) => call.name)).toEqual(EXPECTED_TOOLS);
    expect(results.get('echo_ping')).toMatchObject({
      pong: true,
      received: 'current-contract',
    });
    expect(JSON.stringify(results.get('echo_resolve_mru'))).toContain(source);
    for (const tool of [
      'find_clusters',
      'get_atom',
      'get_atoms',
      'get_recent_work_context',
      'search_memories',
      'wait_for_new_turns',
    ]) {
      expect(JSON.stringify(results.get(tool)), tool).toContain(atomId);
    }
  });
});
