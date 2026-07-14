import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createServer, type Server as HttpServer } from 'node:http';
import { createLogger } from '../logging/index.js';
import type { Storage } from '../storage/interface.js';
import {
  instrumentMcpServer,
  readRecentMcpCalls,
  type RecentMcpCallStatus,
} from './request-log.js';
import { registerEchoPing } from './tools/echo-ping.js';
import { registerEchoResolveMru } from './tools/echo-resolve-mru.js';
import { registerFindClusters } from './tools/find-clusters.js';
import { registerGetAtom } from './tools/get-atom.js';
import { registerGetAtoms } from './tools/get-atoms.js';
import { registerRecentWorkContext } from './tools/recent-work-context.js';
import { registerSearchMemories } from './tools/search-memories.js';
import { registerWaitForNewTurns } from './tools/wait-for-new-turns.js';

const log = createLogger('mcp.server');

export interface McpServerHandle {
  stop: () => Promise<void>;
  port: number;
  url: string;
}

export interface StartMcpServerOptions {
  port?: number;
  host?: string;
}

const MAX_BODY_BYTES = 4 * 1024 * 1024;

class BodyTooLargeError extends Error {
  constructor() {
    super('request body exceeds limit');
  }
}

async function readJsonBody(req: import('node:http').IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    total += buf.length;
    if (total > MAX_BODY_BYTES) throw new BodyTooLargeError();
    chunks.push(buf);
  }
  if (chunks.length === 0) return undefined;
  const raw = Buffer.concat(chunks).toString('utf8');
  if (raw.length === 0) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

function methodNotAllowed(
  res: import('node:http').ServerResponse,
  method: string | undefined,
  allow = 'POST',
): void {
  res.statusCode = 405;
  res.setHeader('Allow', allow);
  res.setHeader('content-type', 'application/json');
  res.end(
    JSON.stringify({
      jsonrpc: '2.0',
      error: {
        code: -32000,
        message: `Method Not Allowed: ${method ?? 'unknown'} (${allow} only)`,
      },
      id: null,
    }),
  );
}

function handleRecentCalls(
  req: import('node:http').IncomingMessage,
  res: import('node:http').ServerResponse,
  host: string,
  boundPort: number,
): boolean {
  const url = new URL(req.url ?? '/', `http://${host}:${boundPort}`);
  if (url.pathname !== '/mcp/recent-calls') return false;
  if (req.method !== 'GET') {
    methodNotAllowed(res, req.method, 'GET');
    return true;
  }

  const since = parseNumberParam(url.searchParams.get('since'), 0);
  const until = parseNumberParam(url.searchParams.get('until'), Number.POSITIVE_INFINITY);
  const status = parseStatusParam(url.searchParams.get('status'));
  if (since === null || until === null || status === null) {
    res.statusCode = 400;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ error: 'invalid recent-calls query parameters' }));
    return true;
  }

  res.statusCode = 200;
  res.setHeader('content-type', 'application/json');
  res.end(
    JSON.stringify({
      calls: readRecentMcpCalls({ since, until, ...(status !== undefined ? { status } : {}) }),
    }),
  );
  return true;
}

function parseNumberParam(raw: string | null, fallback: number): number | null {
  if (raw === null || raw === '') return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseStatusParam(raw: string | null): RecentMcpCallStatus | undefined | null {
  if (raw === null || raw === '') return undefined;
  if (raw === 'pending' || raw === 'ok' || raw === 'error' || raw === 'killed_during_shutdown') {
    return raw;
  }
  return null;
}

export async function startMcpServer(
  storage: Storage,
  options: StartMcpServerOptions = {},
): Promise<McpServerHandle> {
  const host = options.host ?? '127.0.0.1';
  const requestedPort = options.port ?? 38478;

  let boundPort = requestedPort;

  // Stateless: per-request McpServer + StreamableHTTPServerTransport.
  // Storage is shared (process-scoped); only the MCP protocol/session wrapper
  // is request-scoped, so daemon restart no longer invalidates client sessions.
  async function handlePost(
    req: import('node:http').IncomingMessage,
    res: import('node:http').ServerResponse,
    body: unknown,
  ): Promise<void> {
    const mcp = new McpServer({ name: 'echo-context', version: '0.0.0' });
    instrumentMcpServer(mcp);
    registerEchoPing(mcp);
    registerSearchMemories(mcp, storage);
    registerRecentWorkContext(mcp, storage);
    registerFindClusters(mcp, storage);
    registerGetAtoms(mcp, storage);
    registerWaitForNewTurns(mcp, storage);
    registerGetAtom(mcp, storage);
    registerEchoResolveMru(mcp, storage);

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
      enableDnsRebindingProtection: true,
      allowedHosts: [`127.0.0.1:${boundPort}`, `localhost:${boundPort}`],
    });

    try {
      await mcp.connect(transport);
      await transport.handleRequest(req, res, body);
    } finally {
      await transport.close();
      await mcp.close();
    }
  }

  const httpServer: HttpServer = createServer((req, res) => {
    void (async () => {
      if (handleRecentCalls(req, res, host, boundPort)) {
        return;
      }

      if (req.method !== 'POST') {
        methodNotAllowed(res, req.method);
        return;
      }

      let body: unknown;
      try {
        body = await readJsonBody(req);
      } catch (err) {
        if (err instanceof BodyTooLargeError) {
          res.statusCode = 413;
          res.setHeader('content-type', 'application/json');
          res.end(
            JSON.stringify({
              jsonrpc: '2.0',
              error: { code: -32000, message: 'request body too large' },
              id: null,
            }),
          );
          return;
        }
        throw err;
      }

      await handlePost(req, res, body);
    })().catch((err: unknown) => {
      log.error('handle_request_failed', {
        message: (err as Error).message,
      });
      if (!res.headersSent) {
        res.statusCode = 500;
        res.end();
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error): void => {
      httpServer.removeListener('listening', onListening);
      reject(err);
    };
    const onListening = (): void => {
      httpServer.removeListener('error', onError);
      resolve();
    };
    httpServer.once('error', onError);
    httpServer.once('listening', onListening);
    httpServer.listen(requestedPort, host);
  });

  const addr = httpServer.address();
  boundPort = typeof addr === 'object' && addr !== null ? addr.port : requestedPort;
  const url = `http://${host}:${boundPort}/mcp`;

  log.info('started', { port: boundPort, url, host });

  return {
    port: boundPort,
    url,
    stop: async () => {
      await new Promise<void>((resolve) => {
        httpServer.close(() => {
          resolve();
        });
        httpServer.closeAllConnections?.();
      });
      log.info('stopped', {});
    },
  };
}
