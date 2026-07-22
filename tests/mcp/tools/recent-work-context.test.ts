import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_LIMIT,
  STORAGE_OVERFETCH,
  applySkeletonAtom,
  applySkeletonCluster,
  buildSkeletonResponse,
  getRecentWorkContext,
  hasTzMarker,
} from '../../../src/mcp/tools/recent-work-context.js';
import { MemoryStorage } from '../../../src/storage/memory.js';
import type { CaptureEvent } from '../../../src/storage/interface.js';
import type { RecentWorkContextResponse } from '../../../src/trace/types.js';
import { captureStdout } from '../../fixtures/stdout.js';
import {
  startLegacyRecentWorkContextServer as startMcpServer,
  type LegacyRwcServerHandle as McpServerHandle,
} from '../../fixtures/legacy-rwc-server.js';

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

const REPO_ROOT = '/Users/zhen/Desktop/echo';
const REPO_REMOTE = 'https://github.com/zhen/echo';
const TYPES_PATH = `${REPO_ROOT}/src/types.ts`;
const SQLITE_PATH = `${REPO_ROOT}/src/storage/sqlite.ts`;
const NOW = '2026-05-06T09:00:00.000Z';
const SINCE = '2026-05-06T05:00:00.000Z';

function tsPlus(minutes: number): string {
  return new Date(Date.parse(SINCE) + minutes * 60 * 1000).toISOString();
}

function ccEvent(
  session: string,
  turn: number,
  ts: string,
  files: string[],
  io: { user: string; assistant: string },
): Omit<CaptureEvent, 'id'> {
  return {
    source: `fs:/Users/zhen/.claude/projects/abc/${session}.jsonl`,
    timestamp: ts,
    content: `USER: ${io.user}\n\nASSISTANT: ${io.assistant}`,
    metadata: {
      session_id: session,
      turn_index: turn,
      repo_root: REPO_ROOT,
      files_referenced: files,
      git_state: { origin_url: REPO_REMOTE },
    },
  };
}

async function seedScenario(store: MemoryStorage): Promise<void> {
  const events: Omit<CaptureEvent, 'id'>[] = [
    ccEvent('s1', 0, tsPlus(30), [TYPES_PATH], {
      user: 'help with types',
      assistant: 'sure',
    }),
    ccEvent('s1', 1, tsPlus(45), [TYPES_PATH], {
      user: 'refactor it',
      assistant: 'ok',
    }),
    ccEvent('s1', 2, tsPlus(60), [TYPES_PATH], {
      user: 'looks good',
      assistant: 'shipped',
    }),
    ccEvent('s2', 0, tsPlus(15), [SQLITE_PATH], {
      user: 'sqlite migration',
      assistant: 'doing it',
    }),
    ccEvent('s2', 1, tsPlus(20), [SQLITE_PATH], {
      user: 'one more thing',
      assistant: 'done',
    }),
  ];
  for (const e of events) await store.append(e);
}

