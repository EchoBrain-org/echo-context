import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  SEARCH_SCAN_PAGE_ROWS,
  searchMemories,
  type SearchResult,
} from '../../../src/mcp/tools/search-memories.js';
import { startMcpServer, type McpServerHandle } from '../../../src/mcp/server.js';
import { MemoryStorage } from '../../../src/storage/memory.js';
import type { CaptureEvent } from '../../../src/storage/interface.js';
import { captureStdout } from '../../fixtures/stdout.js';

interface ToolContent {
  type: string;
  text: string;
}

interface CallToolResultLike {
  content?: ToolContent[];
  isError?: boolean;
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

// 3 cursor-chat + 3 claude-code + 2 git events, with varied timestamps and content.
async function seedFixtureEvents(store: MemoryStorage): Promise<void> {
  const events: Omit<CaptureEvent, 'id'>[] = [
    {
      source: 'cursor-chat:workspace-a',
      timestamp: '2026-04-25T09:00:00.000Z',
      content: 'discussing TypeScript stack with the team',
      metadata: { workspace_id: 'a', thread_id: 't1' },
    },
    {
      source: 'cursor-chat:workspace-a',
      timestamp: '2026-04-26T10:00:00.000Z',
      content: 'reviewing PR for the new auth flow',
      metadata: { workspace_id: 'a', thread_id: 't2' },
    },
    {
      source: 'cursor-chat:workspace-b',
      timestamp: '2026-04-27T11:00:00.000Z',
      content: 'pricing experiment notes — needle in cursor only',
    },
    {
      source: 'claude-code:session-1',
      timestamp: '2026-04-25T12:00:00.000Z',
      content: 'building the MCP server skeleton',
    },
    {
      source: 'claude-code:session-1',
      timestamp: '2026-04-26T13:00:00.000Z',
      content: 'wiring up storage and capture pipeline',
    },
    {
      source: 'claude-code:session-2',
      timestamp: '2026-04-27T14:00:00.000Z',
      content: 'debug session for the git watcher',
    },
    {
      source: 'git:project-echo',
      timestamp: '2026-04-26T15:00:00.000Z',
      content: 'commit: add storage interface',
    },
    {
      source: 'git:project-echo',
      timestamp: '2026-04-28T16:00:00.000Z',
      content: 'commit: ship MCP scaffold',
    },
  ];
  for (const e of events) {
    await store.append(e);
  }
}

describe('searchMemories (pure handler)', () => {
  let store: MemoryStorage;

  beforeEach(async () => {
    store = new MemoryStorage();
    await seedFixtureEvents(store);
  });

  it('with no params, returns all 8 events ordered by timestamp DESC', async () => {
    const r = await searchMemories(store, {});
    expect(r.total_returned).toBe(8);
    expect(r.limit_applied).toBe(10);
    const ts = r.matches.map((m) => m.timestamp);
    expect(ts).toEqual([...ts].sort().reverse());
    expect(ts[0]).toBe('2026-04-28T16:00:00.000Z'); // most recent first
  });

  it('query substring filter narrows to a single matching event', async () => {
    const r = await searchMemories(store, { query: 'needle in cursor only' });
    expect(r.total_returned).toBe(1);
    expect(r.matches[0]!.content).toContain('needle in cursor only');
  });

  it('query is case-insensitive', async () => {
    const r = await searchMemories(store, { query: 'TYPESCRIPT' });
    expect(r.total_returned).toBe(1);
    expect(r.matches[0]!.content).toContain('TypeScript');
  });

  it('source_prefix "cursor-chat:" returns only the 3 cursor events', async () => {
    const r = await searchMemories(store, { source_prefix: 'cursor-chat:' });
    expect(r.total_returned).toBe(3);
    expect(r.matches.every((m) => m.source.startsWith('cursor-chat:'))).toBe(true);
  });

  it('source_prefix "git:" returns only the 2 git events', async () => {
    const r = await searchMemories(store, { source_prefix: 'git:' });
    expect(r.total_returned).toBe(2);
    expect(r.matches.every((m) => m.source.startsWith('git:'))).toBe(true);
  });

  it('source_prefix "claude-code:" returns only the 3 claude-code events', async () => {
    const r = await searchMemories(store, { source_prefix: 'claude-code:' });
    expect(r.total_returned).toBe(3);
    expect(r.matches.every((m) => m.source.startsWith('claude-code:'))).toBe(true);
  });

  it('since (inclusive) and until (exclusive) bound the window', async () => {
    const r = await searchMemories(store, {
      since: '2026-04-26T00:00:00.000Z',
      until: '2026-04-28T00:00:00.000Z',
    });
    // events on 26th and 27th: 2 cursor + 2 claude + 1 git = 5
    expect(r.total_returned).toBe(5);
    for (const m of r.matches) {
      expect(m.timestamp >= '2026-04-26T00:00:00.000Z').toBe(true);
      expect(m.timestamp < '2026-04-28T00:00:00.000Z').toBe(true);
    }
  });

  it('limit=2 returns the 2 most recent events', async () => {
    const r = await searchMemories(store, { limit: 2 });
    expect(r.total_returned).toBe(2);
    expect(r.limit_applied).toBe(2);
    expect(r.matches[0]!.timestamp).toBe('2026-04-28T16:00:00.000Z');
    expect(r.matches[1]!.timestamp).toBe('2026-04-27T14:00:00.000Z');
  });

  it('combined query + source_prefix + limit returns the correct intersection', async () => {
    const r = await searchMemories(store, {
      query: 'commit',
      source_prefix: 'git:',
      limit: 5,
    });
    expect(r.total_returned).toBe(2);
    expect(r.matches.every((m) => m.source.startsWith('git:'))).toBe(true);
    expect(r.matches.every((m) => m.content.toLowerCase().includes('commit'))).toBe(true);
    // most recent first
    expect(r.matches[0]!.timestamp).toBe('2026-04-28T16:00:00.000Z');
  });

  it('clamps limit > 50 down to 50', async () => {
    const r = await searchMemories(store, { limit: 100 });
    expect(r.limit_applied).toBe(50);
  });

  it('clamps non-positive limit up to 1', async () => {
    const r = await searchMemories(store, { limit: 0 });
    expect(r.limit_applied).toBe(1);
    expect(r.total_returned).toBe(1);
  });

  it('query_echo reflects original parameters and applied limit', async () => {
    const r = await searchMemories(store, {
      query: 'auth',
      source_prefix: 'cursor-chat:',
      since: '2026-04-26T00:00:00.000Z',
      limit: 3,
    });
    expect(r.query_echo).toEqual({
      query: 'auth',
      source_app: null,
      source_prefix: 'cursor-chat:',
      source: null,
      since: '2026-04-26T00:00:00.000Z',
      until: null,
      cursor: null,
      limit: 3,
      repo_path: null,
      metadata_match: null,
    });
  });

  it('preserves metadata when present, omits when absent', async () => {
    const r = await searchMemories(store, { query: 'TypeScript' });
    expect(r.matches[0]!.metadata).toEqual({ workspace_id: 'a', thread_id: 't1' });
    const r2 = await searchMemories(store, { query: 'commit' });
    expect(r2.matches[0]!.metadata).toBeUndefined();
  });

  it('returns 0 matches when query has no hits', async () => {
    const r = await searchMemories(store, { query: 'no-such-needle-anywhere' });
    expect(r.total_returned).toBe(0);
    expect(r.matches).toHaveLength(0);
  });

  it('filter-before-slice: out-of-overfetch substring match is still returned (item 022 Bug D)', async () => {
    const fresh = new MemoryStorage();
    // Seed 30 events; the i=5 (6th oldest = 25th-newest) carries a unique
    // substring. Pre-fix: limit=5 produces overfetch=20, which slices to the
    // newest 20 BEFORE applying the content filter, so the 25th-newest match
    // is dropped. Post-fix: filter runs across all events first, then slice.
    for (let i = 0; i < 30; i++) {
      const ts = new Date(Date.UTC(2026, 0, 1, 0, i, 0)).toISOString();
      await fresh.append({
        source: 'git:bulk',
        timestamp: ts,
        content: i === 5 ? 'needle-out-of-overfetch' : `event-${i}`,
      });
    }
    const r = await searchMemories(fresh, {
      query: 'needle-out-of-overfetch',
      limit: 5,
    });
    expect(r.total_returned).toBe(1);
    expect(r.matches[0]!.content).toBe('needle-out-of-overfetch');
  });

  it('description clarifies substring (not semantic) search (item 022 Bug E)', async () => {
    // SEARCH_MEMORIES_DESCRIPTION is exported; the e2e test below also
    // verifies it via tools/list, but a unit-level assertion makes the
    // intent explicit.
    const { SEARCH_MEMORIES_DESCRIPTION } =
      await import('../../../src/mcp/tools/search-memories.js');
    expect(SEARCH_MEMORIES_DESCRIPTION).toMatch(/case-insensitive literal substring/);
    expect(SEARCH_MEMORIES_DESCRIPTION).toMatch(/NOT a semantic/);
  });

  it('recency-only path returns DESC top-N regardless of fixture size', async () => {
    const big = new MemoryStorage();
    // 250 events spanning 250 minutes; the most-recent 50 should win for a limit=50 query.
    for (let i = 0; i < 250; i++) {
      const ts = new Date(Date.UTC(2026, 0, 1, 0, i, 0)).toISOString();
      await big.append({
        source: 'git:bulk',
        timestamp: ts,
        content: `commit-${i}`,
      });
    }
    const r = await searchMemories(big, { limit: 50 });
    expect(r.total_returned).toBe(50);
    // most recent should be commit-249
    expect(r.matches[0]!.content).toBe('commit-249');
    expect(r.matches[49]!.content).toBe('commit-200');
  });
});

// Bug A — per-match content envelope cap.
//
// Surfaced by the 2026-05-08 15:54 PDT post-026+027 dogfooding round:
// `search_memories(query='JSON-RPC', source_app='codex')` returned only 3
// matches but 318,574 chars total — single matches at 138k / 85k / 94k. A
// real Codex turn JSONL atom is ~100KB, and the response had no per-match
// content cap at all. Distinct from Bug 3 (cluster envelope in
// get_recent_work_context).
//
// Contract: each match's `content` is capped at PER_MATCH_CONTENT_CAP chars
// total. When elided, the content becomes head + elision marker + tail, and
// `bytes_elided` carries the dropped char count so the consumer can size the
// remainder.
describe('searchMemories Bug A — per-match content envelope cap', () => {
  it('content under cap is returned verbatim with no bytes_elided field', async () => {
    const store = new MemoryStorage();
    await store.append({
      source: 'fs:tiny',
      timestamp: '2026-05-08T22:00:00.000Z',
      content: 'short turn that fits well under the per-match cap',
    });
    const r = await searchMemories(store, {});
    expect(r.matches).toHaveLength(1);
    expect(r.matches[0]!.content).toBe('short turn that fits well under the per-match cap');
    expect(r.matches[0]!.bytes_elided).toBeUndefined();
    // V1.6 (item 030): truncations is always present (empty when nothing clipped).
    expect(r.matches[0]!.truncations).toEqual([]);
  });

  it('content over cap is elided to head + marker + tail; bytes_elided reports dropped chars', async () => {
    const store = new MemoryStorage();
    // 100 KB of repeating text — mirrors the 15:54 PDT real-world ~100KB
    // Codex match shape that motivated this fix.
    const head = 'HEAD_SENTINEL_' + 'a'.repeat(50_000);
    const tail = 'b'.repeat(50_000) + '_TAIL_SENTINEL';
    const big = head + tail;
    expect(big.length).toBe(100_028);
    await store.append({
      source: 'fs:big.jsonl',
      timestamp: '2026-05-08T22:00:00.000Z',
      content: big,
    });

    const r = await searchMemories(store, {});

    expect(r.matches).toHaveLength(1);
    const m = r.matches[0]!;
    // Net match content is bounded by the cap + a small marker overhead, NOT
    // the original 100KB. Cap is the load-bearing invariant; assert it here.
    expect(m.content.length).toBeLessThanOrEqual(2500);
    // Both ends present — caller can identify the original by sentinel
    // strings without reading the middle.
    expect(m.content.startsWith('HEAD_SENTINEL_')).toBe(true);
    expect(m.content.endsWith('_TAIL_SENTINEL')).toBe(true);
    // Elision marker is present and references a positive char count.
    expect(m.content).toMatch(/\[\d+\s*chars elided\]/);
    // bytes_elided is exposed as a top-level field on the match for
    // programmatic consumers, and its value plus retained content equals the
    // original byte length.
    expect(typeof m.bytes_elided).toBe('number');
    expect(m.bytes_elided).toBeGreaterThan(0);
    // V1.6 (item 030): content cap fired → truncations contains "content".
    expect(m.truncations).toContain('content');
  });

  it('total response envelope stays under the consumer 25k budget on a 10× ~100KB-match fixture (the 15:54 PDT failure mode)', async () => {
    const store = new MemoryStorage();
    // Reproduce the 15:54 PDT shape exactly: many large matches under the
    // codex prefix, all matching a substring query. Pre-fix: 3 matches blew
    // 318k chars. Post-fix: even 10 matches must stay under 25k.
    for (let i = 0; i < 10; i++) {
      await store.append({
        source: `fs:codex-${i}.jsonl`,
        timestamp: `2026-05-08T22:00:${i.toString().padStart(2, '0')}.000Z`,
        content: `JSON-RPC turn ${i} ` + 'x'.repeat(100_000), // 100KB body, like the real Codex turns
      });
    }

    const r = await searchMemories(store, { query: 'JSON-RPC', limit: 10 });

    expect(r.total_returned).toBe(10);
    const envelopeBytes = JSON.stringify(r).length;
    // Hard envelope ceiling — the load-bearing acceptance check.
    expect(envelopeBytes).toBeLessThan(25_000);
    // Every match contributes a bytes_elided field, since each original
    // content was ~100KB.
    expect(r.matches.every((m) => typeof m.bytes_elided === 'number')).toBe(true);
  });

  it('V1.5.6 — total envelope stays under 25k on a 10× ~100KB-METADATA-tool_calls fixture (the 16:14 PDT failure mode)', async () => {
    // Reproduce the 16:14 PDT post-Bug-A1-merge failure: content was capped
    // (correctly) but metadata.tool_calls was 120-130KB per atom, so the
    // per-match envelope was still ~133KB. Three matches blew the budget by
    // 12.2× even after Bug A1's content cap. The V1.5.6 wire-shape
    // projector's per-KEY metadata cap is what closes this. Test fails on a
    // manual revert of the metadata cap — proves it's load-bearing.
    const store = new MemoryStorage();
    for (let i = 0; i < 10; i++) {
      await store.append({
        source: `fs:codex-${i}.jsonl`,
        timestamp: `2026-05-08T22:00:${i.toString().padStart(2, '0')}.000Z`,
        content: `JSON-RPC turn ${i} short body`,
        metadata: {
          // Small structured neighbours that should pass through verbatim.
          session_id: `019e09${i}`,
          turn_index: i,
          byte_offset: 100_000 + i,
          git_state: { branch: 'main' },
          // Variadic heavy field — the actual bloat source post-026/027.
          tool_calls: Array.from({ length: 30 }, (_, j) => ({
            name: 'exec_command',
            args: 'a'.repeat(2_000),
            output: 'b'.repeat(1_000),
            call_id: `call_${j}`,
          })), // ~95KB serialized per atom
        },
      });
    }

    const r = await searchMemories(store, { query: 'JSON-RPC', limit: 10 });

    expect(r.total_returned).toBe(10);
    const envelopeBytes = JSON.stringify(r).length;
    expect(envelopeBytes).toBeLessThan(25_000);
    // V1.5.6.1: tool_calls is now PROJECTED to a name trajectory (workflow
    // shape), not opaqued out. Distinct from the per-key elision path.
    expect(r.matches.every((m) => m.metadata_keys_projected?.includes('tool_calls'))).toBe(true);
    expect(r.matches.every((m) => typeof m.metadata_bytes_elided === 'number')).toBe(true);
    // Trajectory survives — every match carries the 30-entry exec_command
    // workflow as a string array and a sibling histogram.
    expect(
      r.matches.every(
        (m) =>
          Array.isArray(m.metadata?.['tool_calls']) &&
          (m.metadata!['tool_calls'] as string[]).length === 30,
      ),
    ).toBe(true);
    expect(r.matches.every((m) => m.metadata?.['tool_calls_by_name'] !== undefined)).toBe(true);
    // Per-KEY semantics: small structured metadata neighbours pass verbatim.
    expect(r.matches.every((m) => m.metadata?.['session_id'] !== undefined)).toBe(true);
    expect(r.matches.every((m) => m.metadata?.['git_state'] !== undefined)).toBe(true);
  });
});

// Gap 3 (V1.5.7, surfaced 2026-05-08 17:01 PDT v1.5-livetest): search_memories
// must EXCLUDE fs-watcher meta-events (`metadata.surface === 'fs'`) — same
// discipline as `recent-work-context.ts:171` and `tail-session.ts:94-99`.
// V1.5.6's Bug B fix landed in tail_session and recent-work-context but not
// here; the cursor lane surfaced it because Cursor's extractor was stale and
// the noise dominated, but the same contract violation applies to every
// source_app.
describe('searchMemories Gap 3 — fs-watcher meta-events must be excluded', () => {
  it('source_app cursor: returns extractor turns, not fs-watcher events under the same prefix', async () => {
    const store = new MemoryStorage();
    const HOME = process.env['HOME'] ?? '/tmp';
    const cursorPrefix = `fs:${HOME}/Library/Application Support/Cursor/`;
    const wsRoot = `${cursorPrefix}User/workspaceStorage/abc/`;

    // Seed five fs-watcher events on workspace files (the noisy meta-stream
    // — every file mtime tick) AND two cursor extractor turn atoms.
    for (let i = 0; i < 5; i++) {
      await store.append({
        source: `${wsRoot}cursor-retrieval/embeddable_files.txt`,
        timestamp: `2026-05-08T22:00:${i.toString().padStart(2, '0')}.000Z`,
        content: JSON.stringify({
          event_type: 'change',
          path: `${wsRoot}cursor-retrieval/embeddable_files.txt`,
          mtime: `2026-05-08T22:00:${i}.000Z`,
          size: 1234 + i,
        }),
        metadata: { surface: 'fs', file_kind: 'cursor-workspace' },
      });
    }
    for (let i = 0; i < 2; i++) {
      await store.append({
        source: `${cursorPrefix}User/globalStorage/state.vscdb`,
        timestamp: `2026-05-08T22:10:${i.toString().padStart(2, '0')}.000Z`,
        content: `EXTRACTOR_TURN_${i}: cursor user said something`,
        metadata: { workspace_id: 'abc', thread_id: 't1' },
      });
    }

    const r = await searchMemories(store, { source_app: 'cursor', limit: 10 });

    // Pre-fix: would return 5 fs-watcher events (newest by ts among the
    // matching prefix). Post-fix: returns only the 2 extractor turns.
    expect(r.total_returned).toBe(2);
    expect(r.matches.every((m) => m.content.startsWith('EXTRACTOR_TURN_'))).toBe(true);
    expect(r.matches.every((m) => (m.metadata as { surface?: string }).surface !== 'fs')).toBe(
      true,
    );
  });

  it('no source_app: fs exclusion still applies (whole-store substring search)', async () => {
    const store = new MemoryStorage();
    await store.append({
      source: 'fs:/some/path.jsonl',
      timestamp: '2026-05-08T22:00:00.000Z',
      content: JSON.stringify({ event_type: 'change' }),
      metadata: { surface: 'fs' },
    });
    await store.append({
      source: 'fs:/some/path.jsonl',
      timestamp: '2026-05-08T22:10:00.000Z',
      content: 'real conversation about the change event',
      metadata: { session_id: 's1' },
    });

    const r = await searchMemories(store, { query: 'change', limit: 10 });

    // Both atoms have "change" in content, but the fs-watcher one must be
    // excluded. Only the conversation turn survives.
    expect(r.total_returned).toBe(1);
    expect(r.matches[0]!.content).toBe('real conversation about the change event');
  });
});

// Gap 6 (V1.5.7, surfaced 2026-05-08 17:01 PDT v1.5-livetest): the TZ-naive
// warning is emitted by get_recent_work_context but was silent on
// search_memories despite the two tools sharing the same regex. Lifted into
// `src/mcp/util/iso8601.ts`; both tools now emit the same TZ_NAIVE_WARNING.
describe('searchMemories Gap 6 — TZ-naive timestamp warning parity', () => {
  it('warnings is always present (empty when no advisories)', async () => {
    const store = new MemoryStorage();
    await store.append({
      source: 'fs:x',
      timestamp: '2026-05-08T22:00:00.000Z',
      content: 'hello',
    });
    const r = await searchMemories(store, { limit: 5 });
    expect(Array.isArray(r.warnings)).toBe(true);
    expect(r.warnings).toEqual([]);
  });

  it('emits TZ_NAIVE_WARNING when `since` lacks a TZ marker', async () => {
    const store = new MemoryStorage();
    const r = await searchMemories(store, { since: '2026-05-08T22:00:00' });
    expect(r.warnings.length).toBe(1);
    expect(r.warnings[0]).toMatch(/lacks a TZ specifier/);
  });

  it('emits TZ_NAIVE_WARNING when `until` lacks a TZ marker', async () => {
    const store = new MemoryStorage();
    const r = await searchMemories(store, { until: '2026-05-08T22:00:00' });
    expect(r.warnings.length).toBe(1);
    expect(r.warnings[0]).toMatch(/lacks a TZ specifier/);
  });

  it('does NOT emit when both inputs carry a TZ marker (Z, +HH:MM)', async () => {
    const store = new MemoryStorage();
    const r = await searchMemories(store, {
      since: '2026-05-08T22:00:00.000Z',
      until: '2026-05-08T23:00:00+00:00',
    });
    expect(r.warnings).toEqual([]);
  });

  it('idempotent — single warning even when both inputs are naive', async () => {
    const store = new MemoryStorage();
    const r = await searchMemories(store, {
      since: '2026-05-08T22:00:00',
      until: '2026-05-08T23:00:00',
    });
    expect(r.warnings.length).toBe(1);
  });

  it('naive window filters as local time and still emits the [TZ] warning', async () => {
    const store = new MemoryStorage();
    await store.append({
      source: 'fs:x',
      timestamp: new Date('2026-05-08T22:30:00').toISOString(),
      content: 'inside local window',
    });
    await store.append({
      source: 'fs:x',
      timestamp: new Date('2026-05-08T23:30:00').toISOString(),
      content: 'outside local window',
    });

    const r = await searchMemories(store, {
      source: 'fs:x',
      since: '2026-05-08T22:00:00',
      until: '2026-05-08T23:00:00',
      limit: 5,
    });

    expect(r.matches.map((m) => m.content)).toEqual(['inside local window']);
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]).toMatch(/^\[TZ\]/);
  });
});

