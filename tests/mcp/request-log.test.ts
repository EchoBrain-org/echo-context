import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  beginRecentMcpCall,
  failRecentMcpCall,
  finishRecentMcpCall,
  flushRecentMcpCallLog,
  readRecentMcpCalls,
  resetRecentMcpCallLogForTests,
} from '../../src/mcp/request-log.js';

// 067 AC3 — Mechanism pin for the atomic tmp-then-rename write contract.
// `node:fs` ESM namespace properties are non-configurable in Node 22, so
// `vi.spyOn(fs, 'writeFileSync')` throws "Cannot redefine property". The
// spec ("or equivalent module-level spy") permits this `vi.mock` factory
// — it wraps `writeFileSync` / `renameSync` with vi.fn delegates that
// pass through to the real fs while letting the assertion test observe
// invocation order and arguments. All other fs functions (mkdtempSync,
// readFileSync, rmSync, existsSync) are passed through verbatim.
vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    ...actual,
    writeFileSync: vi.fn(actual.writeFileSync),
    renameSync: vi.fn(actual.renameSync),
  };
});

afterEach(() => {
  resetRecentMcpCallLogForTests();
  vi.clearAllMocks();
});

function okResult(structuredContent: Record<string, unknown>) {
  return {
    content: [{ type: 'text', text: JSON.stringify(structuredContent) }],
    structuredContent,
  };
}

function errorResult(text: string) {
  return {
    isError: true,
    content: [{ type: 'text', text }],
  };
}