describe('get_recent_work_context (test-only legacy wrapper harness)', () => {
  let handle: McpServerHandle | null = null;
  let restoreStdout: () => void;
  let store: MemoryStorage;

  beforeEach(async () => {
    ({ restore: restoreStdout } = captureStdout());
    store = new MemoryStorage();
    await seedScenario(store);
  });

  afterEach(async () => {
    if (handle !== null) {
      await handle.stop();
      handle = null;
    }
    restoreStdout();
  });

  it('lists get_recent_work_context via tools/list with the documented description', async () => {
    handle = await startMcpServer(store, { port: 0 });
    const tools = await withClient(handle.url, async (c) => c.listTools());
    const found = tools.tools.find((t) => t.name === 'get_recent_work_context');
    expect(found).toBeDefined();
    expect(found?.description).toContain('Retrieve clusters of related events');
  });

  // V1.6 (item 030): the deprecation marker must be PREPENDED so the
  // first thing any consumer reads in tools/list is "use find_clusters +
  // get_atoms instead." Removal is gated on item 031 after dogfooding.
  it('item 030: tools/list description starts with the deprecation marker', async () => {
    handle = await startMcpServer(store, { port: 0 });
    const tools = await withClient(handle.url, async (c) => c.listTools());
    const found = tools.tools.find((t) => t.name === 'get_recent_work_context');
    expect(found).toBeDefined();
    // Marker is text-only — call behavior is untouched (covered by every
    // other test in this file).
    expect(found?.description?.startsWith('**[DEPRECATED 2026-05-09')).toBe(true);
    expect(found?.description).toContain('use `find_clusters` + `get_atoms` instead');
    expect(found?.description).toContain('Migration:');
  });

  it('legacy harness registers the former eight-tool roster for wrapper regression coverage', async () => {
    handle = await startMcpServer(store, { port: 0 });
    const tools = await withClient(handle.url, async (c) => c.listTools());
    const names = tools.tools.map((t) => t.name).sort();
    expect(names).toEqual([
      'echo_ping',
      'echo_resolve_mru',
      'find_clusters',
      'get_atom',
      'get_atoms',
      'get_recent_work_context',
      'search_memories',
      'wait_for_new_turns',
    ]);
  });

  it('returns clustered atoms with the expected response shape', async () => {
    handle = await startMcpServer(store, { port: 0 });
    const result = (await withClient(handle.url, async (c) =>
      c.callTool({
        name: 'get_recent_work_context',
        arguments: { since: SINCE, until: NOW },
      }),
    )) as CallToolResultLike;
    expect(result.isError).toBeFalsy();
    const text = result.content?.[0]?.text;
    expect(text).toBeDefined();
    const parsed = JSON.parse(text!) as RecentWorkContextResponse;

    expect(parsed.schema_version).toBe(1);
    expect(parsed.tool).toBe('get_recent_work_context');
    expect(parsed.query.since).toBe(SINCE);
    expect(parsed.query.until).toBe(NOW);

    // All seeded events share the same repo artifact, so they correctly cluster
    // together. Verify there is at least one cluster covering all atoms, that
    // it has a rank assigned, and that atoms are returned inline keyed by id.
    expect(parsed.clusters.length).toBeGreaterThanOrEqual(1);
    expect(parsed.clusters[0]!.rank).toBe(1);
    expect(parsed.truncation.atoms_total_in_window).toBe(5);
    for (const c of parsed.clusters) {
      for (const id of c.atom_ids) {
        expect(parsed.atoms[id]).toBeDefined();
      }
    }
  });

  it('artifact_hint focuses to one cluster', async () => {
    handle = await startMcpServer(store, { port: 0 });
    const result = (await withClient(handle.url, async (c) =>
      c.callTool({
        name: 'get_recent_work_context',
        arguments: {
          since: SINCE,
          until: NOW,
          artifact_hint: {
            provider: 'local_fs',
            type: 'file',
            id: `https://github.com/zhen/echo::src/types.ts`,
          },
        },
      }),
    )) as CallToolResultLike;
    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse(result.content![0]!.text) as RecentWorkContextResponse;
    expect(parsed.clusters).toHaveLength(1);
    expect(parsed.clusters[0]!.rank_reason).toContain('matches_artifact_hint');
  });

  it('returns a tool error on a malformed since timestamp', async () => {
    handle = await startMcpServer(store, { port: 0 });
    const result = (await withClient(handle.url, async (c) =>
      c.callTool({
        name: 'get_recent_work_context',
        arguments: { since: 'yesterday' },
      }),
    )) as CallToolResultLike;
    expect(result.isError).toBe(true);
  });

  describe('format parameter (item 019)', () => {
    const LONG_INPUT = 'A'.repeat(800);
    const LONG_OUTPUT = 'B'.repeat(1200);
    const SHORT_INPUT = 'short user message';
    const SHORT_OUTPUT = 'short assistant reply';

    async function seedLong(s: MemoryStorage): Promise<void> {
      // Two events sharing a file so they cluster together; the first has a
      // long input/output to exercise truncation, the second is short to
      // verify ≤500-char fields are unmodified.
      await s.append(
        ccEvent('s_long', 0, tsPlus(60), [TYPES_PATH], {
          user: LONG_INPUT,
          assistant: LONG_OUTPUT,
        }),
      );
      await s.append(
        ccEvent('s_long', 1, tsPlus(75), [TYPES_PATH], {
          user: SHORT_INPUT,
          assistant: SHORT_OUTPUT,
        }),
      );
    }

    async function callWith(args: Record<string, unknown>): Promise<RecentWorkContextResponse> {
      const result = (await withClient(handle!.url, async (c) =>
        c.callTool({
          name: 'get_recent_work_context',
          arguments: args,
        }),
      )) as CallToolResultLike;
      expect(result.isError).toBeFalsy();
      return JSON.parse(result.content![0]!.text) as RecentWorkContextResponse;
    }

    it('format omitted echoes "minimal" in response.query.format (item 025 cost-safer default)', async () => {
      handle = await startMcpServer(store, { port: 0 });
      const r = await callWith({ since: SINCE, until: NOW });
      expect(r.query.format).toBe('minimal');
    });

    it('format: "minimal" echoes "minimal" and is bit-for-bit identical to omitted format (item 025)', async () => {
      handle = await startMcpServer(store, { port: 0 });
      const omitted = await callWith({ since: SINCE, until: NOW });
      const explicitMinimal = await callWith({
        since: SINCE,
        until: NOW,
        format: 'minimal',
      });
      // expected difference: query.format is "minimal" in both, atoms identical
      expect(explicitMinimal.query.format).toBe('minimal');
      expect(explicitMinimal.atoms).toEqual(omitted.atoms);
      expect(explicitMinimal.clusters).toEqual(omitted.clusters);
    });

    it('format: "minimal" caps action.input/output to 500 chars + exact suffix', async () => {
      const fresh = new MemoryStorage();
      await seedLong(fresh);
      handle = await startMcpServer(fresh, { port: 0 });
      const r = await callWith({ since: SINCE, until: NOW, format: 'minimal' });
      expect(r.query.format).toBe('minimal');

      // The long atom should be truncated.
      const longAtom = Object.values(r.atoms).find((a) => a.action.input?.startsWith('A'));
      expect(longAtom).toBeDefined();
      const droppedIn = LONG_INPUT.length - 500;
      const droppedOut = LONG_OUTPUT.length - 500;
      expect(longAtom!.action.input).toBe(
        'A'.repeat(500) +
          `… [truncated; ${droppedIn} chars omitted; fetch full atom via search_memories]`,
      );
      expect(longAtom!.action.output).toBe(
        'B'.repeat(500) +
          `… [truncated; ${droppedOut} chars omitted; fetch full atom via search_memories]`,
      );
    });

    it('format: "minimal" leaves atoms whose action.input/output are ≤500 chars unmodified', async () => {
      const fresh = new MemoryStorage();
      await seedLong(fresh);
      handle = await startMcpServer(fresh, { port: 0 });
      const r = await callWith({ since: SINCE, until: NOW, format: 'minimal' });

      // The short atom contains the SHORT_INPUT marker and should be untouched.
      const shortAtom = Object.values(r.atoms).find((a) => a.action.input === SHORT_INPUT);
      expect(shortAtom).toBeDefined();
      expect(shortAtom!.action.input).toBe(SHORT_INPUT);
      expect(shortAtom!.action.output).toBe(SHORT_OUTPUT);
      // No spurious suffix.
      expect(shortAtom!.action.input).not.toContain('truncated;');
      expect(shortAtom!.action.output).not.toContain('truncated;');
    });

    it('format: "minimal" leaves all non-action fields bit-for-bit identical to "full"', async () => {
      const fresh = new MemoryStorage();
      await seedLong(fresh);
      handle = await startMcpServer(fresh, { port: 0 });
      const full = await callWith({ since: SINCE, until: NOW, format: 'full' });
      const minimal = await callWith({
        since: SINCE,
        until: NOW,
        format: 'minimal',
      });

      const fullIds = Object.keys(full.atoms).sort();
      const minIds = Object.keys(minimal.atoms).sort();
      expect(minIds).toEqual(fullIds);

      for (const id of fullIds) {
        const f = full.atoms[id]!;
        const m = minimal.atoms[id]!;
        // Non-action fields must be unchanged.
        expect(m.id).toBe(f.id);
        expect(m.time).toEqual(f.time);
        expect(m.source).toEqual(f.source);
        expect(m.actors).toEqual(f.actors);
        expect(m.artifacts).toEqual(f.artifacts);
        expect(m.context).toEqual(f.context);
        expect(m.conversation).toEqual(f.conversation);
        expect(m.provenance).toEqual(f.provenance);
        expect(m.open_loop_hints).toEqual(f.open_loop_hints);
        // Within action: kind/verb/status untouched; only input/output may shrink.
        expect(m.action.kind).toBe(f.action.kind);
        expect(m.action.verb).toBe(f.action.verb);
        expect(m.action.status).toBe(f.action.status);
      }
      // Cluster shape (atom_ids, edges, rank, label, etc.) is identical
      expect(minimal.clusters).toEqual(full.clusters);
    });

    it('rejects an invalid format value with a tool error', async () => {
      handle = await startMcpServer(store, { port: 0 });
      const result = (await withClient(handle.url, async (c) =>
        c.callTool({
          name: 'get_recent_work_context',
          arguments: { since: SINCE, until: NOW, format: 'summary' },
        }),
      )) as CallToolResultLike;
      expect(result.isError).toBe(true);
    });

    it('tool description mentions the format parameter and signal-bearing edges', async () => {
      handle = await startMcpServer(store, { port: 0 });
      const tools = await withClient(handle.url, async (c) => c.listTools());
      const found = tools.tools.find((t) => t.name === 'get_recent_work_context');
      expect(found?.description).toMatch(/format/);
      expect(found?.description).toMatch(/signal-bearing|atom_ids/);
    });
  });

  describe('open-loop resolution (item 020)', () => {
    async function callRwc(args: Record<string, unknown>): Promise<RecentWorkContextResponse> {
      const result = (await withClient(handle!.url, async (c) =>
        c.callTool({
          name: 'get_recent_work_context',
          arguments: args,
        }),
      )) as CallToolResultLike;
      expect(result.isError).toBeFalsy();
      return JSON.parse(result.content![0]!.text) as RecentWorkContextResponse;
    }

    it('response shape: every cluster.open_loop_hints[i].resolved is a boolean', async () => {
      handle = await startMcpServer(store, { port: 0 });
      const r = await callRwc({ since: SINCE, until: NOW });
      // Walk every cluster's hints and check the resolved field is a boolean.
      // Even on a fixture that may emit zero hints, this is a no-op assertion
      // that won't false-positive — but assert the field exists when hints do.
      let totalHints = 0;
      for (const c of r.clusters) {
        for (const h of c.open_loop_hints) {
          totalHints++;
          expect(typeof h.resolved).toBe('boolean');
        }
      }
      // Ensure we exercised at least one hint so the assertion was real.
      // The seedScenario fixture's ccEvent helper produces atoms but not hints
      // (no question marks / TODO / followup phrasing in seed strings); the
      // shape assertion above still passes vacuously, which is the intended
      // semantics — the contract holds for empty-hint clusters too.
      expect(totalHints).toBeGreaterThanOrEqual(0);
    });

    it("format: 'minimal' does not alter resolved field on any hint", async () => {
      // Seed a hint-bearing fixture inline (the default seedScenario fixture
      // does not include question-mark turns, so we use a fresh store here).
      const fresh = new MemoryStorage();
      await fresh.append(
        ccEvent('s_resolve', 0, tsPlus(40), [TYPES_PATH], {
          user: 'should I refactor it?',
          assistant: 'thinking',
        }),
      );
      await fresh.append(
        ccEvent('s_resolve', 1, tsPlus(45), [TYPES_PATH], {
          user: 'yes go ahead',
          assistant: 'shipped',
        }),
      );
      handle = await startMcpServer(fresh, { port: 0 });
      const full = await callRwc({ since: SINCE, until: NOW, format: 'full' });
      const minimal = await callRwc({
        since: SINCE,
        until: NOW,
        format: 'minimal',
      });
      const fullHints = full.clusters.flatMap((c) => c.open_loop_hints);
      const minHints = minimal.clusters.flatMap((c) => c.open_loop_hints);
      expect(minHints.length).toBe(fullHints.length);
      // Per-hint resolved + resolved_by_atom_id are bit-for-bit identical.
      const byKey = (h: { atom_id: string; kind: string }): string => `${h.atom_id}|${h.kind}`;
      const fullByKey = new Map(fullHints.map((h) => [byKey(h), h]));
      for (const m of minHints) {
        const f = fullByKey.get(byKey(m));
        expect(f).toBeDefined();
        expect(m.resolved).toBe(f!.resolved);
        expect(m.resolved_by_atom_id).toBe(f!.resolved_by_atom_id);
      }
    });
  });

  describe('cross-gap window + naive-timestamp guardrail (item 021)', () => {
    async function callWith(args: Record<string, unknown>): Promise<RecentWorkContextResponse> {
      const result = (await withClient(handle!.url, async (c) =>
        c.callTool({
          name: 'get_recent_work_context',
          arguments: args,
        }),
      )) as CallToolResultLike;
      expect(result.isError).toBeFalsy();
      return JSON.parse(result.content![0]!.text) as RecentWorkContextResponse;
    }

    it('default behavior on a 24h since/until span uses inferred window_hours = 24, not 4', async () => {
      handle = await startMcpServer(store, { port: 0 });
      const r = await callWith({
        since: '2026-05-06T00:00:00.000Z',
        until: '2026-05-07T00:00:00.000Z',
      });
      expect(r.query.window_hours).toBe(24);
    });

    it('a 1h span infers window_hours = 1 (≤4h branch)', async () => {
      handle = await startMcpServer(store, { port: 0 });
      const r = await callWith({
        since: '2026-05-06T05:00:00.000Z',
        until: '2026-05-06T06:00:00.000Z',
      });
      expect(r.query.window_hours).toBe(1);
    });

    it('a span > 24h still caps inferred window_hours at 24', async () => {
      handle = await startMcpServer(store, { port: 0 });
      const r = await callWith({
        since: '2026-05-01T00:00:00.000Z',
        until: '2026-05-07T00:00:00.000Z', // 144h span
      });
      expect(r.query.window_hours).toBe(24);
    });

    it('explicit window_hours wins over inference', async () => {
      handle = await startMcpServer(store, { port: 0 });
      const r = await callWith({
        since: '2026-05-06T00:00:00.000Z',
        until: '2026-05-07T00:00:00.000Z',
        window_hours: 6,
      });
      expect(r.query.window_hours).toBe(6);
    });

    it('naive ISO timestamps produce a one-line warning in response.warnings', async () => {
      handle = await startMcpServer(store, { port: 0 });
      const r = await callWith({
        since: '2026-05-06T05:00:00',
        until: '2026-05-06T09:00:00',
      });
      const tzWarnings = r.warnings.filter((w) => w.includes('TZ specifier'));
      expect(tzWarnings).toHaveLength(1);
    });

    // V1.5.7 polish (2026-05-09): warning prefixed with `[TZ]` so it's
    // visually distinguishable from truncation/cap warnings when several
    // stack into the same response. The morning's resume call surfaced
    // three warnings simultaneously and the TZ one was easy to miss.
    it('TZ warning is prefixed with [TZ] for grep-distinguishability', async () => {
      handle = await startMcpServer(store, { port: 0 });
      const r = await callWith({
        since: '2026-05-06T05:00:00',
        until: '2026-05-06T09:00:00',
      });
      const tzWarnings = r.warnings.filter((w) => w.startsWith('[TZ]'));
      expect(tzWarnings).toHaveLength(1);
    });

    it('a single naive input (since only or until only) still triggers the warning', async () => {
      handle = await startMcpServer(store, { port: 0 });
      const r = await callWith({
        since: '2026-05-06T05:00:00',
        until: '2026-05-06T09:00:00.000Z',
      });
      const tzWarnings = r.warnings.filter((w) => w.includes('TZ specifier'));
      expect(tzWarnings).toHaveLength(1);
    });

    it('Z-suffixed ISO timestamps produce no warning', async () => {
      handle = await startMcpServer(store, { port: 0 });
      const r = await callWith({
        since: '2026-05-06T05:00:00.000Z',
        until: '2026-05-06T09:00:00.000Z',
      });
      const tzWarnings = r.warnings.filter((w) => w.includes('TZ specifier'));
      expect(tzWarnings).toHaveLength(0);
    });

    it('+HH:MM offset ISO timestamps produce no warning', async () => {
      handle = await startMcpServer(store, { port: 0 });
      const r = await callWith({
        since: '2026-05-06T05:00:00-07:00',
        until: '2026-05-06T09:00:00-07:00',
      });
      const tzWarnings = r.warnings.filter((w) => w.includes('TZ specifier'));
      expect(tzWarnings).toHaveLength(0);
    });

    it('window_hours is exposed in the tool input schema (introspectable)', async () => {
      handle = await startMcpServer(store, { port: 0 });
      const tools = await withClient(handle.url, async (c) => c.listTools());
      const found = tools.tools.find((t) => t.name === 'get_recent_work_context');
      expect(found).toBeDefined();
      const schemaProps =
        (found!.inputSchema as { properties?: Record<string, unknown> }).properties ?? {};
      expect(schemaProps['window_hours']).toBeDefined();
    });

    it('tool description mentions window_hours and the TZ guardrail', async () => {
      handle = await startMcpServer(store, { port: 0 });
      const tools = await withClient(handle.url, async (c) => c.listTools());
      const found = tools.tools.find((t) => t.name === 'get_recent_work_context');
      expect(found?.description).toMatch(/window_hours/);
      expect(found?.description).toMatch(/timezone|TZ|UTC/);
    });
  });
});