describe('search_memories (end-to-end via MCP server)', () => {
  let handle: McpServerHandle | null = null;
  let restoreStdout: () => void;
  let store: MemoryStorage;

  beforeEach(async () => {
    ({ restore: restoreStdout } = captureStdout());
    store = new MemoryStorage();
    await seedFixtureEvents(store);
  });

  afterEach(async () => {
    if (handle !== null) {
      await handle.stop();
      handle = null;
    }
    restoreStdout();
  });

  it('lists search_memories via tools/list with the documented description', async () => {
    handle = await startMcpServer(store, { port: 0 });
    const tools = await withClient(handle.url, async (c) => c.listTools());
    const found = tools.tools.find((t) => t.name === 'search_memories');
    expect(found).toBeDefined();
    expect(found?.description).toContain("Search the user's captured ECHO memories");
  });

  it('invokes search_memories and returns filtered, DESC-sorted results', async () => {
    handle = await startMcpServer(store, { port: 0 });
    const result = (await withClient(handle.url, async (c) =>
      c.callTool({
        name: 'search_memories',
        arguments: { source_prefix: 'cursor-chat:', limit: 2 },
      }),
    )) as CallToolResultLike;

    expect(result.isError).toBeFalsy();
    const text = result.content?.[0]?.text;
    expect(text).toBeDefined();
    const parsed = JSON.parse(text!) as SearchResult;
    expect(parsed.total_returned).toBe(2);
    expect(parsed.limit_applied).toBe(2);
    expect(parsed.matches.every((m) => m.source.startsWith('cursor-chat:'))).toBe(true);
    expect(parsed.matches[0]!.timestamp).toBe('2026-04-27T11:00:00.000Z');
    expect(parsed.matches[1]!.timestamp).toBe('2026-04-26T10:00:00.000Z');
  });

  it('returns a tool error (not a crash) on a malformed `since` timestamp', async () => {
    handle = await startMcpServer(store, { port: 0 });
    const result = (await withClient(handle.url, async (c) =>
      c.callTool({
        name: 'search_memories',
        arguments: { since: 'yesterday' },
      }),
    )) as CallToolResultLike;
    // SDK wraps zod failure into an error response — server stays up, no crash.
    expect(result.isError).toBe(true);
    // Sanity: server is still alive and responsive afterwards.
    const ok = (await withClient(handle.url, async (c) =>
      c.callTool({ name: 'search_memories', arguments: {} }),
    )) as CallToolResultLike;
    expect(ok.isError).toBeFalsy();
  });

  it('returns a tool error on a malformed `until` timestamp', async () => {
    handle = await startMcpServer(store, { port: 0 });
    const result = (await withClient(handle.url, async (c) =>
      c.callTool({
        name: 'search_memories',
        arguments: { until: 'next-week' },
      }),
    )) as CallToolResultLike;
    expect(result.isError).toBe(true);
  });

  it('combined filter end-to-end produces the spec-shaped JSON envelope', async () => {
    handle = await startMcpServer(store, { port: 0 });
    const result = (await withClient(handle.url, async (c) =>
      c.callTool({
        name: 'search_memories',
        arguments: {
          query: 'commit',
          source_prefix: 'git:',
          since: '2026-04-26T00:00:00.000Z',
          until: '2026-04-30T00:00:00.000Z',
          limit: 10,
        },
      }),
    )) as CallToolResultLike;
    const parsed = JSON.parse(result.content![0]!.text) as SearchResult;
    expect(parsed.total_returned).toBe(2);
    expect(parsed.limit_applied).toBe(10);
    expect(parsed.query_echo.query).toBe('commit');
    expect(parsed.query_echo.source_prefix).toBe('git:');
    expect(parsed.query_echo.since).toBe('2026-04-26T00:00:00.000Z');
    expect(parsed.query_echo.until).toBe('2026-04-30T00:00:00.000Z');
    expect(parsed.matches[0]!.id).toBeDefined();
    expect(parsed.matches[0]!.source).toMatch(/^git:/);
  });
});

