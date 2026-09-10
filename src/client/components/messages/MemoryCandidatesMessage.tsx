

import { useEffect, useMemo, useState } from "react"
import { AlertTriangle, Check, Loader2, Pencil, RefreshCw, ShieldCheck, Undo2, X, Zap } from "lucide-react"
import type { HydratedTranscriptMessage } from "../../../shared/types"
import {
  memoriesApi,
  type CreateMemoryBody,
  type MemoryControlSurface,
  type MemoryItem,
  type MemoryScope,
} from "../../lib/memoriesApi"
import { isMemoryScope } from "../../lib/memoryCitations"
import { useMemoryStore } from "../../stores/memoryStore"
import { Button } from "../ui/button"
import { Textarea } from "../ui/textarea"
import { ScopeControl } from "../memory-chat/ScopeControl"
import { MemoryLegendButton } from "../memory/MemoryLegend"
import { RiseIn, StampIn } from "../ui/motion-primitives"
import { ExpandableRow, useEnsureMemoriesLoaded } from "./shared"
import { useTranscriptChatContext, useTranscriptRenderOptions } from "./render-context"

type MemoryCandidatesHydratedMessage = Extract<HydratedTranscriptMessage, { kind: "memory_candidates" }>

interface Props {
  message: MemoryCandidatesHydratedMessage
}

export function buildCandidateDraftPatch(content: string, detail: string) {
  return { content: content.trim(), detail: detail.trim() }
}

export function buildCandidateActivationScopePatch(input: {
  scope: MemoryScope
  contextProjectId?: string
  contextChatId?: string
  candidateProjectId?: string
  candidateSessionId?: string
}):
  | { patch: Partial<CreateMemoryBody> & { status: "active"; scope: MemoryScope } }
  | { error: string } {
  const patch: Partial<CreateMemoryBody> & { status: "active"; scope: MemoryScope } = {
    status: "active",
    scope: input.scope,
  }
  if (input.scope === "project") {
    const projectId = input.contextProjectId ?? input.candidateProjectId
    if (!projectId) return { error: "Choose a project before accepting this memory." }
    patch.projectId = projectId
  }
  if (input.scope === "session") {
    const sessionId = input.contextChatId ?? input.candidateSessionId
    if (!sessionId) return { error: "Choose a conversation before accepting this memory." }
    patch.sessionId = sessionId
  }
  return { patch }
}

export async function runCandidateMutation<T>(
  mutation: () => Promise<T>,
  onChanged?: () => Promise<void> | void,
): Promise<T> {
  const result = await mutation()
  await onChanged?.()
  return result
}

export function MemoryCandidatesMessage({ message }: Props) {
  const renderOptions = useTranscriptRenderOptions()
  if (message.candidates.length === 0) return null
  if (renderOptions.readonly) {
    return (
      <div className="rounded-lg border border-border/60 bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
        {message.candidates.length === 1 ? "1 memory candidate" : `${message.candidates.length} memory candidates`} omitted from this export for privacy.
      </div>
    )
  }
  return <LiveMemoryCandidatesMessage message={message} />
}

function LiveMemoryCandidatesMessage({ message }: Props) {
  useEnsureMemoriesLoaded()
  const items = useMemoryStore((s) => s.items)
  const status = useMemoryStore((s) => s.status)
  const loadAll = useMemoryStore((s) => s.loadAll)
  const [refreshAttempted, setRefreshAttempted] = useState(false)
  const [locallyDismissedIds, setLocallyDismissedIds] = useState<Set<string>>(() => new Set())
  const itemsById = useMemo(() => new Map(items.map((item) => [item.id, item])), [items])
  const hasMissingCandidate = message.candidates.some((candidate) => !itemsById.has(candidate.id))


  useEffect(() => {
    if (status !== "ready" || !hasMissingCandidate || refreshAttempted) return
    setRefreshAttempted(true)
    void loadAll()
  }, [hasMissingCandidate, loadAll, refreshAttempted, status])

  return (
    <div className="flex flex-col gap-2">
      <div className="flex justify-end">
        <MemoryLegendButton sections={["scope"]} label="What do the colors mean?" />
      </div>
      {message.candidates.map((candidate, index) => {
        const liveCandidate = itemsById.get(candidate.id)
        if (liveCandidate) {
          return (

            <RiseIn key={candidate.id} freshAt={message.timestamp} delay={index * 0.12}>
              <MemoryCandidateCard
                candidate={liveCandidate}
                autoApplied={candidate.auto === true}
                resurfaced={candidate.resurfaced === true}
                freshAt={message.timestamp}
                onDismissed={() => setLocallyDismissedIds((current) => new Set(current).add(candidate.id))}
              />
            </RiseIn>
          )
        }
        if (locallyDismissedIds.has(candidate.id)) {
          return <ResolvedCandidate key={candidate.id} resolved="dismissed" id={candidate.id} />
        }
        if (status === "error") {
          return <UnavailableCandidate key={candidate.id} />
        }
        if (status !== "ready" || !refreshAttempted) {
          return <LoadingCandidate key={candidate.id} />
        }
        return <ResolvedCandidate key={candidate.id} resolved="dismissed" id={candidate.id} />
      })}
    </div>
  )
}