describe('recent MCP request log', () => {
  it('appends calls and reads back in insertion order with redacted shapes', () => {
    const first = beginRecentMcpCall('search_memories', { query: 'secret query', limit: 3 }, 100);
    finishRecentMcpCall(first, 'search_memories', okResult({ matches: [], total_returned: 0, limit_applied: 3, warnings: [] }), 120);
    const second = beginRecentMcpCall('get_atoms', { atom_ids: ['atom-a', 'atom-b'], format: 'minimal' }, 130);
    finishRecentMcpCall(second, 'get_atoms', okResult({ atoms: [], atoms_dropped: 2, atoms_dropped_ids: ['atom-a', 'atom-b'], warnings: [] }), 140);

    const calls = readRecentMcpCalls();
    expect(calls.map((call) => call.tool)).toEqual(['search_memories', 'get_atoms']);
    expect(calls[0]?.status).toBe('ok');
    expect(calls[0]?.duration_ms).toBe(20);
    expect(calls[0]?.args_shape).toMatchObject({ query_length: 12, limit: 3 });
    expect(calls[1]?.args_shape).toMatchObject({ atom_ids_count: 2, format: 'minimal' });
    expect(JSON.stringify(calls)).not.toContain('secret query');
    expect(JSON.stringify(calls)).not.toContain('atom-a');
  });

  it('updates a pending call to ok in place', () => {
    const id = beginRecentMcpCall('echo_ping', { message: 'hello' }, 100);
    expect(readRecentMcpCalls()).toHaveLength(1);
    expect(readRecentMcpCalls()[0]?.status).toBe('pending');

    finishRecentMcpCall(id, 'echo_ping', okResult({ pong: true, received: 'hello' }), 135);

    const calls = readRecentMcpCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      tool: 'echo_ping',
      status: 'ok',
      duration_ms: 35,
      result_shape: { result_type: 'echo_ping', received_present: true },
    });
  });

  it('records grouped discovery and hydration-continuation shapes without cursor contents', () => {
    const findId = beginRecentMcpCall(
      'find_clusters',
      {
        group_by: 'project',
        page_size: 4,
        representative_limit: 3,
        cursor: 'opaque-secret-cursor',
      },
      100,
    );
    finishRecentMcpCall(
      findId,
      'find_clusters',
      okResult({
        clusters: [],
        groups: [{ representative_atom_ids: ['atom-a', 'atom-b'] }],
        membership_page: { atom_ids: ['atom-c'] },
        next_cursor: 'next-secret-cursor',
        warnings: [],
      }),
      110,
    );

    const getId = beginRecentMcpCall(
      'get_atoms',
      { atom_ids: ['atom-a'], cursor: 'hydrate-secret-cursor' },
      120,
    );
    finishRecentMcpCall(
      getId,
      'get_atoms',
      okResult({
        atoms: [],
        atoms_dropped: 1,
        atoms_dropped_ids: ['atom-a'],
        atoms_missing: 0,
        atoms_deferred: 1,
        next_cursor: 'next-hydrate-secret-cursor',
        warnings: [],
      }),
      130,
    );

    const [findCall, getCall] = readRecentMcpCalls();
    expect(findCall?.args_shape).toMatchObject({
      group_by: 'project',
      page_size: 4,
      representative_limit: 3,
      cursor_present: true,
    });
    expect(findCall?.result_shape).toMatchObject({
      group_count: 1,
      representative_atom_id_count: 2,
      member_atom_id_count: 1,
      next_cursor_present: true,
    });
    expect(getCall?.result_shape).toMatchObject({
      atoms_missing: 0,
      atoms_deferred: 1,
      next_cursor_present: true,
    });
    expect(JSON.stringify([findCall, getCall])).not.toContain('secret-cursor');
    expect(JSON.stringify([findCall, getCall])).not.toContain('atom-a');
  });

  it('updates a pending call to error for thrown exceptions', () => {
    const id = beginRecentMcpCall('search_memories', { query: 'secret' }, 100);
    failRecentMcpCall(id, 'search_memories', new Error('boom'), 105);

    expect(readRecentMcpCalls()[0]).toMatchObject({
      status: 'error',
      duration_ms: 5,
      result_shape: { is_error: true, content_text_length: 4 },
    });
  });

  it('updates a pending call to error for MCP isError envelopes', () => {
    const id = beginRecentMcpCall('get_role_state', { task_id: 'missing', role: 'builder' }, 100);
    finishRecentMcpCall(id, 'get_role_state', errorResult('not found'), 130);

    expect(readRecentMcpCalls()[0]).toMatchObject({
      status: 'error',
      duration_ms: 30,
      result_shape: { is_error: true, content_text_length: 9 },
    });
  });

  it('caps the ring buffer at 1000 entries', () => {
    for (let i = 0; i < 1005; i += 1) {
      beginRecentMcpCall('echo_ping', { message: String(i) }, i);
    }

    const calls = readRecentMcpCalls();
    expect(calls).toHaveLength(1000);
    expect(calls[0]?.ts).toBe(5);
    expect(calls.at(-1)?.ts).toBe(1004);
  });

  it('filters by since, until, and status', () => {
    const first = beginRecentMcpCall('echo_ping', {}, 100);
    finishRecentMcpCall(first, 'echo_ping', okResult({ pong: true }), 101);
    const second = beginRecentMcpCall('get_role_state', {}, 200);
    finishRecentMcpCall(second, 'get_role_state', errorResult('nope'), 201);
    beginRecentMcpCall('find_clusters', {}, 300);

    expect(readRecentMcpCalls({ since: 150 }).map((call) => call.tool)).toEqual(['get_role_state', 'find_clusters']);
    expect(readRecentMcpCalls({ until: 250 }).map((call) => call.tool)).toEqual(['echo_ping', 'get_role_state']);
    expect(readRecentMcpCalls({ status: 'error' }).map((call) => call.tool)).toEqual(['get_role_state']);
    expect(readRecentMcpCalls({ status: 'pending' }).map((call) => call.tool)).toEqual(['find_clusters']);
  });

  it('no-ops when a pending entry is evicted before completion', () => {
    const evicted = beginRecentMcpCall('echo_ping', { message: 'oldest' }, 0);
    for (let i = 1; i <= 1000; i += 1) {
      beginRecentMcpCall('echo_ping', { message: String(i) }, i);
    }

    expect(() => finishRecentMcpCall(evicted, 'echo_ping', okResult({ pong: true }), 2000)).not.toThrow();
    const calls = readRecentMcpCalls();
    expect(calls).toHaveLength(1000);
    expect(calls[0]?.ts).toBe(1);
    expect(calls.some((call) => call.ts === 0)).toBe(false);
  });
});

