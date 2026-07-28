import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const NODE = process.execPath;
const STDERR_LIMIT = 64 * 1024;
const CHILD_READINESS_TIMEOUT_MS = 10_000;

interface Ready { host: string; port: number; pid: number }
interface RunningChild {
  child: ChildProcess;
  home: string;
  ready: Ready;
  stderr: () => string;
  extraReadyBytes: () => string;
}
let running: RunningChild | undefined;
let base = '';
const scratchRoots = new Set<string>();

function readinessPromise(
  child: ChildProcess,
  stderr: () => string,
): { ready: Promise<Ready>; extraReadyBytes: () => string } {
  let extraReadyBytes = '';
  const ready = new Promise<Ready>((resolve, reject) => {
    let buffer = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) reject(new Error(`service readiness timeout; stderr=${stderr().slice(-4096)}`));
    }, 10_000);
    const finish = (action: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      action();
    };
    const fd3 = child.stdio[3] as NodeJS.ReadableStream;
    fd3.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      const newline = buffer.indexOf('\n');
      if (newline < 0) return;
      const line = buffer.slice(0, newline);
      extraReadyBytes = buffer.slice(newline + 1);
      finish(() => {
        try {
          const parsed = JSON.parse(line) as Partial<Ready>;
          const canonical = `${JSON.stringify(parsed)}\n`;
          if (canonical !== `${line}\n`) throw new Error('readiness record is not canonical JSON-LF');
          if (
            Object.keys(parsed).join(',') !== 'host,port,pid' ||
            parsed.host !== '127.0.0.1' ||
            !Number.isInteger(parsed.port) ||
            parsed.port! < 1 ||
            parsed.port! > 65535 ||
            parsed.pid !== child.pid
          ) {
            throw new Error('readiness record does not identify the loopback process-group leader');
          }
          resolve(parsed as Ready);
        } catch (error) {
          reject(error);
        }
      });
    });
    child.once('error', (error) => finish(() => reject(error)));
    child.once('exit', (code, signal) =>
      finish(() => reject(new Error(`service exited before readiness: code=${code} signal=${signal}; stderr=${stderr()}`))),
    );
  });
  return { ready, extraReadyBytes: () => extraReadyBytes };
}

function teardownOnReadinessFailure(child: ChildProcess, ready: Promise<Ready>): Promise<Ready> {
  return ready.catch(async (readinessError: unknown) => {
    try {
      await terminateGroup(child, false);
    } catch (teardownError) {
      throw new AggregateError([readinessError, teardownError], 'readiness rejected and child teardown failed');
    }
    throw readinessError;
  });
}

function sanitizedEnvironment(home: string, additions: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const paths = {
    TMPDIR: join(home, 'tmp'),
    XDG_CACHE_HOME: join(home, 'cache'),
    XDG_CONFIG_HOME: join(home, 'config'),
    XDG_DATA_HOME: join(home, 'data'),
  };
  for (const value of Object.values(paths)) mkdirSync(value, { recursive: true });
  return {
    PATH: '/usr/local/bin:/usr/bin:/bin',
    HOME: home,
    ...paths,
    LANG: 'C',
    LC_ALL: 'C',
    TZ: 'UTC',
    ...additions,
  };
}

function spawnService(options: { host?: string; envAdditions?: NodeJS.ProcessEnv } = {}): {
  child: ChildProcess;
  home: string;
  readyPromise: Promise<Ready>;
  stderr: () => string;
  extraReadyBytes: () => string;
} {
  const home = mkdtempSync(join(tmpdir(), 'echo-ctx-service-'));
  scratchRoots.add(home);
  let stderr = '';
  const child = spawn(
    NODE,
    [
      '--import',
      'tsx',
      'tools/verify-service-parity.mjs',
      '--home',
      home,
      '--host',
      options.host ?? '127.0.0.1',
      '--port',
      '0',
      '--ready-fd',
      '3',
    ],
    {
      cwd: ROOT,
      detached: true,
      env: sanitizedEnvironment(home, options.envAdditions),
      stdio: ['ignore', 'ignore', 'pipe', 'pipe'],
    },
  );
  child.stderr?.on('data', (chunk) => {
    stderr += chunk.toString('utf8');
    if (Buffer.byteLength(stderr) > STDERR_LIMIT) {
      try { process.kill(-(child.pid ?? 0), 'SIGKILL'); } catch {}
    }
  });
  const readiness = readinessPromise(child, () => stderr);
  return {
    child,
    home,
    readyPromise: teardownOnReadinessFailure(child, readiness.ready),
    stderr: () => stderr,
    extraReadyBytes: readiness.extraReadyBytes,
  };
}

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<{ code: number | null; signal: NodeJS.Signals | null; timedOut: boolean }> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode, timedOut: false });
  }
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        resolve({ code: null, signal: null, timedOut: true });
      }
    }, timeoutMs);
    child.once('exit', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, signal, timedOut: false });
    });
  });
}

