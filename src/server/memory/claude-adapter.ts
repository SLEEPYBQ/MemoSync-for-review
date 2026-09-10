

import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import type { MemoryToolContext, MemoryToolSpec } from './tools';

export const MEMORY_MCP_SERVER_NAME = 'memory';


export function toClaudeMemoryMcpServer(specs: MemoryToolSpec[], ctx: MemoryToolContext) {
  const tools = specs.map((s) =>
    tool(
      s.name,
      s.description,
      s.schema,
      async (args) => {
        const r = await s.handler(args as Record<string, unknown>, ctx);
        return { content: [{ type: 'text' as const, text: r.text }], isError: r.isError };
      },
      { alwaysLoad: true },
    ),
  );
  return createSdkMcpServer({ name: MEMORY_MCP_SERVER_NAME, version: '1.0.0', tools });
}