describe('flushRecentMcpCallLog', () => {
  function withTmpDir<T>(fn: (dir: string) => T): T {
    const dir = mkdtempSync(join(tmpdir(), 'echo-mcp-shutdown-flush-'));
    try {
      return fn(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  function readJsonLines(path: string): Record<string, unknown>[] {
    const raw = readFileSync(path, 'utf8');
    if (raw.length === 0) return [];
    return raw
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  }

  it('flushes a mixed-status ring: ok + error + pending → killed_during_shutdown', () => {
    withTmpDir((dir) => {
      const path = join(dir, 'mcp-shutdown.jsonl');
      const okId = beginRecentMcpCall('echo_ping', { message: 'a' }, 100);
      finishRecentMcpCall(okId, 'echo_ping', okResult({ pong: true, received: 'a' }), 110);
      const errId = beginRecentMcpCall('search_memories', { query: 'q' }, 120);
      failRecentMcpCall(errId, 'search_memories', new Error('boom'), 125);
      const pendingId = beginRecentMcpCall('find_clusters', {}, 200);
      void pendingId;

      flushRecentMcpCallLog(path, 500);

      const lines = readJsonLines(path);
      expect(lines).toHaveLength(3);
      expect(lines.map((entry) => entry['status'])).toEqual([
        'ok',
        'error',
        'killed_during_shutdown',
      ]);
      const killed = lines[2];
      expect(killed?.['tool']).toBe('find_clusters');
      expect(killed?.['duration_ms']).toBe(300);

      // The in-memory ring is rewritten in place for the killed entry.
      const ring = readRecentMcpCalls();
      expect(ring[2]?.status).toBe('killed_during_shutdown');
      expect(ring[2]?.duration_ms).toBe(300);
    });
  });

  it('writes an empty file when the ring is empty', () => {
    withTmpDir((dir) => {
      const path = join(dir, 'mcp-shutdown.jsonl');
      flushRecentMcpCallLog(path, 1000);
      expect(existsSync(path)).toBe(true);
      expect(readFileSync(path, 'utf8')).toBe('');
    });
  });

  it('overwrites with the full current ring on repeated flush, not an append', () => {
    withTmpDir((dir) => {
      const path = join(dir, 'mcp-shutdown.jsonl');
      beginRecentMcpCall('echo_ping', { message: 'first' }, 100);
      flushRecentMcpCallLog(path, 200);
      expect(readJsonLines(path)).toHaveLength(1);

      beginRecentMcpCall('echo_ping', { message: 'second' }, 300);
      flushRecentMcpCallLog(path, 400);

      const lines = readJsonLines(path);
      expect(lines).toHaveLength(2);
      expect(lines.every((entry) => entry['status'] === 'killed_during_shutdown')).toBe(true);
      // Second call's duration measured from its own ts (300) to flush (400).
      expect(lines[1]?.['duration_ms']).toBe(100);
      // First call was already killed in the first flush; second flush
      // re-measures from its original ts (100) to the new flush time (400)
      // because the rewriter only acts on `pending` entries — once killed,
      // duration_ms is preserved from the first flush.
      expect(lines[0]?.['duration_ms']).toBe(100);
    });
  });

  it('writes atomically via tmp-then-rename (mechanism pin)', () => {
    withTmpDir((dir) => {
      const path = join(dir, 'mcp-shutdown.jsonl');
      beginRecentMcpCall('echo_ping', { message: 'pin' }, 100);

      // Clear any prior invocations from this test's own setup (mkdtempSync
      // doesn't call these, but other tests in this file do).
      const writeMock = vi.mocked(writeFileSync);
      const renameMock = vi.mocked(renameSync);
      writeMock.mockClear();
      renameMock.mockClear();

      flushRecentMcpCallLog(path, 200);

      // (a) writeFileSync is called with a path ending in `.tmp`, never the
      // final path directly.
      expect(writeMock).toHaveBeenCalled();
      const writeTarget = writeMock.mock.calls[0]?.[0];
      expect(typeof writeTarget === 'string' && writeTarget.endsWith('.tmp')).toBe(true);
      expect(writeTarget).not.toBe(path);

      // (b) renameSync is called with (path + '.tmp', path) after the
      // writeFileSync invocation order.
      expect(renameMock).toHaveBeenCalledWith(path + '.tmp', path);
      const writeOrder = writeMock.mock.invocationCallOrder[0] ?? 0;
      const renameOrder = renameMock.mock.invocationCallOrder[0] ?? 0;
      expect(renameOrder).toBeGreaterThan(writeOrder);

      // (c) the final file at `path` contains the expected JSONL contents
      // (proves the rename actually moved the file).
      const lines = readJsonLines(path);
      expect(lines).toHaveLength(1);
      expect(lines[0]?.['tool']).toBe('echo_ping');
      expect(lines[0]?.['status']).toBe('killed_during_shutdown');
    });
  });
});
