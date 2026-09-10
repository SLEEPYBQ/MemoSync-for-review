

import type { LlmJsonCaller } from './deepseek';
import type { MemoryService } from './index';
import type { MemoryItem, MemoryType } from './types';

export interface MemorySummarySnapshot {

  text: string;
  updatedAt: string;

  stale: boolean;
}

export interface SummaryChatResult {

  reply: string;

  applied: number;

  summary: MemorySummarySnapshot;
}

export interface SummaryService {
  get(projectId: string): MemorySummarySnapshot;

  refresh(projectId: string): Promise<MemorySummarySnapshot>;

  chat(message: string, opts: { projectId: string; sessionId?: string; eventId?: string }): Promise<SummaryChatResult>;
}

const SUMMARY_SYSTEM = `You write the "memory summary" panel of an AI coding assistant: a concise, \
second-person prose summary of the assistant's memory copy for the current project. \
Input: the raw memory items. Output: Markdown with short "## " section headings chosen to fit the \
content (e.g. Overview, Preferences & habits, Project knowledge, Constraints). Rules: only restate \
what the items say — never invent; merge related items into flowing sentences; omit empty sections; \
keep it under 220 words; no bullet lists, prose only; no preamble or closing line.

Respond with strict JSON only: {"summary": "<markdown>"}.`;

const CHAT_SYSTEM = `You are the memory panel assistant of an AI coding tool. The user talks to you to \
INSPECT or CHANGE what the tool remembers about them. You are given the current memory items \
(id + content) and the user's message.

- Questions ("what do you remember about X?") → answer from the items, conversationally.
- Requests to remember/add → operations with action "add" (content: a concise, standalone memory of \
at most 100 words; optional detail/type/topic). Keep content semantically complete; never cut it off mid-sentence. \
All items join the current project's memory copy.
- Requests to change/correct → action "edit" with the item id and complete replacement content following \
the same 100-word target.
- Requests to forget/remove → action "forget" with the item id.
- A vague "anything to update?" with nothing to change → empty operations and say so briefly.

Never invent items. Reply in the user's language. Classify an explicit request to add, change, or \
forget memory as intent "update"; classify questions and inspection as intent "inspect". Respond \
with strict JSON only:
{"intent": "inspect" | "update", "reply": "<conversational answer>", "operations": [{"action": "add" | "edit" | "forget", \
"id": "<existing id, for edit/forget>", "content": "...", "detail": "...", "type": "constraint" | \
"preference" | "lesson" | "fact", "topic": "..."}]}`;

export interface AutoProjectSummaryProjection {
  text: string;
  updatedAt: string;
  itemsHash: string;
}

export const autoProjectSummaryKey = (projectId: string) => `auto_summary:project:${projectId}`;


export function buildCanonicalAutoProjectSummary(items: MemoryItem[]): string {
  if (items.length === 0) return '';
  const paragraphs = items.map((item) => (
    [item.content.trim(), item.detail?.trim()].filter(Boolean).join('\n\n')
  ));
  return ['## Project memory', '', paragraphs.join('\n\n')].join('\n');
}

function autoSummaryRequestEventId(eventId?: string): string {
  return eventId ?? `prompt:auto-summary:${crypto.randomUUID()}`;
}

function autoSummaryControlEventId(requestEventId: string): string {
  return `control:auto-summary:${requestEventId}`;
}

function pool(memory: MemoryService, projectId: string): MemoryItem[] {
  return memory.autoProjectMemories(projectId);
}

export function autoProjectSummaryItemsHash(items: MemoryItem[]): string {
  return items.map((m) => `${m.id}@v${m.version}`).join('|');
}

