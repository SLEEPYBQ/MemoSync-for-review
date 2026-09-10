

import type { AgentProvider, ChatAttachment, ModelOptions } from "../../../shared/types"

export interface StudyPromptSubmission {

  content: string

  attachments?: ChatAttachment[]

  dispatchOptions?: {
    provider?: AgentProvider
    model?: string
    modelOptions?: ModelOptions
    planMode?: boolean
  }

  dispatch: (openingReviewId?: string) => Promise<void>
}

type StudyPromptInterceptor = (submission: StudyPromptSubmission) => Promise<void> | undefined

let interceptor: StudyPromptInterceptor | null = null

export interface StudyPromptDraftSnapshot {
  content: string
  attachments: unknown[]
}

export interface StudyPromptServerOwnership {
  openingReviewId: string
  promptHash: string
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(",")}}`
  }
  return JSON.stringify(value) ?? "null"
}


export async function hashStudyPromptDraft(input: StudyPromptDraftSnapshot): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalJson({
    content: input.content,
    attachments: input.attachments,
  }))
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes)
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("")
}


export async function settleServerOwnedStudyPromptDraft(input: {
  promptHash: string
  getCurrent: () => StudyPromptDraftSnapshot
  clear: (matched: StudyPromptDraftSnapshot) => void
}): Promise<boolean> {
  const candidate = structuredClone(input.getCurrent())
  if (await hashStudyPromptDraft(candidate) !== input.promptHash) return false
  if (canonicalJson(input.getCurrent()) !== canonicalJson(candidate)) return false
  input.clear(candidate)
  return true
}

type ServerOwnershipListener = (ownership: StudyPromptServerOwnership) => void
const pendingServerOwnership = new Map<string, StudyPromptServerOwnership>()
const deliveredServerOwnership = new Set<string>()
const serverOwnershipListeners = new Map<string, Set<ServerOwnershipListener>>()


export function markStudyPromptServerOwned(chatId: string, openingReviewId: string, promptHash: string): void {
  if (!promptHash) return
  const receiptKey = `${chatId}:${openingReviewId}`
  if (deliveredServerOwnership.has(receiptKey)) return
  deliveredServerOwnership.add(receiptKey)
  const listeners = serverOwnershipListeners.get(chatId)
  if (!listeners?.size) {
    pendingServerOwnership.set(chatId, { openingReviewId, promptHash })
    return
  }
  pendingServerOwnership.delete(chatId)
  for (const listener of listeners) listener({ openingReviewId, promptHash })
}


export function subscribeStudyPromptServerOwnership(
  chatId: string,
  listener: ServerOwnershipListener,
): () => void {
  const listeners = serverOwnershipListeners.get(chatId) ?? new Set<ServerOwnershipListener>()
  listeners.add(listener)
  serverOwnershipListeners.set(chatId, listeners)
  const pending = pendingServerOwnership.get(chatId)
  if (pending) {
    pendingServerOwnership.delete(chatId)
    listener(pending)
  }
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0) serverOwnershipListeners.delete(chatId)
  }
}


export function setStudyPromptInterceptor(next: StudyPromptInterceptor | null) {
  interceptor = next
}


export function submitStudyPrompt(submission: StudyPromptSubmission): Promise<void> {
  return interceptor?.(submission) ?? submission.dispatch()
}

export interface HeldStudyPrompt {
  readonly submission: StudyPromptSubmission
  readonly promise: Promise<void>

  prepare(openingReviewId: string): Promise<void>

  markExternallyPrepared(openingReviewId: string): void

  release(): Promise<void>

  abandon(reason?: string): void
}


export function createHeldStudyPrompt(submission: StudyPromptSubmission): HeldStudyPrompt {
  let state: "held" | "preparing" | "prepared" | "released" | "abandoned" = "held"
  let preparation: Promise<void> | null = null
  let resolvePromise!: () => void
  let rejectPromise!: (reason: unknown) => void
  const promise = new Promise<void>((resolve, reject) => {
    resolvePromise = resolve
    rejectPromise = reject
  })

  return {
    submission,
    promise,
    prepare(openingReviewId) {
      if (preparation) return preparation
      if (state !== "held") return Promise.reject(new Error("The waiting first message is no longer available for preparation."))
      state = "preparing"
      preparation = Promise.resolve()
        .then(() => submission.dispatch(openingReviewId))
        .then(
          () => {
            if (state === "preparing") state = "prepared"
          },
          (error) => {
            if (state !== "abandoned") {
              state = "abandoned"
              rejectPromise(error)
            }
            throw error
          },
        )
      return preparation
    },
    markExternallyPrepared(_openingReviewId) {
      if (state === "held") state = "prepared"
    },
    release() {
      if (state === "released" || state === "abandoned") return promise
      if (state === "preparing") {
        state = "released"
        void preparation!.then(resolvePromise, () => undefined)
        return promise
      }
      if (state === "prepared") {
        state = "released"
        resolvePromise()
        return promise
      }
      state = "released"
      void Promise.resolve()
        .then(() => submission.dispatch())
        .then(resolvePromise, rejectPromise)
      return promise
    },
    abandon(reason = "The message stayed in its original chat draft because you left before memory review finished.") {
      if (state === "released" || state === "abandoned") return
      if (state === "preparing") {


        state = "released"
        void preparation!.then(resolvePromise, rejectPromise)
        return
      }
      if (state === "prepared") {


        state = "released"
        resolvePromise()
        return
      }
      state = "abandoned"
      rejectPromise(new Error(reason))
    },
  }
}


export type StudyPromptAdmissionKind = "checking" | "review_required" | "admitted" | "closed" | "error"

export function studyGateCapturesPrompt(stateKind: StudyPromptAdmissionKind): boolean {
  return stateKind === "checking" || stateKind === "review_required" || stateKind === "error"
}