function waitForExactOutput(child: ChildProcess, expected: string, timeoutMs: number): Promise<void> {
  const output = child.stdout;
  if (!output) return Promise.reject(new Error('child stdout pipe is unavailable'));
  return new Promise((resolve, reject) => {
    let buffer = '';
    let settled = false;
    const cleanup = () => {
      clearTimeout(timer);
      output.off('data', onData);
      child.off('error', onError);
      child.off('exit', onExit);
    };
    const finish = (action: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      action();
    };
    const onData = (bytes: Buffer) => {
      buffer += bytes.toString('utf8');
      if (buffer === expected) finish(resolve);
      else if (!expected.startsWith(buffer)) {
        finish(() => reject(new Error(`invalid child readiness bytes: ${JSON.stringify(buffer)}`)));
      }
    };
    const onError = (error: Error) => finish(() => reject(error));
    const onExit = (code: number | null, signal: NodeJS.Signals | null) =>
      finish(() => reject(new Error(`child exited before readiness: code=${code} signal=${signal}`)));
    const timer = setTimeout(
      () => finish(() => reject(new Error(`child readiness timeout after ${timeoutMs}ms`))),
      timeoutMs,
    );
    output.on('data', onData);
    child.once('error', onError);
    child.once('exit', onExit);
  });
}

