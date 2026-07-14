#!/usr/bin/env node
// verify-service-parity.mjs — AC8 context service child (item 135).
//
// Stands up the read-only context service over loopback and its one write
// operation (service-only capture), exercising the REAL TS retrieval stack.
//
// Q3 / Founder adjudication #3 (option (b)-refined): this stays a plain .mjs
// child, launched as `node --import tsx tools/verify-service-parity.mjs` so it
// can dynamically import the .ts source; the target commits no dist/. The spec's
// literal argv is `node tools/verify-service-parity.mjs …`; the `--import tsx`
// prefix is the adjudicated invocation deviation (recorded in the migration
// record citing adjudication #3). The child-process ceremony is real and
// load-bearing: a 127.0.0.1-only listener, exactly one canonical JSON-LF FD3
// readiness record, process-group leadership (the caller spawns detached), and
// SIGTERM graceful shutdown ahead of the group KILL.
//
//   node --import tsx tools/verify-service-parity.mjs \
//        --home <scratch> --host 127.0.0.1 --port 0 --ready-fd 3

import { createServer } from 'node:http';
import { writeSync } from 'node:fs';
import { join } from 'node:path';

function arg(name, dflt) {
  const i = process.argv.indexOf(name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : dflt;
}
const HOME = arg('--home');
const HOST = arg('--host', '127.0.0.1');
const PORT = Number(arg('--port', '0'));
const READY_FD = Number(arg('--ready-fd', '3'));
if (!HOME) { process.stderr.write('verify-service-parity: --home required\n'); process.exit(2); }
if (HOST !== '127.0.0.1') { process.stderr.write('verify-service-parity: refusing non-loopback host\n'); process.exit(2); }
process.env.ECHO_CONTEXT_HOME = HOME;

// Dynamically import the real TS retrieval stack (tsx loader).
const { SqliteStorage } = await import('../src/storage/sqlite.js');
const { searchMemories } = await import('../src/mcp/tools/search-memories.js');
const { getRecentWorkContext } = await import('../src/mcp/internal/cluster-engine.js');
const { waitForNewTurns } = await import('../src/mcp/tools/wait-for-new-turns.js');

const storage = new SqliteStorage(join(HOME, 'context.db'));

// Allowed request keys per endpoint — any extra key is rejected (unknown-field).
const ALLOWED = {
  capture: new Set(['source', 'timestamp', 'content', 'metadata']),
  search: new Set(['query', 'source_app', 'source_prefix', 'source', 'limit', 'cursor', 'repo_path', 'metadata_match', 'since', 'until']),
  clusters: new Set(['since', 'until', 'limit', 'format', 'window_hours', 'repo_path']),
  atoms: new Set(['atom_ids', 'format', 'prefer']),
  wait: new Set(['sources', 'source_prefix', 'since', 'timeout', 'repo_path']),
};
function rejectUnknown(op, body) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return 'body must be a JSON object';
  for (const k of Object.keys(body)) if (!ALLOWED[op].has(k)) return `unknown field: ${k}`;
  return null;
}
async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
function send(res, code, obj) {
  const body = JSON.stringify(obj);
  res.statusCode = code;
  res.setHeader('content-type', 'application/json');
  res.end(body);
}

const server = createServer((req, res) => {
  void (async () => {
    const url = new URL(req.url ?? '/', `http://${HOST}`);
    if (req.method === 'GET' && url.pathname === '/v1/ping') return send(res, 200, { pong: true, ts: new Date().toISOString() });
    if (req.method !== 'POST') return send(res, 405, { error: 'method not allowed' });
    const op = url.pathname.replace(/^\/v1\//, '');
    if (!ALLOWED[op]) return send(res, 404, { error: 'unknown endpoint' });
    let body;
    try { body = await readBody(req); } catch { return send(res, 400, { error: 'invalid json' }); }
    const bad = rejectUnknown(op, body);
    if (bad) return send(res, 400, { error: bad });
    try {
      if (op === 'capture') {
        const id = await storage.append({ source: body.source, timestamp: body.timestamp, content: body.content, metadata: body.metadata ?? {} });
        return send(res, 200, { id });
      }
      if (op === 'search') return send(res, 200, await searchMemories(storage, body));
      if (op === 'clusters') return send(res, 200, await getRecentWorkContext(storage, body));
      if (op === 'atoms') {
        const ids = new Set(body.atom_ids ?? []);
        const all = await storage.query();
        return send(res, 200, { atoms: all.filter((a) => ids.has(a.id)) });
      }
      if (op === 'wait') return send(res, 200, await waitForNewTurns(storage, body));
    } catch (err) {
      return send(res, 500, { error: (err instanceof Error ? err.message : String(err)) });
    }
  })().catch((err) => { if (!res.headersSent) send(res, 500, { error: String(err) }); });
});

server.on('error', (err) => { process.stderr.write(`verify-service-parity: listen error ${err.message}\n`); process.exit(1); });
server.listen(PORT, HOST, () => {
  const addr = server.address();
  const port = typeof addr === 'object' && addr !== null ? addr.port : PORT;
  // Exactly one canonical JSON-LF readiness record on the ready FD.
  writeSync(READY_FD, JSON.stringify({ host: HOST, port, pid: process.pid }) + '\n');
});

function shutdown() { server.close(() => process.exit(0)); server.closeAllConnections?.(); setTimeout(() => process.exit(0), 500); }
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
