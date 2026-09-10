

import type { ConditionPolicy } from '../experiment/condition';
import type { AgentProvider } from '../../shared/types';
import type { MemoryService } from './index';
import type { MemoryItem } from './types';
import {
  buildMemoryBlock,
  buildMemoryDeltaBlock,
  buildPlainMemoryBlock,
  formatMemoryLine,
  type MemoryConflictPair,
  type MemoryDeltaEntry,
} from './prompt';
import {
  buildStudyStaticFocusPayload,
  buildStaticFocusPayload,
  ensureStaticMemoryScaffold,
  hashStaticMemoryFiles,
  readStaticMemoryFiles,
  readStudyStaticMemoryFiles,
  type StaticFocusPayload,
} from './static-files';

export interface MemoryInjectionPlan {
  mode: 'skills' | 'plain' | 'file';

  block: string;

  registerTools: boolean;

  injectedMemories: MemoryItem[];


  bakedMemories: MemoryItem[];

  staticFiles: string[];

  staticPayload: StaticFocusPayload | null;


  hash: string;


  sessionRebuildKey: string;
}

export interface PlanMemoryInjectionOptions {
  policy: ConditionPolicy;

  provider: AgentProvider;
  memory: MemoryService;
  projectId?: string;
  chatId?: string;

  workspaceDir: string;


  restrictToIds?: string[];
}

export interface NormalizeMemorySelectionOptions {
  memory: MemoryService;
  projectId?: string;
  chatId?: string;

  selectedIds: readonly string[];
}


export function normalizeMemorySelection(opts: NormalizeMemorySelectionOptions): string[] {
  const selected = new Set(opts.selectedIds);
  return opts.memory
    .injectedFor(opts.projectId, opts.chatId)
    .filter((item) => selected.has(item.id))
    .map((item) => item.id);
}


function conflictPairsAmong(memory: MemoryService, items: MemoryItem[]): MemoryConflictPair[] {
  const injected = new Set(items.map((m) => m.id));
  const seen = new Set<string>();
  const pairs: MemoryConflictPair[] = [];
  for (const item of items) {
    for (const other of memory.store.getConflicts(item.id)) {
      if (other.status !== 'active' || !injected.has(other.id)) continue;
      const key = [item.id, other.id].sort().join('|');
      if (seen.has(key)) continue;
      seen.add(key);
      pairs.push({ id: item.id, otherId: other.id });
    }
  }
  return pairs;
}

export function planMemoryInjection(opts: PlanMemoryInjectionOptions): MemoryInjectionPlan {
  const { policy, memory } = opts;

  if (policy.injection === 'file') {


    const studyStatic = policy.studyMode && policy.condition === 'static';
    const scaffoldSeeds = studyStatic
      ? []
      : memory.injectedFor(opts.projectId);
    ensureStaticMemoryScaffold(opts.workspaceDir, scaffoldSeeds);
    const files = studyStatic
      ? readStudyStaticMemoryFiles(opts.workspaceDir)
      : readStaticMemoryFiles(opts.workspaceDir);
    const staticPayload = studyStatic
      ? buildStudyStaticFocusPayload(files)
      : buildStaticFocusPayload(files);
    const hash = `file:${hashStaticMemoryFiles(files)}`;
    return {
      mode: 'file',
      block: staticPayload.text,
      registerTools: false,
      injectedMemories: [],
      bakedMemories: [],
      staticFiles: files.map((f) => f.relPath),
      staticPayload,
      hash,
      sessionRebuildKey: hash,
    };
  }


  const projectCopyAuto = policy.studyMode && policy.condition === 'auto' && opts.provider === 'claude';
  let injected = projectCopyAuto
    ? memory.autoProjectMemories(opts.projectId)
    : memory.injectedFor(opts.projectId, opts.chatId);
  if (opts.restrictToIds && policy.injection !== 'skills' && !projectCopyAuto) {
    const allowed = new Set(opts.restrictToIds);
    injected = injected.filter((m) => allowed.has(m.id));
  }
  const setHash = injected.map((m) => `${m.id}@v${m.version}`).join('|');

  if (policy.injection === 'plain') {
    const hash = `plain:${setHash}`;
    return {
      mode: 'plain',
      block: buildPlainMemoryBlock(injected),
      registerTools: false,
      injectedMemories: injected,
      bakedMemories: injected,
      staticFiles: [],
      staticPayload: null,
      hash,
      sessionRebuildKey: hash,
    };
  }


  const restricted = opts.restrictToIds
    ? injected.filter((m) => new Set(opts.restrictToIds).has(m.id))
    : injected;
  return {
    mode: 'skills',
    block: buildMemoryBlock({
      memories: restricted,
      tools: policy.memoryTools,
      conflicts: conflictPairsAmong(memory, restricted),
    }),
    registerTools: policy.memoryTools,
    injectedMemories: restricted,
    bakedMemories: restricted,
    staticFiles: [],
    staticPayload: null,
    hash: `skills:${restricted.map(m => `${m.id}@v${m.version}`).join('|')}`,

    sessionRebuildKey: `skills-live:${policy.memoryTools}`,
  };
}

