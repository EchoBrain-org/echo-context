import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createServer } from 'node:http';
import type { Storage } from '../../src/storage/interface.js';
import { ECHO_CONTEXT_VERSION } from '../../src/version.js';
import { registerEchoPing } from '../../src/mcp/tools/echo-ping.js';
import { registerEchoResolveMru } from '../../src/mcp/tools/echo-resolve-mru.js';
import { registerFindClusters } from '../../src/mcp/tools/find-clusters.js';
import { registerGetAtom } from '../../src/mcp/tools/get-atom.js';
import { registerGetAtoms } from '../../src/mcp/tools/get-atoms.js';
import { registerRecentWorkContext } from '../../src/mcp/tools/recent-work-context.js';
import { registerSearchMemories } from '../../src/mcp/tools/search-memories.js';
import { registerWaitForNewTurns } from '../../src/mcp/tools/wait-for-new-turns.js';

export interface LegacyRwcServerHandle {
  stop: () => Promise<void>;
  port: number;
  url: string;
}

/** Test-only harness for the removed MCP wrapper. It preserves its historical
 *  transport/schema regression coverage without putting it back in the
 *  production roster. The service API tests cover the supported /v1/clusters
 *  path separately. */
export async function startLegacyRecentWorkContextServer(
  storage: Storage,
  options: { port?: number } = {},
): Promise<LegacyRwcServerHandle> {
  const httpServer = createServer((req, res) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const body = chunks.length === 0 ? undefined : JSON.parse(Buffer.concat(chunks).toString());
      const mcp = new McpServer({ name: 'echo-context-legacy-test', version: ECHO_CONTEXT_VERSION });
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
      });
      try {
        await mcp.connect(transport);
        await transport.handleRequest(req, res, body);
      } finally {
        await transport.close();
        await mcp.close();
      }
    })().catch((error: unknown) => {
      res.statusCode = 500;
      res.end(error instanceof Error ? error.message : String(error));
    });
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(options.port ?? 0, '127.0.0.1', resolve);
  });
  const address = httpServer.address();
  if (typeof address !== 'object' || address === null) throw new Error('legacy test server bind failed');
  return {
    port: address.port,
    url: `http://127.0.0.1:${address.port}/mcp`,
    stop: () =>
      new Promise<void>((resolve, reject) => {
        httpServer.close((error) => (error === undefined ? resolve() : reject(error)));
      }),
  };
}
