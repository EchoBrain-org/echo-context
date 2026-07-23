// Item 038 / AC1 tests — `echo_resolve_mru` primitive.
//
// Coverage matrix (≥ 15 unit tests per AC1 contract #7):
//   - 8 matrix cases: each source_app (4) × {with, without} repo_path
//   - Historical Cursor atoms remain resolvable from stored metadata
//   - Mixed-entry-type input — source-app names AND literal paths together
//   - Validation: empty array; absolute-path check
//   - End-to-end composition: echo_resolve_mru → search_memories(source, ...filter)
//     recovers only atoms from the named repo (Codex R2 HIGH #2 closure)
//   - Git two-path OR (post-AC1 fixture + legacy fixture both recoverable)
//   - Git two-path OR null (no eligible git atoms for the named repo)
//   - Registered-handler integration (tools/list advertises echo_resolve_mru)

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  echoResolveMru,
  type EchoResolveMruResult,
} from '../../../src/mcp/tools/echo-resolve-mru.js';
import { searchMemories } from '../../../src/mcp/tools/search-memories.js';
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

const HOME = homedir();
const CURSOR_PREFIX = `fs:${HOME}/Library/Application Support/Cursor/`;
const CC_PREFIX = `fs:${HOME}/.claude/projects/`;
const CODEX_PREFIX = `fs:${HOME}/.codex/sessions/`;
const REPO_A = '/Users/x/proj-a';
const REPO_B = '/Users/x/proj-b';

function ts(min: number): string {
  return new Date(Date.UTC(2026, 4, 11, 10, min, 0)).toISOString();
}

function ev(
  source: string,
  timestamp: string,
  content: string,
  metadata?: Record<string, unknown>,
): Omit<CaptureEvent, 'id'> {
  return metadata !== undefined
    ? { source, timestamp, content, metadata }
    : { source, timestamp, content };
}

describe('echoResolveMru — logical-observation freshness', () => {
  it('does not let a newer inherited copy beat genuine work', async () => {
    const store = new MemoryStorage();
    const genuineSource = `${CODEX_PREFIX}genuine.jsonl`;
    const forkSource = `${CODEX_PREFIX}fork.jsonl`;
    await store.append(
      ev(genuineSource, ts(10), 'genuine local turn', {
        logical_turn_id: 'local-turn',
        occurred_at: ts(10),
        observed_at: ts(10),
        observation_kind: 'original',
      }),
    );
    await store.append(
      ev(forkSource, ts(20), 'copied parent turn', {
        logical_turn_id: 'parent-turn',
        occurred_at: ts(0),
        observed_at: ts(20),
        observation_kind: 'inherited',
      }),
    );

    const result = await echoResolveMru(store, { sources: ['codex'] });

    expect(result.sources['codex']?.source).toBe(genuineSource);
    expect(result.warnings).toEqual([]);
  });

  it('continues a bounded MRU scan past an inherited-copy burst', async () => {
    const store = new MemoryStorage();
    const genuineSource = `${CODEX_PREFIX}genuine-behind-burst.jsonl`;
    await store.append(
      ev(genuineSource, ts(0), 'genuine local turn', {
        observation_kind: 'original',
      }),
    );
    for (let minute = 1; minute <= 9; minute += 1) {
      await store.append(
        ev(`${CODEX_PREFIX}fork-${minute}.jsonl`, ts(minute), `copy ${minute}`, {
          logical_turn_id: `parent-${minute}`,
          occurred_at: ts(0),
          observed_at: ts(minute),
          observation_kind: 'inherited',
        }),
      );
    }

    const result = await echoResolveMru(store, { sources: ['codex'] });

    expect(result.sources['codex']?.source).toBe(genuineSource);
    expect(result.warnings).toEqual([]);
  });

  it('keeps unknown observations eligible for legacy compatibility', async () => {
    const store = new MemoryStorage();
    const originalSource = `${CODEX_PREFIX}original.jsonl`;
    const unknownSource = `${CODEX_PREFIX}legacy-unknown.jsonl`;
    await store.append(
      ev(originalSource, ts(0), 'known original', {
        observation_kind: 'original',
      }),
    );
    await store.append(
      ev(unknownSource, ts(10), 'legacy-compatible unknown', {
        observation_kind: 'unknown',
      }),
    );

    const result = await echoResolveMru(store, { sources: ['codex'] });

    expect(result.sources['codex']?.source).toBe(unknownSource);
  });
});

