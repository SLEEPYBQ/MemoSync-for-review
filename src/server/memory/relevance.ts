

import type { LlmJsonCaller } from './deepseek';
import type { MemoryItem } from './types';

export interface RelevantMemory {
  id: string;

  why: string;

  expectedUse?: string;
}

export interface RelevanceService {


  assess(
    userText: string,
    injected: MemoryItem[],
    opts?: { mustInclude?: string[]; recentContext?: string },
  ): Promise<RelevantMemory[]>;
}

const MAX_RELEVANT = 5;
const WHY_MAX_LEN = 80;
const EXPECTED_USE_MAX_LEN = 220;

const RELEVANCE_SYSTEM = `You are shown a developer's task message and the index of their agent's active \
memories (one line each; [+detail] marks items with a loadable detailed form). Do TWO things in one pass:

1. SELECT the memories LIKELY TO MATTER for this specific task — the ones the agent should honor or \
draw on while doing it. Up to ${MAX_RELEVANT}; fewer is better than padding; an empty list is correct \
when nothing clearly applies (unless a must-include list is given).
2. For EVERY memory you return, write "why" (under 10 words, tying it to the task) and "expectedUse" — \
one concrete imperative sentence telling the agent how to apply it in THIS task. Name an observable \
action, decision, constraint, or output property; never merely say it is relevant. When the item is \
marked [+detail], tell the agent to load the detail first when appropriate.

When a MUST-INCLUDE list is provided, always include those ids in your output (they are already \
selected; still write their why and expectedUse).

Respond with strict JSON only: {"relevant": [{"id": "M-07", "why": "<short clause>", "expectedUse": \
"<one imperative sentence>"}, ...]}.`;

export function createRelevanceService(opts: { callJson: LlmJsonCaller }): RelevanceService {
  const { callJson } = opts;
  return {
    async assess(userText, injected, options): Promise<RelevantMemory[]> {
      const mustInclude = (options?.mustInclude ?? []).filter((id) => injected.some((m) => m.id === id));
      if (injected.length === 0 || !userText.trim()) return mustInclude.map((id) => ({ id, why: '' }));
      try {
        const raw = await callJson({
          system: RELEVANCE_SYSTEM,
          user:
            (options?.recentContext?.trim()
              ? `Recent conversation (earlier turns, context only — the task is below):\n${options.recentContext.trim()}\n\n`
              : '') +
            `Task:\n${userText}\n\nActive memory index:\n` +
            injected
              .map((m) => `[${m.id}] (${m.scope} · ${m.type}) ${m.content}${m.detail ? ' [+detail]' : ''}`)
              .join('\n') +
            (mustInclude.length ? `\n\nMUST-INCLUDE ids: ${mustInclude.join(', ')}` : ''),


          disableThinking: true,
          maxTokens: 1400,
          timeoutMs: 15_000,
        });
        const list = Array.isArray(raw.relevant) ? (raw.relevant as unknown[]) : [];
        const injectedIds = new Set(injected.map((m) => m.id));
        const seen = new Set<string>();
        const out: RelevantMemory[] = [];
        const cap = MAX_RELEVANT + mustInclude.length;
        for (const entry of list) {
          if (!entry || typeof entry !== 'object') continue;
          const rec = entry as Record<string, unknown>;
          const id = typeof rec.id === 'string' ? rec.id : '';


          if (!id || !injectedIds.has(id) || seen.has(id)) continue;
          seen.add(id);
          const expectedUse = typeof rec.expectedUse === 'string' && rec.expectedUse.trim()
            ? rec.expectedUse.trim().slice(0, EXPECTED_USE_MAX_LEN)
            : undefined;
          out.push({
            id,
            why: typeof rec.why === 'string' ? rec.why.trim().slice(0, WHY_MAX_LEN) : '',
            ...(expectedUse ? { expectedUse } : {}),
          });
          if (out.length >= cap) break;
        }


        for (const id of mustInclude) {
          if (!seen.has(id)) out.push({ id, why: '' });
        }
        return out;
      } catch {


        return mustInclude.map((id) => ({ id, why: '' }));
      }
    },
  };
}
