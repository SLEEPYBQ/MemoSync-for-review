

import { appendFileSync, mkdirSync } from "node:fs"
import { dirname } from "node:path"
import type {
  StudyAssessedMemoryAnswer,
  StudyAssessedMemoryAnswerV2,
  StudyDesiredMemoryAnswer,
  StudyDesiredMemoryAnswerV2,
  StudyExecutionAnswer,
  StudyExecutionAnswerV2,
  StudyQuestionnaireVersion,
} from "../../shared/studyTasks"
import type { StudyAttentionCheckResult } from "../../shared/studyAttentionChecks"
import type { RawTlxActivity, RawTlxRatings, SusRatings } from "../../shared/studyScales"

export type ExperimentCondition = "memosync" | "static" | "auto"
export type ExperimentAllocationMode = "study" | "internal_qa"

export interface ExperimentDurableSinkInput {
  recordedAt: string
  condition: ExperimentCondition
  participant: string | null
  allocationMode: ExperimentAllocationMode | null
  event: ExperimentEvent
}

export interface ExperimentDurableSinkResult {
  created: boolean
}

export interface ExperimentLogResult {
  durableCreated: boolean | null
}

type MemoryRef = { id: string; scope: string }

export interface DeliveredFocusMemoryRef {
  id: string
  identity: { scheme: string; id: string }
  version: number
  content: string
  contentHash: string
  stateHash: string
  scope: "personal" | "project" | "session"
  actualFocus: true
  expectedUse?: string
  sourceRef: Record<string, unknown>
  qualityFlags?: string[]
}

export interface DeliveredFocusEvent {
  type: "memory.inject"
  schemaVersion: 2
  semantics: "turn_focus"
  injectionId: string
  taskId: string | null
  sessionId: string
  chatId: string
  turnId: string
  turn: number
  engine: "claude"
  focusedAt: string
  outcome: "delivered" | "empty" | "disabled"

  resumeOfInterruptId?: string

  deliveryStage: "queued_to_claude"
  mode: "skills" | "plain" | "file"
  deliveryHash: string
  focusPayloadHash?: string
  visiblePoolHash: string
  memories: DeliveredFocusMemoryRef[]
  qualityFlags?: string[]
}


