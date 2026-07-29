// B2 (continuation-parameter trap) — runtime unknown-key rejection at the
// REAL MCP boundary. The 0.1.0-beta.5 audit proved unknown top-level input
// keys were silently accepted and stripped before the handler, so a caller
// following the old description literally (`membership_cursor: ...` as an
// input key) silently lost continuation and got a legacy-shaped listing.
// These tests go through startMcpServer + a real SDK client so they verify
// the rejection actually fires in the SDK validation path — not merely that
// the published schema text says `additionalProperties: false`.

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startMcpServer, type McpServerHandle } from '../../src/mcp/server.js';
import { FIND_CLUSTERS_DESCRIPTION } from '../../src/mcp/tools/find-clusters.js';
import { MemoryStorage } from '../../src/storage/memory.js';
import { captureStdout } from '../fixtures/stdout.js';

interface ToolContent {
  type: string;
  text: string;
}

interface CallToolResultLike {
  content?: ToolContent[];
  isError?: boolean;
}

interface JsonSchemaLike {
  properties?: Record<string, { pattern?: string; minItems?: number }>;
  additionalProperties?: boolean;
  anyOf?: unknown[];
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

// The server rejects with JSON-RPC InvalidParams (-32602); the SDK client
// re-presents that as a resolved `{ isError: true }` envelope whose text
// carries the validation message. Either surface is a loud failure — this
// helper accepts both so the assertion tracks the rejection, not the SDK
// client's presentation choice.
async function callExpectingValidationError(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<string> {
  let result: CallToolResultLike;
  try {
    result = (await client.callTool({ name, arguments: args })) as CallToolResultLike;
  } catch (err) {
    return (err as Error).message;
  }
  expect(result.isError, `${name} must fail closed, got success envelope`).toBe(true);
  return result.content?.map((entry) => entry.text).join('\n') ?? '';
}

const SINCE = '2026-07-22T10:00:00.000Z';
const UNTIL = '2026-07-22T14:00:00.000Z';

async function seedProjectTurn(
  store: MemoryStorage,
  root: string,
  turnId: string,
  ts: string,
): Promise<void> {
  await store.append({
    source: `fs:${root}/.claude/projects/demo/${turnId}.jsonl`,
    timestamp: ts,
    content: `USER: q-${turnId}\n\nASSISTANT: a-${turnId}`,
    metadata: {
      session_id: turnId,
      logical_turn_id: turnId,
      occurred_at: ts,
      observed_at: ts,
      observation_kind: 'original',
      initiator: 'human',
      thread_id: turnId,
      repo_root: root,
      canonical_root: root,
      project_key: `local:workspace:${root}`,
    },
  });
}

// Minimal schema-valid arguments per tool, so appending one bogus key is the
// ONLY reason a call may be rejected.
const MINIMAL_VALID_ARGS: Record<string, Record<string, unknown>> = {
  echo_ping: {},
  search_memories: {},
  find_clusters: {},
  get_atoms: { atom_ids: ['atom-1'] },
  get_atom: { id: 'atom-1' },
  wait_for_new_turns: {
    sources: ['claude_code'],
    since: '2026-05-09T00:00:00.000Z',
    timeout: 0,
  },
  echo_resolve_mru: { sources: ['claude_code'] },
};

describe('MCP boundary — unknown-key rejection (B2)', () => {
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

  it('every registered tool rejects an unknown top-level key, naming it', async () => {
    const storage = new MemoryStorage();
    handle = await startMcpServer(storage, { port: 0 });

    await withClient(handle.url, async (client) => {
      const tools = await client.listTools();
      const names = tools.tools.map((t) => t.name).sort();
      expect(names).toEqual(Object.keys(MINIMAL_VALID_ARGS).sort());

      for (const [name, valid] of Object.entries(MINIMAL_VALID_ARGS)) {
        const message = await callExpectingValidationError(client, name, {
          ...valid,
          zzz_bogus: 1,
        });
        // "Input validation error" proves the SDK schema-validation path
        // fired (InvalidParams before the handler), not a handler-side
        // isError envelope.
        expect(message, `${name} rejection`).toContain('Input validation error');
        expect(message, `${name} rejection must name the key`).toContain('zzz_bogus');
      }
    });
  });

  it('find_clusters membership_cursor/next_cursor input keys get trap-specific guidance naming `cursor`', async () => {
    const storage = new MemoryStorage();
    handle = await startMcpServer(storage, { port: 0 });

    await withClient(handle.url, async (client) => {
      const membership = await callExpectingValidationError(client, 'find_clusters', {
        membership_cursor: 'opaque',
      });
      expect(membership).toMatch(/membership_cursor[\s\S]*`cursor` parameter/);
      const next = await callExpectingValidationError(client, 'find_clusters', {
        next_cursor: 'opaque',
      });
      expect(next).toMatch(/next_cursor[\s\S]*`cursor` parameter/);
    });
  });

  it('valid cursor-only continuation still works through the strict boundary', async () => {
    const storage = new MemoryStorage();
    await seedProjectTurn(storage, '/workspace/alpha', 'turn-a', '2026-07-22T10:30:00.000Z');
    await seedProjectTurn(storage, '/workspace/beta', 'turn-b', '2026-07-22T11:00:00.000Z');
    handle = await startMcpServer(storage, { port: 0 });

    await withClient(handle.url, async (client) => {
      const first = (await client.callTool({
        name: 'find_clusters',
        arguments: { since: SINCE, until: UNTIL, group_by: 'project', page_size: 1 },
      })) as CallToolResultLike;
      expect(first.isError).not.toBe(true);
      const firstBody = JSON.parse(first.content![0]!.text) as {
        groups?: { group_id: string }[];
        next_cursor?: string | null;
      };
      expect(firstBody.groups).toHaveLength(1);
      expect(firstBody.next_cursor).toBeTruthy();

      const second = (await client.callTool({
        name: 'find_clusters',
        arguments: { cursor: firstBody.next_cursor },
      })) as CallToolResultLike;
      expect(second.isError).not.toBe(true);
      const secondBody = JSON.parse(second.content![0]!.text) as {
        groups?: { group_id: string }[];
        next_cursor?: string | null;
      };
      expect(secondBody.groups).toHaveLength(1);
      expect(secondBody.groups![0]!.group_id).not.toBe(firstBody.groups![0]!.group_id);
    });
  });

  it('publishes additionalProperties:false for all seven tools', async () => {
    const storage = new MemoryStorage();
    handle = await startMcpServer(storage, { port: 0 });

    const tools = await withClient(handle.url, async (client) => client.listTools());
    expect(tools.tools).toHaveLength(7);
    for (const tool of tools.tools) {
      const schema = tool.inputSchema as JsonSchemaLike;
      expect(schema.additionalProperties, `${tool.name} additionalProperties`).toBe(false);
    }
  });
});

describe('MCP boundary — wait_for_new_turns timezone trap (B3)', () => {
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

  it('published since pattern requires an explicit offset; siblings stay warn-only', async () => {
    const storage = new MemoryStorage();
    handle = await startMcpServer(storage, { port: 0 });

    const tools = await withClient(handle.url, async (client) => client.listTools());
    const wait = tools.tools.find((t) => t.name === 'wait_for_new_turns');
    const waitSince = (wait?.inputSchema as JsonSchemaLike).properties?.['since'];
    expect(waitSince?.pattern).toBeDefined();
    const waitRe = new RegExp(waitSince!.pattern!);
    expect(waitRe.test('2026-07-28T10:00:00Z')).toBe(true);
    expect(waitRe.test('2026-07-28T10:00:00.123Z')).toBe(true);
    expect(waitRe.test('2026-07-28T10:00:00+02:00')).toBe(true);
    expect(waitRe.test('2026-07-28T10:00:00.123-0700')).toBe(true);
    expect(waitRe.test('2026-07-28T10:00:00')).toBe(false);
    expect(waitRe.test('2026-07-28T10:00:00.123')).toBe(false);

    const fc = tools.tools.find((t) => t.name === 'find_clusters');
    const fcSince = (fc?.inputSchema as JsonSchemaLike).properties?.['since'];
    expect(fcSince?.pattern).toBeDefined();
    expect(new RegExp(fcSince!.pattern!).test('2026-07-28T10:00:00')).toBe(true);
  });

  it('rejects an offset-less since at the boundary', async () => {
    const storage = new MemoryStorage();
    handle = await startMcpServer(storage, { port: 0 });

    await withClient(handle.url, async (client) => {
      const message = await callExpectingValidationError(client, 'wait_for_new_turns', {
        sources: ['claude_code'],
        since: '2026-07-28T10:00:00',
        timeout: 0,
      });
      expect(message).toContain('Input validation error');
      expect(message).toContain('since');
      expect(message).toContain('explicit offset');
    });
  });

  it('expresses the non-empty sources/source_prefix disjunction as schema anyOf', async () => {
    const storage = new MemoryStorage();
    handle = await startMcpServer(storage, { port: 0 });

    const tools = await withClient(handle.url, async (client) => client.listTools());
    const wait = tools.tools.find((t) => t.name === 'wait_for_new_turns');
    const schema = wait?.inputSchema as JsonSchemaLike;
    expect(schema.anyOf).toEqual([
      { required: ['sources'], properties: { sources: { minItems: 1 } } },
      { required: ['source_prefix'] },
    ]);
  });
});

describe('find_clusters continuation description (B2 wording)', () => {
  it('every continuation instruction names `cursor` as the request parameter', () => {
    expect(FIND_CLUSTERS_DESCRIPTION).toContain('`next_cursor` value in the `cursor` parameter');
    expect(FIND_CLUSTERS_DESCRIPTION).toContain(
      '`membership_cursor` value in the `cursor` parameter',
    );
    expect(FIND_CLUSTERS_DESCRIPTION).not.toMatch(
      /`(?:next_cursor|membership_cursor)` by itself/,
    );
  });
});