describe('search_memories item 025 (outputSchema + readOnlyHint + source_app + cursor)', () => {
  let handle: McpServerHandle | null = null;
  let restoreStdout: () => void;
  let store: MemoryStorage;

  beforeEach(async () => {
    ({ restore: restoreStdout } = captureStdout());
    store = new MemoryStorage();
    await seedFixtureEvents(store);
  });

  afterEach(async () => {
    if (handle !== null) {
      await handle.stop();
      handle = null;
    }
    restoreStdout();
  });

  interface ToolListEntry {
    name: string;
    description?: string;
    inputSchema?: { properties?: Record<string, unknown> };
    outputSchema?: unknown;
    annotations?: { readOnlyHint?: boolean };
  }

  it('tools/list advertises outputSchema, readOnlyHint, and source_app enum', async () => {
    handle = await startMcpServer(store, { port: 0 });
    const tools = await withClient(handle.url, async (c) => c.listTools());
    const found = tools.tools.find((t) => t.name === 'search_memories') as
      | ToolListEntry
      | undefined;
    expect(found).toBeDefined();
    expect(found?.outputSchema).toBeDefined();
    expect(found?.annotations?.readOnlyHint).toBe(true);
    // source_app appears in the input schema with the pinned enum.
    const props = found?.inputSchema?.properties ?? {};
    expect(props['source_app']).toBeDefined();
    const sourceApp = props['source_app'] as { enum?: string[] };
    expect(new Set(sourceApp.enum)).toEqual(
      new Set(['cursor', 'claude_code', 'codex', 'git', 'granola']),
    );
  });

  it('tools/call returns both content (text JSON) and structuredContent with matching JSON', async () => {
    handle = await startMcpServer(store, { port: 0 });
    interface ResultWithStructured extends CallToolResultLike {
      structuredContent?: Record<string, unknown>;
    }
    const result = (await withClient(handle.url, async (c) =>
      c.callTool({ name: 'search_memories', arguments: { limit: 2 } }),
    )) as ResultWithStructured;
    expect(result.isError).toBeFalsy();
    const text = result.content?.[0]?.text;
    expect(text).toBeDefined();
    const parsed = JSON.parse(text!) as Record<string, unknown>;
    expect(result.structuredContent).toEqual(parsed);
  });

  it('source_app maps to the same matches as the equivalent FS source_prefix', async () => {
    handle = await startMcpServer(store, { port: 0 });
    // Fresh fixture with FS-prefixed sources matching the source_app contract.
    const fresh = new MemoryStorage();
    const HOME = (await import('node:os')).homedir();
    const codexPrefix = `fs:${HOME}/.codex/sessions/`;
    await fresh.append({
      source: `${codexPrefix}2026/05/08/rollout-abc.jsonl`,
      timestamp: '2026-05-08T10:00:00.000Z',
      content: 'codex turn 1',
    });
    await fresh.append({
      source: `${codexPrefix}2026/05/08/rollout-def.jsonl`,
      timestamp: '2026-05-08T10:01:00.000Z',
      content: 'codex turn 2',
    });
    await fresh.append({
      source: 'git:repo',
      timestamp: '2026-05-08T10:02:00.000Z',
      content: 'irrelevant git',
    });
    handle = await startMcpServer(fresh, { port: 0 });

    const byApp = (await withClient(handle.url, async (c) =>
      c.callTool({
        name: 'search_memories',
        arguments: { source_app: 'codex' },
      }),
    )) as CallToolResultLike;
    const parsedByApp = JSON.parse(byApp.content![0]!.text) as SearchResult;

    const byPrefix = (await withClient(handle.url, async (c) =>
      c.callTool({
        name: 'search_memories',
        arguments: { source_prefix: codexPrefix },
      }),
    )) as CallToolResultLike;
    const parsedByPrefix = JSON.parse(byPrefix.content![0]!.text) as SearchResult;

    expect(parsedByApp.matches.map((m) => m.id).sort()).toEqual(
      parsedByPrefix.matches.map((m) => m.id).sort(),
    );
    expect(parsedByApp.matches).toHaveLength(2);
  });

  it("source_app='granola' maps to api:granola atoms", async () => {
    const fresh = new MemoryStorage();
    await fresh.append({
      source: 'api:granola',
      timestamp: '2026-06-21T10:00:00.000Z',
      content: 'Customer asked about deployment timeline',
      metadata: { note_id: 'note-1', granola_atom_type: 'summary' },
    });
    await fresh.append({
      source: 'api:granola',
      timestamp: '2026-06-21T10:01:00.000Z',
      content: 'CEO: We should follow up next week',
      metadata: { note_id: 'note-1', granola_atom_type: 'transcript' },
    });
    await fresh.append({
      source: 'git:/repo',
      timestamp: '2026-06-21T10:02:00.000Z',
      content: 'irrelevant commit',
    });
    handle = await startMcpServer(fresh, { port: 0 });

    const byApp = (await withClient(handle.url, async (c) =>
      c.callTool({
        name: 'search_memories',
        arguments: { source_app: 'granola' },
      }),
    )) as CallToolResultLike;
    const parsed = JSON.parse(byApp.content![0]!.text) as SearchResult;

    expect(parsed.matches).toHaveLength(2);
    expect(parsed.matches.every((m) => m.source === 'api:granola')).toBe(true);
    expect(parsed.query_echo.source_app).toBe('granola');
  });

  it('metadata_match supports scalar equality and array membership for Granola signals', async () => {
    const fresh = new MemoryStorage();
    const oldDecisionId = await fresh.append({
      source: 'derived:granola-signals',
      timestamp: '2026-06-21T10:00:00.000Z',
      content: 'Old pricing decision',
      metadata: {
        signal_type: 'decision',
        canonical_subject: 'pricing',
        extraction_run_id: 'run-old',
      },
    });
    const newDecisionId = await fresh.append({
      source: 'derived:granola-signals',
      timestamp: '2026-06-21T11:00:00.000Z',
      content: 'New pricing decision',
      metadata: {
        signal_type: 'decision',
        canonical_subject: 'pricing',
        extraction_run_id: 'run-new',
      },
    });
    const newRationaleId = await fresh.append({
      source: 'derived:granola-signals',
      timestamp: '2026-06-21T11:01:00.000Z',
      content: 'Pricing rationale',
      metadata: {
        signal_type: 'rationale',
        canonical_subject: 'pricing',
        extraction_run_id: 'run-new',
      },
    });
    await fresh.append({
      source: 'derived:granola-signals-index',
      timestamp: '2026-06-21T10:01:00.000Z',
      content: '{}',
      metadata: {
        note_id: 'note-1',
        extractor_version: 'v1',
        extraction_run_id: 'run-old',
        completed_at: '2026-06-21T10:01:00.000Z',
        supersedes: null,
        signal_atom_ids: [oldDecisionId],
      },
    });
    await fresh.append({
      source: 'derived:granola-signals-index',
      timestamp: '2026-06-21T11:02:00.000Z',
      content: '{}',
      metadata: {
        note_id: 'note-1',
        extractor_version: 'v2',
        extraction_run_id: 'run-new',
        completed_at: '2026-06-21T11:02:00.000Z',
        supersedes: 'run-old',
        signal_atom_ids: [newDecisionId, newRationaleId],
      },
    });

    const r = await searchMemories(fresh, {
      query: 'pricing',
      metadata_match: {
        source: 'derived:granola-signals',
        signal_type: ['decision', 'rationale'],
        canonical_subject: 'pricing',
      },
    });

    expect(r.matches.map((m) => m.content)).toEqual(['Pricing rationale', 'New pricing decision']);
    expect(r.matches.map((m) => m.id)).not.toContain(oldDecisionId);
    expect(r.query_echo.metadata_match).toEqual({
      source: 'derived:granola-signals',
      signal_type: ['decision', 'rationale'],
      canonical_subject: 'pricing',
    });
  });

  it('metadata_match granola_atom_type keeps the summary-only lane queryable', async () => {
    const fresh = new MemoryStorage();
    await fresh.append({
      source: 'api:granola',
      timestamp: '2026-06-21T10:00:00.000Z',
      content: 'Deployment summary with customer signal',
      metadata: { note_id: 'note-1', granola_atom_type: 'summary' },
    });
    await fresh.append({
      source: 'api:granola',
      timestamp: '2026-06-21T10:01:00.000Z',
      content: 'Deployment transcript with customer signal',
      metadata: { note_id: 'note-1', granola_atom_type: 'transcript' },
    });

    const r = await searchMemories(fresh, {
      query: 'customer signal',
      metadata_match: { source: 'api:granola', granola_atom_type: 'summary' },
    });

    expect(r.matches.map((m) => m.content)).toEqual(['Deployment summary with customer signal']);
    expect(r.matches[0]!.metadata?.['granola_atom_type']).toBe('summary');
  });

  it('source_prefix wins on conflict and query_echo records both raw inputs', async () => {
    handle = await startMcpServer(store, { port: 0 });
    const result = (await withClient(handle.url, async (c) =>
      c.callTool({
        name: 'search_memories',
        arguments: {
          source_app: 'codex',
          source_prefix: 'cursor-chat:',
        },
      }),
    )) as CallToolResultLike;
    const parsed = JSON.parse(result.content![0]!.text) as SearchResult;
    // source_prefix wins (3 cursor-chat events in the fixture).
    expect(parsed.matches.length).toBeGreaterThan(0);
    expect(parsed.matches.every((m) => m.source.startsWith('cursor-chat:'))).toBe(true);
    expect(parsed.query_echo.source_app).toBe('codex');
    expect(parsed.query_echo.source_prefix).toBe('cursor-chat:');
  });

  it('paginates a 60-row recency-only result via next_cursor (no query)', async () => {
    const fresh = new MemoryStorage();
    for (let i = 0; i < 60; i++) {
      const ts = new Date(Date.UTC(2026, 0, 1, 0, i, 0)).toISOString();
      await fresh.append({
        source: 'git:bulk',
        timestamp: ts,
        content: `event-${i}`,
      });
    }
    handle = await startMcpServer(fresh, { port: 0 });

    const first = (await withClient(handle.url, async (c) =>
      c.callTool({ name: 'search_memories', arguments: { limit: 50 } }),
    )) as CallToolResultLike;
    const p1 = JSON.parse(first.content![0]!.text) as SearchResult;
    expect(p1.total_returned).toBe(50);
    expect(p1.next_cursor).not.toBeNull();

    const second = (await withClient(handle.url, async (c) =>
      c.callTool({
        name: 'search_memories',
        arguments: { limit: 50, cursor: p1.next_cursor },
      }),
    )) as CallToolResultLike;
    const p2 = JSON.parse(second.content![0]!.text) as SearchResult;
    expect(p2.total_returned).toBe(10);
    expect(p2.next_cursor).toBeNull();
  });

  it('same-millisecond ties paginate stably without skip or duplicate', async () => {
    const fresh = new MemoryStorage();
    const ts = '2026-05-08T12:00:00.000Z';
    for (const c of ['a', 'b', 'c', 'd', 'e']) {
      await fresh.append({
        source: 'git:bulk',
        timestamp: ts,
        content: c,
        // Use a stable id-shaped content to make assertions readable. The
        // storage will assign random UUIDs; we identify by content instead.
      });
    }
    handle = await startMcpServer(fresh, { port: 0 });

    // Page through 5 same-ms-tied rows in pages of 2; assert no skip / no dup.
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let p = 0; p < 5; p++) {
      const args: Record<string, unknown> = { limit: 2 };
      if (cursor !== null) args['cursor'] = cursor;
      const r = (await withClient(handle.url, async (c) =>
        c.callTool({ name: 'search_memories', arguments: args }),
      )) as CallToolResultLike;
      const parsed = JSON.parse(r.content![0]!.text) as SearchResult;
      for (const m of parsed.matches) seen.push(m.content);
      cursor = parsed.next_cursor;
      if (cursor === null) break;
    }
    expect(seen).toHaveLength(5);
    expect(new Set(seen)).toEqual(new Set(['a', 'b', 'c', 'd', 'e']));
  });

  it('substring-query path paginates by post-filter slice (preserves item 022 invariant)', async () => {
    // Seed 30 events; 6 contain 'needle' at recency ranks 1, 5, 12, 18, 24, 28.
    const fresh = new MemoryStorage();
    const NEEDLE_RANKS = new Set([1, 5, 12, 18, 24, 28]);
    for (let i = 0; i < 30; i++) {
      const ts = new Date(Date.UTC(2026, 0, 1, 0, 30 - i, 0)).toISOString();
      const isNeedle = NEEDLE_RANKS.has(i);
      await fresh.append({
        source: 'git:repo',
        timestamp: ts,
        content: isNeedle ? `event-${i} needle` : `event-${i}`,
      });
    }
    // The 6 needle events end up most-recent-first as i=1, 5, 12, 18, 24, 28
    // (see how the ts is computed: `30 - i` minutes — smaller i = later).
    handle = await startMcpServer(fresh, { port: 0 });

    const first = (await withClient(handle.url, async (c) =>
      c.callTool({
        name: 'search_memories',
        arguments: { query: 'needle', limit: 4 },
      }),
    )) as CallToolResultLike;
    const p1 = JSON.parse(first.content![0]!.text) as SearchResult;
    expect(p1.total_returned).toBe(4);
    expect(p1.next_cursor).not.toBeNull();
    expect(p1.matches.every((m) => m.content.includes('needle'))).toBe(true);

    const second = (await withClient(handle.url, async (c) =>
      c.callTool({
        name: 'search_memories',
        arguments: { query: 'needle', limit: 4, cursor: p1.next_cursor },
      }),
    )) as CallToolResultLike;
    const p2 = JSON.parse(second.content![0]!.text) as SearchResult;
    expect(p2.total_returned).toBe(2);
    expect(p2.next_cursor).toBeNull();
    expect(p2.matches.every((m) => m.content.includes('needle'))).toBe(true);

    // No duplicates across pages.
    const allIds = [...p1.matches, ...p2.matches].map((m) => m.id);
    expect(new Set(allIds).size).toBe(allIds.length);
  });

  it('cursor + until apply both: cursor is inner page boundary, until is outer bound', async () => {
    const fresh = new MemoryStorage();
    for (let i = 0; i < 10; i++) {
      const ts = new Date(Date.UTC(2026, 0, 1, 0, i, 0)).toISOString();
      await fresh.append({
        source: 'git:repo',
        timestamp: ts,
        content: `event-${i}`,
      });
    }
    handle = await startMcpServer(fresh, { port: 0 });

    // Window: until = 0:08 (exclusive). Limit = 3 → page 1: event-7, event-6,
    // event-5; cursor → next page: event-4, event-3, event-2.
    const first = (await withClient(handle.url, async (c) =>
      c.callTool({
        name: 'search_memories',
        arguments: { until: '2026-01-01T00:08:00.000Z', limit: 3 },
      }),
    )) as CallToolResultLike;
    const p1 = JSON.parse(first.content![0]!.text) as SearchResult;
    expect(p1.matches.map((m) => m.content)).toEqual(['event-7', 'event-6', 'event-5']);
    expect(p1.next_cursor).not.toBeNull();

    const second = (await withClient(handle.url, async (c) =>
      c.callTool({
        name: 'search_memories',
        arguments: {
          until: '2026-01-01T00:08:00.000Z',
          limit: 3,
          cursor: p1.next_cursor,
        },
      }),
    )) as CallToolResultLike;
    const p2 = JSON.parse(second.content![0]!.text) as SearchResult;
    expect(p2.matches.map((m) => m.content)).toEqual(['event-4', 'event-3', 'event-2']);
    expect(p2.query_echo.until).toBe('2026-01-01T00:08:00.000Z');
    expect(p2.query_echo.cursor).toBe(p1.next_cursor);
  });

  it('malformed cursor returns isError:true with no structuredContent', async () => {
    handle = await startMcpServer(store, { port: 0 });

    interface ResultWithStructured extends CallToolResultLike {
      structuredContent?: unknown;
    }

    // (a) not base64
    const r1 = (await withClient(handle.url, async (c) =>
      c.callTool({
        name: 'search_memories',
        arguments: { cursor: 'not-base64-at-all-!@#' },
      }),
    )) as ResultWithStructured;
    expect(r1.isError).toBe(true);
    expect(r1.content?.[0]?.text).toMatch(/cursor|JSON|base64|object|field/i);
    expect(r1.structuredContent).toBeUndefined();

    // (b) base64 of '{}' — valid base64, invalid shape
    const r2 = (await withClient(handle.url, async (c) =>
      c.callTool({
        name: 'search_memories',
        arguments: { cursor: Buffer.from('{}').toString('base64') },
      }),
    )) as ResultWithStructured;
    expect(r2.isError).toBe(true);
    expect(r2.structuredContent).toBeUndefined();

    // (c) base64 of '{"timestamp":"..."}' — missing id
    const r3 = (await withClient(handle.url, async (c) =>
      c.callTool({
        name: 'search_memories',
        arguments: {
          cursor: Buffer.from(JSON.stringify({ timestamp: '2026-05-08T12:00:00.000Z' })).toString(
            'base64',
          ),
        },
      }),
    )) as ResultWithStructured;
    expect(r3.isError).toBe(true);
    expect(r3.content?.[0]?.text).toMatch(/id/);
    expect(r3.structuredContent).toBeUndefined();
  });

  it('description mentions source_app, cursor, and three-tool integration', async () => {
    const { SEARCH_MEMORIES_DESCRIPTION } =
      await import('../../../src/mcp/tools/search-memories.js');
    expect(SEARCH_MEMORIES_DESCRIPTION).toMatch(/source_app/);
    expect(SEARCH_MEMORIES_DESCRIPTION).toMatch(
      /cursor.*claude_code.*codex.*git.*granola|next_cursor/,
    );
  });

  // Item 037 / AC3 — repo_path filter.
  it('AC3: repo_path filters results to atoms whose metadata.repo_root matches', async () => {
    const store = new MemoryStorage();
    await store.append({
      source: 'fs:/cursor/a',
      timestamp: '2026-05-10T10:00:00.000Z',
      content: 'in project_echo',
      metadata: { repo_root: '/Users/x/Desktop/Project_echo' },
    });
    await store.append({
      source: 'fs:/cursor/a',
      timestamp: '2026-05-10T11:00:00.000Z',
      content: 'in another repo',
      metadata: { repo_root: '/Users/x/Desktop/Other' },
    });
    await store.append({
      source: 'fs:/cursor/a',
      timestamp: '2026-05-10T12:00:00.000Z',
      content: 'no repo metadata',
    });
    const r = await searchMemories(store, {
      repo_path: '/Users/x/Desktop/Project_echo',
    });
    expect(r.matches.map((m) => m.content)).toEqual(['in project_echo']);
    expect(r.query_echo.repo_path).toBe('/Users/x/Desktop/Project_echo');
  });

  it('AC3: query_echo.repo_path is null when not passed (baseline)', async () => {
    const store = new MemoryStorage();
    await store.append({
      source: 'fs:/cursor/a',
      timestamp: '2026-05-10T10:00:00.000Z',
      content: 'baseline',
    });
    const r = await searchMemories(store, {});
    expect(r.query_echo.repo_path).toBeNull();
  });

  it('AC3: repo_path joins AND with source_app', async () => {
    const store = new MemoryStorage();
    await store.append({
      source: `fs:${process.env['HOME']}/Library/Application Support/Cursor/sess-A`,
      timestamp: '2026-05-10T10:00:00.000Z',
      content: 'cursor in repo',
      metadata: { repo_root: '/r1' },
    });
    await store.append({
      source: `fs:${process.env['HOME']}/.claude/projects/sess-B`,
      timestamp: '2026-05-10T11:00:00.000Z',
      content: 'claude_code in repo',
      metadata: { repo_root: '/r1' },
    });
    const r = await searchMemories(store, {
      source_app: 'claude_code',
      repo_path: '/r1',
    });
    expect(r.matches.map((m) => m.content)).toEqual(['claude_code in repo']);
  });

  it('AC3: repo_path joins AND with since/until', async () => {
    const store = new MemoryStorage();
    await store.append({
      source: 'fs:/x',
      timestamp: '2026-05-09T10:00:00.000Z',
      content: 'too old',
      metadata: { repo_root: '/r1' },
    });
    await store.append({
      source: 'fs:/x',
      timestamp: '2026-05-10T10:00:00.000Z',
      content: 'in window',
      metadata: { repo_root: '/r1' },
    });
    const r = await searchMemories(store, {
      since: '2026-05-10T00:00:00.000Z',
      until: '2026-05-11T00:00:00.000Z',
      repo_path: '/r1',
    });
    expect(r.matches.map((m) => m.content)).toEqual(['in window']);
  });

  it('AC3: rejects non-absolute repo_path with a clear error', async () => {
    const store = new MemoryStorage();
    await expect(searchMemories(store, { repo_path: 'relative/path' })).rejects.toThrow(
      /repo_path must be absolute/,
    );
  });

  it('AC3: repo_path with trailing slash normalises before storage lookup', async () => {
    const store = new MemoryStorage();
    await store.append({
      source: 'fs:/x',
      timestamp: '2026-05-10T10:00:00.000Z',
      content: 'in repo',
      metadata: { repo_root: '/Users/x/Project_echo' },
    });
    const r = await searchMemories(store, {
      repo_path: '/Users/x/Project_echo/',
    });
    expect(r.matches.map((m) => m.content)).toEqual(['in repo']);
    expect(r.query_echo.repo_path).toBe('/Users/x/Project_echo');
  });

  it('substring-query path: every storage scan is row-bounded', async () => {
    // Instrument a storage that records every filter passed to query().
    const calls: Array<Record<string, unknown>> = [];
    const inner = new MemoryStorage();
    for (let i = 0; i < 30; i++) {
      const ts = new Date(Date.UTC(2026, 0, 1, 0, 30 - i, 0)).toISOString();
      await inner.append({
        source: 'git:repo',
        timestamp: ts,
        content: i % 5 === 1 ? `event-${i} needle` : `event-${i}`,
      });
    }
    const recording = {
      append: inner.append.bind(inner),
      count: inner.count.bind(inner),
      query: async (filter?: Record<string, unknown>) => {
        calls.push({ ...(filter ?? {}) });
        return inner.query(filter as Parameters<typeof inner.query>[0]);
      },
    };
    const { searchMemories } = await import('../../../src/mcp/tools/search-memories.js');
    const r = await searchMemories(recording as unknown as Parameters<typeof searchMemories>[0], {
      query: 'needle',
      limit: 4,
    });
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((c) => c['limit'] === SEARCH_SCAN_PAGE_ROWS)).toBe(true);
    expect(r.total_returned).toBeGreaterThan(0);
    expect(r.matches.every((m) => m.content.includes('needle'))).toBe(true);
  });
});

