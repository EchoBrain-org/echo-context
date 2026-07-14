#!/usr/bin/env node
// AC8 context-only loopback service. Run with: node --import tsx <this-file>.

import { createServer } from 'node:http';
import { readFileSync, writeSync } from 'node:fs';
import { isAbsolute, join, resolve, sep } from 'node:path';
import Ajv from 'ajv';

const API_PATH = new URL('../schemas/service-api.v1.json', import.meta.url);
const API = JSON.parse(readFileSync(API_PATH, 'utf8'));
const ajv = new Ajv({ allErrors: true, strict: false });
const validators = new Map(
  Object.entries(API.endpoints).map(([route, contract]) => [
    route,
    { request: ajv.compile(contract.request), response: ajv.compile(contract.response) },
  ]),
);

function argument(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 && index + 1 < process.argv.length ? process.argv[index + 1] : fallback;
}
function bootFail(message) {
  process.stderr.write(`verify-service-parity: ${message}\n`);
  process.exit(2);
}
const HOME = argument('--home');
const HOST = argument('--host', '127.0.0.1');
const PORT = Number(argument('--port', '0'));
const READY_FD = Number(argument('--ready-fd', '3'));
if (!HOME || !isAbsolute(HOME)) bootFail('--home must be an absolute scratch path');
if (HOST !== '127.0.0.1') bootFail('refusing non-loopback host');
if (!Number.isInteger(PORT) || PORT < 0 || PORT > 65535) bootFail('--port must be 0..65535');
if (!Number.isInteger(READY_FD) || READY_FD < 3) bootFail('--ready-fd must be >=3');

