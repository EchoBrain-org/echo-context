import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
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
  const transport = new StreamableHTTPClientTransport(new URL(url));
  const client = new Client({ name: 'roster-test', version: '0.0.0' });
  await client.connect(transport);
  try {
    const { tools } = await client.listTools();
    return tools.map((t) => t.name).sort();
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
});