describe('echoResolveMru — matrix: each source_app, with/without repo_path', () => {
  it('claude_code without repo_path returns the newest cc source globally', async () => {
    const store = new MemoryStorage();
    await store.append(
      ev(`${CC_PREFIX}-Users-x-proj-a/sess-A.jsonl`, ts(0), 'a', { repo_root: REPO_A }),
    );
    await store.append(
      ev(`${CC_PREFIX}-Users-x-proj-b/sess-B.jsonl`, ts(10), 'b', { repo_root: REPO_B }),
    );
    const r = await echoResolveMru(store, { sources: ['claude_code'] });
    expect(r.sources['claude_code']).not.toBeNull();
    expect(r.sources['claude_code']!.source).toContain('sess-B.jsonl');
    expect(r.sources['claude_code']!.filter).toEqual({});
  });

  it('claude_code with repo_path scopes to the newest matching repo_root source', async () => {
    const store = new MemoryStorage();
    await store.append(
      ev(`${CC_PREFIX}-Users-x-proj-a/sess-A.jsonl`, ts(0), 'a', { repo_root: REPO_A }),
    );
    await store.append(
      ev(`${CC_PREFIX}-Users-x-proj-b/sess-B.jsonl`, ts(10), 'b', { repo_root: REPO_B }),
    );
    const r = await echoResolveMru(store, {
      sources: ['claude_code'],
      repo_path: REPO_A,
    });
    expect(r.sources['claude_code']).not.toBeNull();
    expect(r.sources['claude_code']!.source).toContain('sess-A.jsonl');
    expect(r.sources['claude_code']!.filter).toEqual({ repo_path: REPO_A });
  });

  it('codex without repo_path returns the newest codex source', async () => {
    const store = new MemoryStorage();
    await store.append(ev(`${CODEX_PREFIX}rollout-1.jsonl`, ts(0), '1', { repo_root: REPO_A }));
    await store.append(ev(`${CODEX_PREFIX}rollout-2.jsonl`, ts(20), '2', { repo_root: REPO_B }));
    const r = await echoResolveMru(store, { sources: ['codex'] });
    expect(r.sources['codex']!.source).toContain('rollout-2.jsonl');
    expect(r.sources['codex']!.filter).toEqual({});
  });

  it('codex with repo_path scopes correctly', async () => {
    const store = new MemoryStorage();
    await store.append(ev(`${CODEX_PREFIX}rollout-1.jsonl`, ts(0), '1', { repo_root: REPO_A }));
    await store.append(ev(`${CODEX_PREFIX}rollout-2.jsonl`, ts(20), '2', { repo_root: REPO_B }));
    const r = await echoResolveMru(store, {
      sources: ['codex'],
      repo_path: REPO_B,
    });
    expect(r.sources['codex']!.source).toContain('rollout-2.jsonl');
    expect(r.sources['codex']!.filter).toEqual({ repo_path: REPO_B });
  });

  it('historical cursor atoms remain resolvable without repo_path', async () => {
    const store = new MemoryStorage();
    await store.append(
      ev(`${CURSOR_PREFIX}User/globalStorage/state.vscdb`, ts(15), 'composer turn', {
        composer_id: 'comp-1',
        repo_root: REPO_A,
      }),
    );
    const r = await echoResolveMru(store, { sources: ['cursor'] });
    expect(r.sources['cursor']).not.toBeNull();
    expect(r.sources['cursor']!.source).toContain('state.vscdb');
    expect(r.sources['cursor']!.filter).toEqual({});
  });

  it('historical cursor atoms with repo metadata remain repo-scoped', async () => {
    const store = new MemoryStorage();
    await store.append(
      ev(`${CURSOR_PREFIX}User/globalStorage/state.vscdb`, ts(15), 'composer turn', {
        composer_id: 'comp-1',
        repo_root: REPO_A,
      }),
    );
    const r = await echoResolveMru(store, {
      sources: ['cursor'],
      repo_path: REPO_A,
    });
    expect(r.sources['cursor']).not.toBeNull();
    const desc = r.sources['cursor']!;
    expect(desc.source).toContain('state.vscdb');
    expect(desc.filter).toEqual({ repo_path: REPO_A });
  });

  it('historical cursor atoms without repo metadata are not guessed from live app state', async () => {
    const store = new MemoryStorage();
    await store.append(
      ev(`${CURSOR_PREFIX}User/globalStorage/state.vscdb`, ts(15), 'legacy', {
        composer_id: 'comp-legacy',
      }),
    );
    const r = await echoResolveMru(store, {
      sources: ['cursor'],
      repo_path: REPO_A,
    });
    expect(r.sources['cursor']).toBeNull();
  });

  it('git without repo_path returns the newest git source', async () => {
    const store = new MemoryStorage();
    await store.append(ev(`git:${REPO_A}`, ts(0), 'commit a', { repo_root: REPO_A }));
    await store.append(ev(`git:${REPO_B}`, ts(20), 'commit b', { repo_root: REPO_B }));
    const r = await echoResolveMru(store, { sources: ['git'] });
    expect(r.sources['git']).not.toBeNull();
    expect(r.sources['git']!.source).toBe(`git:${REPO_B}`);
    expect(r.sources['git']!.filter).toEqual({});
  });

  it('git with repo_path uses two-path OR — finds the post-AC1 atom by metadata.repo_root', async () => {
    const store = new MemoryStorage();
    await store.append(ev(`git:${REPO_A}`, ts(20), 'modern A', { repo_root: REPO_A }));
    await store.append(ev(`git:${REPO_B}`, ts(20), 'modern B', { repo_root: REPO_B }));
    const r = await echoResolveMru(store, {
      sources: ['git'],
      repo_path: REPO_A,
    });
    expect(r.sources['git']).not.toBeNull();
    const desc = r.sources['git']!;
    // Either path A (metadata.repo_root) won — filter carries repo_path through.
    expect(desc.source).toBe(`git:${REPO_A}`);
    expect(desc.filter.repo_path).toBe(REPO_A);
  });
});

