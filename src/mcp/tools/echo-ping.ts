import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

// Output schema mirrors the handler's return shape exactly. Small enough that
// full mirroring (vs. the permissive z.record(z.unknown()) used for the deeply
// nested cluster/atom bodies in get_recent_work_context) is the right call.
const echoPingOutputSchema = {
  pong: z.boolean(),
  received: z.string().optional(),
  ts: z.string(),
};

export function registerEchoPing(server: McpServer): void {
  server.registerTool(
    'echo_ping',
    {
      description:
        'Connectivity check: returns pong with the received message and a timestamp.',
      inputSchema: { message: z.string().optional() },
      outputSchema: echoPingOutputSchema,
      annotations: { readOnlyHint: true },
    },
    async ({ message }) => {
      const result: { pong: boolean; received?: string; ts: string } = {
        pong: true,
        ts: new Date().toISOString(),
      };
      if (message !== undefined) result.received = message;
      return {
        content: [{ type: 'text', text: JSON.stringify(result) }],
        structuredContent: result,
      };
    },
  );
}
