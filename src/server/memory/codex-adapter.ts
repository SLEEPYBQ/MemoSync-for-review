

import { z } from 'zod';
import type { MemoryToolSpec } from './tools';


export interface CodexDynamicFunctionSpec {
  type: 'function';
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}


export function toCodexDynamicTools(specs: MemoryToolSpec[]): CodexDynamicFunctionSpec[] {
  return specs.map((s) => ({
    type: 'function',
    name: s.name,
    description: s.description,
    inputSchema: z.toJSONSchema(z.object(s.schema)) as Record<string, unknown>,
  }));
}

export { dispatchMemoryTool } from './tools';
export type { MemoryToolContext, MemoryToolResult, MemoryToolSpec } from './tools';