export interface MemoryTurnDeltaOptions {
  memory: MemoryService;
  projectId?: string;
  chatId?: string;

  baseline: Map<string, number>;

  restrictToIds?: string[];
}

export interface MemoryTurnDeltaResult {

  block: string;

  nextBaseline: Map<string, number>;

  visibleMemories: MemoryItem[];

  effectiveMemories: MemoryItem[];

  effectiveIds: string[];
}


export function computeMemoryTurnDelta(opts: MemoryTurnDeltaOptions): MemoryTurnDeltaResult {
  const visible = opts.memory.injectedFor(opts.projectId, opts.chatId);
  const selected = opts.restrictToIds ? new Set(opts.restrictToIds) : null;
  const current = selected ? visible.filter(item => selected.has(item.id)) : visible;
  const currentById = new Map(current.map((m) => [m.id, m]));
  const nextBaseline = new Map(current.map((m) => [m.id, m.version]));

  const entries: MemoryDeltaEntry[] = [];
  for (const item of current) {
    const baseVersion = opts.baseline.get(item.id);
    const conflictsWith = opts.memory.store
      .getConflicts(item.id)
      .filter((o) => o.status === 'active' && currentById.has(o.id))
      .map((o) => o.id);
    if (baseVersion === undefined) {
      entries.push({
        kind: 'added',
        id: item.id,
        version: item.version,
        line: `(${item.scope} · ${item.type}) ${item.content}${item.detail ? ' [+detail]' : ''}`,
        conflictsWith: conflictsWith.length ? conflictsWith : undefined,
      });
    } else if (item.version > baseVersion) {
      entries.push({
        kind: 'edited',
        id: item.id,
        version: item.version,
        fromVersion: baseVersion,
        line: `(${item.scope} · ${item.type}) ${item.content}${item.detail ? ' [+detail]' : ''}`,
        conflictsWith: conflictsWith.length ? conflictsWith : undefined,
      });
    }
  }
  for (const id of opts.baseline.keys()) {
    if (!currentById.has(id)) entries.push({ kind: 'removed', id });
  }

  const ignoreForTurn = opts.restrictToIds
    ? [...opts.baseline.keys()].filter(id => !currentById.has(id))
    : undefined;

  const effective = opts.restrictToIds
    ? current.filter((m) => new Set(opts.restrictToIds).has(m.id))
    : current;

  return {
    block: buildMemoryDeltaBlock({ entries, ignoreForTurn }),
    nextBaseline,
    visibleMemories: visible,
    effectiveMemories: effective,
    effectiveIds: effective.map((m) => m.id),
  };
}

export { formatMemoryLine };
