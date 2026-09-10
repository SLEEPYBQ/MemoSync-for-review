

import type { MemoryItem } from './types';


export function formatMemoryLine(m: MemoryItem): string {
  return `[${m.id} v${m.version}] (${m.scope} · ${m.type}) ${m.content}${m.detail ? ' [+detail]' : ''}`;
}


export function formatMemoryList(memories: MemoryItem[]): string {
  if (memories.length === 0) return '(none)';
  return memories.map(formatMemoryLine).join('\n');
}


export function buildPlainMemoryBlock(memories: MemoryItem[]): string {
  if (memories.length === 0) return '';
  return [
    '# Notes from previous sessions',
    '',
    ...memories.map((m) => `- ${m.content}`),
  ].join('\n');
}


export interface MemoryConflictPair {
  id: string;
  otherId: string;
}

export interface MemoryBlockOptions {

  memories: MemoryItem[];

  tools?: boolean;

  conflicts?: MemoryConflictPair[];
}


export function buildMemoryBlock(opts: MemoryBlockOptions): string {
  const tools = opts.tools ?? true;
  const memories = opts.memories ?? [];
  if (memories.length === 0 && !tools) return '';

  const parts: string[] = [];
  parts.push('# Memory (MemoSync)');
  parts.push(
    'You have a persistent, user-controlled memory that spans sessions. ' +
      'The snapshot below lists every memory active at session start, as one-line SHORT forms. ' +
      'Later changes arrive as "Memory changes" notes attached to user messages; those notes are ' +
      'authoritative — they supersede this snapshot and any earlier notes. When the same id appears ' +
      'more than once in the conversation, trust the HIGHEST version (e.g. [M-07 v3] overrides [M-07 v2]).',
  );

  parts.push(
    '\n## Citing memory\nEach memory has an id like [M-07]. Whenever a memory shapes what you do or say — a rule you follow, a preference you honor, a fact you rely on — cite it inline at the point of influence as [M-07]. Do not leave an influence uncited: an uncited memory is invisible to the user.',
  );

  if (tools) {
    parts.push(
      '\n## Loading details\n' +
        'Lines marked `[+detail]` are HEADLINES — a longer, more specific form exists. Before you act on ' +
        'anything such a memory governs (write code it constrains, follow a workflow it describes, answer ' +
        'a question it covers), call `load_memory_detail({ ids: ["M-07"] })` first: the one-line form is ' +
        'not the full rule. Skipping the detail and guessing is the failure mode to avoid; loading none is ' +
        'right only when no [+detail] memory touches the task.',
    );
  }

  parts.push(
    `\n## Memory snapshot (session start)\n${memories.length} ${memories.length === 1 ? 'memory is' : 'memories are'} active:\n${formatMemoryList(memories)}`,
  );

  if (opts.conflicts?.length) {
    parts.push(
      '\n⚠ Unresolved conflicts: ' +
        opts.conflicts.map((c) => `[${c.id}] conflicts with [${c.otherId}]`).join('; ') +
        ' — if both sides apply to the task, ask the user rather than silently picking one.',
    );
  }

  return parts.join('\n');
}


export interface MemoryDeltaEntry {
  kind: 'added' | 'edited' | 'removed';
  id: string;

  version?: number;

  fromVersion?: number;

  line?: string;

  conflictsWith?: string[];
}

export interface MemoryDeltaBlockOptions {
  entries: MemoryDeltaEntry[];

  ignoreForTurn?: string[];
}


export function buildMemoryDeltaBlock(opts: MemoryDeltaBlockOptions): string {
  const { entries, ignoreForTurn } = opts;
  const hasIgnores = Boolean(ignoreForTurn?.length);
  if (entries.length === 0 && !hasIgnores) return '';

  const parts: string[] = [];
  if (entries.length > 0) {
    parts.push(
      'Memory changes since last turn (authoritative — these supersede the session-start snapshot and any earlier change notes; same id → highest version wins):',
    );
    for (const e of entries) {
      const conflictSuffix = e.conflictsWith?.length
        ? ` — ⚠ conflicts with ${e.conflictsWith.map((id) => `[${id}]`).join(', ')} (unresolved; if both apply, ask the user)`
        : '';
      if (e.kind === 'removed') {

        parts.push(`- [${e.id}] (no longer in the active set)`);
      } else if (e.kind === 'added') {
        parts.push(`- [${e.id} v${e.version ?? 1}] (added) ${e.line ?? ''}${conflictSuffix}`);
      } else {
        parts.push(
          `- [${e.id} v${e.version ?? 1}] (edited, v${e.fromVersion ?? 1}→v${e.version ?? 1}) ${e.line ?? ''}${conflictSuffix}`,
        );
      }
    }
  }
  if (hasIgnores) {
    parts.push(`For this turn only, ignore: ${ignoreForTurn!.map((id) => `[${id}]`).join(', ')}.`);
  }
  return parts.join('\n');
}