describe('echoResolveMru — git two-path OR (R3 Codex #2 port from 037 AC6 Note 2)', () => {
  it('legacy git atom (source-only, no metadata.repo_root) is recoverable via path B', async () => {
    const store = new MemoryStorage();
    // Legacy: source encodes the repo, no metadata.repo_root.
    await store.append(ev(`git:${REPO_A}`, ts(20), 'legacy commit'));
    // Post-AC1 atom in REPO_B (Should NOT be picked).
    await store.append(ev(`git:${REPO_B}`, ts(0), 'wrong repo', { repo_root: REPO_B }));
    const r = await echoResolveMru(store, {
      sources: ['git'],
      repo_path: REPO_A,
    });
    expect(r.sources['git']).not.toBeNull();
    const desc = r.sources['git']!;
    expect(desc.source).toBe(`git:${REPO_A}`);
    // Path B won. The downstream project predicate preserves this source-only
    // legacy row while remaining fail-closed for modern identity.
    expect(desc.filter).toEqual({ repo_path: REPO_A });
    const search = await searchMemories(store, {
      source: desc.source,
      ...desc.filter,
      limit: 10,
    });
    expect(search.matches.map((match) => match.content)).toEqual(['legacy commit']);
  });

  it('scans past newer mismatched or malformed identity and returns a downstream-safe descriptor', async () => {
    const store = new MemoryStorage();
    const source = `git:${REPO_A}`;
    for (let minute = 1; minute <= 10; minute += 1) {
      const metadata: Record<string, unknown> =
        minute % 4 === 0
          ? {
              project_key: `local:workspace:${REPO_B}`,
              repo_root: REPO_A,
            }
          : minute % 4 === 1
            ? { project_key: null, repo_root: REPO_A }
            : minute % 4 === 2
              ? { canonical_root: REPO_B, repo_root: REPO_A }
              : { canonical_root: null, repo_root: REPO_A };
      await store.append(ev(source, ts(minute), `wrong project ${minute}`, metadata));
    }

    const mismatchesOnly = await echoResolveMru(store, {
      sources: ['git'],
      repo_path: REPO_A,
    });
    expect(mismatchesOnly.sources['git']).toBeNull();

    await store.append(ev(source, ts(0), 'metadata-less legacy commit'));
    const result = await echoResolveMru(store, {
      sources: ['git'],
      repo_path: REPO_A,
    });

    expect(result.sources['git']).toEqual({
      source,
      filter: { repo_path: REPO_A },
    });
    expect(result.warnings).toEqual([]);

    const descriptor = result.sources['git']!;
    const search = await searchMemories(store, {
      source: descriptor.source,
      ...descriptor.filter,
      limit: 20,
    });
    expect(search.matches.map((match) => match.content)).toEqual(['metadata-less legacy commit']);
  });

  it('does not let a dot-segment repo_root escape survive MRU descriptor composition', async () => {
    const store = new MemoryStorage();
    await store.append(ev(`git:${REPO_A}`, ts(0), 'repo A commit', { repo_root: REPO_A }));
    await store.append(
      ev(`git:${REPO_B}`, ts(20), 'repo B escaped commit', {
        repo_root: `${REPO_A}/../${REPO_B.slice(REPO_B.lastIndexOf('/') + 1)}`,
      }),
    );

    const resolved = await echoResolveMru(store, {
      sources: ['git'],
      repo_path: REPO_A,
    });

    expect(resolved.sources['git']).toEqual({
      source: `git:${REPO_A}`,
      filter: { repo_path: REPO_A },
    });
    const descriptor = resolved.sources['git']!;
    const search = await searchMemories(store, {
      source: descriptor.source,
      ...descriptor.filter,
      limit: 20,
    });
    expect(search.matches.map((match) => match.content)).toEqual(['repo A commit']);
  });

  it('recovers a metadata-less legacy git source through a symlinked caller path', async () => {
    const actualRepo = realpathSync(mkdtempSync(join(tmpdir(), 'echo-mru-actual-')));
    const linkParent = realpathSync(mkdtempSync(join(tmpdir(), 'echo-mru-link-')));
    const repoAlias = join(linkParent, 'repo-alias');
    try {
      writeFileSync(join(actualRepo, 'package.json'), '{}');
      symlinkSync(actualRepo, repoAlias, 'dir');
      const store = new MemoryStorage();
      await store.append(ev(`git:${actualRepo}`, ts(20), 'legacy commit'));

      const result = await echoResolveMru(store, {
        sources: ['git'],
        repo_path: repoAlias,
      });

      expect(result.sources['git']?.source).toBe(`git:${actualRepo}`);
      expect(result.sources['git']?.filter).toEqual({
        repo_path: repoAlias,
      });
    } finally {
      rmSync(linkParent, { recursive: true, force: true });
      rmSync(actualRepo, { recursive: true, force: true });
    }
  });

  it('no eligible git atoms for the repo → null slot', async () => {
    const store = new MemoryStorage();
    await store.append(ev(`git:${REPO_B}`, ts(20), 'other repo', { repo_root: REPO_B }));
    const r = await echoResolveMru(store, {
      sources: ['git'],
      repo_path: REPO_A,
    });
    expect(r.sources['git']).toBeNull();
  });
});

