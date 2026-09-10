

import type { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import type {
  ActorMeta,
  AbstractionLevel,
  EvidenceClass,
  MemoryEvent,
  MemoryEventKind,
  MemoryItem,
  MemoryItemSnapshot,
  MemoryScope,
  MemoryType,
  MemoryStatus,
  MemoryRelation,
  MemoryRelationType,
  MemoryTraceLabel,
} from './types';
import { computeMemoryHash } from './hash';


type Bind = string | number | bigint | boolean | null | Uint8Array;

export interface CreateMemoryInput {
  content: string;
  detail?: string;
  abstractionLevel?: AbstractionLevel;
  sensitive?: boolean;
  scope: MemoryScope;
  type: MemoryType;
  status?: MemoryStatus;
  projectId?: string;
  sessionId?: string;
  topic?: string;
  provenanceSessionId?: string;
  provenanceTurn?: number;
  evidenceClass?: EvidenceClass;

  id?: string;
}

export interface MemoryFilter {
  scope?: MemoryScope;
  projectId?: string;
  sessionId?: string;
  status?: MemoryStatus;
}


export interface UseMeta extends ActorMeta {

  via?: string;

  detailLoaded?: boolean;
}

interface MemoryRow {
  id: string;
  content: string;
  detail: string | null;
  abstraction_level: string;
  sensitive: number;
  scope: string;
  type: string;
  status: string;
  project_id: string | null;
  session_id: string | null;
  topic: string | null;
  provenance_session_id: string | null;
  provenance_turn: number | null;
  usage_count: number;
  reinforced_count: number;
  evidence_class: string | null;
  version: number;
  created_at: string;
  updated_at: string;
}

interface MemoryEventRow {
  seq: number;
  memory_id: string;
  ts: string;
  kind: string;
  actor: string;
  session_id: string | null;
  turn: number | null;
  changes: string | null;
  snapshot: string | null;
  meta: string | null;
}


const UPDATABLE_COLUMNS: Record<string, string> = {
  content: 'content',
  detail: 'detail',
  abstractionLevel: 'abstraction_level',
  sensitive: 'sensitive',
  scope: 'scope',
  type: 'type',
  status: 'status',
  projectId: 'project_id',
  sessionId: 'session_id',
  topic: 'topic',
  provenanceSessionId: 'provenance_session_id',
  provenanceTurn: 'provenance_turn',
  evidenceClass: 'evidence_class',
};


const VERSIONED_FIELDS = [
  'content',
  'detail',
  'scope',
  'type',
  'status',
  'topic',
  'abstractionLevel',
  'projectId',
  'sessionId',
] as const;


const SCOPE_REACH: Record<MemoryScope, number> = { session: 0, project: 1, personal: 2 };


const CONTENT_VERSION_FIELDS = ['content', 'detail', 'scope', 'type', 'topic', 'abstractionLevel'] as const;

type CandidateDecisionTransition = 'ordinary' | 'dismiss' | 'restore';


export class CandidateDismissalTransitionError extends Error {
  readonly code = 'CANDIDATE_DISCARDED';

  constructor(message = 'A dismissed Candidate is immutable. Restore a non-sensitive Candidate through its review flow.') {
    super(message);
    this.name = 'CandidateDismissalTransitionError';
  }
}

export class MemoryStore {
  constructor(private db: Database) {}


  static computeHash(items: Array<Pick<MemoryItem, 'id' | 'content'>>): string {
    return computeMemoryHash(items);
  }

  create(input: CreateMemoryInput, meta: ActorMeta): MemoryItem {
    return this.db.transaction(() => {
      const id = input.id ?? this.nextId();
      if (this.db.query(
        'SELECT 1 FROM dismissed_candidate_fingerprints WHERE memory_id = ?',
      ).get(id)) {
        throw new Error(`Memory id was already used by a dismissed candidate: ${id}`);
      }
      const now = new Date().toISOString();
      this.db
        .query(
          `INSERT INTO memories
             (id, content, detail, abstraction_level, sensitive, scope, type, status, project_id, session_id, topic,
              provenance_session_id, provenance_turn, usage_count, reinforced_count, evidence_class, created_at, updated_at)
           VALUES
             ($id, $content, $detail, $abstraction_level, $sensitive, $scope, $type, $status, $project_id, $session_id, $topic,
              $provenance_session_id, $provenance_turn, $usage_count, $reinforced_count, $evidence_class, $created_at, $updated_at)`,
        )
        .run({
          $id: id,
          $content: input.content,
          $detail: input.detail ?? null,
          $abstraction_level: input.abstractionLevel ?? 'contextual',
          $sensitive: input.sensitive ? 1 : 0,
          $scope: input.scope,
          $type: input.type,
          $status: input.status ?? 'active',
          $project_id: input.projectId ?? null,
          $session_id: input.sessionId ?? null,
          $topic: input.topic ?? null,
          $provenance_session_id: input.provenanceSessionId ?? null,
          $provenance_turn: input.provenanceTurn ?? null,
          $usage_count: 0,
          $reinforced_count: 0,
          $evidence_class: input.evidenceClass ?? null,
          $created_at: now,
          $updated_at: now,
        });
      const created = this.getById(id)!;
      this.appendEvent(id, 'create', meta, { snapshot: this.snapshotOf(created) });
      return created;
    })();
  }


  createDerivedMemory(
    input: CreateMemoryInput,
    sourceId: string,
    meta: ActorMeta,
    opts?: { conflictsWith?: string },
  ): MemoryItem {
    return this.db.transaction(() => {
      const created = this.create(input, meta);
      this.addRelation(created.id, sourceId, 'derived_from');
      if (opts?.conflictsWith) this.addRelation(created.id, opts.conflictsWith, 'conflicts_with');
      return created;
    })() as MemoryItem;
  }

  getById(id: string): MemoryItem | null {
    const row = this.db.query('SELECT * FROM memories WHERE id = ?').get(id) as MemoryRow | null;
    return row ? this.rowToItem(row) : null;
  }

  list(filter: MemoryFilter = {}): MemoryItem[] {
    const clauses: string[] = [];
    const params: Bind[] = [];
    if (filter.scope) {
      clauses.push('scope = ?');
      params.push(filter.scope);
    }
    if (filter.projectId) {
      clauses.push('project_id = ?');
      params.push(filter.projectId);
    }
    if (filter.sessionId) {
      clauses.push('session_id = ?');
      params.push(filter.sessionId);
    }
    if (filter.status) {
      clauses.push('status = ?');
      params.push(filter.status);
    }
    const where = clauses.length ? ` WHERE ${clauses.join(' AND ')}` : '';

    const rows = this.db
      .query(
        `SELECT * FROM memories${where}
         ORDER BY CAST(SUBSTR(id, INSTR(id, '-') + 1) AS INTEGER), id`,
      )
      .all(...params) as MemoryRow[];
    return rows.map((r) => this.rowToItem(r));
  }


  private normalizeScopePatch(existing: MemoryItem, patch: Partial<MemoryItem>): Partial<MemoryItem> {
    if (!patch.scope || patch.scope === existing.scope) return patch;
    const normalized = { ...patch } as Record<string, unknown>;
    if (patch.scope === 'personal') {
      normalized.projectId = null;
      normalized.sessionId = null;
    } else if (patch.scope === 'project') {
      normalized.sessionId = null;
    } else {
      normalized.projectId = null;
    }
    return normalized as Partial<MemoryItem>;
  }

  private candidateDismissalEvidence(id: string): { sensitive: boolean } | null {
    const row = this.db.query(
      'SELECT sensitive FROM dismissed_candidate_fingerprints WHERE memory_id = ?',
    ).get(id) as { sensitive: number } | null;
    return row ? { sensitive: row.sensitive === 1 } : null;
  }

  private recordCandidateDismissal(existing: MemoryItem): void {
    this.db.query(
      `INSERT INTO dismissed_candidate_fingerprints
         (memory_id, fingerprint, dismissed_at, sensitive)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(memory_id) DO UPDATE SET
         dismissed_at = excluded.dismissed_at,
         sensitive = MAX(dismissed_candidate_fingerprints.sensitive, excluded.sensitive)`,
    ).run(
      existing.id,
      this.candidateFingerprint(existing.content),
      new Date().toISOString(),
      existing.sensitive ? 1 : 0,
    );
  }

  private hasDiscardedStatusHistory(id: string): boolean {
    return Boolean(this.db.query(
      `SELECT 1 FROM memory_events
        WHERE memory_id = ?
          AND kind = 'status'
          AND json_extract(changes, '$.status.after') = 'discarded'
        LIMIT 1`,
    ).get(id));
  }


  private assertCandidateDecisionTransition(
    existing: MemoryItem,
    patch: Partial<MemoryItem>,
    transition: CandidateDecisionTransition,
  ): void {
    const nextStatus = patch.status;
    const dismissalEvidence = this.candidateDismissalEvidence(existing.id);
    if (transition === 'dismiss') {
      if (existing.status !== 'candidate' || nextStatus !== 'discarded') {
        throw new Error(`Only a Candidate can be dismissed (got ${existing.status})`);
      }
      return;
    }
    if (transition === 'restore') {
      if (existing.status !== 'discarded' || nextStatus !== 'candidate') {
        throw new CandidateDismissalTransitionError(
          `Only a soft-dismissed Candidate can be restored (got ${existing.status})`,
        );
      }
      if (existing.sensitive || dismissalEvidence?.sensitive) {
        throw new CandidateDismissalTransitionError('Sensitive candidates cannot be restored after dismissal.');
      }
      if (!dismissalEvidence) {
        throw new CandidateDismissalTransitionError(
          `Dismissed candidate has no recoverable suppression record: ${existing.id}`,
        );
      }
      return;
    }

    if (nextStatus === 'discarded') {
      throw new CandidateDismissalTransitionError(
        'Candidate dismissal must use the dedicated dismissal flow.',
      );
    }
    const protectedDecision = existing.status === 'discarded'
      || dismissalEvidence !== null
      || (existing.sensitive && this.hasDiscardedStatusHistory(existing.id));
    if (protectedDecision) throw new CandidateDismissalTransitionError();
  }

  private updateWithCandidateDecision(
    id: string,
    patch: Partial<MemoryItem>,
    meta: ActorMeta,
    transition: CandidateDecisionTransition,
  ): MemoryItem {
    return this.db.transaction(() => {
      const existing = this.getById(id);
      if (!existing) throw new Error(`Memory not found: ${id}`);
      this.assertCandidateDecisionTransition(existing, patch, transition);
      patch = this.normalizeScopePatch(existing, patch);


    const sets: string[] = [];
    const params: Record<string, Bind> = { $id: id };
    const changes: Record<string, { before: unknown; after: unknown }> = {};
    for (const [key, column] of Object.entries(UPDATABLE_COLUMNS)) {
      const value = (patch as Record<string, unknown>)[key];
      if (value === undefined) continue;
      const before = (existing as unknown as Record<string, unknown>)[key] ?? null;
      const after = value ?? null;
      if (before === after) continue;
      sets.push(`${column} = $${column}`);
      params[`$${column}`] = after as Bind;
      changes[key] = { before, after };
    }

      if (sets.length === 0) return existing;

    sets.push('updated_at = $updated_at');
    params.$updated_at = new Date().toISOString();


    if (CONTENT_VERSION_FIELDS.some((f) => f in changes)) {
      sets.push('version = version + 1');
    }
    this.db.query(`UPDATE memories SET ${sets.join(', ')} WHERE id = $id`).run(params);

    const updated = this.getById(id)!;
    this.appendEvent(id, this.classifyChange(existing, changes), meta, {
      changes,
      snapshot: this.snapshotOf(updated),
    });
      return updated;
    })();
  }

  update(id: string, patch: Partial<MemoryItem>, meta: ActorMeta): MemoryItem {
    return this.updateWithCandidateDecision(id, patch, meta, 'ordinary');
  }


  archive(id: string, meta: ActorMeta): MemoryItem {
    return this.update(id, { status: 'archived' }, meta);
  }


  discardCandidate(id: string): void {
    this.db.transaction(() => {
      const existing = this.getById(id);
      if (!existing) throw new Error(`Memory not found: ${id}`);
      if (existing.status !== 'candidate') throw new Error(`Memory is not a candidate: ${id}`);
      this.recordCandidateDismissal(existing);
      this.db.query('DELETE FROM memory_relations WHERE source_id = ? OR target_id = ?').run(id, id);
      this.db.query('DELETE FROM memory_events WHERE memory_id = ?').run(id);
      this.db.query('DELETE FROM memories WHERE id = ?').run(id);
    })();
  }


  eraseCandidate(id: string): void {
    this.db.transaction(() => {
      const existing = this.getById(id);
      if (!existing) return;
      if (existing.status !== 'candidate') throw new Error(`Memory is not a candidate: ${id}`);
      this.db.query('DELETE FROM memory_relations WHERE source_id = ? OR target_id = ?').run(id, id);
      this.db.query('DELETE FROM memory_events WHERE memory_id = ?').run(id);
      this.db.query('DELETE FROM memories WHERE id = ?').run(id);
    })();
  }


  dismissCandidate(id: string, meta: ActorMeta): MemoryItem {
    return this.db.transaction(() => {
      const existing = this.getById(id);
      if (!existing) throw new Error(`Memory not found: ${id}`);
      if (existing.status !== 'candidate') throw new Error(`Memory is not a candidate: ${id}`);
      this.recordCandidateDismissal(existing);
      return this.updateWithCandidateDecision(id, { status: 'discarded' }, meta, 'dismiss');
    })();
  }


  dismissCandidateByPolicy(id: string, meta: ActorMeta): 'hard_erased' | 'soft_dismissed' {
    return this.db.transaction(() => {
      const existing = this.getById(id);
      if (!existing) throw new Error(`Memory not found: ${id}`);
      if (existing.status !== 'candidate') throw new Error(`Memory is not a candidate: ${id}`);
      const evidence = this.candidateDismissalEvidence(id);
      if (existing.sensitive || evidence?.sensitive) {
        this.discardCandidate(id);
        return 'hard_erased';
      }
      this.dismissCandidate(id, meta);
      return 'soft_dismissed';
    })();
  }


  restoreDismissedCandidate(id: string, meta: ActorMeta): MemoryItem {
    return this.db.transaction(() => {
      const existing = this.getById(id);
      if (!existing) throw new Error(`Dismissed candidate is not recoverable: ${id}`);
      const restored = this.updateWithCandidateDecision(id, { status: 'candidate' }, meta, 'restore');
      const lifted = this.db
        .query('DELETE FROM dismissed_candidate_fingerprints WHERE memory_id = ?')
        .run(id);
      if (lifted.changes !== 1) throw new Error(`Failed to lift candidate suppression: ${id}`);
      return restored;
    })() as MemoryItem;
  }


  replaceCandidateDraft(id: string, patch: Partial<MemoryItem>, meta: ActorMeta): MemoryItem {
    const replaced = this.db.transaction(() => {
      const existing = this.getById(id);
      if (!existing) throw new Error(`Memory not found: ${id}`);
      if (existing.status !== 'candidate') throw new Error(`Memory is not a candidate: ${id}`);
      this.assertCandidateDecisionTransition(existing, patch, 'ordinary');
      patch = this.normalizeScopePatch(existing, patch);

      const sets: string[] = [];
      const params: Record<string, Bind> = { $id: id };
      for (const [key, column] of Object.entries(UPDATABLE_COLUMNS)) {
        if (key === 'status') continue;
        const value = (patch as Record<string, unknown>)[key];
        if (value === undefined) continue;
        const before = (existing as unknown as Record<string, unknown>)[key] ?? null;
        const after = value ?? null;
        if (before === after) continue;
        sets.push(`${column} = $${column}`);
        params[`$${column}`] = after as Bind;
      }

      if (sets.length === 0) return existing;
      sets.push('updated_at = $updated_at');
      params.$updated_at = new Date().toISOString();
      this.db.query(`UPDATE memories SET ${sets.join(', ')} WHERE id = $id`).run(params);

      const replaced = this.getById(id)!;
      this.db.query('DELETE FROM memory_events WHERE memory_id = ?').run(id);
      this.appendEvent(id, 'create', meta, { snapshot: this.snapshotOf(replaced) });
      return replaced;
    })();
    return replaced;
  }


  acceptReviewedSensitiveCandidate(
    id: string,
    patch: Partial<MemoryItem> & { content: string; detail: string },
    meta: ActorMeta,
  ): { updated: MemoryItem; replaced: MemoryItem[] } {
    return this.db.transaction(() => {
      const existing = this.getById(id);
      if (!existing) throw new Error(`Memory not found: ${id}`);
      if (existing.status !== 'candidate' || !existing.sensitive) {
        throw new Error(`Memory is not a sensitive candidate: ${id}`);
      }
      if (typeof patch.content !== 'string' || typeof patch.detail !== 'string') {
        throw new Error('Reviewed Content and explicit Detail are required');
      }
      const content = patch.content.trim();
      const detail = patch.detail.trim();
      if (!content || content === existing.content.trim()) {
        throw new Error('Reviewed Content must replace the original sensitive text');
      }
      if (patch.sensitive === false) {
        throw new Error('A sensitive candidate cannot be re-labelled during review');
      }

      const { status: _status, ...draftPatch } = patch;
      this.replaceCandidateDraft(
        id,
        { ...draftPatch, content, detail, sensitive: true },
        meta,
      );
      return this.acceptRevision(id, meta);
    })() as { updated: MemoryItem; replaced: MemoryItem[] };
  }


  wasCandidateDismissed(content: string): boolean {
    return Boolean(this.db.query(
      'SELECT 1 FROM dismissed_candidate_fingerprints WHERE fingerprint = ?',
    ).get(this.candidateFingerprint(content)));
  }


  listMutedProposals(): Array<{
    memoryId: string;
    content: string | null;
    dismissedAt: string;
    canUnmute: boolean;
  }> {
    const rows = this.db
      .query(
        `SELECT f.memory_id AS memory_id,
                f.dismissed_at AS dismissed_at,
                f.sensitive AS sensitive,
                m.content AS content,
                m.status AS status
           FROM dismissed_candidate_fingerprints f
           LEFT JOIN memories m ON m.id = f.memory_id
          ORDER BY f.dismissed_at DESC`,
      )
      .all() as Array<{
        memory_id: string;
        dismissed_at: string;
        sensitive: number;
        content: string | null;
        status: string | null;
      }>;
    return rows.map((r) => ({
      memoryId: r.memory_id,
      content: r.sensitive === 1 ? null : r.content,
      dismissedAt: r.dismissed_at,
      canUnmute: r.sensitive === 0 && (r.status === null || r.status === 'discarded'),
    }));
  }


  unmuteProposal(memoryId: string): boolean {
    const evidence = this.candidateDismissalEvidence(memoryId);
    const existing = this.getById(memoryId);
    if (evidence?.sensitive || existing?.sensitive) {
      throw new CandidateDismissalTransitionError('A sensitive dismissal is permanent and cannot be unmuted.');
    }
    if (evidence && existing && existing.status !== 'discarded') {
      throw new CandidateDismissalTransitionError(
        'Candidate dismissal evidence cannot be lifted from a non-discarded legacy row.',
      );
    }
    const res = this.db
      .query('DELETE FROM dismissed_candidate_fingerprints WHERE memory_id = ?')
      .run(memoryId);
    return res.changes > 0;
  }


  recordUse(id: string, meta: UseMeta): void {
    this.db.transaction(() => {
      const isCitation = meta.via !== 'detail_load';
      const res = isCitation
        ? this.db.query(`UPDATE memories SET usage_count = usage_count + 1 WHERE id = ?`).run(id)
        : this.db.query(`UPDATE memories SET usage_count = usage_count WHERE id = ?`).run(id);
      if (res.changes === 0) throw new Error(`Memory not found: ${id}`);
      const extra: Record<string, unknown> = {};
      if (meta.via !== undefined) extra.via = meta.via;
      if (meta.detailLoaded !== undefined) extra.detailLoaded = meta.detailLoaded;
      this.appendEvent(id, 'use', meta, { meta: Object.keys(extra).length ? extra : undefined });
    })();
  }


  recordTraceLabel(id: string, label: MemoryTraceLabel, meta: ActorMeta & { turn?: number }): void {
    const row = this.db.query(`SELECT id FROM memories WHERE id = ?`).get(id);
    if (!row) return;
    this.appendEvent(id, 'trace', meta, { meta: { label } });
  }


  latestTraceLabels(): Map<string, MemoryTraceLabel> {
    const rows = this.db
      .query(`SELECT memory_id, meta FROM memory_events WHERE kind = 'trace' ORDER BY seq`)
      .all() as Array<{ memory_id: string; meta: string | null }>;
    const labels = new Map<string, MemoryTraceLabel>();
    for (const row of rows) {
      const label = row.meta ? (JSON.parse(row.meta) as { label?: MemoryTraceLabel }).label : undefined;
      if (label) labels.set(row.memory_id, label);
    }
    return labels;
  }


  recentlyDismissedCandidates(limit = 8): MemoryItem[] {
    const rows = this.db
      .query(
        `SELECT m.*, MAX(e.seq) AS dismissed_seq
           FROM memory_events e
           JOIN memories m ON m.id = e.memory_id
          WHERE json_extract(e.changes, '$.status.before') = 'candidate'
            AND json_extract(e.changes, '$.status.after') = 'discarded'
            AND m.status = 'discarded'
            AND m.sensitive = 0
          GROUP BY e.memory_id
          ORDER BY dismissed_seq DESC
          LIMIT ?`,
      )
      .all(limit) as MemoryRow[];
    return rows.map((r) => this.rowToItem(r));
  }


  recentlyAcceptedCandidates(limit = 8): MemoryItem[] {
    const rows = this.db
      .query(
        `SELECT m.*, MAX(e.seq) AS accepted_seq
           FROM memory_events e
           JOIN memories m ON m.id = e.memory_id
          WHERE json_extract(e.changes, '$.status.before') = 'candidate'
            AND json_extract(e.changes, '$.status.after') = 'active'
            AND m.sensitive = 0
          GROUP BY e.memory_id
          ORDER BY accepted_seq DESC
          LIMIT ?`,
      )
      .all(limit) as MemoryRow[];
    return rows.map((r) => this.rowToItem(r));
  }


  recordReinforce(id: string, meta: ActorMeta): void {
    this.db.transaction(() => {
      const res = this.db
        .query(`UPDATE memories SET reinforced_count = reinforced_count + 1 WHERE id = ?`)
        .run(id);
      if (res.changes === 0) throw new Error(`Memory not found: ${id}`);
      this.appendEvent(id, 'reinforce', meta);
    })();
  }


  recordDerivedReinforce(id: string, sourceId: string, meta: ActorMeta): void {
    this.db.transaction(() => {
      this.recordReinforce(id, meta);
      this.addRelation(id, sourceId, 'derived_from');
    })();
  }


  recentTraceLabels(id: string, limit = 3): MemoryTraceLabel[] {
    const rows = this.db
      .query(
        `SELECT meta FROM memory_events
          WHERE memory_id = ? AND kind = 'trace'
          ORDER BY seq DESC LIMIT ?`,
      )
      .all(id, limit) as Array<{ meta: string | null }>;
    const labels: MemoryTraceLabel[] = [];
    for (const row of rows) {
      const label = row.meta ? (JSON.parse(row.meta) as { label?: MemoryTraceLabel }).label : undefined;
      if (label) labels.push(label);
    }
    return labels;
  }


  hasOpenRevision(id: string): boolean {
    return Boolean(
      this.db
        .query(
          `SELECT 1 FROM memory_relations r
             JOIN memories m ON m.id = r.source_id
            WHERE r.target_id = ? AND r.relation_type = 'revises' AND m.status = 'candidate'
            LIMIT 1`,
        )
        .get(id),
    );
  }


  createRevisionProposal(
    input: CreateMemoryInput,
    targetId: string,
    meta: ActorMeta,
    opts?: {


      expectedTargetContent?: string;
    },
  ): MemoryItem | null {
    return this.db.transaction(() => {
      const target = this.getById(targetId);
      if (!target || target.status !== 'active') return null;
      if (opts?.expectedTargetContent !== undefined && target.content !== opts.expectedTargetContent) return null;
      if (this.hasOpenRevision(targetId)) return null;
      const proposal = this.create({ ...input, status: 'candidate' }, meta);
      this.addRelation(proposal.id, targetId, 'revises');
      return proposal;
    })() as MemoryItem | null;
  }


  acceptRevision(candidateId: string, meta: ActorMeta): { updated: MemoryItem; replaced: MemoryItem[] } {
    return this.db.transaction(() => {
      const updated = this.update(candidateId, { status: 'active' }, meta);
      const replaced = this.revisionTargetsOf(candidateId)
        .filter((t) => t.status === 'active')
        .map((t) => this.archive(t.id, meta));
      return { updated, replaced };
    })() as { updated: MemoryItem; replaced: MemoryItem[] };
  }


  renewMemory(id: string, meta: ActorMeta): MemoryItem {
    const item = this.getById(id);
    if (!item) throw new Error(`Memory not found: ${id}`);


    if (item.status !== 'active') throw new Error(`Only an active memory can be renewed (got ${item.status})`);
    this.appendEvent(id, 'renew', meta);
    return item;
  }


  listExpired(opts: { boundaryTs: string; projectId?: string }): MemoryItem[] {
    const rows = this.db
      .query(
        `SELECT m.* FROM memories m
          WHERE m.status = 'active'
            AND (m.scope = 'personal'
                 OR (m.scope = 'project' AND ($project_id IS NULL OR m.project_id = $project_id)))
            AND m.created_at < $boundary
            AND NOT EXISTS (
              SELECT 1 FROM memory_events e
               WHERE e.memory_id = m.id AND e.kind != 'trace' AND e.ts >= $boundary)
            AND NOT EXISTS (
              SELECT 1 FROM memory_relations r
                JOIN memories c ON c.id = r.source_id
               WHERE r.target_id = m.id AND r.relation_type = 'revises' AND c.status = 'candidate')
          ORDER BY m.created_at ASC`,
      )
      .all({ $boundary: opts.boundaryTs, $project_id: opts.projectId ?? null }) as MemoryRow[];
    return rows.map((r) => this.rowToItem(r));
  }


  listOpenRevisions(projectId?: string): Array<{ proposal: MemoryItem; target: MemoryItem }> {
    const rows = this.db
      .query(
        `SELECT c.id AS proposal_id, t.id AS target_id FROM memories c
           JOIN memory_relations r ON r.source_id = c.id AND r.relation_type = 'revises'
           JOIN memories t ON t.id = r.target_id
          WHERE c.status = 'candidate' AND t.status = 'active'
            AND (t.scope = 'personal'
                 OR (t.scope = 'project' AND ($project_id IS NULL OR t.project_id = $project_id)))
          ORDER BY c.created_at ASC`,
      )
      .all({ $project_id: projectId ?? null }) as Array<{ proposal_id: string; target_id: string }>;
    const pairs: Array<{ proposal: MemoryItem; target: MemoryItem }> = [];
    for (const row of rows) {
      const proposal = this.getById(row.proposal_id);
      const target = this.getById(row.target_id);
      if (proposal && target) pairs.push({ proposal, target });
    }
    return pairs;
  }


  revertAutoAccept(
    id: string,
    meta: ActorMeta,
  ): { reverted: MemoryItem; restored: MemoryItem | null; restoredAll: MemoryItem[] } {
    return this.db.transaction(() => {
      const existing = this.getById(id);
      if (!existing) throw new Error(`Memory not found: ${id}`);
      if (existing.status !== 'active') throw new Error(`Only an active memory can be reverted (got ${existing.status})`);


      const lastStatus = this.db
        .query(
          `SELECT seq AS s,
                  json_extract(changes, '$.status.before') AS before_status,
                  json_extract(changes, '$.status.after') AS after_status
             FROM memory_events
            WHERE memory_id = ? AND kind = 'status'
            ORDER BY seq DESC LIMIT 1`,
        )
        .get(id) as { s: number; before_status: string | null; after_status: string | null } | null;
      if (!lastStatus || lastStatus.before_status !== 'candidate' || lastStatus.after_status !== 'active') {
        throw new Error('Memory was not accepted from a Candidate review and cannot be reverted to Candidate.');
      }


      const editedAfter = this.db
        .query(
          `SELECT 1 FROM memory_events
            WHERE memory_id = ? AND kind IN ('edit', 'rescope', 'promote') AND seq > ? LIMIT 1`,
        )
        .get(id, lastStatus.s);
      if (editedAfter) {
        throw new Error('Memory was edited after the auto-accept — use its history on the Board to roll back.');
      }
      const targets = this.revisionTargetsOf(id);
      const reverted = this.update(id, { status: 'candidate' }, meta);
      const restored = targets
        .filter((t) => t.status === 'archived')
        .map((t) => this.update(t.id, { status: 'active' }, meta));
      return { reverted, restored: restored[0] ?? null, restoredAll: restored };
    })() as { reverted: MemoryItem; restored: MemoryItem | null; restoredAll: MemoryItem[] };
  }


  revisionTargetOf(candidateId: string): MemoryItem | null {
    return this.revisionTargetsOf(candidateId)[0] ?? null;
  }


  revisionTargetsOf(candidateId: string): MemoryItem[] {
    const rows = this.db
      .query(
        `SELECT m.* FROM memories m
           JOIN memory_relations r ON m.id = r.target_id
          WHERE r.source_id = ? AND r.relation_type = 'revises'
          ORDER BY r.id`,
      )
      .all(candidateId) as MemoryRow[];
    return rows.map((r) => this.rowToItem(r));
  }


  createMergeProposal(
    input: CreateMemoryInput,
    targetIds: [string, string],
    meta: ActorMeta,
    opts?: { expectedContents?: [string, string] },
  ): MemoryItem | null {
    return this.db.transaction(() => {
      for (let i = 0; i < targetIds.length; i++) {
        const target = this.getById(targetIds[i]!);
        if (!target || target.status !== 'active') return null;
        if (opts?.expectedContents && target.content !== opts.expectedContents[i]) return null;
        if (this.hasOpenRevision(target.id)) return null;
      }
      const proposal = this.create({ ...input, status: 'candidate' }, meta);
      for (const targetId of targetIds) this.addRelation(proposal.id, targetId, 'revises');
      return proposal;
    })() as MemoryItem | null;
  }


  getKv<T>(key: string): T | null {
    const row = this.db.query('SELECT value FROM memory_kv WHERE key = ?').get(key) as
      | { value: string }
      | null;
    if (!row) return null;
    try {
      return JSON.parse(row.value) as T;
    } catch {
      return null;
    }
  }


  setKv(key: string, value: unknown): void {
    this.db
      .query(
        `INSERT INTO memory_kv (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(key, JSON.stringify(value), new Date().toISOString());
  }


  setKvBatch(entries: ReadonlyArray<readonly [key: string, value: unknown]>): void {
    this.db.transaction(() => {
      for (const [key, value] of entries) this.setKv(key, value);
    })();
  }


  candidateResolutionsSince(sinceSeq: number): { count: number; maxSeq: number } {
    const row = this.db
      .query(
        `SELECT COUNT(*) AS count, COALESCE(MAX(seq), ?) AS max_seq
           FROM memory_events
          WHERE seq > ?
            AND kind = 'status'
            AND json_extract(changes, '$.status.before') = 'candidate'
            AND json_extract(changes, '$.status.after') IN ('active', 'discarded')`,
      )
      .get(sinceSeq, sinceSeq) as { count: number; max_seq: number };
    return { count: row.count, maxSeq: row.max_seq };
  }


  getEvents(id: string): MemoryEvent[] {
    const rows = this.db
      .query(`SELECT * FROM memory_events WHERE memory_id = ? ORDER BY seq`)
      .all(id) as MemoryEventRow[];
    return rows.map((r) => ({
      seq: r.seq,
      memoryId: r.memory_id,
      ts: r.ts,
      kind: r.kind as MemoryEventKind,
      actor: r.actor as MemoryEvent['actor'],
      sessionId: r.session_id ?? undefined,
      turn: r.turn ?? undefined,
      changes: r.changes ? JSON.parse(r.changes) : undefined,
      snapshot: r.snapshot ? JSON.parse(r.snapshot) : undefined,
      meta: r.meta ? JSON.parse(r.meta) : undefined,
    }));
  }


  rollback(id: string, toSeq: number, meta: ActorMeta): MemoryItem {
    return this.db.transaction(() => {
      const target = this.getEvents(id).find((e) => e.seq === toSeq);
      if (!target) throw new Error(`No event ${toSeq} for memory ${id}`);
      if (!target.snapshot) throw new Error(`Event ${toSeq} (${target.kind}) is not a version — cannot roll back to it`);

    const existing = this.getById(id);
    if (!existing) throw new Error(`Memory not found: ${id}`);
    this.assertCandidateDecisionTransition(existing, target.snapshot, 'ordinary');

    const patch: Record<string, unknown> = {};
    const changes: Record<string, { before: unknown; after: unknown }> = {};
    for (const field of VERSIONED_FIELDS) {
      const before = (existing as unknown as Record<string, unknown>)[field] ?? null;
      const after = (target.snapshot as unknown as Record<string, unknown>)[field] ?? null;
      if (before === after) continue;
      patch[field] = after;
      changes[field] = { before, after };
    }
      if (Object.keys(patch).length === 0) return existing;

    const sets: string[] = ['updated_at = $updated_at'];
    const params: Record<string, Bind> = { $id: id, $updated_at: new Date().toISOString() };
    for (const [key, value] of Object.entries(patch)) {
      const column = UPDATABLE_COLUMNS[key]!;
      sets.push(`${column} = $${column}`);
      params[`$${column}`] = value as Bind;
    }


    if (CONTENT_VERSION_FIELDS.some((f) => f in changes)) {
      sets.push('version = version + 1');
    }
    this.db.query(`UPDATE memories SET ${sets.join(', ')} WHERE id = $id`).run(params);

    const reverted = this.getById(id)!;
    this.appendEvent(id, 'revert', meta, {
      changes,
      snapshot: this.snapshotOf(reverted),
      meta: { toSeq },
    });
      return reverted;
    })();
  }


  setSessionExclusions(sessionId: string, ids: string[]): void {
    this.db
      .query(
        `INSERT INTO session_exclusions (session_id, ids, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(session_id) DO UPDATE SET ids = excluded.ids, updated_at = excluded.updated_at`,
      )
      .run(sessionId, JSON.stringify(ids), new Date().toISOString());
  }


  getSessionExclusions(sessionId: string): string[] {
    const row = this.db.query('SELECT ids FROM session_exclusions WHERE session_id = ?').get(sessionId) as
      | { ids: string }
      | null;
    if (!row) return [];
    try {
      const parsed = JSON.parse(row.ids);
      return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
    } catch {
      return [];
    }
  }

  addRelation(sourceId: string, targetId: string, type: MemoryRelationType): void {
    this.db
      .query(
        `INSERT INTO memory_relations (source_id, target_id, relation_type)
         VALUES (?, ?, ?)`,
      )
      .run(sourceId, targetId, type);
  }

  getRelations(id: string): MemoryRelation[] {
    const rows = this.db
      .query(`SELECT target_id, relation_type FROM memory_relations WHERE source_id = ?`)
      .all(id) as Array<{ target_id: string; relation_type: string }>;
    return rows.map((r) => ({
      type: r.relation_type as MemoryRelationType,
      targetId: r.target_id,
    }));
  }


  getConflicts(id: string): MemoryItem[] {
    const rows = this.db
      .query(
        `SELECT m.* FROM memories m
           JOIN memory_relations r ON m.id = r.target_id
          WHERE r.source_id = ? AND r.relation_type = 'conflicts_with'`,
      )
      .all(id) as MemoryRow[];
    return rows.map((r) => this.rowToItem(r));
  }


  getSupersedingItems(id: string): MemoryItem[] {
    const rows = this.db
      .query(
        `SELECT m.* FROM memories m
           JOIN memory_relations r ON m.id = r.source_id
          WHERE r.target_id = ? AND r.relation_type = 'conflicts_with' AND m.status IN ('active', 'candidate')`,
      )
      .all(id) as MemoryRow[];
    return rows.map((r) => this.rowToItem(r));
  }


  listConflicted(projectId?: string): MemoryItem[] {
    const projectClause = projectId
      ? `(m.scope = 'project' AND m.project_id = ?)`
      : `m.scope = 'project'`;
    const params = projectId ? [projectId] : [];
    const rows = this.db
      .query(
        `SELECT DISTINCT m.* FROM memories m
           JOIN memory_relations r ON m.id = r.target_id
           JOIN memories src ON src.id = r.source_id
          WHERE r.relation_type = 'conflicts_with'
            AND m.status = 'active'
            AND src.status IN ('active', 'candidate')
            AND (m.scope = 'personal' OR ${projectClause})`,
      )
      .all(...params) as MemoryRow[];
    return rows.map((r) => this.rowToItem(r));
  }


  private classifyChange(
    before: MemoryItem,
    changes: Record<string, { before: unknown; after: unknown }>,
  ): MemoryEventKind {
    if (changes.scope) {
      const from = SCOPE_REACH[changes.scope.before as MemoryScope] ?? 0;
      const to = SCOPE_REACH[changes.scope.after as MemoryScope] ?? 0;
      return to > from ? 'promote' : 'rescope';
    }
    if (changes.status) return 'status';
    return 'edit';
  }

  private appendEvent(
    memoryId: string,
    kind: MemoryEventKind,
    actorMeta: ActorMeta,
    payload: {
      changes?: Record<string, { before: unknown; after: unknown }>;
      snapshot?: MemoryItemSnapshot;
      meta?: Record<string, unknown>;
    } = {},
  ): void {
    this.db
      .query(
        `INSERT INTO memory_events (memory_id, ts, kind, actor, session_id, turn, changes, snapshot, meta)
         VALUES ($memory_id, $ts, $kind, $actor, $session_id, $turn, $changes, $snapshot, $meta)`,
      )
      .run({
        $memory_id: memoryId,
        $ts: new Date().toISOString(),
        $kind: kind,
        $actor: actorMeta.actor,
        $session_id: actorMeta.sessionId ?? null,
        $turn: actorMeta.turn ?? null,
        $changes: payload.changes ? JSON.stringify(payload.changes) : null,
        $snapshot: payload.snapshot ? JSON.stringify(payload.snapshot) : null,
        $meta: payload.meta ? JSON.stringify(payload.meta) : null,
      });
  }

  private candidateFingerprint(content: string): string {
    const normalized = content.trim().replace(/\s+/g, ' ').toLocaleLowerCase('en-US');
    return createHash('sha256').update(normalized).digest('hex');
  }

  private snapshotOf(item: MemoryItem): MemoryItemSnapshot {
    return {
      content: item.content,
      detail: item.detail,
      scope: item.scope,
      type: item.type,
      status: item.status,
      topic: item.topic,
      abstractionLevel: item.abstractionLevel,
      projectId: item.projectId,
      sessionId: item.sessionId,
    };
  }

  private nextId(): string {
    const rows = this.db.query(
      `SELECT id FROM memories
       UNION ALL
       SELECT memory_id AS id FROM dismissed_candidate_fingerprints`,
    ).all() as Array<{ id: string }>;
    let max = 0;
    for (const { id } of rows) {
      const m = /^M-(\d+)$/.exec(id);
      if (m) max = Math.max(max, parseInt(m[1], 10));
    }
    return `M-${String(max + 1).padStart(2, '0')}`;
  }

  private rowToItem(row: MemoryRow): MemoryItem {
    const evidenceClass = (row.evidence_class ?? undefined) as EvidenceClass | undefined;
    return {
      id: row.id,
      content: row.content,
      detail: row.detail ?? undefined,
      abstractionLevel: row.abstraction_level as AbstractionLevel,
      sensitive: row.sensitive === 1,
      scope: row.scope as MemoryScope,
      type: row.type as MemoryType,
      status: row.status as MemoryStatus,
      projectId: row.project_id ?? undefined,
      sessionId: row.session_id ?? undefined,
      topic: row.topic ?? undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      provenanceSessionId: row.provenance_session_id ?? undefined,
      provenanceTurn: row.provenance_turn ?? undefined,
      usageCount: row.usage_count,
      reinforcedCount: row.reinforced_count ?? 0,
      evidenceClass,
      version: row.version ?? 1,
      citedInCurrentSession: 0,
    };
  }
}