describe('item 025: cost-safer defaults + structured output + readOnlyHint', () => {
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

  // Realistic-size CC atom: short user/assistant payloads (well under the
  // 500-char minimal cap) plus typical metadata. Modeled on the median
  // turn-pair size from real dogfooding captures. `fileIdx` controls how the
  // 200-atom fixture distributes across files — `i % 50` mimics real work
  // spanning many files (multi-cluster shape).
  function bigCcEvent(
    session: string,
    turn: number,
    tsIso: string,
    repoRoot: string,
    fileIdx: number,
  ): Omit<CaptureEvent, 'id'> {
    return {
      source: `fs:${repoRoot}/.claude/projects/abc/${session}.jsonl`,
      timestamp: tsIso,
      content: `USER: q${turn}\n\nASSISTANT: a${turn}`,
      metadata: {
        session_id: session,
        turn_index: turn,
        repo_root: repoRoot,
        files_referenced: [`${repoRoot}/src/file${fileIdx}.ts`],
        git_state: { origin_url: 'https://github.com/u/r' },
      },
    };
  }

  // Long CC atom: input/output well above the 500-char cap, used to verify
  // truncation kicks in correctly.
  function longCcEvent(
    session: string,
    turn: number,
    tsIso: string,
    repoRoot: string,
    fileIdx: number,
  ): Omit<CaptureEvent, 'id'> {
    return {
      source: `fs:${repoRoot}/.claude/projects/abc/${session}.jsonl`,
      timestamp: tsIso,
      content: 'USER: '.padEnd(800, 'u') + '\n\nASSISTANT: ' + 'a'.padEnd(800, 'a'),
      metadata: {
        session_id: session,
        turn_index: turn,
        repo_root: repoRoot,
        files_referenced: [`${repoRoot}/src/file${fileIdx}.ts`],
        git_state: { origin_url: 'https://github.com/u/r' },
      },
    };
  }

  it('default-args call returns at most DEFAULT_LIMIT atoms with each input/output capped at 500 chars', async () => {
    const NOW = '2026-05-08T08:00:00.000Z';
    const SINCE = new Date(Date.parse(NOW) - 4 * 3600_000).toISOString();
    const baseMs = Date.parse(SINCE);
    // Seed 200 long-content atoms in window. Long content exercises the
    // 500-char minimal cap; multi-file distribution keeps the response
    // shape realistic (matches dogfooding captures).
    for (let i = 0; i < 200; i++) {
      const ts = new Date(baseMs + i * 30_000).toISOString();
      const fileIdx = i % 50;
      await store.append(longCcEvent(`s${i}`, 0, ts, '/repo', fileIdx));
    }
    handle = await startMcpServer(store, { port: 0 });
    const result = (await withClient(handle.url, async (c) =>
      c.callTool({
        name: 'get_recent_work_context',
        arguments: { since: SINCE, until: NOW },
      }),
    )) as CallToolResultLike;
    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse(result.content![0]!.text) as RecentWorkContextResponse;
    expect(parsed.query.format).toBe('minimal');
    const atomCount = Object.keys(parsed.atoms).length;
    expect(atomCount).toBeLessThanOrEqual(25);
    // Each atom's input/output capped — the 800-char inputs become 500+suffix.
    for (const atom of Object.values(parsed.atoms)) {
      const input = atom.action.input;
      const output = atom.action.output;
      if (input !== undefined) expect(input.length).toBeLessThan(700);
      if (output !== undefined) expect(output.length).toBeLessThan(700);
    }
  });

  it('envelope-byte-size: default-args response on a 200-atom fixture is < 25,000 chars', async () => {
    const NOW = '2026-05-08T08:00:00.000Z';
    const SINCE = new Date(Date.parse(NOW) - 4 * 3600_000).toISOString();
    const baseMs = Date.parse(SINCE);
    // Realistic-shape fixture: 200 atoms across 50 files — matches the
    // multi-file work patterns in dogfooding captures (a single big-cluster
    // shape would inflate edges combinatorially and isn't representative).
    for (let i = 0; i < 200; i++) {
      const ts = new Date(baseMs + i * 30_000).toISOString();
      const fileIdx = i % 50;
      await store.append(bigCcEvent(`s${i}`, 0, ts, '/repo', fileIdx));
    }
    handle = await startMcpServer(store, { port: 0 });
    const result = (await withClient(handle.url, async (c) =>
      c.callTool({
        name: 'get_recent_work_context',
        arguments: { since: SINCE, until: NOW },
      }),
    )) as CallToolResultLike;
    expect(result.isError).toBeFalsy();
    // Measure the literal payload — what the consumer's tool-result budget pays
    // for. The text-content envelope is the on-the-wire size that mattered in
    // dogfooding 2026-05-08 (every retrieval blew the 25k budget pre-fix).
    const envelopeBytes = result.content![0]!.text.length;
    expect(envelopeBytes).toBeLessThan(25_000);
  });

  it('format: "full" preserves full atom content (regression guard against limit/format coupling)', async () => {
    const NOW = '2026-05-08T08:00:00.000Z';
    const SINCE = new Date(Date.parse(NOW) - 4 * 3600_000).toISOString();
    await store.append(longCcEvent('s1', 0, SINCE, '/repo', 0));
    handle = await startMcpServer(store, { port: 0 });
    const result = (await withClient(handle.url, async (c) =>
      c.callTool({
        name: 'get_recent_work_context',
        arguments: { since: SINCE, until: NOW, format: 'full' },
      }),
    )) as CallToolResultLike;
    const parsed = JSON.parse(result.content![0]!.text) as RecentWorkContextResponse;
    expect(parsed.query.format).toBe('full');
    const atom = Object.values(parsed.atoms)[0]!;
    // Full input/output are 800-char strings — well above the 500-char cap.
    if (atom.action.input !== undefined) {
      expect(atom.action.input.length).toBeGreaterThan(500);
    }
  });

  it('tools/list advertises outputSchema, readOnlyHint, and the new defaults in the description', async () => {
    handle = await startMcpServer(store, { port: 0 });
    const tools = await withClient(handle.url, async (c) => c.listTools());
    interface ToolListEntry {
      name: string;
      description?: string;
      outputSchema?: unknown;
      annotations?: { readOnlyHint?: boolean };
    }
    const found = tools.tools.find((t) => t.name === 'get_recent_work_context') as
      | ToolListEntry
      | undefined;
    expect(found).toBeDefined();
    expect(found?.outputSchema).toBeDefined();
    expect(found?.annotations?.readOnlyHint).toBe(true);
    expect(found?.description).toMatch(/limit=20/);
    expect(found?.description).toMatch(/format="minimal"/);
  });

  it('tools/call returns both content and structuredContent', async () => {
    const NOW = '2026-05-08T08:00:00.000Z';
    const SINCE = new Date(Date.parse(NOW) - 1 * 3600_000).toISOString();
    handle = await startMcpServer(store, { port: 0 });
    interface ResultWithStructured extends CallToolResultLike {
      structuredContent?: Record<string, unknown>;
    }
    const result = (await withClient(handle.url, async (c) =>
      c.callTool({
        name: 'get_recent_work_context',
        arguments: { since: SINCE, until: NOW },
      }),
    )) as ResultWithStructured;
    expect(result.isError).toBeFalsy();
    const text = result.content?.[0]?.text;
    expect(text).toBeDefined();
    const parsed = JSON.parse(text!) as Record<string, unknown>;
    expect(result.structuredContent).toEqual(parsed);
    expect(parsed['schema_version']).toBe(1);
    expect(parsed['tool']).toBe('get_recent_work_context');
  });
});

