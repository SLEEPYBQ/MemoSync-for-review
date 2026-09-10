

import type { HydratedTranscriptMessage, MemoryCheckupKind } from "../../shared/types"

export type AuditVerdict = "operational" | "injected_without_effect" | "violated" | "not_applicable"

export interface RecordCandidatesStage {
  entryId: string
  pending?: boolean
  decision?: "reviewed" | "skipped" | "cancelled" | "expired" | "empty"


  items: Array<{ id: string; content?: string; scope?: string }>
}

export interface RecordTransfersStage {
  entryId: string
  pending?: boolean
  decision?: "handled" | "skipped" | "cancelled" | "expired" | "empty"
  items: Array<{ sourceId: string; sourceLabel: string; content: string }>
}

export interface RecordCheckupStage {
  entryId: string
  pending?: boolean
  decision?: "handled" | "skipped" | "cancelled" | "expired" | "empty" | "failed"
  failedKinds?: MemoryCheckupKind[]
  items: Array<{ kind: string; memoryId: string; otherMemoryId?: string; reason: string }>
}

export interface RecordInjectedStage {
  entryId: string

  items: Array<{ id: string; content: string; scope: string }>
}

export interface RecordReportedStage {

  counts: Map<string, number>
}

export interface RecordAuditStage {
  entryId: string
  status?: "ok" | "failed" | "discarded" | "pending" | "empty"
  labels: Array<{ id: string; label: AuditVerdict; note?: string; quote?: string; toolId?: string; missing?: string }>
}

export interface MemoryRecordTurn {
  turn: number

  summary?: string

  decision?: "go_on" | "dismiss" | "without_memory" | "expired"
  candidates?: RecordCandidatesStage
  transfers?: RecordTransfersStage
  checkup?: RecordCheckupStage
  injected?: RecordInjectedStage
  reported?: RecordReportedStage
  audit?: RecordAuditStage

  interrupted?: { memoryId: string }
}

export interface MemoryRecord {

  turns: MemoryRecordTurn[]
}

const CITATION_RE = /\[(M-\d+)\]/g

export function turnPulse(turn: MemoryRecordTurn): "violated" | "shaped" | "quiet" {

  if (turn.interrupted) return "violated"
  let shaped = false
  for (const label of turn.audit?.labels ?? []) {
    if (label.label === "violated") return "violated"
    if (label.label === "operational") shaped = true
  }
  return shaped ? "shaped" : "quiet"
}


export function memoryRecordMonitorIds(record: MemoryRecord): string[] {
  const ids = new Set<string>()
  for (const turn of record.turns) {
    for (const item of turn.injected?.items ?? []) ids.add(item.id)
    for (const label of turn.audit?.labels ?? []) ids.add(label.id)
  }
  return [...ids]
}

export function buildMemoryRecord(
  messages: HydratedTranscriptMessage[],
  liveStreamingText: string | null = null,
): MemoryRecord {
  const turnsByNumber = new Map<number, MemoryRecordTurn>()


  let currentTurn: number | null = null

  const turnOf = (turn: number): MemoryRecordTurn => {
    let t = turnsByNumber.get(turn)
    if (!t) {
      t = { turn }
      turnsByNumber.set(turn, t)
    }
    currentTurn = turn
    return t
  }

  const recordReportedCitations = (turn: MemoryRecordTurn, text: string) => {
    for (const match of text.matchAll(CITATION_RE)) {
      const id = match[1]
      if (!id) continue
      if (!turn.reported) turn.reported = { counts: new Map() }
      turn.reported.counts.set(id, (turn.reported.counts.get(id) ?? 0) + 1)
    }
  }

  for (const message of messages) {
    if (message.hidden) continue
    switch (message.kind) {
      case "memory_proposals": {
        if (message.turn === undefined) break
        const t = turnOf(message.turn)
        t.candidates = {
          entryId: message.id,
          pending: message.pending,
          decision: message.decision,
          items: message.candidates.map((c) => ({ id: c.id, content: c.content, scope: c.scope })),
        }
        break
      }
      case "memory_transfer": {
        if (message.turn === undefined) break
        const t = turnOf(message.turn)
        t.transfers = {
          entryId: message.id,
          pending: message.pending,
          decision: message.decision,
          items: message.suggestions.map((s) => ({
            sourceId: s.sourceId,
            sourceLabel: s.sourceLabel,
            content: s.content ?? s.sourceContent,
          })),
        }
        break
      }
      case "memory_checkup": {
        if (message.turn === undefined) break
        const t = turnOf(message.turn)
        t.checkup = {
          entryId: message.id,
          pending: message.pending || message.waiting,
          decision: message.decision,
          failedKinds: message.failedKinds,
          items: (message.suggestions ?? []).map((s) => ({
            kind: s.kind,
            memoryId: s.memoryId,
            otherMemoryId: s.otherMemoryId,
            reason: s.reason,
          })),
        }
        break
      }
      case "memory_preview": {
        if (message.turn === undefined) break
        const t = turnOf(message.turn)
        t.decision = message.decision


        const selected = message.decisionSelectedIds ? new Set(message.decisionSelectedIds) : null
        const injected = message.decision === "go_on"
          ? message.memories.filter((m) => (selected ? selected.has(m.id) : true))
          : []
        if (message.decision === "go_on") {
          t.injected = {
            entryId: message.id,
            items: injected.map((m) => ({ id: m.id, content: m.content, scope: m.scope })),
          }
        }
        break
      }
      case "assistant_text": {
        if (currentTurn === null) break
        const t = turnsByNumber.get(currentTurn)
        if (!t) break
        recordReportedCitations(t, message.text)
        break
      }
      case "memory_interrupt": {
        if (message.turn === undefined) break
        const t = turnOf(message.turn)
        t.interrupted = { memoryId: message.memoryId }
        break
      }
      case "memory_trace": {
        if (message.turn === undefined) break
        const t = turnOf(message.turn)
        if (message.summary) t.summary = message.summary
        t.audit = {
          entryId: message.id,
          status: message.status,
          labels: message.labels
            .filter((l): l is typeof l & { label: AuditVerdict } =>
              l.label === "operational" || l.label === "injected_without_effect" || l.label === "violated" || l.label === "not_applicable")
            .map((l) => ({ id: l.id, label: l.label, note: l.note, quote: l.quote, toolId: l.toolId, missing: l.missing })),
        }
        break
      }
      default:
        break
    }
  }


  if (currentTurn !== null && liveStreamingText) {
    const current = turnsByNumber.get(currentTurn)
    if (current) recordReportedCitations(current, liveStreamingText)
  }

  return { turns: [...turnsByNumber.values()].sort((a, b) => a.turn - b.turn) }
}
