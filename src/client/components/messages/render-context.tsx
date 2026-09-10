import { createContext, useContext, type ReactNode } from "react"
import type {
  ExpectedMemoryUse,
  MemoryPreviewDecision,
  StandaloneTranscriptAttachmentMode,
} from "../../../shared/types"

export interface PreviewDemoDecision {
  previewId: string
  decision: MemoryPreviewDecision
  selectedIds?: string[]
  expectedUses?: ExpectedMemoryUse[]
  prompt?: string
}


export interface PreviewDemoOptions {
  poolExpanded?: boolean
  exchanges?: Array<{ q: string; a: string }>

  reviseReply: string

  onDecision?: (decision: PreviewDemoDecision) => void
}


export function dispatchPreviewDemoDecision(
  options: PreviewDemoOptions | undefined,
  decision: PreviewDemoDecision,
): boolean {
  if (!options) return false
  options.onDecision?.(decision)
  return true
}

export interface TranscriptRenderOptions {
  readonly: boolean
  localLinkMode: "open" | "text"
  attachmentMode: "live" | StandaloneTranscriptAttachmentMode
  previewDemo?: PreviewDemoOptions
}

const DEFAULT_RENDER_OPTIONS: TranscriptRenderOptions = {
  readonly: false,
  localLinkMode: "open",
  attachmentMode: "live",
}

const TranscriptRenderOptionsContext = createContext<TranscriptRenderOptions>(DEFAULT_RENDER_OPTIONS)

export function TranscriptRenderOptionsProvider({
  children,
  value,
}: {
  children: ReactNode
  value: Partial<TranscriptRenderOptions>
}) {
  return (
    <TranscriptRenderOptionsContext.Provider
      value={{
        ...DEFAULT_RENDER_OPTIONS,
        ...value,
      }}
    >
      {children}
    </TranscriptRenderOptionsContext.Provider>
  )
}

export function useTranscriptRenderOptions() {
  return useContext(TranscriptRenderOptionsContext)
}


export interface TranscriptChatContextValue {
  chatId?: string
  projectId?: string
}

const TranscriptChatContext = createContext<TranscriptChatContextValue>({})

export function TranscriptChatContextProvider({
  children,
  value,
}: {
  children: ReactNode
  value: TranscriptChatContextValue
}) {
  return <TranscriptChatContext.Provider value={value}>{children}</TranscriptChatContext.Provider>
}

export function useTranscriptChatContext() {
  return useContext(TranscriptChatContext)
}


const ViolatedCitationsMapContext = createContext<ReadonlyMap<string, ReadonlySet<string>> | null>(null)

export function ViolatedCitationsMapProvider({
  children,
  value,
}: {
  children: ReactNode
  value: ReadonlyMap<string, ReadonlySet<string>> | null
}) {
  return <ViolatedCitationsMapContext.Provider value={value}>{children}</ViolatedCitationsMapContext.Provider>
}

export function useViolatedCitationsMap() {
  return useContext(ViolatedCitationsMapContext)
}


const MessageViolatedCitationsContext = createContext<ReadonlySet<string> | null>(null)

export function MessageViolatedCitationsProvider({
  children,
  value,
}: {
  children: ReactNode
  value: ReadonlySet<string> | null
}) {
  return (
    <MessageViolatedCitationsContext.Provider value={value}>{children}</MessageViolatedCitationsContext.Provider>
  )
}

export function useMessageViolatedCitations() {
  return useContext(MessageViolatedCitationsContext)
}