export type ExperimentEvent =
  | { type: "memory.branch"; sessionId: string; engine: string; purpose: string; branchId: string; mode: "fork" | "empty-history" }
  | {
      type: "study.control_operation"
      operationId: string
      phase: "attempted" | "completed" | "failed"
      taskId: string
      sessionId: string
      chatId?: string

      clientTimestamp?: string
      surface: "board" | "chat_gate" | "static_memory" | "audit" | "working_memory"
      action: string
      controlType: "crud" | "transfer" | "checkup" | "static_edit" | "audit" | "working_memory"
      payload?: Record<string, unknown>
      errorClass?: string
    }
  | { type: "memory.inject"; schemaVersion?: 1; sessionId?: string; engine?: string; memories: MemoryRef[]; tokenEstimate?: number; mode?: "skills" | "plain" | "file"; staticFiles?: string[] }
  | DeliveredFocusEvent
  | { type: "memory.propose"; sessionId?: string; engine?: string; id: string; memType: string; scope: string; via?: string; targetId?: string; drift?: string; revisionAction?: string; reason?: string }


  | { type: "memory.cite"; sessionId?: string; citedIds: string[]; countedIds: string[]; carryoverIds?: string[] }
  | { type: "memory.decision"; taskId?: string; sessionId?: string; action: "create" | "accept" | "edit" | "dismiss" | "rescope" | "archive" | "revert" | "restore" | "unmute" | "promote"; id: string; fromScope?: string; toScope?: string; via?: string }


  | { type: "memory.capture"; sessionId?: string; engine?: string; turn?: number; status: "ok" | "failed"; stage?: "capture_pass" | "necessity_pass" | "persist"; errorClass?: string; errorCategory?: "cancelled" | "timeout" | "network" | "rate_limited" | "provider_5xx" | "provider_4xx" | "empty_response" | "truncated" | "invalid_json" | "invalid_response" | "unknown"; httpStatus?: number; channel?: "hook" | "agent" | "prompt"; proposed?: number; surfaced?: number; dropped?: number; sensitive?: number; reinforced?: number; revisions?: number; sameTurnDuplicates?: number }
  | { type: "memory.conflict"; sessionId?: string; engine?: string; turn?: number; newId: string; staleId: string }


  | { type: "memory.proposals"; sessionId?: string; engine?: string; turn?: number; count: number; decision: "reviewed" | "skipped" | "cancelled" | "expired" | "empty" }


  | { type: "memory.checkup"; sessionId?: string; engine?: string; turn?: number; suggestions: number; cached?: boolean; failedKinds?: Array<"conflict" | "redundancy" | "staleness">; decision: "clear" | "handled" | "skipped" | "cancelled" | "expired" | "failed" }


  | { type: "memory.preparation_reopen"; sessionId?: string; engine?: string; turn?: number; from: "proposals" | "checkup" | "transfer"; revision: number }


  | { type: "memory.trace"; sessionId?: string; engine?: string; turn?: number; status?: "ok" | "failed" | "discarded" | "empty"; stage?: "trace_pass" | "cas"; errorClass?: string; dropped?: number; labels: Array<{ id: string; label: string }>; via?: "fork" | "sidecar" }
  | { type: "memory.detail_load"; sessionId?: string; engine?: string; ids: string[] }
  | { type: "memory.bringin"; sessionId?: string; ids: string[] }

  | { type: "memory.exclude"; sessionId?: string; ids: string[] }


  | { type: "memory.working_memory_selection"; eventId?: string; clientTimestamp?: string; sessionId?: string; chatId: string; previewId: string; memoryId: string; action: "add" | "remove" }
  | { type: "memory.transfer"; taskId?: string; sessionId?: string; sourceId: string; newId?: string; fromScope?: string; targetScope: string; targetProjectId?: string; verdict?: string; edited?: boolean; archivedOriginal?: boolean; surface?: "board" | "chat_gate" }
  | { type: "memory.transfer_decline"; taskId?: string; sessionId?: string; id: string; contextKey: string; surface?: "board" | "chat_gate" }
  | { type: "memory.transfer_card"; sessionId: string; engine?: string; turn?: number; suggestions: number; decision: "handled" | "skipped" | "cancelled" | "expired" | "empty" }
  | { type: "memory.board_backlog"; kind: "transfer" | "checkup"; chatId: string; gateId: string; semanticKey: string; outcome: "invalidated"; reason: string }
  | { type: "memory.sanitize"; sessionId?: string; id: string; redactions: number }


  | { type: "study.participant_prompt"; eventId: string; sessionId?: string; surface: "auto_summary_chat"; action: "submit"; projectId: string; content: string }


  | { type: "memory.control_request"; eventId?: string; sessionId?: string; via: "auto_summary_chat"; requestedAction: "update_memory"; causalRequestId?: string; applied?: number }


  | { type: "memory.static_edit"; eventId?: string; sessionId?: string; projectId: string; path: string; durationMs?: number }
  | { type: "ui.monitor"; eventId?: string; clientTimestamp?: string; taskId?: string; sessionId?: string; chatId?: string; surface: string; interaction?: "open" | "click" | "scroll" | "hover"; ids?: string[] }


  | { type: "ui.surface_exposure"; eventId?: string; clientTimestamp?: string; sessionId?: string; chatId?: string; surface: string; action: "opened" | "hidden" | "visible" | "closed"; exposureId?: string; sequence?: number; initiator?: "participant" | "system"; memoryIds?: string[]; closeReason?: string }
  | { type: "memory.attention"; taskId?: string; sessionId?: string; kind: "conflict" | "revision" | "redundant" | "stale" | "promotion"; id: string; action: "shown" | "defer" | "renew" | "archive" | "keep" | "merge" | "promote" | "decline"; surface?: "board" | "chat_gate" }


  | { type: "memory.audit_action"; eventId?: string; operationId?: string; taskId?: string; sessionId?: string; chatId?: string; id: string; action: "pay_attention" | "draft_fix" | "enforce" }

  | { type: "memory.interrupt"; eventId?: string; interruptId?: string; taskId?: string; sessionId?: string; chatId?: string; id: string; turn?: number; quote?: string }
  | { type: "memory.resume"; eventId: string; interruptId: string; taskId: string; sessionId: string; chatId: string; id: string; enforced: boolean }
  | { type: "memory.preview"; operationId?: string; sessionId?: string; engine?: string; turn?: number; memoryIds: string[]; decision?: "go_on" | "dismiss" | "without_memory" | "auto_go_on" | "expired"; selectedIds?: string[] }


  | { type: "memory.revise_injection"; operationId?: string; sessionId?: string; instruction: string; beforeIds: string[]; afterIds: string[]; changed: boolean }


  | { type: "memory.relevance"; sessionId?: string; turn?: number; ids: string[] }
  | { type: "memory.setting"; sessionId?: string; section: string; value: Record<string, unknown> }
  | { type: "turn.usage"; sessionId?: string; engine?: string; model?: string; tokens?: number; ms?: number }


  | { type: "turn.compacted"; sessionId?: string; engine?: string; turn?: number }


  | { type: "quiz.answer"; sessionId?: string; taskId: string; memoryId: string; desiredContent: string; desiredScope: string; believedContent: string; believedScope: string; execution: string; objectContent?: string; objectScope?: string; objectStatus?: string }
  | {
      type: "quiz.answer"
      schemaVersion: 2
      questionnaireVersion: StudyQuestionnaireVersion
      taskId: string
      snapshotId: string
      probeId: string
      cue: string
      desired: StudyDesiredMemoryAnswer | StudyDesiredMemoryAnswerV2
      assessed: StudyAssessedMemoryAnswer | StudyAssessedMemoryAnswerV2
      execution: StudyExecutionAnswer | StudyExecutionAnswerV2
      object: Record<string, unknown>
      qualityFlags?: string[]
      finalLineage?: unknown[]
      controlApplicable: boolean
    }


  | { type: "quiz.submit"; sessionId?: string; taskId: string; snapshotId?: string; submissionId?: string; items: number; attentionCheck?: StudyAttentionCheckResult; chats?: Array<{ chatId: string; title?: string; projectId?: string }> }


  | { type: "study.completion.receipt"; taskId: string; susSubmissionId: string; codeVersion: string; issuedAt: string }

  | {
      type: "study.freeze"
      sessionId?: string
      taskId: string
      snapshotId?: string
      qualityFlags?: string[]
      workspaceSnapshotPath?: string
      workspaceTreeHash?: string
    }

  | { type: "study.unfreeze"; taskId: string }
  | { type: "study.raw_tlx.submit"; taskId: string; snapshotId: string; submissionId: string; activity: RawTlxActivity; ratings: RawTlxRatings; score: number }
  | { type: "study.session.complete"; taskId: string; snapshotId: string; completionId: string }
  | { type: "study.sus.submit"; taskId: string; submissionId: string; ratings: SusRatings; score: number }
  | {
      type: "study.instruction_guard"
      eventId: string
      taskId: string
      channel: "chat.send" | "message.enqueue" | "message.steer" | "queue.dispatch" | "ui"
      reason: "near_verbatim" | "ui_attempt"
      disqualifying: boolean
      chatId?: string
      projectId?: string
      surface?: "task_page" | "task_dialog"
      action?: string
      ruleVersion?: string
      longestContiguousRun?: number
      lcsRatio?: number
      reference?: string | null
    }

