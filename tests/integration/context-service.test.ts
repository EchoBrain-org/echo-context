import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const NODE = '/usr/local/bin/node';
const STDERR_LIMIT = 64 * 1024;

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
  let extraReadyBytes = '';
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
  const readyPromise = new Promise<Ready>((resolve, reject) => {
    let buffer = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) reject(new Error(`service readiness timeout; stderr=${stderr.slice(-4096)}`));
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
      extraReadyBytes += buffer.slice(newline + 1);
      finish(() => {
        try {
          const parsed = JSON.parse(line) as Ready;
          const canonical = `${JSON.stringify(parsed)}\n`;
          if (canonical !== `${line}\n`) throw new Error('readiness record is not canonical JSON-LF');
          resolve(parsed);
        } catch (error) {
          reject(error);
        }
      });
    });
    child.once('error', (error) => finish(() => reject(error)));
    child.once('exit', (code, signal) =>
      finish(() => reject(new Error(`service exited before readiness: code=${code} signal=${signal}; stderr=${stderr}`))),
    );
  });
  return { child, home, readyPromise, stderr: () => stderr, extraReadyBytes: () => extraReadyBytes };
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

  it('validates ping, capture, search, clustering, bounded getByIds atoms, and a real 100ms wait', async () => {
    const ping = await fetchJson('/v1/ping');
    expect(ping.status).toBe(200);
    expect(ping.json).toMatchObject({ pong: true });

    const capture = await post('/v1/capture', {
      source: 'claude_code:/svc',
      timestamp: '2026-07-01T00:00:00.000Z',
      content: 'alpha service capture',
      metadata: { repo_root: '/svc' },
    });
    expect(capture.status).toBe(200);
    const id = capture.json.id as string;
    expect(typeof id).toBe('string');

    const search = await post('/v1/search', { query: 'alpha', limit: 10 });
    expect(search.status).toBe(200);
    expect((search.json.matches as { id: string }[]).map((match) => match.id)).toContain(id);
    const atoms = await post('/v1/atoms', { atom_ids: [id], format: 'minimal' });
    expect(atoms.status).toBe(200);
    expect((atoms.json.atoms as { id: string }[]).map((atom) => atom.id)).toEqual([id]);
    expect((await post('/v1/clusters', { limit: 10, format: 'minimal' })).status).toBe(200);

    const started = performance.now();
    const wait = await post('/v1/wait', {
      source_prefix: 'nope:',
      since: '2026-07-01T00:00:00.000Z',
      timeout: 0.1,
    });
    const elapsed = performance.now() - started;
    expect(wait.status).toBe(200);
    expect(wait.json).toMatchObject({ timed_out: true });
    expect(elapsed).toBeGreaterThanOrEqual(75);
    expect(elapsed).toBeLessThan(1_000);
  });

  it('rejects schema violations before storage and enforces content type/ID caps', async () => {
    expect((await post('/v1/capture', { source: 'x', content: 'missing timestamp' })).status).toBe(400);
    expect((await post('/v1/search', { query: 'x', not_a_field: true })).status).toBe(400);
    expect((await post('/v1/atoms', { atom_ids: Array.from({ length: 101 }, (_, index) => `id-${index}`) })).status).toBe(400);
    expect((await fetchJson('/v1/search', { method: 'POST', body: '{}' })).status).toBe(415);
  });

  it('bounds request bodies and serialized results', async () => {
    const oversized = await post('/v1/capture', {
      source: 'x',
      timestamp: '2026-07-01T00:00:00.000Z',
      content: 'x'.repeat(70_000),
    });
    expect(oversized.status).toBe(413);

    const ids: string[] = [];
    for (let index = 0; index < 5; index++) {
      const captured = await post('/v1/capture', {
        source: `fixture:${index}`,
        timestamp: `2026-07-01T00:00:0${index}.000Z`,
        content: 'z'.repeat(59_000),
      });
      expect(captured.status).toBe(200);
      ids.push(captured.json.id as string);
    }
    expect((await post('/v1/atoms', { atom_ids: ids })).status).toBe(507);
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
    await new Promise<void>((resolveReady, reject) => {
      const timer = setTimeout(() => reject(new Error('uncooperative child did not become ready')), 1_000);
      child.stdout?.once('data', (bytes) => {
        clearTimeout(timer);
        if (bytes.toString('utf8') !== 'ready\n') reject(new Error('invalid uncooperative-child readiness bytes'));
        else resolveReady();
      });
      child.once('error', reject);
    });
    await expect(terminateGroup(child, true)).rejects.toThrow('required SIGKILL after graceful-shutdown deadline');
    expect(groupExists(child.pid!)).toBe(false);
  }, 7_000);

  it('tears down via SIGTERM only; SIGKILL fallback can never resolve success', async () => {
    await terminateGroup(running!.child, true);
    expect(groupExists(running!.child.pid!)).toBe(false);
  });
});