type ResolvedState = "pending" | "accepted" | "dismissed"

function LoadingCandidate() {
  return (
    <div className="flex items-center gap-2 rounded-lg border border-border/60 bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
      <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading memory candidate…
    </div>
  )
}

function UnavailableCandidate() {
  return (
    <div className="rounded-lg border border-border/60 bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
      Memory candidate unavailable. Refresh to try again.
    </div>
  )
}

function ResolvedCandidate({ resolved, id }: { resolved: Exclude<ResolvedState, "pending">; id: string }) {
  return (
    <div className="rounded-lg border border-border/60 bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
      {resolved === "accepted" ? `saved as ${id} · this turn's focus is decided in Working Memory` : "dismissed"}
    </div>
  )
}


function AcceptedCandidateCard({
  candidate,
  surface,
  onChanged,
}: {
  candidate: MemoryItem
  surface: MemoryControlSurface
  onChanged?: () => Promise<void> | void
}) {
  const loadAll = useMemoryStore((s) => s.loadAll)
  const { chatId } = useTranscriptChatContext()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleUndo() {
    setBusy(true)
    setError(null)
    try {
      await runCandidateMutation(async () => {
        await memoriesApi.revertAutoAccept(candidate.id, { sessionId: chatId, surface })


        await loadAll()
      }, onChanged)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to undo")
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="rounded-xl border border-border bg-card px-4 py-3 shadow-sm">
      <ExpandableRow
        expandedContent={
          <div className="mt-2 flex flex-col gap-2">
            <p className="whitespace-pre-wrap text-sm text-foreground">{candidate.content}</p>
            {candidate.detail ? (
              <p className="whitespace-pre-wrap text-xs text-muted-foreground">{candidate.detail}</p>
            ) : null}
            <div className="flex items-center justify-between gap-2">
              <span className="text-[11px] text-muted-foreground">
                {candidate.scope}
                {candidate.status === "archived" ? " · since archived" : ""}
              </span>
              {candidate.status === "active" ? (
                <Button variant="ghost" size="xs" disabled={busy} onClick={() => void handleUndo()}>
                  {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Undo2 className="h-3.5 w-3.5" />}
                  Undo accept
                </Button>
              ) : null}
            </div>
            {error ? <p className="text-xs text-destructive">{error}</p> : null}
          </div>
        }
      >
        <span className="text-xs text-muted-foreground">
          saved as {candidate.id} · this turn&apos;s focus is decided in Working Memory
        </span>
      </ExpandableRow>
    </div>
  )
}

function AutoAppliedCard({
  candidate,
  revisionOf,
  freshAt,
  surface,
  onChanged,
}: {
  candidate: MemoryItem
  revisionOf?: MemoryItem["revisionOf"]
  freshAt?: string | number
  surface: MemoryControlSurface
  onChanged?: () => Promise<void> | void
}) {
  const loadAll = useMemoryStore((s) => s.loadAll)
  const { chatId } = useTranscriptChatContext()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleRevert() {
    setBusy(true)
    setError(null)
    try {
      await runCandidateMutation(async () => {
        await memoriesApi.revertAutoAccept(candidate.id, { sessionId: chatId, surface })


        await loadAll()
      }, onChanged)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to revert")
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="rounded-xl border border-border bg-card p-4 shadow-sm">
      <div className="flex flex-wrap items-center gap-2">

        <StampIn freshAt={freshAt}>
          <span className="inline-flex items-center gap-1 rounded-full border border-violet-500/30 bg-violet-500/10 px-2 py-0.5 text-[11px] font-medium text-violet-700 dark:text-violet-300">
            <Zap className="h-3 w-3" />
            auto-applied
          </span>
        </StampIn>
        {revisionOf ? (
          <span className="inline-flex items-center gap-1 rounded-full border border-blue-500/30 bg-blue-500/10 px-2 py-0.5 text-[11px] font-medium text-blue-700 dark:text-blue-300">
            <RefreshCw className="h-3 w-3" />
            revision — replaced {revisionOf.id}
          </span>
        ) : null}
        <span className="ml-auto font-mono text-[11px] text-muted-foreground">{candidate.id}</span>
      </div>
      <p className="mt-2 whitespace-pre-wrap text-sm text-foreground">{candidate.content}</p>
      <div className="mt-2 flex items-center justify-end gap-2">
        {error ? <p className="text-xs text-destructive">{error}</p> : null}
        <Button variant="ghost" size="xs" disabled={busy} onClick={() => void handleRevert()}>
          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Undo2 className="h-3.5 w-3.5" />} Revert
        </Button>
      </div>
    </div>
  )
}

export function MemoryCandidateCard({
  candidate,
  autoApplied = false,
  resurfaced = false,
  freshAt,
  onDismissed,
  onChanged,
  allowRestore = false,
  surface = "chat_gate",
}: {
  candidate: MemoryItem

  autoApplied?: boolean

  resurfaced?: boolean

  freshAt?: string | number
  onDismissed?: () => void
  onChanged?: () => Promise<void> | void

  allowRestore?: boolean
  surface?: MemoryControlSurface
}) {
  const storeStatus = candidate.status
  const upsertLocal = useMemoryStore((s) => s.upsertLocal)
  const removeLocal = useMemoryStore((s) => s.removeLocal)
  const loadAll = useMemoryStore((s) => s.loadAll)


  const revisionOf = candidate.revisionOf

  const { chatId, projectId } = useTranscriptChatContext()
  const [scope, setScope] = useState<MemoryScope>(isMemoryScope(candidate.scope) ? candidate.scope : "session")
  const [editing, setEditing] = useState(false)
  const [draftContent, setDraftContent] = useState(candidate.content)
  const [draftDetail, setDraftDetail] = useState(candidate.detail ?? "")


  const [displayContent, setDisplayContent] = useState(candidate.content)
  const [displayDetail, setDisplayDetail] = useState(candidate.detail)
  const [busy, setBusy] = useState<"accept" | "dismiss" | "restore" | "save" | "sanitize" | null>(null)
  const [error, setError] = useState<string | null>(null)


  const [sanitized, setSanitized] = useState<{
    redactions: Array<{ placeholder: string; kind: string }>
  } | null>(null)


  const resolved: ResolvedState =
    storeStatus === "active" || storeStatus === "archived"
      ? "accepted"
      : storeStatus === "discarded"
        ? "dismissed"
        : "pending"

  useEffect(() => {
    if (editing) return
    setDisplayContent(candidate.content)
    setDisplayDetail(candidate.detail)
    setDraftContent(candidate.content)
    setDraftDetail(candidate.detail ?? "")
  }, [candidate.content, candidate.detail, editing])

  async function handleAccept() {
    setBusy("accept")
    setError(null)
    try {
      const trimmed = draftContent.trim()


      if ((editing || sanitized) && !trimmed) {
        setError("Memory content can't be empty.")
        return
      }


      const activation = buildCandidateActivationScopePatch({
        scope,
        contextProjectId: projectId,
        contextChatId: chatId,
        candidateProjectId: candidate.projectId,
        candidateSessionId: candidate.sessionId,
      })
      if ("error" in activation) {
        setError(activation.error)
        return
      }
      const patch = activation.patch


      if ((editing || sanitized) && trimmed) {
        Object.assign(patch, buildCandidateDraftPatch(trimmed, draftDetail))
      }
      const updated = await runCandidateMutation(async () => {
        const result = await memoriesApi.update(candidate.id, patch, { surface })
        upsertLocal(result)


        if (revisionOf) await loadAll()
        return result
      }, onChanged)
      setDisplayContent(updated.content)
      setDisplayDetail(updated.detail)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to accept")
    } finally {
      setBusy(null)
    }
  }


  async function handleSanitize() {
    setBusy("sanitize")
    setError(null)
    try {
      const proposal = await memoriesApi.sanitizePreview(candidate.id)
      setDraftContent(proposal.content)
      setDraftDetail(proposal.detail ?? "")
      setSanitized({ redactions: proposal.redactions })
      setEditing(true)
    } catch (err) {
      setError(err instanceof Error ? `Redaction unavailable — edit manually (${err.message})` : "Redaction unavailable — edit manually")
    } finally {
      setBusy(null)
    }
  }

  async function handleDismiss() {
    setBusy("dismiss")
    setError(null)
    try {
      await runCandidateMutation(async () => {
        await memoriesApi.remove(candidate.id, { surface })
        onDismissed?.()
        if (candidate.sensitive) removeLocal(candidate.id)
        else upsertLocal({ ...candidate, status: "discarded" })
      }, onChanged)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to dismiss")
    } finally {
      setBusy(null)
    }
  }

  async function handleRestore() {
    setBusy("restore")
    setError(null)
    try {
      await runCandidateMutation(async () => {
        const restored = await memoriesApi.restoreCandidate(candidate.id, { surface })
        upsertLocal(restored)
      }, onChanged)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to restore the candidate")
    } finally {
      setBusy(null)
    }
  }

  async function handleSaveEdit() {
    const { content, detail } = buildCandidateDraftPatch(draftContent, draftDetail)
    if (!content) return
    setBusy("save")
    setError(null)
    try {
      const updated = await runCandidateMutation(async () => {
        const result = await memoriesApi.update(candidate.id, { content, detail }, { surface })
        upsertLocal(result)
        return result
      }, onChanged)
      setDisplayContent(updated.content)
      setDisplayDetail(updated.detail)
      setEditing(false)
      setSanitized(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save")
    } finally {
      setBusy(null)
    }
  }

  if (resolved !== "pending") {


    if (autoApplied && storeStatus === "active") {
      return <AutoAppliedCard candidate={candidate} revisionOf={revisionOf} freshAt={freshAt} surface={surface} onChanged={onChanged} />
    }
    if (resolved === "accepted") {
      return <AcceptedCandidateCard candidate={candidate} surface={surface} onChanged={onChanged} />
    }
    return (
      <div className="flex items-center justify-between gap-3 rounded-lg border border-border/60 bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
        <span>dismissed</span>
        {allowRestore && !candidate.sensitive ? (
          <Button variant="ghost" size="xs" disabled={busy !== null} onClick={() => void handleRestore()}>
            {busy === "restore" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Undo2 className="h-3.5 w-3.5" />}
            Restore for review
          </Button>
        ) : null}
        {error ? <span className="text-destructive">{error}</span> : null}
      </div>
    )
  }

  const busyState = busy !== null

  return (
    <div className="rounded-xl border border-border bg-card p-4 shadow-sm">
      <div className="flex flex-wrap items-center gap-2">
        <span className="inline-flex items-center gap-1.5 rounded-full border border-cand-border bg-cand-surface px-2 py-0.5 text-[11px] font-medium text-cand-fg">
          <span className="h-1.5 w-1.5 rounded-full bg-cand-dot" />
          memory candidate
        </span>
        {revisionOf ? (
          <span className="inline-flex items-center gap-1 rounded-full border border-blue-500/30 bg-blue-500/10 px-2 py-0.5 text-[11px] font-medium text-blue-700 dark:text-blue-300">
            <RefreshCw className="h-3 w-3" />
            revision — replaces {revisionOf.id}
          </span>
        ) : null}
        {candidate.sensitive ? (
          <span className="inline-flex items-center gap-1 rounded-full border border-cand-border bg-cand-surface px-2 py-0.5 text-[11px] font-medium text-cand-fg">
            <AlertTriangle className="h-3 w-3" />
            sensitive — needs your confirmation
          </span>
        ) : null}
        <span className="ml-auto font-mono text-[11px] text-muted-foreground">{candidate.id}</span>
      </div>

      {resurfaced ? (
        <p className="mt-1.5 flex items-start gap-1.5 rounded-md border border-blue-500/25 bg-blue-500/5 px-2 py-1 text-xs text-muted-foreground">
          <RefreshCw className="mt-0.5 h-3 w-3 shrink-0 text-blue-600 dark:text-blue-400" />
          <span className="min-w-0 flex-1">
            Proposed before{candidate.provenanceSessionId && candidate.provenanceSessionId !== chatId ? " in another chat" : " in this chat"} and
            still waiting for your review — this is the same pending proposal, brought back because it came up again.
          </span>
        </p>
      ) : null}

      {revisionOf ? (


        <div className="mt-2 flex flex-col gap-1.5">
          <div className="rounded-lg border border-border bg-muted/40 px-3 py-2">
            <p className="text-[10px] font-medium text-muted-foreground">
              current · <span className="font-mono normal-case">{revisionOf.id}</span>
            </p>
            <p className="mt-0.5 whitespace-pre-wrap text-xs text-muted-foreground">{revisionOf.content}</p>
          </div>
          {!editing ? (
            <div className="rounded-lg border border-blue-500/30 bg-blue-500/5 px-3 py-2">
              <p className="text-[10px] font-medium text-blue-700 dark:text-blue-300">proposed</p>
              <p className="mt-0.5 whitespace-pre-wrap text-sm text-foreground">{displayContent}</p>
            </div>
          ) : null}
        </div>
      ) : null}

      <div className="mt-3">
        {editing ? (
          <div className="space-y-2">
            {sanitized ? (
              <p className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                <ShieldCheck className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" />
                redaction proposal — review, edit, then Accept to activate it
                {sanitized.redactions.map((r) => (
                  <span key={r.placeholder} className="rounded-full border border-border bg-muted px-1.5 py-0.5 font-mono text-[10px]">
                    {r.placeholder} {r.kind}
                  </span>
                ))}
              </p>
            ) : null}
            <Textarea
              value={draftContent}
              onChange={(e) => setDraftContent(e.target.value)}
              className="min-h-16 text-sm"
              autoFocus
            />
            <label className="block space-y-1 text-xs text-muted-foreground">
              <span>Detail (optional)</span>
              <Textarea
                value={draftDetail}
                onChange={(e) => setDraftDetail(e.target.value)}
                className="min-h-20 text-sm text-foreground"
                placeholder="Clear this field to remove the detail"
              />
            </label>
            <div className="flex justify-end gap-2">
              <Button
                variant="ghost"
                size="xs"
                disabled={busyState}
                onClick={() => {
                  setEditing(false)
                  setSanitized(null)
                  setDraftContent(displayContent)
                  setDraftDetail(displayDetail ?? "")
                }}
              >
                Cancel
              </Button>
              <Button variant="juicy" size="xs" disabled={busyState || !draftContent.trim()} onClick={() => void handleSaveEdit()}>
                Save
              </Button>
            </div>
          </div>
        ) : revisionOf ? null : (
          <p className="whitespace-pre-wrap text-sm text-foreground">{displayContent}</p>
        )}
      </div>

      {displayDetail && !editing ? (
        <div className="mt-2">
          <ExpandableRow
            expandedContent={<p className="mt-1 whitespace-pre-wrap text-xs text-muted-foreground">{displayDetail}</p>}
          >
            <span className="text-xs text-muted-foreground">detail</span>
          </ExpandableRow>
        </div>
      ) : null}

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <ScopeControl value={scope} onValueChange={setScope} disabled={busyState} showConsequence />
        <div className="ml-auto flex items-center gap-2">
          {!editing && candidate.sensitive ? (
            <Button variant="ghost" size="xs" disabled={busyState} onClick={() => void handleSanitize()}>
              {busy === "sanitize" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ShieldCheck className="h-3.5 w-3.5" />}
              Prepare sanitized
            </Button>
          ) : null}
          {!editing ? (
            <Button variant="ghost" size="xs" disabled={busyState} onClick={() => {
              setDraftContent(displayContent)
              setDraftDetail(displayDetail ?? "")
              setEditing(true)
            }}>
              <Pencil className="h-3.5 w-3.5" />Edit
            </Button>
          ) : null}
          <Button variant="ghost" size="xs" disabled={busyState} onClick={() => void handleDismiss()}>
            <X className="h-3.5 w-3.5" />Dismiss
          </Button>
          <Button
            variant="juicy"
            size="xs"
            disabled={busyState}
            title={revisionOf ? `Accepting archives ${revisionOf.id} and replaces it with this text.` : undefined}
            onClick={() => void handleAccept()}
          >
            <Check className="h-3.5 w-3.5" /> {revisionOf ? "Accept & replace" : "Accept"}
          </Button>
        </div>
      </div>
      {error ? <p className="mt-2 text-xs text-destructive">{error}</p> : null}
    </div>
  )
}