describe('echoResolveMru — mixed input types + validation', () => {
  it('source-app name + literal path together: split mechanism per entry', async () => {
    const store = new MemoryStorage();
    const literalPath = `${CC_PREFIX}-Users-x-proj-a/sess-X.jsonl`;
    await store.append(ev(literalPath, ts(0), 'literal hit'));
    await store.append(ev(`${CODEX_PREFIX}rollout-Y.jsonl`, ts(10), 'codex hit'));
    const r = await echoResolveMru(store, {
      sources: [literalPath, 'codex'],
    });
    // Literal path resolves to itself (exact match).
    expect(r.sources[literalPath]).not.toBeNull();
    expect(r.sources[literalPath]!.source).toBe(literalPath);
    // App-name resolves to the newest codex source.
    expect(r.sources['codex']).not.toBeNull();
    expect(r.sources['codex']!.source).toContain('rollout-Y.jsonl');
  });

  it('empty sources array → throws (defense-in-depth)', async () => {
    const store = new MemoryStorage();
    await expect(echoResolveMru(store, { sources: [] })).rejects.toThrow(/non-empty/);
  });

  it('repo_path must be absolute', async () => {
    const store = new MemoryStorage();
    await expect(
      echoResolveMru(store, { sources: ['claude_code'], repo_path: 'relative/path' }),
    ).rejects.toThrow(/repo_path must be absolute/);
  });

  it('repo_path is normalised (trailing-slash → no-slash form)', async () => {
    const store = new MemoryStorage();
    await store.append(
      ev(`${CC_PREFIX}-Users-x-proj-a/sess.jsonl`, ts(0), 'a', { repo_root: REPO_A }),
    );
    const r = await echoResolveMru(store, {
      sources: ['claude_code'],
      repo_path: `${REPO_A}/`,
    });
    expect(r.repo_path).toBe(REPO_A);
    expect(r.sources['claude_code']!.filter.repo_path).toBe(REPO_A);
  });
});