export function createSummaryService(opts: { memory: MemoryService; callJson: LlmJsonCaller }): SummaryService {
  const { memory, callJson } = opts;

  function getSnapshot(projectId: string): MemorySummarySnapshot {
    const storedProjection = memory.store.getKv<AutoProjectSummaryProjection>(autoProjectSummaryKey(projectId));
    const currentHash = autoProjectSummaryItemsHash(pool(memory, projectId));
    if (!storedProjection) return { text: '', updatedAt: '', stale: currentHash !== '' };
    return {
      text: storedProjection.text,
      updatedAt: storedProjection.updatedAt,
      stale: storedProjection.itemsHash !== currentHash,
    };
  }

  async function regenerate(projectId: string): Promise<MemorySummarySnapshot> {
    const items = pool(memory, projectId);
    let text = '';
    if (items.length > 0) {
      const raw = await callJson({
        system: SUMMARY_SYSTEM,
        user: JSON.stringify(
          items.map((m) => ({ id: m.id, scope: m.scope, type: m.type, topic: m.topic ?? null, content: m.content, detail: m.detail ?? null })),
          null,
          2,
        ),
      });
      text = typeof raw.summary === 'string' ? raw.summary.trim() : '';
    }
    const snapshot = { text, updatedAt: new Date().toISOString(), itemsHash: autoProjectSummaryItemsHash(items) };
    memory.store.setKv(autoProjectSummaryKey(projectId), snapshot);
    return { text: snapshot.text, updatedAt: snapshot.updatedAt, stale: false };
  }

  return {
    get: getSnapshot,

    refresh: regenerate,

    async chat(message: string, chatOpts: { projectId: string; sessionId?: string; eventId?: string }): Promise<SummaryChatResult> {
      const requestEventId = autoSummaryRequestEventId(chatOpts.eventId);


      memory.logger.event({
        type: 'study.participant_prompt',
        eventId: requestEventId,
        sessionId: chatOpts.sessionId,
        surface: 'auto_summary_chat',
        action: 'submit',
        projectId: chatOpts.projectId,
        content: message,
      });
      const items = pool(memory, chatOpts.projectId);
      const raw = await callJson({
        system: CHAT_SYSTEM,
        user:
          `Current memory items:\n${JSON.stringify(items.map((m) => ({ id: m.id, scope: m.scope, content: m.content })), null, 2)}\n\n` +
          `User message:\n${message.trim()}`,
      });
      const reply = typeof raw.reply === 'string' ? raw.reply.trim() : '';


      const requestedUpdate = raw.intent === 'update';
      const operations = requestedUpdate && Array.isArray(raw.operations)
        ? (raw.operations as unknown[])
        : [];
      const byId = new Map(items.map((m) => [m.id, m]));
      const meta = { actor: 'user' as const, sessionId: chatOpts?.sessionId };
      let applied = 0;


      for (const op of operations) {
        if (!op || typeof op !== 'object') continue;
        const rec = op as Record<string, unknown>;
        try {
          if (rec.action === 'add' && typeof rec.content === 'string' && rec.content.trim()) {
            const type: MemoryType = ['constraint', 'preference', 'lesson', 'fact'].includes(rec.type as string)
              ? (rec.type as MemoryType)
              : 'fact';
            const item = memory.store.create(
              {
                content: rec.content.trim(),
                detail: typeof rec.detail === 'string' && rec.detail.trim() ? rec.detail.trim() : undefined,
                type,
                scope: 'project',
                projectId: chatOpts.projectId,


                status: 'active',
                topic: typeof rec.topic === 'string' && rec.topic.trim() ? rec.topic.trim() : undefined,
                evidenceClass: 'user_stated',
              },
              meta,
            );
            memory.logger.event({ type: 'memory.decision', sessionId: chatOpts?.sessionId, action: 'create', id: item.id, via: 'summary_chat' });
            applied++;
          } else if (rec.action === 'edit' && typeof rec.id === 'string' && byId.get(rec.id)?.status === 'active') {
            const patch: Partial<MemoryItem> = {};
            if (typeof rec.content === 'string' && rec.content.trim()) patch.content = rec.content.trim();
            if (typeof rec.detail === 'string') patch.detail = rec.detail.trim() || undefined;
            if (typeof rec.topic === 'string') patch.topic = rec.topic.trim() || undefined;
            if (Object.keys(patch).length === 0) continue;
            memory.store.update(rec.id, patch, meta);
            memory.logger.event({ type: 'memory.decision', sessionId: chatOpts?.sessionId, action: 'edit', id: rec.id, via: 'summary_chat' });
            applied++;
          } else if (rec.action === 'forget' && typeof rec.id === 'string' && byId.get(rec.id)?.status === 'active') {
            memory.store.archive(rec.id, meta);
            memory.logger.event({ type: 'memory.decision', sessionId: chatOpts?.sessionId, action: 'archive', id: rec.id, via: 'summary_chat' });
            applied++;
          }


        } catch {

        }
      }

      if (requestedUpdate) {


        memory.logger.event({
          type: 'memory.control_request',
          eventId: autoSummaryControlEventId(requestEventId),
          sessionId: chatOpts.sessionId,
          via: 'auto_summary_chat',
          requestedAction: 'update_memory',
          causalRequestId: requestEventId,
          applied,
        });
      }

      if (applied > 0) memory.syncProjection(chatOpts.projectId);


      const summary = applied > 0 || getSnapshot(chatOpts.projectId).stale
        ? await regenerate(chatOpts.projectId)
        : getSnapshot(chatOpts.projectId);
      return { reply, applied, summary };
    },
  };
}
