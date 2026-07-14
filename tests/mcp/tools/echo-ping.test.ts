import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startMcpServer, type McpServerHandle } from '../../../src/mcp/server.js';
import { MemoryStorage } from '../../../src/storage/memory.js';
import { captureStdout } from '../../fixtures/stdout.js';

interface ToolContent {
  type: string;
  text: string;
}

interface CallToolResultLike {
  content?: ToolContent[];
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
}

interface ToolListEntry {
  name: string;
  description?: string;
  inputSchema?: unknown;
  outputSchema?: unknown;
  annotations?: { readOnlyHint?: boolean };
}

async function withClient<T>(
  url: string,
  fn: (client: Client) => Promise<T>,
): Promise<T> {
  const transport = new StreamableHTTPClientTransport(new URL(url));
  const client = new Client({ name: 'echo-test', version: '0.0.0' });
  await client.connect(transport);
  try {
    return await fn(client);
  } finally {
    await client.close();
  }
}

describe('echo_ping (item 025: outputSchema + structuredContent + readOnlyHint)', () => {
  let handle: McpServerHandle | null = null;
  let restoreStdout: () => void;
  let store: MemoryStorage;

  beforeEach(() => {
    ({ restore: restoreStdout } = captureStdout());
    store = new MemoryStorage();
  });

  afterEach(async () => {
    if (handle !== null) {
      await handle.stop();
      handle = null;
    }
    restoreStdout();
  });

  it('tools/list advertises outputSchema and readOnlyHint annotation', async () => {
    handle = await startMcpServer(store, { port: 0 });
    const tools = await withClient(handle.url, async (c) => c.listTools());
    const found = tools.tools.find((t) => t.name === 'echo_ping') as
      | ToolListEntry
      | undefined;
    expect(found).toBeDefined();
    expect(found?.outputSchema).toBeDefined();
    expect(found?.annotations?.readOnlyHint).toBe(true);
  });

  it('tools/call returns both `content` (text JSON) and `structuredContent` whose JSON content matches', async () => {
    handle = await startMcpServer(store, { port: 0 });
    const result = (await withClient(handle.url, async (c) =>
      c.callTool({ name: 'echo_ping', arguments: { message: 'hello' } }),
    )) as CallToolResultLike;
    expect(result.isError).toBeFalsy();
    expect(result.content?.[0]?.type).toBe('text');
    const parsed = JSON.parse(result.content![0]!.text) as Record<string, unknown>;
    expect(parsed['pong']).toBe(true);
    expect(parsed['received']).toBe('hello');
    expect(typeof parsed['ts']).toBe('string');
    expect(result.structuredContent).toBeDefined();
    expect(result.structuredContent).toEqual(parsed);
  });
});