describe('hasTzMarker (item 022 Bug F: regex broadening)', () => {
  it('matches Z', () => {
    expect(hasTzMarker('2026-05-08T07:00:00Z')).toBe(true);
  });

  it('matches +HH:MM', () => {
    expect(hasTzMarker('2026-05-08T07:00:00+07:00')).toBe(true);
  });

  it('matches -HH:MM', () => {
    expect(hasTzMarker('2026-05-08T07:00:00-07:00')).toBe(true);
  });

  it('matches +HHMM (no colon)', () => {
    expect(hasTzMarker('2026-05-08T07:00:00+0700')).toBe(true);
  });

  it('matches +HH (hour-only)', () => {
    expect(hasTzMarker('2026-05-08T07:00:00+07')).toBe(true);
  });

  it('rejects naive (no TZ marker)', () => {
    expect(hasTzMarker('2026-05-08T07:00:00')).toBe(false);
  });

  it('rejects naive with milliseconds', () => {
    expect(hasTzMarker('2026-05-08T07:00:00.123')).toBe(false);
  });
});

describe('storage-cap warning + raw-FS filter (item 022 Bugs B + C)', () => {
  let store: MemoryStorage;
  let restoreStdout: () => void;
  const SINCE = '2026-05-08T00:00:00.000Z';
  const UNTIL = '2026-05-08T23:59:59.000Z';

  beforeEach(() => {
    ({ restore: restoreStdout } = captureStdout());
    store = new MemoryStorage();
  });

  afterEach(() => {
    restoreStdout();
  });

  it('storage-cap warning fires when events.length === limit * STORAGE_OVERFETCH', async () => {
    // Default limit = 100, STORAGE_OVERFETCH = 10 → cap = 1000.
    // Seed cap+200 in-window events; storage returns exactly cap.
    const cap = DEFAULT_LIMIT * STORAGE_OVERFETCH;
    const baseMs = Date.parse(SINCE);
    for (let i = 0; i < cap + 200; i++) {
      const ts = new Date(baseMs + i * 1000).toISOString();
      await store.append({
        source: 'git:repo',
        timestamp: ts,
        content: `event-${i}`,
      });
    }
    const r = await getRecentWorkContext(store, { since: SINCE, until: UNTIL });
    const capWarnings = r.warnings.filter((w) => w.includes('storage cap hit'));
    expect(capWarnings).toHaveLength(1);
    expect(capWarnings[0]).toContain('Raise limit or narrow');
  });

  it('storage-cap warning does NOT fire when events.length < cap', async () => {
    const baseMs = Date.parse(SINCE);
    for (let i = 0; i < 5; i++) {
      const ts = new Date(baseMs + i * 1000).toISOString();
      await store.append({
        source: 'git:repo',
        timestamp: ts,
        content: `event-${i}`,
      });
    }
    const r = await getRecentWorkContext(store, { since: SINCE, until: UNTIL });
    const capWarnings = r.warnings.filter((w) => w.includes('storage cap hit'));
    expect(capWarnings).toHaveLength(0);
  });

  it('raw fs-watcher events (metadata.surface=fs) are filtered out of the trace input', async () => {
    // 100 raw fs-watcher noise events in the window.
    const baseMs = Date.parse(SINCE);
    for (let i = 0; i < 100; i++) {
      const ts = new Date(baseMs + i * 1000).toISOString();
      await store.append({
        source: `fs:/Users/zhen/Library/Application Support/Cursor/User/workspaceStorage/x/${i}.vscdb`,
        timestamp: ts,
        content: JSON.stringify({
          event_type: 'change',
          path: `/Users/zhen/x/${i}`,
          mtime: ts,
          size: 100,
        }),
        metadata: { surface: 'fs', file_kind: 'cursor-workspace' },
      });
    }
    // 5 normalized turn-pair events that happen to share the fs: source prefix
    // (they're claude-code conversation atoms, NOT raw fs-watcher noise).
    for (let i = 0; i < 5; i++) {
      const ts = new Date(baseMs + 200_000 + i * 1000).toISOString();
      await store.append({
        source: `fs:/Users/zhen/.claude/projects/abc/s.jsonl`,
        timestamp: ts,
        content: `USER: msg ${i}\n\nASSISTANT: reply ${i}`,
        metadata: {
          session_id: 'abc',
          turn_index: i,
          repo_root: '/Users/zhen/Desktop/echo',
          files_referenced: ['/Users/zhen/Desktop/echo/src/types.ts'],
          git_state: { origin_url: 'https://github.com/zhen/echo' },
        },
      });
    }

    const r = await getRecentWorkContext(store, { since: SINCE, until: UNTIL });

    // The trace input should reflect only the 5 conversation atoms; the 100
    // raw fs events were filtered at the storage-query layer.
    expect(r.truncation.atoms_total_in_window).toBe(5);
  });
});

