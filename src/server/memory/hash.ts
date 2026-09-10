

import { createHash } from 'node:crypto';
import type { MemoryItem } from './types';

type HashableMemory = Pick<MemoryItem, 'id' | 'content'>;


export function computeMemoryHash(items: HashableMemory[]): string {
  const sorted = [...items].sort((a, b) => a.id.localeCompare(b.id));


  const payload = sorted.map((m) => JSON.stringify([m.id, m.content])).join('\n');
  return createHash('sha1').update(payload).digest('hex').slice(0, 8);
}