function groupExists(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

async function terminateGroup(child: ChildProcess, requireGraceful: boolean): Promise<void> {
  const pid = child.pid;
  if (!pid) return;
  if (child.exitCode === null && child.signalCode === null) {
    try { process.kill(-pid, 'SIGTERM'); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
    }
  }
  const graceful = await waitForExit(child, 5_000);
  if (graceful.timedOut) {
    try { process.kill(-pid, 'SIGKILL'); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
    }
    const killed = await waitForExit(child, 5_000);
    if (killed.timedOut) throw new Error('service process group survived SIGKILL deadline');
    if (requireGraceful) throw new Error('service required SIGKILL after graceful-shutdown deadline');
  } else if (requireGraceful && (graceful.code !== 0 || graceful.signal !== null)) {
    throw new Error(`service graceful shutdown failed: code=${graceful.code} signal=${graceful.signal}`);
  }
  await new Promise((resolve) => setTimeout(resolve, 25));
  if (groupExists(pid)) throw new Error(`service process group ${pid} survived teardown`);
}

async function fetchJson(path: string, init?: RequestInit): Promise<{ status: number; json: Record<string, unknown> }> {
  const response = await fetch(`${base}${path}`, { ...init, signal: AbortSignal.timeout(5_000) });
  const json = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: response.status, json };
}
function post(path: string, body: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  return fetchJson(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeAll(async () => {
  const spawned = spawnService();
  const ready = await spawned.readyPromise;
  running = { child: spawned.child, home: spawned.home, ready, stderr: spawned.stderr, extraReadyBytes: spawned.extraReadyBytes };
  base = `http://127.0.0.1:${ready.port}`;
});

afterAll(async () => {
  try {
    if (running) await terminateGroup(running.child, false);
  } finally {
    for (const root of scratchRoots) rmSync(root, { recursive: true, force: true });
  }
});

describe('AC8 — committed service contract and fail-closed child ceremony', () => {
  it('binds canonical FD3 readiness to the detached process-group leader', () => {
    expect(running?.ready).toEqual({ host: '127.0.0.1', port: running?.ready.port, pid: running?.child.pid });
    expect(running!.ready.port).toBeGreaterThan(0);
    expect(running!.ready.port).toBeLessThan(65536);
    expect(running!.extraReadyBytes()).toBe('');
    expect(Buffer.byteLength(running!.stderr())).toBeLessThanOrEqual(STDERR_LIMIT);
  });

  it('validates exact search/cluster/wait shapes and projects bounded getByIds atoms', async () => {
    const ping = await fetchJson('/v1/ping');
    expect(ping.status).toBe(200);
    expect(ping.json).toMatchObject({ pong: true });

    const capture = await post('/v1/capture', {
      source: 'api:granola',
      timestamp: '2026-07-01T00:00:00.000Z',
      content: 'alpha service capture',
      metadata: { repo_root: '/svc' },
    });
    expect(capture.status).toBe(200);
    const id = capture.json.id as string;
    expect(typeof id).toBe('string');
    const newerCapture = await post('/v1/capture', {
      source: 'api:granola',
      timestamp: '2026-07-01T00:00:01.000Z',
      content: 'beta service capture',
      metadata: { repo_root: '/svc' },
    });
    expect(newerCapture.status).toBe(200);
    const newerId = newerCapture.json.id as string;

    const search = await post('/v1/search', { query: 'alpha', limit: 10 });
    expect(search.status).toBe(200);
    expect(Object.keys(search.json).sort()).toEqual([
      'limit_applied', 'matches', 'next_cursor', 'query_echo', 'total_returned', 'warnings',
    ]);
    expect((search.json.matches as { id: string }[]).map((match) => match.id)).toContain(id);
    const atoms = await post('/v1/atoms', {
      atom_ids: [id, newerId],
      format: 'minimal',
      prefer: 'newest_first',
    });
    expect(atoms.status).toBe(200);
    expect(Object.keys(atoms.json).sort()).toEqual([
      'atoms',
      'atoms_dropped',
      'atoms_dropped_ids',
      'schema_version',
      'tool',
      'warnings',
    ]);
    expect(atoms.json).toMatchObject({
      schema_version: 1,
      tool: 'get_atoms',
      atoms_dropped: 0,
      atoms_dropped_ids: [],
      warnings: [],
    });
    expect((atoms.json.atoms as { id: string; truncations: string[] }[]).map((atom) => atom.id)).toEqual([newerId, id]);
    expect((atoms.json.atoms as { truncations: string[] }[]).every((atom) => Array.isArray(atom.truncations))).toBe(true);

    const clusters = await post('/v1/clusters', { limit: 10, format: 'minimal' });
    expect(clusters.status).toBe(200);
    expect(Object.keys(clusters.json).sort()).toEqual([
      'atoms', 'clusters', 'query', 'schema_version', 'tool', 'truncation', 'warnings',
    ]);
    expect(clusters.json).toMatchObject({ schema_version: 1, tool: 'get_recent_work_context' });

    const started = performance.now();
    const wait = await post('/v1/wait', {
      source_prefix: 'nope:',
      since: '2026-07-01T00:00:00.000Z',
      timeout: 0.1,
    });
    const elapsed = performance.now() - started;
    expect(wait.status).toBe(200);
    expect(wait.json).toEqual({
      schema_version: 1,
      tool: 'wait_for_new_turns',
      turn_ids: [],
      next_since: '2026-07-01T00:00:00.000Z',
      timed_out: true,
      warnings: [],
    });
    expect(elapsed).toBeGreaterThanOrEqual(75);
    expect(elapsed).toBeLessThan(1_000);

    const defaultStarted = performance.now();
    const defaultWait = await post('/v1/wait', {
      source_prefix: 'nope-default:',
      since: '2026-07-01T00:00:00.000Z',
    });
    const defaultElapsed = performance.now() - defaultStarted;
    expect(defaultWait.status).toBe(200);
    expect(defaultWait.json).toMatchObject({ timed_out: true, turn_ids: [] });
    expect(defaultElapsed).toBeGreaterThanOrEqual(750);
    expect(defaultElapsed).toBeLessThan(2_000);
  });

  it('projects normalized coding events onto the frozen service-v1 cluster atom shape', async () => {
    const codexCapture = await post('/v1/capture', {
      source: `fs:${running!.home}/.codex/sessions/2026/07/01/rollout-service-v1.jsonl`,
      timestamp: '2026-07-01T01:00:00.000Z',
      content: 'USER: preserve the frozen API\n\nASSISTANT: Added the boundary projection.',
      metadata: {
        session_id: 'service-v1-codex-session',
        turn_index: 7,
        repo_root: '/svc',
        canonical_root: '/svc',
        project_key: 'local:workspace:/svc',
        logical_turn_id: 'service-v1-codex-turn',
        parent_logical_turn_id: 'service-v1-parent-turn',
        thread_id: 'service-v1-child-thread',
        root_thread_id: 'service-v1-root-thread',
        parent_thread_id: 'service-v1-parent-thread',
        thread_kind: 'subagent',
        agent_path: 'reviewer/child',
        agent_depth: 1,
        initiator: 'agent',
        observation_kind: 'original',
        occurred_at: '2026-07-01T01:00:00.000Z',
        observed_at: '2026-07-01T01:00:01.000Z',
      },
    });
    expect(codexCapture.status).toBe(200);
    const codexId = codexCapture.json.id as string;

    const clusters = await post('/v1/clusters', {
      since: '2026-07-01T00:59:00.000Z',
      until: '2026-07-01T01:01:00.000Z',
      limit: 10,
      format: 'minimal',
    });

    // A 200 response proves the strict committed response schema accepted the
    // projected atom. Assert the compatibility-sensitive nested shapes too.
    expect(clusters.status).toBe(200);
    const atom = (clusters.json.atoms as Record<string, Record<string, unknown>>)[codexId];
    expect(atom).toBeDefined();
    expect(atom).not.toHaveProperty('project');
    expect(atom?.conversation).toEqual({
      provider: 'codex',
      session_id: 'service-v1-codex-session',
      turn_index: 7,
    });
    expect(atom?.provenance).toMatchObject({
      source_event_id: codexId,
      extractor_version: 'codex@2',
    });
    expect(atom?.provenance).not.toHaveProperty('raw_observation_count');
  });

  it('rejects schema violations before storage and enforces content type/ID caps', async () => {
    expect((await post('/v1/capture', { source: 'x', content: 'missing timestamp' })).status).toBe(400);
    expect((await post('/v1/search', { query: 'x', not_a_field: true })).status).toBe(400);
    expect((await post('/v1/search', { source_app: 'not-an-app' })).status).toBe(400);
    expect((await post('/v1/atoms', { atom_ids: Array.from({ length: 51 }, (_, index) => `id-${index}`) })).status).toBe(400);
    expect((await post('/v1/atoms', { atom_ids: [] })).status).toBe(400);
    expect((await post('/v1/atoms', { atom_ids: ['x'], format: 'full' })).status).toBe(400);
    expect((await post('/v1/atoms', { atom_ids: ['x'], prefer: 'oldest_first' })).status).toBe(400);
    expect((await post('/v1/wait', { source_prefix: 'x:', since: '2026-07-01T00:00:00.000Z', timeout: 4.1 })).status).toBe(400);
    expect((await fetchJson('/v1/search', { method: 'POST', body: '{}' })).status).toBe(415);
  });

  it('keeps configured extractor roots private from the service capture gate', async () => {
    const configuredExtractorPath = join(
      running!.home,
      'sources',
      'codex',
      'session.jsonl',
    );
    const configuredRootAttempt = await post('/v1/capture', {
      source: `fs:${configuredExtractorPath}`,
      timestamp: '2026-07-01T00:00:00.000Z',
      content: 'must-stay-extractor-private',
    });
    expect(configuredRootAttempt.status).toBe(403);
    expect(configuredRootAttempt.json.error).toContain('unknown_path');

    const unrelated = await post('/v1/capture', {
      source: 'fs:/tmp/unrelated-echo-context-source.jsonl',
      timestamp: '2026-07-01T00:00:00.000Z',
      content: 'must-be-rejected',
    });
    expect(unrelated.status).toBe(403);
    expect(unrelated.json.error).toContain('unknown_path');
  });

  it('bounds request bodies and serialized results', async () => {
    const oversized = await post('/v1/capture', {
      source: 'x',
      timestamp: '2026-07-01T00:00:00.000Z',
      content: 'x'.repeat(70_000),
    });
    expect(oversized.status).toBe(413);

    const ids: string[] = [];
    const largeMetadata = Object.fromEntries(
      Array.from({ length: 55 }, (_, index) => [`field_${index}`, 'm'.repeat(900)]),
    );
    for (let index = 0; index < 6; index++) {
      const captured = await post('/v1/capture', {
        source: 'api:granola',
        timestamp: `2026-07-01T00:00:0${index}.000Z`,
        content: `response-cap-marker ${index}`,
        metadata: largeMetadata,
      });
      expect(captured.status).toBe(200);
      ids.push(captured.json.id as string);
    }
    const boundedSearch = await post('/v1/search', {
      query: 'response-cap-marker',
      limit: 10,
    });
    expect(boundedSearch.status).toBe(200);
    expect(Buffer.byteLength(JSON.stringify(boundedSearch.json), 'utf8')).toBeLessThanOrEqual(
      25_000,
    );
    expect(boundedSearch.json.warnings).toContainEqual(
      expect.stringContaining('[SEARCH_METADATA_CAP]'),
    );
    const projected = await post('/v1/atoms', { atom_ids: ids, format: 'minimal' });
    expect(projected.status).toBe(200);
    expect(projected.json).toMatchObject({ atoms_dropped: 0, atoms_dropped_ids: [] });
    const projectedAtoms = projected.json.atoms;
    expect(Array.isArray(projectedAtoms)).toBe(true);
    if (!Array.isArray(projectedAtoms)) throw new Error('projected atoms response is not an array');
    expect(projectedAtoms).toHaveLength(6);
    expect(projectedAtoms[0]).toMatchObject({
      metadata_keys_omitted: expect.any(Number),
      truncations: expect.arrayContaining(['metadata']),
    });
  });

  it('fails a slow partial body at the committed 5s request deadline', async () => {
    const response = await new Promise<string>((resolveResponse, reject) => {
      const socket = connect(running!.ready.port, '127.0.0.1');
      let bytes = '';
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new Error('slow-body deadline was fail-open'));
      }, 6_000);
      socket.on('connect', () => {
        socket.write('POST /v1/capture HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\nContent-Length: 100\r\n\r\n{');
      });
      socket.on('data', (chunk) => { bytes += chunk.toString('utf8'); });
      socket.on('close', () => {
        clearTimeout(timer);
        resolveResponse(bytes);
      });
      socket.on('error', reject);
    });
    expect(response).toContain('408');
    expect(response).toContain('request deadline exceeded');
  }, 7_000);

  it('tears down the retained child whenever readiness validation rejects', async () => {
    const home = mkdtempSync(join(tmpdir(), 'echo-ctx-invalid-ready-'));
    scratchRoots.add(home);
    let stderr = '';
    const child = spawn(
      NODE,
      ['-e', "process.on('SIGTERM',()=>process.exit(0));require('fs').writeSync(3,'{}\\n');setInterval(()=>{},1000)"],
      {
        detached: true,
        env: sanitizedEnvironment(home),
        stdio: ['ignore', 'ignore', 'pipe', 'pipe'],
      },
    );
    child.stderr?.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
    const readiness = readinessPromise(child, () => stderr);
    await expect(teardownOnReadinessFailure(child, readiness.ready)).rejects.toThrow(
      'readiness record does not identify the loopback process-group leader',
    );
    expect(groupExists(child.pid!)).toBe(false);
  });

  it('refuses a poisoned inherited environment and any non-loopback host', async () => {
    for (const variant of [
      { envAddition: { ECHO_HOME: '/Users/founder/.echo' }, host: '127.0.0.1' },
      { envAddition: {}, host: '0.0.0.0' },
    ]) {
      const probe = spawnService({
        host: variant.host,
        envAdditions: variant.envAddition,
      });
      probe.readyPromise.catch(() => undefined);
      const exited = await waitForExit(probe.child, 5_000);
      if (exited.timedOut) await terminateGroup(probe.child, false);
      expect(exited.timedOut).toBe(false);
      expect(exited.code).toBe(2);
      expect(probe.stderr()).toMatch(/unsafe inherited environment|refusing non-loopback/);
    }
  });

  it('kills an uncooperative process group but rejects any graceful-success claim', async () => {
    const home = mkdtempSync(join(tmpdir(), 'echo-ctx-uncooperative-'));
    scratchRoots.add(home);
    const child = spawn(
      NODE,
      ['-e', "process.on('SIGTERM',()=>{});process.stdout.write('ready\\n');setInterval(()=>{},1000)"],
      {
        detached: true,
        env: sanitizedEnvironment(home),
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    try {
      await waitForExactOutput(child, 'ready\n', CHILD_READINESS_TIMEOUT_MS);
      await expect(terminateGroup(child, true)).rejects.toThrow('required SIGKILL after graceful-shutdown deadline');
      expect(groupExists(child.pid!)).toBe(false);
    } finally {
      if (child.pid && groupExists(child.pid)) await terminateGroup(child, false);
    }
  }, CHILD_READINESS_TIMEOUT_MS + 15_000);

  it('tears down via SIGTERM only; SIGKILL fallback can never resolve success', async () => {
    await terminateGroup(running!.child, true);
    expect(groupExists(running!.child.pid!)).toBe(false);
  });
});