// Item 038 / AC0: `source` (exact) + `metadata_match` expansion.
//
// Tests cover the 3-way precedence rule, the storage whitelist defense, the
// repo_path/repo_root merge precedence + conflict, the next_cursor invariant
// over the new exact filter, and backward compat (calls without the new
// params behave identically to today).
describe('searchMemories — AC0 source (exact) + metadata_match', () => {
  function seedSiblingSources(): Promise<MemoryStorage> {
    const store = new MemoryStorage();
    // Two sibling sources sharing a common prefix; an exact-source filter
    // must hit only one of them, while a prefix filter hits both.
    const ts = (i: number): string => new Date(Date.UTC(2026, 4, 11, 10, i, 0)).toISOString();
    return (async (): Promise<MemoryStorage> => {
      for (let i = 0; i < 4; i++) {
        await store.append({
          source: 'fs:/Users/x/.codex/sessions/rollout-A.jsonl',
          timestamp: ts(i),
          content: `A turn ${i}`,
          metadata: { session_id: 'A', repo_root: '/Users/x/proj-a' },
        });
      }
      for (let i = 0; i < 4; i++) {
        await store.append({
          source: 'fs:/Users/x/.codex/sessions/rollout-B.jsonl',
          timestamp: ts(10 + i),
          content: `B turn ${i}`,
          metadata: { session_id: 'B', repo_root: '/Users/x/proj-b' },
        });
      }
      return store;
    })();
  }

  it('(a) `source` exact filters to a single sibling source (prefix would have caught both)', async () => {
    const store = await seedSiblingSources();
    const r = await searchMemories(store, {
      source: 'fs:/Users/x/.codex/sessions/rollout-A.jsonl',
      limit: 50,
    });
    expect(r.total_returned).toBe(4);
    expect(r.matches.every((m) => m.source === 'fs:/Users/x/.codex/sessions/rollout-A.jsonl')).toBe(
      true,
    );
  });

  it('(b) `source` + `source_prefix` together: `source` wins (more-specific)', async () => {
    const store = await seedSiblingSources();
    // source_prefix would normally catch both rollouts; source wins.
    const r = await searchMemories(store, {
      source: 'fs:/Users/x/.codex/sessions/rollout-A.jsonl',
      source_prefix: 'fs:/Users/x/.codex/sessions/',
      limit: 50,
    });
    expect(r.total_returned).toBe(4);
    expect(r.matches.every((m) => m.source === 'fs:/Users/x/.codex/sessions/rollout-A.jsonl')).toBe(
      true,
    );
  });

  it('(c) `source` + `source_prefix` + `source_app` together: `source` wins', async () => {
    const store = await seedSiblingSources();
    const r = await searchMemories(store, {
      source: 'fs:/Users/x/.codex/sessions/rollout-A.jsonl',
      source_prefix: 'fs:/Users/x/.codex/sessions/',
      source_app: 'codex',
      limit: 50,
    });
    expect(r.total_returned).toBe(4);
    expect(r.matches.every((m) => m.source === 'fs:/Users/x/.codex/sessions/rollout-A.jsonl')).toBe(
      true,
    );
    expect(r.query_echo.source_app).toBe('codex');
    expect(r.query_echo.source_prefix).toBe('fs:/Users/x/.codex/sessions/');
    expect(r.query_echo.source).toBe('fs:/Users/x/.codex/sessions/rollout-A.jsonl');
  });

  it('(d) `metadata_match: {composer_id: X}` filters correctly', async () => {
    const store = new MemoryStorage();
    await store.append({
      source: 'fs:/cursor/state.vscdb',
      timestamp: '2026-05-11T10:00:00.000Z',
      content: 'composer A turn 0',
      metadata: { composer_id: 'comp-A' },
    });
    await store.append({
      source: 'fs:/cursor/state.vscdb',
      timestamp: '2026-05-11T10:01:00.000Z',
      content: 'composer B turn 0',
      metadata: { composer_id: 'comp-B' },
    });
    const r = await searchMemories(store, {
      metadata_match: { composer_id: 'comp-A' },
    });
    expect(r.total_returned).toBe(1);
    expect(r.matches[0]!.content).toBe('composer A turn 0');
  });

  it('(e) non-whitelisted metadata_match key → isError with dynamically-interpolated whitelist message', async () => {
    const store = new MemoryStorage();
    await store.append({
      source: 'fs:/anything',
      timestamp: '2026-05-11T10:00:00.000Z',
      content: 'x',
    });
    let caught: Error | null = null;
    try {
      await searchMemories(store, {
        metadata_match: { not_on_whitelist: 'foo' },
      });
    } catch (err) {
      caught = err as Error;
    }
    expect(caught).not.toBeNull();
    expect(caught!.message).toContain('search_memories: ');
    expect(caught!.message).toContain('not_on_whitelist');
    // Dynamic interpolation: each whitelist key surfaces in the message.
    expect(caught!.message).toContain('workspace_id');
    expect(caught!.message).toContain('composer_id');
    expect(caught!.message).toContain('session_id');
    expect(caught!.message).toContain('repo_root');
  });

  it('(f) query_echo carries both new fields verbatim', async () => {
    const store = await seedSiblingSources();
    const r = await searchMemories(store, {
      source: 'fs:/Users/x/.codex/sessions/rollout-A.jsonl',
      metadata_match: { session_id: 'A' },
    });
    expect(r.query_echo.source).toBe('fs:/Users/x/.codex/sessions/rollout-A.jsonl');
    expect(r.query_echo.metadata_match).toEqual({ session_id: 'A' });
  });

  it('(g) backward compat: calls without the new params behave identically (query_echo.source + metadata_match are null)', async () => {
    const store = await seedSiblingSources();
    const r = await searchMemories(store, {
      source_prefix: 'fs:/Users/x/.codex/sessions/',
      limit: 50,
    });
    expect(r.total_returned).toBe(8);
    expect(r.query_echo.source).toBeNull();
    expect(r.query_echo.metadata_match).toBeNull();
  });

  it('(h) `repo_path` + conflicting `metadata_match.repo_root` → isError', async () => {
    const store = new MemoryStorage();
    await store.append({
      source: 'fs:/x',
      timestamp: '2026-05-11T10:00:00.000Z',
      content: 'x',
      metadata: { repo_root: '/Users/x/proj-a' },
    });
    let caught: Error | null = null;
    try {
      await searchMemories(store, {
        repo_path: '/Users/x/proj-a',
        metadata_match: { repo_root: '/Users/x/proj-b' },
      });
    } catch (err) {
      caught = err as Error;
    }
    expect(caught).not.toBeNull();
    expect(caught!.message).toMatch(
      /search_memories: metadata_match\.repo_root conflicts with repo_path/,
    );
  });

  it('(i) `repo_path` + non-conflicting `metadata_match: {composer_id: X}` → merged correctly (both flow to storage)', async () => {
    const store = new MemoryStorage();
    await store.append({
      source: 'fs:/cursor/state.vscdb',
      timestamp: '2026-05-11T10:00:00.000Z',
      content: 'matching atom',
      metadata: { repo_root: '/Users/x/proj-a', composer_id: 'comp-A' },
    });
    await store.append({
      source: 'fs:/cursor/state.vscdb',
      timestamp: '2026-05-11T10:01:00.000Z',
      content: 'wrong composer',
      metadata: { repo_root: '/Users/x/proj-a', composer_id: 'comp-B' },
    });
    await store.append({
      source: 'fs:/cursor/state.vscdb',
      timestamp: '2026-05-11T10:02:00.000Z',
      content: 'wrong repo',
      metadata: { repo_root: '/Users/x/proj-b', composer_id: 'comp-A' },
    });
    const r = await searchMemories(store, {
      repo_path: '/Users/x/proj-a',
      metadata_match: { composer_id: 'comp-A' },
    });
    expect(r.total_returned).toBe(1);
    expect(r.matches[0]!.content).toBe('matching atom');
  });

  it('(j) next_cursor pagination works with `source` exact filter (source-agnostic)', async () => {
    const store = new MemoryStorage();
    // 12 atoms in one source; paginate at limit=5 → 3 pages.
    for (let i = 0; i < 12; i++) {
      await store.append({
        source: 'fs:/x.jsonl',
        timestamp: new Date(Date.UTC(2026, 4, 11, 10, i, 0)).toISOString(),
        content: `turn-${i}`,
      });
    }
    const p1 = await searchMemories(store, {
      source: 'fs:/x.jsonl',
      limit: 5,
    });
    expect(p1.matches).toHaveLength(5);
    expect(p1.next_cursor).not.toBeNull();
    const p2 = await searchMemories(store, {
      source: 'fs:/x.jsonl',
      limit: 5,
      cursor: p1.next_cursor!,
    });
    expect(p2.matches).toHaveLength(5);
    expect(p2.next_cursor).not.toBeNull();
    const p3 = await searchMemories(store, {
      source: 'fs:/x.jsonl',
      limit: 5,
      cursor: p2.next_cursor!,
    });
    expect(p3.matches).toHaveLength(2);
    expect(p3.next_cursor).toBeNull();
    // Coverage is the union of all three pages, no duplicates.
    const seen = new Set<string>([
      ...p1.matches.map((m) => m.id),
      ...p2.matches.map((m) => m.id),
      ...p3.matches.map((m) => m.id),
    ]);
    expect(seen.size).toBe(12);
  });
});