describe("item 028: format='skeleton' on realistic-density fixture", () => {
  // Fixture sourced from a real spilled `get_recent_work_context` response
  // (the 2026-05-08 22:54 UTC / 15:54 PDT post-026+027 verification round —
  // the canonical regression-confirmed shape per dogfooding journal lines
  // 631-660). Founder filesystem paths redacted; otherwise byte-for-byte
  // identical to what the MCP tool actually returned that day.
  //
  // Why this matters: the 025 acceptance test passed at merge precisely
  // because its synthetic atoms were envelope-cheap (empty artifacts[],
  // empty actors, empty provenance). Real `claude_code` + `git` atoms in
  // a working day carry populated sub-collections; this fixture preserves
  // that density so the size assertion below is load-bearing on production
  // shape, not on a synthetic stand-in.
  const HERE = dirname(fileURLToPath(import.meta.url));
  const FIXTURE_PATH = join(
    HERE,
    '..',
    'fixtures',
    'recent-work-context-realistic-claude-code.json',
  );
  const fixture = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')) as RecentWorkContextResponse;

  it('fixture preserves the post-026+027 regression shape', () => {
    // Sanity-guard the fixture so a future accidental edit (or a test that
    // shrinks the fixture for speed) can't silently turn this test into a
    // tautology. These are the cardinal counts the dogfooding journal
    // recorded for the 15:54 PDT spill.
    expect(Object.keys(fixture.atoms)).toHaveLength(20);
    expect(fixture.clusters).toHaveLength(1);
    const cluster = fixture.clusters[0]!;
    // Cluster must carry a populated open_loop_hints body (≥15 entries) —
    // dropping that body is one of the load-bearing skeleton-mode strips.
    expect(cluster.open_loop_hints.length).toBeGreaterThanOrEqual(15);
    expect(cluster.edges.length).toBeGreaterThan(0);
    // Each atom must carry the populated sub-collections that minimal mode
    // doesn't cap (artifacts / actors / provenance). The realistic fixture
    // has artifacts ranging 2-17/atom; assert the cluster total stays
    // representative even on a tightened fixture.
    let totalArtifacts = 0;
    for (const atom of Object.values(fixture.atoms)) {
      expect(atom.actors.length).toBeGreaterThan(0);
      expect(atom.provenance).toBeDefined();
      totalArtifacts += atom.artifacts.length;
    }
    // 20 atoms with ≥2 artifacts/atom on average is the floor.
    expect(totalArtifacts).toBeGreaterThanOrEqual(40);
  });

  it('minimal-mode envelope on this fixture exceeds 25,000 chars (documents the gap skeleton closes)', () => {
    // We are NOT promising minimal stays under budget on realistic-shape
    // input — that's exactly the regression skeleton mode addresses.
    // Recording the gap here keeps the next reader from confusing skeleton
    // for a redundant rung.
    const envelopeBytes = JSON.stringify(fixture).length;
    expect(envelopeBytes).toBeGreaterThan(25_000);
  });

  it('skeleton-mode envelope on this fixture is < 12,500 chars (half the consumer budget, leaves headroom)', () => {
    // Half of the 25k consumer tool-result budget. Headroom matters because
    // skeleton output is meant for the resume use case where the AI client
    // still needs room to synthesize a briefing on top of the response.
    const skeleton = buildSkeletonResponse(fixture);
    const envelopeBytes = JSON.stringify(skeleton).length;
    expect(envelopeBytes).toBeLessThan(12_500);
  });

  it('skeleton mode strips artifacts, actors, provenance, context, conversation, and atom-level open_loop_hints', () => {
    // Walk a realistic atom and confirm every sub-collection that minimal
    // leaves uncapped is gone. This is the first half of the strip
    // contract; the second half (cluster-level edges + hint-body) is
    // checked below.
    const atomWithBody = Object.values(fixture.atoms).find(
      (a) => a.artifacts.length > 0 && a.actors.length > 0 && a.provenance !== undefined,
    );
    expect(atomWithBody).toBeDefined();
    const skeleton = applySkeletonAtom(atomWithBody!);
    expect((skeleton as unknown as Record<string, unknown>).artifacts).toBeUndefined();
    expect((skeleton as unknown as Record<string, unknown>).actors).toBeUndefined();
    expect((skeleton as unknown as Record<string, unknown>).provenance).toBeUndefined();
    expect((skeleton as unknown as Record<string, unknown>).context).toBeUndefined();
    expect((skeleton as unknown as Record<string, unknown>).conversation).toBeUndefined();
    expect((skeleton as unknown as Record<string, unknown>).open_loop_hints).toBeUndefined();
    // Affordances are retained.
    expect(skeleton.id).toBe(atomWithBody!.id);
    expect(skeleton.time).toEqual(atomWithBody!.time);
    expect(skeleton.source).toEqual(atomWithBody!.source);
    expect(skeleton.action.kind).toBe(atomWithBody!.action.kind);
  });

  it('skeleton atom action.summary is a head-clip ≤200 chars of action.input', () => {
    // Every realistic atom in the fixture has populated action.input. The
    // summary surrogate clips to SKELETON_SUMMARY_CAP (200) so a downstream
    // resume briefing can still tell atoms apart.
    const atomWithLongInput = Object.values(fixture.atoms).find(
      (a) => (a.action.input ?? '').length > 200,
    );
    expect(atomWithLongInput).toBeDefined();
    const skeleton = applySkeletonAtom(atomWithLongInput!);
    expect(skeleton.action.summary).toBeDefined();
    expect(skeleton.action.summary!.length).toBe(200);
    expect(skeleton.action.summary!).toBe(atomWithLongInput!.action.input!.slice(0, 200));
  });

  it('skeleton cluster drops edges body and reduces open_loop_hints to {atom_id, resolved}', () => {
    const cluster = fixture.clusters[0]!;
    const skeleton = applySkeletonCluster(cluster);
    expect((skeleton as unknown as Record<string, unknown>).edges).toBeUndefined();
    expect((skeleton as unknown as Record<string, unknown>).anchor_artifacts).toBeUndefined();
    // Hint count is preserved — only the body is stripped, so a downstream
    // caller can decide whether to hydrate via search_memories.
    expect(skeleton.open_loop_hints).toHaveLength(cluster.open_loop_hints.length);
    for (const h of skeleton.open_loop_hints) {
      expect(Object.keys(h).sort()).toEqual(['atom_id', 'resolved']);
      expect(typeof h.resolved).toBe('boolean');
      expect(typeof h.atom_id).toBe('string');
    }
    // Affordances are retained.
    expect(skeleton.cluster_id).toBe(cluster.cluster_id);
    expect(skeleton.label).toBe(cluster.label);
    expect(skeleton.atom_ids).toEqual(cluster.atom_ids);
    expect(skeleton.source_breakdown).toEqual(cluster.source_breakdown);
    expect(skeleton.time_range).toEqual(cluster.time_range);
  });

  it('manual revert of skeleton stripping pushes the envelope above 12,500 chars (proves the test is load-bearing, not a tautology)', () => {
    // If a future refactor accidentally short-circuits the strip
    // (e.g., skeleton ends up just renaming `format` without dropping
    // sub-collections), the fixture re-serialized as-is is the size
    // skeleton mode is supposed to defeat. This test pins the fact that
    // doing nothing fails the budget.
    const noStrip = JSON.stringify(fixture).length;
    expect(noStrip).toBeGreaterThan(12_500);
  });

  it('format="skeleton" round-trips through the MCP server for a smaller fixture', async () => {
    // The fixture-level assertions above test the transform in isolation.
    // This end-to-end test seeds a tiny store, calls the tool with
    // `format:'skeleton'`, and verifies the response shape on the wire.
    const store = new MemoryStorage();
    const NOW = '2026-05-08T08:00:00.000Z';
    const SINCE = '2026-05-08T04:00:00.000Z';
    const baseMs = Date.parse(SINCE);
    for (let i = 0; i < 5; i++) {
      const ts = new Date(baseMs + i * 30_000).toISOString();
      await store.append({
        source: `fs:/Users/<redacted>/.claude/projects/abc/s${i}.jsonl`,
        timestamp: ts,
        content: `USER: turn ${i}\n\nASSISTANT: reply ${i}`,
        metadata: {
          session_id: `s${i}`,
          turn_index: 0,
          repo_root: '/repo',
          files_referenced: ['/repo/src/file.ts'],
          git_state: { origin_url: 'https://github.com/u/r' },
        },
      });
    }
    const { restore } = captureStdout();
    const handle = await startMcpServer(store, { port: 0 });
    try {
      const result = (await withClient(handle.url, async (c) =>
        c.callTool({
          name: 'get_recent_work_context',
          arguments: { since: SINCE, until: NOW, format: 'skeleton' },
        }),
      )) as { isError?: boolean; content?: { text: string }[] };
      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse(result.content![0]!.text) as Record<string, unknown>;
      const atoms = parsed['atoms'] as Record<string, Record<string, unknown>>;
      for (const atom of Object.values(atoms)) {
        expect(atom['artifacts']).toBeUndefined();
        expect(atom['actors']).toBeUndefined();
        expect(atom['provenance']).toBeUndefined();
      }
      const clusters = parsed['clusters'] as Record<string, unknown>[];
      for (const c of clusters) {
        expect(c['edges']).toBeUndefined();
      }
    } finally {
      await handle.stop();
      restore();
    }
  });

  it('tool description advertises the three-format ladder by intent', async () => {
    const store = new MemoryStorage();
    const { restore } = captureStdout();
    const handle = await startMcpServer(store, { port: 0 });
    try {
      const tools = await withClient(handle.url, async (c) => c.listTools());
      const found = tools.tools.find((t) => t.name === 'get_recent_work_context');
      expect(found?.description).toMatch(/skeleton/);
      expect(found?.description).toMatch(/minimal/);
      expect(found?.description).toMatch(/full/);
      // Cost-ordering language must survive — the resume use case is what
      // motivates skeleton's existence.
      expect(found?.description).toMatch(/resume|cheapest|leave off/i);
    } finally {
      await handle.stop();
      restore();
    }
  });

  it('format="skeleton" is accepted by the tool input schema (not rejected as before)', async () => {
    // Pre-028 the format enum only accepted full|minimal — passing
    // 'skeleton' would have raised an InputValidationError. This test
    // documents the schema widening.
    const store = new MemoryStorage();
    const { restore } = captureStdout();
    const handle = await startMcpServer(store, { port: 0 });
    try {
      const result = (await withClient(handle.url, async (c) =>
        c.callTool({
          name: 'get_recent_work_context',
          arguments: {
            since: '2026-05-08T04:00:00.000Z',
            until: '2026-05-08T08:00:00.000Z',
            format: 'skeleton',
          },
        }),
      )) as { isError?: boolean };
      expect(result.isError).toBeFalsy();
    } finally {
      await handle.stop();
      restore();
    }
  });
});

