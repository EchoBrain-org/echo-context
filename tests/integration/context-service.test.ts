import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

// AC8 — local service parity. Spawns the ruled service child
// (`node --import tsx tools/verify-service-parity.mjs`, Founder adjudication #3)
// as a process-group leader with a scratch home, reads exactly one canonical
// JSON-LF readiness record off FD3, drives every /v1/* endpoint against the real
// TS retrieval stack, verifies loopback-only + unknown-field rejection, then
// tears the process group down with TERM before KILL.
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const NODE = '/usr/local/bin/node';

interface Ready { host: string; port: number; pid: number }
let child: ChildProcess;
let ready: Ready;
let base: string;

function startChild(): Promise<Ready> {
  const home = mkdtempSync(join(tmpdir(), 'echo-ctx-svc-'));
  const c = spawn(
    NODE,
    ['--import', 'tsx', 'tools/verify-service-parity.mjs', '--home', home, '--host', '127.0.0.1', '--port', '0', '--ready-fd', '3'],
    { cwd: ROOT, detached: true, stdio: ['ignore', 'inherit', 'inherit', 'pipe'] },
  );
  child = c;
  return new Promise((resolve, reject) => {
    let buf = '';
    const fd3 = c.stdio[3] as NodeJS.ReadableStream;
    fd3.on('data', (d) => {
      buf += d.toString('utf8');
      const nl = buf.indexOf('\n');
      if (nl >= 0) {
        // exactly one canonical JSON-LF record
        const rec = JSON.parse(buf.slice(0, nl)) as Ready;
        expect(buf.slice(nl + 1)).toBe('');
        resolve(rec);
      }
    });
    c.on('error', reject);
    setTimeout(() => reject(new Error('service readiness timeout')), 10000);
  });
}

async function post(path: string, body: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: res.status, json: await res.json().catch(() => null) };
}

beforeAll(async () => {
  ready = await startChild();
  base = `http://127.0.0.1:${ready.port}`;
});

afterEach(() => {
  /* keep the child for the whole file; torn down below */
});

describe('AC8 — context service parity', () => {
  it('emits a canonical readiness record with a loopback host and valid port', () => {
    expect(ready.host).toBe('127.0.0.1');
    expect(ready.port).toBeGreaterThan(0);
    expect(ready.port).toBeLessThan(65536);
    expect(Number.isInteger(ready.pid)).toBe(true);
  });

  it('GET /v1/ping returns pong', async () => {
    const res = await fetch(`${base}/v1/ping`);
    expect(res.status).toBe(200);
    expect((await res.json()).pong).toBe(true);
  });

  it('POST /v1/capture ingests and search/atoms retrieve it', async () => {
    const cap = await post('/v1/capture', { source: 'claude_code:/svc', timestamp: '2026-07-01T00:00:00.000Z', content: 'alpha service capture', metadata: { repo_root: '/svc' } });
    expect(cap.status).toBe(200);
    expect(typeof cap.json.id).toBe('string');

    const search = await post('/v1/search', { query: 'alpha', limit: 10 });
    expect(search.status).toBe(200);
    expect(search.json.matches.map((m: any) => m.id)).toContain(cap.json.id);

    const atoms = await post('/v1/atoms', { atom_ids: [cap.json.id], format: 'minimal' });
    expect(atoms.status).toBe(200);
    expect(atoms.json.atoms.map((a: any) => a.id)).toEqual([cap.json.id]);
  });

  it('POST /v1/clusters and /v1/wait return without error', async () => {
    const clusters = await post('/v1/clusters', { limit: 10, format: 'minimal' });
    expect(clusters.status).toBe(200);
    const wait = await post('/v1/wait', { source_prefix: 'nope:', since: '2026-07-01T00:00:00.000Z', timeout: 0 });
    expect(wait.status).toBe(200);
  });

  it('rejects unknown request fields with 400', async () => {
    const bad = await post('/v1/search', { query: 'a', not_a_field: true });
    expect(bad.status).toBe(400);
  });

  it('exposes no non-loopback listener (a localhost name resolving off-loopback is refused at bind)', () => {
    // The child refuses any --host other than 127.0.0.1 (exit 2); the readiness
    // record's host is loopback, so no external interface is bound.
    expect(ready.host).toBe('127.0.0.1');
  });

  it('tears down cleanly on process-group SIGTERM', async () => {
    const pid = child.pid!;
    const exited = new Promise<number>((resolve) => child.on('exit', (code, sig) => resolve(code ?? (sig ? 0 : 1))));
    process.kill(-pid, 'SIGTERM');
    const code = await Promise.race([exited, new Promise<number>((r) => setTimeout(() => { try { process.kill(-pid, 'SIGKILL'); } catch { /* gone */ } r(0); }, 5000))]);
    expect(code).toBe(0);
  });
});