const poison = Object.keys(process.env).filter(
  (key) =>
    key === 'ECHO_HOME' ||
    key === 'ECHO_CONTEXT_HOME' ||
    key.startsWith('ECHO_REPO') ||
    /(?:TOKEN|SECRET|PASSWORD|CREDENTIAL)/i.test(key),
);
if (poison.length > 0) bootFail(`unsafe inherited environment keys: ${poison.sort().join(',')}`);
const allowedEnv = new Set(['PATH', 'HOME', 'TMPDIR', 'TMP', 'TEMP', 'XDG_CACHE_HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'LANG', 'LC_ALL', 'TZ']);
for (const key of Object.keys(process.env)) if (!allowedEnv.has(key)) delete process.env[key];
const insideHome = (value) => resolve(value) === resolve(HOME) || resolve(value).startsWith(`${resolve(HOME)}${sep}`);
if (process.env.HOME !== HOME) bootFail('sanitized HOME must equal --home');
for (const key of ['TMPDIR', 'XDG_CACHE_HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME']) {
  const value = process.env[key];
  if (!value || !insideHome(value)) bootFail(`${key} must be inside --home`);
}
process.env.ECHO_CONTEXT_HOME = HOME;

const { SqliteStorage } = await import('../src/storage/sqlite.js');
const { searchMemories } = await import('../src/mcp/tools/search-memories.js');
const { getRecentWorkContext } = await import('../src/mcp/internal/cluster-engine.js');
const { waitForNewTurns } = await import('../src/mcp/tools/wait-for-new-turns.js');
const storage = new SqliteStorage(join(HOME, 'context.db'));

class BodyLimitError extends Error {}
class BodyDeadlineError extends Error {}

async function readBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > API.limits.request_body_bytes) throw new BodyLimitError('request body exceeds committed limit');
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
function errorResponse(response, status, message) {
  if (response.writableEnded) return;
  const bytes = Buffer.from(JSON.stringify({ error: message }), 'utf8');
  response.statusCode = status;
  response.setHeader('content-type', 'application/json');
  response.setHeader('content-length', String(bytes.length));
  response.end(bytes);
}
function contractError(validate) {
  return ajv.errorsText(validate.errors, { separator: '; ' });
}
function sendContractResponse(route, response, status, value) {
  const validate = validators.get(route)?.response;
  if (!validate || !validate(value)) {
    errorResponse(response, 500, `response schema violation: ${validate ? contractError(validate) : 'missing route validator'}`);
    return;
  }
  const bytes = Buffer.from(JSON.stringify(value), 'utf8');
  if (bytes.length > API.limits.response_body_bytes) {
    errorResponse(response, 507, 'response exceeds committed result-size limit');
    return;
  }
  response.statusCode = status;
  response.setHeader('content-type', 'application/json');
  response.setHeader('content-length', String(bytes.length));
  response.end(bytes);
}

let shuttingDown = false;
const server = createServer((request, response) => {
  void (async () => {
    if (shuttingDown) return errorResponse(response, 503, 'service shutting down');
    const deadline = setTimeout(() => {
      errorResponse(response, 408, 'request deadline exceeded');
      request.destroy(new BodyDeadlineError('request deadline exceeded'));
    }, API.limits.request_deadline_ms);
    deadline.unref();
    const clearDeadline = () => clearTimeout(deadline);
    response.once('finish', clearDeadline);
    response.once('close', clearDeadline);
    try {
      const url = new URL(request.url ?? '/', `http://${HOST}`);
      const route = `${request.method ?? ''} ${url.pathname}`;
      const contract = validators.get(route);
      if (!contract) {
        const knownPath = [...validators.keys()].some((candidate) => candidate.endsWith(` ${url.pathname}`));
        return errorResponse(response, knownPath ? 405 : 404, knownPath ? 'method not allowed' : 'unknown endpoint');
      }
      if (route === 'GET /v1/ping') {
        return sendContractResponse(route, response, 200, { pong: true, ts: new Date().toISOString() });
      }
      if (!/^application\/json(?:\s*;|$)/i.test(String(request.headers['content-type'] ?? ''))) {
        return errorResponse(response, 415, 'content-type must be application/json');
      }
      let body;
      try {
        body = await readBody(request);
      } catch (error) {
        if (error instanceof BodyLimitError) return errorResponse(response, 413, error.message);
        if (error instanceof BodyDeadlineError) return;
        return errorResponse(response, 400, 'invalid JSON');
      }
      if (!contract.request(body)) return errorResponse(response, 400, `request schema violation: ${contractError(contract.request)}`);
      if (route === 'POST /v1/capture') {
        const id = await storage.append({
          source: body.source,
          timestamp: body.timestamp,
          content: body.content,
          ...(body.metadata !== undefined ? { metadata: body.metadata } : {}),
        });
        return sendContractResponse(route, response, 200, { id });
      }
      if (route === 'POST /v1/search') return sendContractResponse(route, response, 200, await searchMemories(storage, body));
      if (route === 'POST /v1/clusters') return sendContractResponse(route, response, 200, await getRecentWorkContext(storage, body));
      if (route === 'POST /v1/atoms') return sendContractResponse(route, response, 200, { atoms: await storage.getByIds(body.atom_ids) });
      if (route === 'POST /v1/wait') return sendContractResponse(route, response, 200, await waitForNewTurns(storage, body));
      throw new Error(`unhandled committed route: ${route}`);
    } catch (error) {
      errorResponse(response, 500, error instanceof Error ? error.message : String(error));
    }
  })();
});
server.requestTimeout = API.limits.request_deadline_ms;
server.headersTimeout = API.limits.request_deadline_ms;
server.keepAliveTimeout = 1_000;
server.on('clientError', (_error, socket) => socket.destroy());
server.on('error', (error) => {
  process.stderr.write(`verify-service-parity: listen error ${error.message}\n`);
  process.exitCode = 1;
});
server.listen(PORT, HOST, () => {
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : PORT;
  writeSync(READY_FD, `${JSON.stringify({ host: HOST, port, pid: process.pid })}\n`);
});

let shutdownStarted = false;
function shutdown(signal) {
  if (shutdownStarted) return;
  shutdownStarted = true;
  shuttingDown = true;
  const failureTimer = setTimeout(() => {
    process.stderr.write(`verify-service-parity: graceful shutdown deadline exceeded after ${signal}\n`);
    server.closeAllConnections?.();
    try { storage.close(); } catch {}
    process.exit(1);
  }, API.limits.graceful_shutdown_ms);
  failureTimer.unref();
  server.close((error) => {
    clearTimeout(failureTimer);
    try { storage.close(); } catch (closeError) {
      process.stderr.write(`verify-service-parity: storage close failed: ${closeError.message}\n`);
      process.exit(1);
      return;
    }
    if (error) {
      process.stderr.write(`verify-service-parity: server close failed: ${error.message}\n`);
      process.exit(1);
      return;
    }
    process.exit(0);
  });
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