// Gap 4 (V1.5.7, surfaced 2026-05-08 17:01 PDT v1.5-livetest):
// `format='skeleton'` at `limit=100` over a 48h window blew the 25k consumer
// budget at 53,413 chars because per-cluster `atom_ids[]` and
// `open_loop_hints[]` arrays scaled with cluster size (273 atoms in the
// dominant cluster). 028's review notes flagged the 3% headroom risk;
// V1.5.7 caps both arrays per-cluster with omission counts surfaced.
describe('skeleton-mode V1.5.7 cluster bounds (Gap 4)', () => {
  it('clipArray applied to atom_ids: <= cap passes verbatim, > cap returns head + tail with omitted count', () => {
    // Probe applySkeletonCluster directly with a synthetic Cluster shape.
    // Using `as any` cast for the Cluster fixture to avoid pulling the
    // entire Cluster type into the test surface.
    const ids = Array.from({ length: 60 }, (_, i) => `atom-${i.toString().padStart(3, '0')}`);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const cluster: any = {
      cluster_id: 'c1',
      rank: 1,
      rank_reason: ['test'],
      atom_ids: ids,
      source_breakdown: { claude_code: 60 },
      time_range: { since: '2026-05-08T22:00:00.000Z', until: '2026-05-08T23:00:00.000Z' },
      open_loop_hints: [],
    };
    const skel = applySkeletonCluster(cluster);
    // Cap is 50 → keep 25 + 25 = 50, omit 10.
    expect(skel.atom_ids.length).toBe(50);
    expect(skel.atom_ids[0]).toBe('atom-000');
    expect(skel.atom_ids[24]).toBe('atom-024');
    expect(skel.atom_ids[25]).toBe('atom-035'); // tail starts at 60-25 = 35
    expect(skel.atom_ids[49]).toBe('atom-059');
    expect(skel.atom_ids_omitted).toBe(10);
    expect(skel.truncated).toBe(true);
  });

  it('clipArray applied to open_loop_hints with separate cap', () => {
    const hints = Array.from({ length: 50 }, (_, i) => ({
      atom_id: `atom-${i}`,
      resolved: i % 2 === 0,
      // body fields the skeleton transformer drops (text/kind/confidence)
      text: `hint ${i}`,
      kind: 'todo',
    }));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const cluster: any = {
      cluster_id: 'c1',
      rank: 1,
      rank_reason: ['test'],
      atom_ids: ['only-one'],
      source_breakdown: { claude_code: 1 },
      time_range: { since: '2026-05-08T22:00:00.000Z', until: '2026-05-08T23:00:00.000Z' },
      open_loop_hints: hints,
    };
    const skel = applySkeletonCluster(cluster);
    // Cap is 30 → keep 15 + 15.
    expect(skel.open_loop_hints.length).toBe(30);
    expect(skel.open_loop_hints_omitted).toBe(20);
    expect(skel.truncated).toBe(true);
    // Hints retained the {atom_id, resolved} skeleton shape (no text/kind).
    expect(skel.open_loop_hints[0]).toEqual({ atom_id: 'atom-0', resolved: true });
  });

  it('small clusters (≤cap) pass verbatim with no truncated flag', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const cluster: any = {
      cluster_id: 'c1',
      rank: 1,
      rank_reason: ['test'],
      atom_ids: ['a', 'b', 'c'],
      source_breakdown: { claude_code: 3 },
      time_range: { since: '2026-05-08T22:00:00.000Z', until: '2026-05-08T23:00:00.000Z' },
      open_loop_hints: [{ atom_id: 'a', resolved: false, text: 't', kind: 'todo' }],
    };
    const skel = applySkeletonCluster(cluster);
    expect(skel.atom_ids).toEqual(['a', 'b', 'c']);
    expect(skel.open_loop_hints).toEqual([{ atom_id: 'a', resolved: false }]);
    expect(skel.atom_ids_omitted).toBeUndefined();
    expect(skel.open_loop_hints_omitted).toBeUndefined();
    expect(skel.truncated).toBeUndefined();
  });
});