describe('item 115 AC2 — search-memories consumes filterToCurrentSignalRuns', () => {
  it('excludes orphan signals from a failed manifest append through the tool path', async () => {
    const fresh = new MemoryStorage();
    // run-1 appended a signal atom, then the manifest append "failed" — the
    // orphan atom is referenced by no manifest.
    const orphanId = await fresh.append({
      source: 'derived:granola-signals',
      timestamp: '2026-07-04T10:00:00.000Z',
      content: 'orphan pricing decision',
      metadata: {
        signal_type: 'decision',
        canonical_subject: 'pricing',
        extraction_run_id: 'run-1',
      },
    });
    // Retry run: a fresh signal atom plus a manifest referencing only it.
    const retryId = await fresh.append({
      source: 'derived:granola-signals',
      timestamp: '2026-07-04T10:05:00.000Z',
      content: 'retry pricing decision',
      metadata: {
        signal_type: 'decision',
        canonical_subject: 'pricing',
        extraction_run_id: 'run-2',
      },
    });
    await fresh.append({
      source: 'derived:granola-signals-index',
      timestamp: '2026-07-04T10:06:00.000Z',
      content: '{}',
      metadata: {
        note_id: 'note-1',
        extractor_version: 'v1',
        extraction_run_id: 'run-2',
        completed_at: '2026-07-04T10:06:00.000Z',
        supersedes: null,
        signal_atom_ids: [retryId],
      },
    });

    const r = await searchMemories(fresh, {
      metadata_match: { canonical_subject: 'pricing' },
    });
    const ids = r.matches.map((m) => m.id);
    expect(ids).toContain(retryId);
    expect(ids).not.toContain(orphanId);
  });
});