describe('echoResolveMru — end-to-end composition with search_memories (Codex R2 HIGH #2 closure)', () => {
  it('echo_resolve_mru → search_memories(source=desc.source, ...desc.filter) recovers only the named-repo atoms', async () => {
    const store = new MemoryStorage();
    // Cursor atoms across two repos under the same global state.vscdb source.
    const cursorSource = `${CURSOR_PREFIX}User/globalStorage/state.vscdb`;
    await store.append(
      ev(cursorSource, ts(0), 'repo A turn', { composer_id: 'cA', repo_root: REPO_A }),
    );
    await store.append(
      ev(cursorSource, ts(5), 'repo B turn', { composer_id: 'cB', repo_root: REPO_B }),
    );
    const r = await echoResolveMru(store, {
      sources: ['cursor'],
      repo_path: REPO_A,
    });
    expect(r.sources['cursor']).not.toBeNull();
    const desc = r.sources['cursor']!;
    expect(desc.source).toBe(cursorSource);
    expect(desc.filter.repo_path).toBe(REPO_A);

    // Compose: search_memories(source=desc.source, ...desc.filter).
    const search = await searchMemories(store, {
      source: desc.source,
      ...desc.filter,
      limit: 10,
    });
    expect(search.total_returned).toBe(1);
    expect(search.matches[0]!.content).toBe('repo A turn');
    // Cross-repo leak structurally impossible — the repo B turn is gone
    // despite sharing the resolved source.
  });
});

describe('echoResolveMru — registered-handler integration', () => {
  let handle: McpServerHandle | null = null;
  let restoreStdout: () => void;
  beforeEach(() => {
    ({ restore: restoreStdout } = captureStdout());
  });
  afterEach(async () => {
    if (handle !== null) await handle.stop();
    handle = null;
    restoreStdout();
  });

  it('tools/list advertises echo_resolve_mru with the descriptor description', async () => {
    const store = new MemoryStorage();
    handle = await startMcpServer(store, { port: 0 });
    const tools = await withClient(handle.url, async (c) => c.listTools());
    const advertised = tools.tools.find((t) => t.name === 'echo_resolve_mru');
    expect(advertised).toBeDefined();
    expect(advertised!.description).toMatch(/most-recently-active/i);
    expect(advertised!.description).toMatch(/descriptor/);
  });

  it('AC2 closure — tools/list no longer advertises tail_session', async () => {
    const store = new MemoryStorage();
    handle = await startMcpServer(store, { port: 0 });
    const tools = await withClient(handle.url, async (c) => c.listTools());
    expect(tools.tools.find((t) => t.name === 'tail_session')).toBeUndefined();
  });

  it('callTool echo_resolve_mru returns the expected shape', async () => {
    const store = new MemoryStorage();
    await store.append(
      ev(`${CC_PREFIX}-Users-x-proj-a/sess.jsonl`, ts(0), 'a', { repo_root: REPO_A }),
    );
    handle = await startMcpServer(store, { port: 0 });
    const result = (await withClient(handle.url, async (c) =>
      c.callTool({
        name: 'echo_resolve_mru',
        arguments: { sources: ['claude_code'], repo_path: REPO_A },
      }),
    )) as CallToolResultLike;
    expect(result.isError).not.toBe(true);
    const parsed = JSON.parse(result.content![0]!.text) as EchoResolveMruResult;
    expect(parsed.repo_path).toBe(REPO_A);
    expect(parsed.sources['claude_code']).not.toBeNull();
    expect(parsed.sources['claude_code']!.filter.repo_path).toBe(REPO_A);
  });
});