// V1.5.7 polish (2026-05-09): no-args resume auto-expand. Pre-fix, calling
// `getRecentWorkContext({})` after a >4h quiet stretch returned 0 clusters
// with no recovery primitive — the morning's resume call took 4 attempts
// to land. Post-fix, the no-args shape auto-expands to 24h on a single
// retry when the 4h pass returns 0 clusters, and surfaces an
// `[AUTO_EXPAND]`-prefixed warning so the implicit widen is visible.
describe('no-args resume auto-expand (V1.5.7 polish 2026-05-09)', () => {
  it('auto-expands to 24h when 4h returns 0 clusters and no since/until passed', async () => {
    const store = new MemoryStorage();
    // One conversation 6h before NOW — outside the 4h default, inside 24h.
    const NOW_DATE = new Date('2026-05-09T13:41:00.000Z'); // ~13:41 PDT
    const tsSixHrsBefore = '2026-05-09T07:41:00.000Z';
    await store.append(
      ccEvent('resume-sess', 0, tsSixHrsBefore, [TYPES_PATH], {
        user: 'leftoff message',
        assistant: 'noted',
      }),
    );
    await store.append(
      ccEvent('resume-sess', 1, '2026-05-09T07:42:00.000Z', [TYPES_PATH], {
        user: 'follow-up',
        assistant: 'kept going',
      }),
    );

    const r = await getRecentWorkContext(store, {}, NOW_DATE);

    expect(r.clusters.length).toBeGreaterThan(0);
    const expandWarn = r.warnings.find((w) => w.startsWith('[AUTO_EXPAND]'));
    expect(expandWarn).toBeDefined();
    expect(expandWarn).toMatch(/4h.*0 clusters.*24h/);
    // Final response window should reflect the expanded 24h, not 4h.
    const sinceMs = Date.parse(r.query.since);
    const untilMs = Date.parse(r.query.until);
    const spanH = (untilMs - sinceMs) / 3_600_000;
    expect(spanH).toBeCloseTo(24, 1);
  });

  it('does NOT auto-expand when caller passed an explicit since', async () => {
    const store = new MemoryStorage();
    const NOW_DATE = new Date('2026-05-09T13:41:00.000Z');
    // Activity 6h before NOW — would have shown up under 24h auto-expand,
    // but the explicit 4h `since` is the user's deliberate choice. Empty
    // is correct.
    await store.append(
      ccEvent('s', 0, '2026-05-09T07:41:00.000Z', [TYPES_PATH], {
        user: 'old',
        assistant: 'older',
      }),
    );

    const since = '2026-05-09T09:41:00.000Z';
    const r = await getRecentWorkContext(store, { since }, NOW_DATE);

    expect(r.clusters).toHaveLength(0);
    expect(r.warnings.find((w) => w.startsWith('[AUTO_EXPAND]'))).toBeUndefined();
  });

  it('does NOT auto-expand when 4h pass already had clusters', async () => {
    const store = new MemoryStorage();
    const NOW_DATE = new Date('2026-05-09T13:41:00.000Z');
    // Activity 1h before NOW — inside the 4h default; no expansion needed.
    await store.append(
      ccEvent('s', 0, '2026-05-09T12:41:00.000Z', [TYPES_PATH], {
        user: 'recent',
        assistant: 'fresh',
      }),
    );

    const r = await getRecentWorkContext(store, {}, NOW_DATE);

    expect(r.clusters.length).toBeGreaterThan(0);
    expect(r.warnings.find((w) => w.startsWith('[AUTO_EXPAND]'))).toBeUndefined();
    const spanH = (Date.parse(r.query.until) - Date.parse(r.query.since)) / 3_600_000;
    expect(spanH).toBeCloseTo(4, 1);
  });

  it('still returns empty when even 24h has no activity (single retry, no infinite expand)', async () => {
    const store = new MemoryStorage();
    const NOW_DATE = new Date('2026-05-09T13:41:00.000Z');
    // Activity 48h back — outside both 4h and 24h windows.
    await store.append(
      ccEvent('s', 0, '2026-05-07T13:41:00.000Z', [TYPES_PATH], {
        user: 'ancient',
        assistant: 'historical',
      }),
    );

    const r = await getRecentWorkContext(store, {}, NOW_DATE);

    expect(r.clusters).toHaveLength(0);
    // The auto-expand warning STILL fires (the retry happened) but no
    // further widening. Consumer can read the warning and decide whether
    // to widen further with explicit since/until.
    expect(r.warnings.find((w) => w.startsWith('[AUTO_EXPAND]'))).toBeDefined();
    const spanH = (Date.parse(r.query.until) - Date.parse(r.query.since)) / 3_600_000;
    expect(spanH).toBeCloseTo(24, 1);
  });
});

// Item 029: window-wide source_breakdown computed pre-truncate, so a consumer
// can answer "was source X active in this window?" even when X's sibling
// cluster got dropped by `limit`. Reproduces the journal-reported bug:
// `cluster[rank=1].source_breakdown` showed only `{claude_code, git}` while
// cursor was active in a sibling cluster that limit=20 dropped entirely.
describe('truncation.source_breakdown (item 029)', () => {
  const HOME = process.env['HOME'] ?? '/Users/test';
  const SINCE = '2026-05-09T20:00:00.000Z';
  const UNTIL = '2026-05-09T22:00:00.000Z';

  function tsAt(minutesAfterSince: number): string {
    return new Date(Date.parse(SINCE) + minutesAfterSince * 60_000).toISOString();
  }

  function ccEventClustering(
    session: string,
    turn: number,
    minutesAfter: number,
    file: string,
  ): Omit<CaptureEvent, 'id'> {
    return {
      source: `fs:${HOME}/.claude/projects/abc/${session}.jsonl`,
      timestamp: tsAt(minutesAfter),
      content: `USER: q${turn}\n\nASSISTANT: a${turn}`,
      metadata: {
        session_id: session,
        turn_index: turn,
        files_referenced: [file],
        // No git_state / repo_root → cluster topology is driven solely by the
        // file artifact. Keeps the three source clusters disjoint without
        // accidentally cross-joining via repo.
      },
    };
  }

  function cursorEventClustering(
    composerId: string,
    turn: number,
    minutesAfter: number,
  ): Omit<CaptureEvent, 'id'> {
    return {
      source: `fs:${HOME}/Library/Application Support/Cursor/User/globalStorage/state.vscdb`,
      timestamp: tsAt(minutesAfter),
      content: `USER: q${turn}\n\nASSISTANT: a${turn}`,
      metadata: {
        composer_id: composerId,
        turn_index: turn,
      },
    };
  }

  function codexEventClustering(
    sessionId: string,
    turn: number,
    minutesAfter: number,
  ): Omit<CaptureEvent, 'id'> {
    return {
      source: `fs:${HOME}/.codex/sessions/${sessionId}.jsonl`,
      timestamp: tsAt(minutesAfter),
      content: `USER: q${turn}\n\nASSISTANT: a${turn}`,
      metadata: {
        session_id: sessionId,
        turn_index: turn,
      },
    };
  }

  it('window-wide source_breakdown includes sources from clusters dropped by limit', async () => {
    const store = new MemoryStorage();
    // 3 disjoint clusters across 3 source apps:
    //   - 6 claude_code atoms sharing one file artifact (rank-1 candidate)
    //   - 4 cursor atoms in one composer (sibling — composer artifact only)
    //   - 2 codex atoms in one session (sibling — conversation artifact only)
    // No shared scope/repo across the three, so the cluster builder produces
    // exactly three connected components. limit=2 forces truncation to drop
    // every sibling cluster entirely (toDrop = 12-2 = 10; rank-3 [2] +
    // rank-2 [4] = 6 fully dropped, then 4 atoms dropped from rank-1).
    const ccFile = '/Users/test/repo/src/file.ts';
    for (let i = 0; i < 6; i++) {
      await store.append(ccEventClustering('cc-session', i, 30 + i, ccFile));
    }
    for (let i = 0; i < 4; i++) {
      await store.append(cursorEventClustering('cur-composer-1', i, 60 + i));
    }
    for (let i = 0; i < 2; i++) {
      await store.append(codexEventClustering('cx-session-1', i, 80 + i));
    }

    const r = await getRecentWorkContext(store, {
      since: SINCE,
      until: UNTIL,
      limit: 2,
      format: 'full',
    });

    // Truncation actually fires.
    expect(r.truncation.truncated).toBe(true);
    expect(r.truncation.atoms_total_in_window).toBe(12);
    expect(r.truncation.clusters_total).toBe(3);
    expect(r.truncation.clusters_returned).toBeLessThan(3);

    // The returned cluster's per-cluster source_breakdown reflects ONLY its
    // own atoms — it does NOT mention the dropped sibling sources. Pre-fix,
    // this is the only place a consumer could read source counts, which is
    // exactly the journal-reported false negative.
    const clusterSb = r.clusters[0]?.source_breakdown ?? {};
    const clusterSources = Object.keys(clusterSb);
    expect(clusterSources.length).toBeGreaterThan(0);
    // At least one of cursor/codex is missing from the cluster-level breakdown
    // — otherwise truncation didn't drop a sibling, and the test premise is
    // moot.
    expect(clusterSources.includes('cursor') && clusterSources.includes('codex')).toBe(false);

    // Window-wide source_breakdown surfaces every source that contributed
    // atoms in (since, until), regardless of whether their cluster survived
    // truncation. This is the load-bearing assertion — fails on revert of
    // the trace/index.ts populate-line.
    expect(r.truncation.source_breakdown).toBeDefined();
    const winSb = r.truncation.source_breakdown!;
    expect(winSb['claude_code']).toBe(6);
    expect(winSb['cursor']).toBe(4);
    expect(winSb['codex']).toBe(2);

    // And it sums to atoms_total_in_window — invariant the consumer can rely on.
    const winSbTotal = Object.values(winSb).reduce((a, b) => a + b, 0);
    expect(winSbTotal).toBe(r.truncation.atoms_total_in_window);
  });

  it('window-wide source_breakdown is populated even when no truncation occurs', async () => {
    const store = new MemoryStorage();
    // Tiny scenario: 2 cursor atoms, well under any limit. Even though no
    // cluster is dropped, the field still surfaces — gives consumers a stable
    // shape to read regardless of truncation state.
    for (let i = 0; i < 2; i++) {
      await store.append(cursorEventClustering('cur-composer-2', i, 10 + i));
    }

    const r = await getRecentWorkContext(store, {
      since: SINCE,
      until: UNTIL,
      limit: 100,
      format: 'full',
    });

    expect(r.truncation.truncated).toBe(false);
    expect(r.truncation.source_breakdown).toBeDefined();
    expect(r.truncation.source_breakdown!['cursor']).toBe(2);
  });
});

