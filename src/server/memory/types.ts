

export type MemoryScope = 'personal' | 'project' | 'session';
export type MemoryType = 'constraint' | 'preference' | 'lesson' | 'fact';
export type MemoryStatus = 'active' | 'candidate' | 'archived' | 'discarded';
export type MemoryRelationType =
  | 'conflicts_with'
  | 'generalized_from'
  | 'similar_to'
  | 'derived_from'


  | 'revises';


export type EvidenceClass = 'user_stated' | 'user_corrected' | 'inferred' | 'agent_proposed';


export type AbstractionLevel = 'concrete' | 'contextual' | 'general';


export type MemoryActor = 'user' | 'agent' | 'system';


export interface ActorMeta {
  actor: MemoryActor;
  sessionId?: string;
  turn?: number;
}

export type MemoryEventKind =
  | 'create'
  | 'edit'
  | 'rescope'
  | 'promote'
  | 'status'
  | 'revert'
  | 'use'
  | 'trace'
  | 'reinforce'
  | 'renew';


export type MemoryTraceLabel = 'operational' | 'injected_without_effect' | 'violated' | 'not_applicable';

export interface MemoryRelation {
  type: MemoryRelationType;
  targetId: string;
}

export interface MemoryItem {
  id: string;
  content: string;
  detail?: string;
  abstractionLevel: AbstractionLevel;

  sensitive: boolean;
  scope: MemoryScope;
  type: MemoryType;
  status: MemoryStatus;
  projectId?: string;
  sessionId?: string;
  topic?: string;
  createdAt: string;
  updatedAt: string;
  provenanceSessionId?: string;
  provenanceTurn?: number;
  usageCount: number;

  reinforcedCount: number;

  evidenceClass?: EvidenceClass;


  version: number;


  lastTraceLabel?: MemoryTraceLabel;

  revisionOf?: { id: string; content: string };
  citedInCurrentSession: number;
  citedAtSteps?: number[];
  relations?: MemoryRelation[];
}

export interface ScoredMemory {
  memory: MemoryItem;
  score: number;
}


export type MemoryItemSnapshot = Pick<
  MemoryItem,
  'content' | 'detail' | 'scope' | 'type' | 'status' | 'topic' | 'abstractionLevel' | 'projectId' | 'sessionId'
>;


export interface MemoryEvent {
  seq: number;
  memoryId: string;
  ts: string;
  kind: MemoryEventKind;
  actor: MemoryActor;
  sessionId?: string;
  turn?: number;
  changes?: Record<string, { before: unknown; after: unknown }>;
  snapshot?: MemoryItemSnapshot;
  meta?: Record<string, unknown>;
}