export class ExperimentLogger {
  private readonly filePath: string | null
  private readonly condition: ExperimentCondition
  private readonly participant: string | null
  private readonly allocationMode: ExperimentAllocationMode | null
  private readonly toStdout: boolean
  private readonly enabled: boolean
  private readonly durableSink: ((input: ExperimentDurableSinkInput) => ExperimentDurableSinkResult | void) | null

  constructor(opts: {
    filePath?: string | null
    condition?: string
    participant?: string
    allocationMode?: ExperimentAllocationMode
    stdout?: boolean


    durableSink?: (input: ExperimentDurableSinkInput) => ExperimentDurableSinkResult | void
  } = {}) {
    this.enabled = process.env.EXPERIMENT_LOG !== "0"
    this.condition = (opts.condition ?? process.env.EXPERIMENT_CONDITION ?? "memosync") as ExperimentCondition


    this.participant = opts.participant ?? process.env.PARTICIPANT_ID ?? null
    const allocationMode = opts.allocationMode ?? process.env.STUDY_ALLOCATION_MODE ?? null
    if (allocationMode !== null && allocationMode !== "study" && allocationMode !== "internal_qa") {
      throw new Error(`Invalid STUDY_ALLOCATION_MODE: ${allocationMode}`)
    }
    this.allocationMode = allocationMode
    this.toStdout = opts.stdout ?? true
    this.durableSink = opts.durableSink ?? null
    this.filePath = opts.filePath ?? null
    if (this.enabled && this.filePath) {
      try {
        mkdirSync(dirname(this.filePath), { recursive: true })
      } catch {

      }
    }
  }


  event(e: ExperimentEvent): unknown {
    const recordedAt = new Date().toISOString()
    const durableResult = this.durableSink?.({
      recordedAt,
      condition: this.condition,
      participant: this.participant,
      allocationMode: this.allocationMode,
      event: e,
    })
    const result = { durableCreated: durableResult?.created ?? null }
    if (!this.enabled) return result
    const record = {
      ts: recordedAt,
      condition: this.condition,
      ...(this.participant ? { participant: this.participant } : {}),
      ...(this.allocationMode ? { allocationMode: this.allocationMode } : {}),
      ...e,
    }
    const line = JSON.stringify(record)
    if (this.toStdout) console.log(`[experiment] ${line}`)
    if (this.filePath) {
      try {
        appendFileSync(this.filePath, line + "\n")
      } catch {

      }
    }
    return result
  }
}


export const NoopExperimentLogger: Pick<ExperimentLogger, "event"> = { event: () => ({ durableCreated: null }) }