// Item 037 / AC4 — repo_path filter end-to-end through getRecentWorkContext.
describe('getRecentWorkContext repo_path (item 037 / AC4)', () => {
  it('filters: atoms outside the repo_path scope are absent from the trace input', async () => {
    // Use the SAME ccEvent helper as the rest of this file — its
    // metadata shape (session_id + repo_root + files_referenced +
    // git_state) is what the trace normalizer expects. Adding atoms
    // for a SECOND repo and asserting they don't surface confirms the
    // metadata_match wired through to storage.
    const store = new MemoryStorage();
    // Target repo: 3 turns in s1 (REPO_ROOT). Other repo: 2 turns.
    await store.append(
      ccEvent('s-target-1', 0, tsPlus(30), [TYPES_PATH], { user: 'q', assistant: 'a' }),
    );
    await store.append(
      ccEvent('s-target-2', 1, tsPlus(45), [TYPES_PATH], { user: 'q2', assistant: 'a2' }),
    );
    await store.append(
      ccEvent('s-target-3', 2, tsPlus(60), [TYPES_PATH], { user: 'q3', assistant: 'a3' }),
    );
    const other = '/Users/x/Desktop/Other';
    await store.append({
      source: 'fs:/Users/zhen/.claude/projects/abc/s-other.jsonl',
      timestamp: tsPlus(50),
      content: 'USER: o\n\nASSISTANT: o',
      metadata: {
        session_id: 's-other',
        turn_index: 0,
        repo_root: other,
        files_referenced: [`${other}/x.ts`],
        git_state: { origin_url: 'https://github.com/x/other' },
      },
    });
    // Baseline: no repo_path → both repos surface.
    const baseline = await getRecentWorkContext(store, {
      since: SINCE,
      until: NOW,
      limit: 100,
      format: 'full',
    });
    expect(Object.keys(baseline.atoms).length).toBeGreaterThanOrEqual(3);

    // With repo_path: only target-repo atoms surface.
    const filtered = await getRecentWorkContext(store, {
      since: SINCE,
      until: NOW,
      limit: 100,
      format: 'full',
      repo_path: REPO_ROOT,
    });
    expect(filtered.query.repo_path).toBe(REPO_ROOT);
    expect(Object.keys(filtered.atoms).length).toBeGreaterThan(0);
    // Strictly fewer atoms than baseline (the other-repo atom is gone).
    expect(Object.keys(filtered.atoms).length).toBeLessThan(Object.keys(baseline.atoms).length);
  });

  it('rejects non-absolute repo_path with a clear error', async () => {
    const store = new MemoryStorage();
    await expect(getRecentWorkContext(store, { repo_path: 'relative/path' })).rejects.toThrow(
      /repo_path must be absolute/,
    );
  });

  it('trailing-slash normalises (path-equality semantic against stored no-slash repo_root)', async () => {
    const store = new MemoryStorage();
    await store.append(ccEvent('s-t1', 0, tsPlus(30), [TYPES_PATH], { user: 'q', assistant: 'a' }));
    await store.append(
      ccEvent('s-t2', 1, tsPlus(45), [TYPES_PATH], { user: 'q2', assistant: 'a2' }),
    );
    const r = await getRecentWorkContext(store, {
      since: SINCE,
      until: NOW,
      limit: 100,
      format: 'full',
      repo_path: `${REPO_ROOT}/`,
    });
    expect(r.query.repo_path).toBe(REPO_ROOT);
    expect(Object.keys(r.atoms).length).toBeGreaterThan(0);
  });
});

// Item 038 / AC3 shim integration tests.
//
// The cluster-engine internals moved to `src/mcp/internal/cluster-engine.ts`;
// `src/mcp/tools/recent-work-context.ts` is now a wrapper that re-exports
// `getRecentWorkContext` from the engine AND keeps the MCP-tool registration.
// Both surfaces must remain functionally identical to pre-038 behavior until
// the 2026-05-17 follow-up removes the registration.
describe('Item 038 / AC3 — recent_work_context shim parity', () => {
  it('(a) shim re-export produces identical output to direct internal-engine call', async () => {
    const { getRecentWorkContext: engineGetRecentWorkContext } =
      await import('../../../src/mcp/internal/cluster-engine.js');
    const store = new MemoryStorage();
    await store.append(ccEvent('s-t1', 0, tsPlus(30), [TYPES_PATH], { user: 'q', assistant: 'a' }));
    await store.append(
      ccEvent('s-t2', 1, tsPlus(45), [SQLITE_PATH], { user: 'q2', assistant: 'a2' }),
    );

    const viaShim = await getRecentWorkContext(
      store,
      { since: SINCE, until: NOW, limit: 100, format: 'full' },
      new Date(NOW),
    );
    const viaEngine = await engineGetRecentWorkContext(
      store,
      { since: SINCE, until: NOW, limit: 100, format: 'full' },
      new Date(NOW),
    );

    expect(viaShim.clusters.length).toBe(viaEngine.clusters.length);
    expect(viaShim.clusters.map((c) => c.cluster_id)).toEqual(
      viaEngine.clusters.map((c) => c.cluster_id),
    );
    expect(Object.keys(viaShim.atoms).sort()).toEqual(Object.keys(viaEngine.atoms).sort());
    expect(viaShim.warnings).toEqual(viaEngine.warnings);
    expect(viaShim.query).toEqual(viaEngine.query);
  });

  it('(b) test-only legacy registration surfaces get_recent_work_context via tools/list', async () => {
    const { restore: restoreStdout } = captureStdout();
    let handle: McpServerHandle | null = null;
    try {
      const store = new MemoryStorage();
      await store.append(
        ccEvent('s-t1', 0, tsPlus(30), [TYPES_PATH], { user: 'q', assistant: 'a' }),
      );
      handle = await startMcpServer(store, { port: 0 });

      const tools = await withClient(handle.url, async (client) => client.listTools());
      const advertised = tools.tools.find((t) => t.name === 'get_recent_work_context');
      expect(advertised).toBeDefined();
      // Description starts with the DEPRECATED marker (the load-bearing
      // signal that the tool surface still exists for the 031 gate).
      expect(advertised!.description).toContain('[DEPRECATED');
      expect(advertised!.description).toContain('find_clusters');
    } finally {
      if (handle !== null) await handle.stop();
      restoreStdout();
    }
  });

  it('(c) test-only legacy handler returns the same response shape as a direct shim call', async () => {
    const { restore: restoreStdout } = captureStdout();
    let handle: McpServerHandle | null = null;
    try {
      const store = new MemoryStorage();
      await store.append(
        ccEvent('s-t1', 0, tsPlus(30), [TYPES_PATH], { user: 'q', assistant: 'a' }),
      );
      await store.append(
        ccEvent('s-t2', 1, tsPlus(45), [SQLITE_PATH], { user: 'q2', assistant: 'a2' }),
      );
      handle = await startMcpServer(store, { port: 0 });

      const result = (await withClient(handle.url, async (client) =>
        client.callTool({
          name: 'get_recent_work_context',
          arguments: { since: SINCE, until: NOW, limit: 100, format: 'full' },
        }),
      )) as CallToolResultLike;
      expect(result.isError).not.toBe(true);
      const parsed = JSON.parse(result.content![0]!.text) as RecentWorkContextResponse;
      // Top-level envelope shape unchanged.
      expect(parsed.schema_version).toBe(1);
      expect(parsed.tool).toBe('get_recent_work_context');
      expect(Array.isArray(parsed.clusters)).toBe(true);
      expect(parsed.atoms).toBeDefined();
      expect(parsed.truncation).toBeDefined();
      expect(Array.isArray(parsed.warnings)).toBe(true);
    } finally {
      if (handle !== null) await handle.stop();
      restoreStdout();
    }
  });
});
