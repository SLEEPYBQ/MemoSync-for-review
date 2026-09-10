

import type { LlmJsonCaller } from './deepseek';
import type { MemoryService } from './index';
import type { ActorMeta } from './types';
import { validateCandidate } from './capture';
import type { StudySessionAttribution } from '../study-session-attribution';

export type AttentionKind = 'conflict' | 'redundant' | 'stale';
type MaintenanceActorMeta = ActorMeta & {
  surface?: 'board' | 'chat_gate';
  studyAttribution?: Partial<StudySessionAttribution>;
};

const MERGE_SYSTEM = `You merge two near-duplicate developer-memory items into ONE. Produce a single \
item that preserves every distinct piece of information from both — union their facts, do not average \
them away. Keep the user's own wording where possible.

Respond with strict JSON only:
{"content": "<concise standalone memory, semantically complete, at most 100 words; never cut off mid-sentence>", "detail": "<2-4 self-contained sentences \
covering everything both originals said>", "type": "constraint" | "preference" | "lesson" | "fact", \
"topic": "<short label or null>", "abstractionLevel": "concrete" | "contextual" | "general"}`;


export interface SessionClockEntry {
  id: string;
  startedAt: string;
}

export interface MaintenanceServiceOptions {
  memory: MemoryService;

  callJson?: LlmJsonCaller;
}

export function createMaintenanceService(opts: MaintenanceServiceOptions) {
  const { memory, callJson } = opts;

  return {


    archive(kind: AttentionKind, memoryId: string, meta: MaintenanceActorMeta) {
      const item = memory.store.getById(memoryId);
      if (!item) throw new Error(`Memory not found: ${memoryId}`);
      if (item.status !== 'active') throw new Error(`Only an active memory can be archived (got ${item.status})`);
      const archived = memory.store.archive(memoryId, meta);
      memory.logger.event({
        type: 'memory.attention',
        sessionId: meta.studyAttribution?.sessionId ?? meta.sessionId,
        taskId: meta.studyAttribution?.taskId,
        kind,
        id: memoryId,
        action: 'archive',
        surface: meta.surface,
      });
      memory.syncProjection(archived.projectId);
      return archived;
    },


    renew(memoryId: string, meta: MaintenanceActorMeta) {
      const item = memory.store.renewMemory(memoryId, meta);
      memory.logger.event({
        type: 'memory.attention',
        sessionId: meta.studyAttribution?.sessionId ?? meta.sessionId,
        taskId: meta.studyAttribution?.taskId,
        kind: 'stale',
        id: memoryId,
        action: 'renew',
        surface: meta.surface,
      });
      return item;
    },


    keepBoth(memoryId: string, otherMemoryId: string, meta: MaintenanceActorMeta): void {
      const a = memory.store.getById(memoryId);
      const b = memory.store.getById(otherMemoryId);
      if (!a || !b) throw new Error('Memory not found');
      if (a.status !== 'active' || b.status !== 'active') {
        throw new Error('Both memories must still be active to keep');
      }
      memory.store.addRelation(a.id, b.id, 'similar_to');
      memory.logger.event({
        type: 'memory.attention',
        sessionId: meta.studyAttribution?.sessionId ?? meta.sessionId,
        taskId: meta.studyAttribution?.taskId,
        kind: 'redundant',
        id: memoryId,
        action: 'keep',
        surface: meta.surface,
      });
    },


    async merge(memoryId: string, otherMemoryId: string, meta: MaintenanceActorMeta) {
      if (!callJson) throw new Error('Merge drafting is not available (no LLM caller configured)');
      const a = memory.store.getById(memoryId);
      const b = memory.store.getById(otherMemoryId);
      if (!a || !b) throw new Error('Memory not found');
      if (a.status !== 'active' || b.status !== 'active') {
        throw new Error('Both memories must still be active to merge');
      }
      const draftRaw = await callJson({
        system: MERGE_SYSTEM,
        user: JSON.stringify(
          {
            itemA: { content: a.content, detail: a.detail ?? null, type: a.type, topic: a.topic ?? null },
            itemB: { content: b.content, detail: b.detail ?? null, type: b.type, topic: b.topic ?? null },
          },
          null,
          2,
        ),
      });
      const draft = validateCandidate({ ...draftRaw, scope: a.scope, sensitive: a.sensitive || b.sensitive });
      if (!draft) return null;
      const proposal = memory.store.createMergeProposal(
        {
          content: draft.content,
          detail: draft.detail,
          type: draft.type,
          scope: a.scope,
          topic: draft.topic,
          abstractionLevel: draft.abstractionLevel,
          sensitive: draft.sensitive,
          projectId: a.scope === 'project' ? a.projectId : undefined,
          provenanceSessionId: meta.sessionId,
        },
        [a.id, b.id],
        meta,
        { expectedContents: [a.content, b.content] },
      );
      if (!proposal) return null;
      memory.logger.event({
        type: 'memory.attention',
        sessionId: meta.studyAttribution?.sessionId ?? meta.sessionId,
        taskId: meta.studyAttribution?.taskId,
        kind: 'redundant',
        id: memoryId,
        action: 'merge',
        surface: meta.surface,
      });
      memory.logger.event({
        type: 'memory.propose',
        sessionId: meta.sessionId,
        id: proposal.id,
        memType: proposal.type,
        scope: proposal.scope,
        via: 'merge_draft',
      });
      return proposal;
    },
  };
}

export type MaintenanceService = ReturnType<typeof createMaintenanceService>;
