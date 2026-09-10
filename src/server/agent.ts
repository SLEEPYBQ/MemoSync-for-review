import { query, type CanUseTool, type PermissionResult, type Query, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk"
import { homedir } from "node:os"
import type {
  AgentProvider,
  ChatAttachment,
  ContextWindowUsageSnapshot,
  ModelOptions,
  NormalizedToolCall,
  PendingToolSnapshot,
  ChatActivityStatus,
  QueuedChatMessage,
  TranscriptEntry,
} from "../shared/types"
import { normalizeToolCall } from "../shared/tools"
import type { ClientCommand } from "../shared/protocol"
import { EventStore } from "./event-store"
import { CodexAppServerManager } from "./codex-app-server"
import { type GenerateChatTitleResult, generateTitleForChatDetailed } from "./generate-title"
import type { HarnessEvent, HarnessToolRequest, HarnessTurn } from "./harness-types"
import {
  applyClaudeSdkModels,
  type ClaudeSdkModelInfo,
  codexServiceTierFromModelOptions,
  getServerProviderCatalog,
  normalizeClaudeModelOptions,
  normalizeCodexModelOptions,
  normalizeServerModel,
} from "./provider-catalog"
import { resolveClaudeApiModelId } from "../shared/types"
import { fallbackTitleFromMessage } from "./generate-title"
import type { MemoryService } from "./memory"
import { buildMemoryToolSpecs, dispatchMemoryTool, type MemoryToolContext } from "./memory/tools"
import {
  computeMemoryTurnDelta,
  normalizeMemorySelection,
  planMemoryInjection,
  type MemoryInjectionPlan,
} from "./memory/injection"
import { toClaudeMemoryMcpServer } from "./memory/claude-adapter"
import { resolveConditionPolicy, type ConditionPolicy } from "./experiment/condition"
import {
  buildDeliveredStoreFocusEvent,
  persistDeliveredStoreFocusEvent,
  recordDeliveredStoreFocus,
} from "./experiment/focus"
import type { PendingStaticFocusDelivery, StudyMemoryStore } from "./experiment/study-memory-store"
import type { StaticMemoryExtractor } from "./experiment/static-memory-extractor"
import { materializePendingStaticFocus, reserveDeliveredStaticFocus } from "./experiment/static-focus"
import type { StudyPromptGate, StudyPromptGateInput } from "./study-prompt-gate"
import { claudeSessionFileExists } from "./claude-session-files"
import { ensureProjectDirectory } from "./paths"
import { toCodexDynamicTools } from "./memory/codex-adapter"
import { extractCitations } from "./memory/citations"
import type { CaptureOutcome, CaptureService } from "./memory/capture"
import type { RelevanceService, RelevantMemory } from "./memory/relevance"
import type { ExpectedMemoryUse, UsePlanService } from "./memory/use-plan"
import { coerceTraceOutcome, type TraceOutcome, type TraceService } from "./memory/trace"
import { runForkTrace } from "./memory/trace-fork"
import { runForkCapture } from "./memory/capture-fork"
import { runForkQuery } from "./memory/fork-query"
import { createMemoryBranch, type MemoryBranch } from "./memory/branch-runtime"
import { MemoryBranchPipeline, type BranchRequest } from "./memory/branch-pipeline"
import { memoryStageSchema } from "./memory/branch-schemas"
import {
  buildWorkingMemoryBranchPrompt, parseWorkingMemoryBranchResult,
  buildAuditBranchPrompt, parseAuditBranchResult, MemoryBranchResultError,
} from "./memory/branch-stages"
import { buildIsolatedClaudeEnv, assertIsolatedClaudeCredentials, isCliIsolationEnabled, resolveOfficialClaudeEnv } from "./provider-runtime"
import type { RevisionService } from "./memory/evolution"
import type { CheckupResult, CheckupService } from "./memory/checkup"
import type {
  TransferDetectService,
  TransferSuggestionCard,
  TransferSuggestionProgress,
  TransferTaskResult,
} from "./memory/transfer-detect"
import type { MemoryItem } from "./memory/types"
import type { MemoryPreviewDecision } from "../shared/types"
import type {
  MemoryBoardBacklogService,
  MemoryBoardOpeningPromptRecovery,
} from "./memory/board-backlog"
import { studyProjectSubprocessEnv } from "./study-project-runtime"
import type { StudyPreviewRuntimeController } from "./study-preview-runtime"
import { toClaudeStudyPreviewMcpServer } from "./study-preview-claude-adapter"
import { isKnownCatalogModel, resolveChatProviderRoute } from "./chat-providers"

export function toMemoryCandidateReferences(items: Array<Pick<MemoryItem, "id">>) {
  return items.map(({ id }) => ({ id }))
}

export function resolveClaudeSessionModel(requestedModel: string, configuredModel = process.env.ANTHROPIC_MODEL) {
  const configured = configuredModel?.trim()
  if (isKnownCatalogModel(requestedModel)) {


    return configured && !isKnownCatalogModel(configured) ? configured : requestedModel
  }
  return configured || requestedModel
}

export function buildClaudeSdkRuntimeOptions(args: {
  requestedModel: string
  configuredModel?: string
  env: Readonly<Record<string, string | undefined>>
}): { model: string; settings: { autoMemoryEnabled: boolean; autoDreamEnabled: boolean }; env: Record<string, string | undefined> } {
  const official = args.requestedModel === "sonnet" || args.requestedModel === "opus" || args.requestedModel.startsWith("claude-")
  const configuredModel = args.configuredModel ?? (args.env.MEMOSYNC_USE_OWN_ANTHROPIC === "1" ? args.env.ANTHROPIC_MODEL : "")
  const rawModel = official ? args.requestedModel : resolveClaudeSessionModel(args.requestedModel, configuredModel ?? "")
  if (official) args = { ...args, env: resolveOfficialClaudeEnv(args.env) }

  const resolvedModel = rawModel.endsWith("[1m]") ? rawModel.slice(0, -"[1m]".length) : rawModel


  const route = resolveChatProviderRoute(resolvedModel, args.env)
  if (route) {
    assertIsolatedClaudeCredentials({ ...args.env, ANTHROPIC_API_KEY: route.apiKey, ANTHROPIC_AUTH_TOKEN: route.apiKey })
    return {
      model: route.appendOneMillionSuffix ? `${resolvedModel}[1m]` : resolvedModel,
      settings: { autoMemoryEnabled: false, autoDreamEnabled: false },
      env: {
        ...args.env,
        ANTHROPIC_BASE_URL: route.baseUrl,

        ANTHROPIC_AUTH_TOKEN: route.apiKey,
        ANTHROPIC_API_KEY: route.apiKey,
        ANTHROPIC_MODEL: resolvedModel,
        ANTHROPIC_DEFAULT_OPUS_MODEL: resolvedModel,
        ANTHROPIC_DEFAULT_SONNET_MODEL: resolvedModel,
        ANTHROPIC_DEFAULT_HAIKU_MODEL: route.subagentModel,
        ANTHROPIC_SMALL_FAST_MODEL: route.subagentModel,
        CLAUDE_CODE_SUBAGENT_MODEL: route.subagentModel,

        CLAUDE_CODE_AUTO_COMPACT_WINDOW: route.autoCompactWindow,
      },
    }
  }


  const isDeepSeek = resolvedModel.startsWith("deepseek-")
  assertIsolatedClaudeCredentials(args.env)
  return {
    model: isDeepSeek ? `${resolvedModel}[1m]` : resolvedModel,
    settings: {
      autoMemoryEnabled: false,
      autoDreamEnabled: false,
    },
    env: {
      ...args.env,
      ...(isDeepSeek
        ? {


            CLAUDE_CODE_AUTO_COMPACT_WINDOW: args.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW || "786432",
          }
        : {}),
    },
  }
}


const CLAUDE_ENGINE_ENV_ALLOWLIST = new Set([
  "CLAUDE_CONFIG_DIR",
  "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC",
  "CLAUDE_CODE_AUTO_COMPACT_WINDOW",
  "CLAUDE_CODE_SUBAGENT_MODEL",
  "CLAUDE_CODE_EFFORT_LEVEL",
])

export function buildClaudeSubprocessEnv(args: {
  localPath: string
  rawStudyProjects: string | undefined
  baseEnv?: Readonly<Record<string, string | undefined>>
}): Record<string, string | undefined> {
  const rawEnv = args.baseEnv ?? process.env
  const baseEnv: Record<string, string | undefined> = buildIsolatedClaudeEnv(rawEnv)
  for (const key of Object.keys(baseEnv)) {
    if ((key === "CLAUDECODE" || key.startsWith("CLAUDE_")) && !CLAUDE_ENGINE_ENV_ALLOWLIST.has(key)) {
      delete baseEnv[key]
    }
  }
  return studyProjectSubprocessEnv(baseEnv, args.localPath, args.rawStudyProjects)
}

const CLAUDE_TOOLSET = [
  "Skill",
  "WebFetch",
  "WebSearch",
  "Task",
  "TaskOutput",
  "Bash",
  "Glob",
  "Grep",
  "Read",
  "Edit",
  "Write",
  "TodoWrite",
  "KillShell",
  "AskUserQuestion",
  "EnterPlanMode",
  "ExitPlanMode",
] as const


const MAX_TRANSFER_TARGET_REFRESHES = 3

interface MemoryPreparationCancellation {


  signal: AbortSignal
  requested: Promise<void>
  cancelAndWait: () => Promise<void>
  settle: () => void
}

interface DeferredAutoStartGuard {
  signal: AbortSignal
  authorizeDelivery: () => boolean
  isCommittedCancellationRequested: () => boolean
  markTurnStarted: () => void
}

function createMemoryPreparationCancellation(): MemoryPreparationCancellation {
  const controller = new AbortController()
  let resolveRequested!: () => void
  const requested = new Promise<void>((resolve) => { resolveRequested = resolve })
  let resolveSettled!: () => void
  const settled = new Promise<void>((resolve) => { resolveSettled = resolve })
  let didSettle = false
  return {
    signal: controller.signal,
    requested,
    cancelAndWait: () => {
      if (!controller.signal.aborted) {
        controller.abort()
        resolveRequested()
      }
      return settled
    },
    settle: () => {
      if (didSettle) return
      didSettle = true
      resolveSettled()
    },
  }
}

class PendingAutoCaptureStart {
  phase: "barrier" | "dispatching" = "barrier"
  readonly cancellation = createMemoryPreparationCancellation()
  cancellationReceipt?: Promise<void>
  cancellationOperation?: Promise<void>
  deliveryCommitted = false
  cancelCommittedDelivery = false
  readonly turnStartSettlement: Promise<boolean>
  readonly guard: DeferredAutoStartGuard
  private settleTurnStartOnce: (started: boolean) => void

  constructor(public queuedMessageId: string) {
    let settled = false
    let resolveTurnStart!: (started: boolean) => void
    this.turnStartSettlement = new Promise<boolean>((resolve) => {
      resolveTurnStart = resolve
    })
    this.settleTurnStartOnce = (started) => {
      if (settled) return
      settled = true
      resolveTurnStart(started)
    }
    this.guard = {
      signal: this.cancellation.signal,
      authorizeDelivery: () => {
        if (this.cancellation.signal.aborted) return false
        this.deliveryCommitted = true
        return true
      },
      isCommittedCancellationRequested: () => this.cancelCommittedDelivery,
      markTurnStarted: () => this.settleTurnStartOnce(true),
    }
  }

  settleWithoutTurnStart(): void {
    this.settleTurnStartOnce(false)
  }
}


const BROWSER_USAGE_GUIDE = [
  "## Showing web apps in the participant's Browser panel",
  "",
  "The participant views the app through the Browser panel built into this study interface. The web server runs inside your project container; the participant's own browser cannot reach that container through `localhost`.",
  "",
  "- The supplied study workspace already has its starter dependencies and a project-specific PostgreSQL database. Use the existing `DB_*` environment variables; do not start or reconfigure a system PostgreSQL cluster unless a readiness check proves the provided database is unavailable.",
  "- The study runtime owns one preview server for the assigned project: frontend port 3000 and backend port 3001. It starts and stops that server automatically for every study condition.",
  "- Do not run commands that start, stop, detach, or replace a development server. In particular, do not use `npm run dev`, `npm run start:dev`, `next dev`, `nohup`, `setsid`, `disown`, `pkill`, or `kill`, and do not move either service to another port.",
  "- Do not run a production build (`npm run build`, `next build`, or an equivalent root build) while the managed preview owns this workspace: Next production builds rewrite the same `.next` artifacts used by the live preview. Tests, lint, and `tsc --noEmit` remain available.",
  "- Edit the application normally and rely on the managed server's hot reload. Use preview_status to inspect its phase, fixed ports, and bounded recent log; if it reports degraded or exited, use preview_restart. Do not repair its process lifecycle through Bash.",
  "- Do not deploy, tunnel, or expose the app through an external service.",
  "- Do not tell the participant to open `http://localhost:<port>` in their own browser.",
  "- After the server is ready, tell the participant exactly: open **Browser**, press **Home** if needed, find the server under **Local Servers**, and click the green server card belonging to the current project.",
  "- Prefer browser-side relative URLs such as `/api`. When a separate API server is needed, configure the frontend dev server to proxy those relative API requests to it. Do not embed a participant-facing `localhost` API URL.",
  "- Continue normal code and task verification after making the preview available. A quick HTTP readiness check is enough for the first preview; do not install browser automation solely to prove that the Browser panel can open it. Container-local success does not prove that the participant-visible Browser preview rendered successfully.",
  "- Ask the participant to test the result in the Browser panel. If hot reload is unavailable, ask them to press the Browser panel's **Refresh** button after your changes.",
  "- If the participant reports a blank page, do not claim the app is visible merely because `curl` or local Playwright succeeds. Re-check server logs and app errors, and report that the participant-visible preview may have failed.",
].join("\n")

export function buildClaudeSystemAppend(memoryBlock: string) {
  return [BROWSER_USAGE_GUIDE, memoryBlock].filter(Boolean).join("\n\n")
}

interface PendingToolRequest {
  toolUseId: string
  tool: NormalizedToolCall & { toolKind: "ask_user_question" | "exit_plan_mode" }
  resolve: (result: unknown) => void
}

interface ResumeInterruptedTurn {
  interruptId: string
  memoryId: string
  correction: string
  enforce?: boolean

  quote?: string

  selectedIds: string[]
}

interface StartTurnArgs {
  chatId: string
  provider: AgentProvider
  content: string
  attachments: ChatAttachment[]


  providerAttachments?: ChatAttachment[]
  model: string
  effort?: string
  serviceTier?: "fast"
  planMode: boolean
  appendUserPrompt: boolean
  steered?: boolean


  resume?: ResumeInterruptedTurn


  memoryUserText?: string
  profile?: SendToStartingProfile | null

  turnId?: string

  deferredAutoStart?: DeferredAutoStartGuard


  onMemoryDeliveryAccepted?: (focusedIds: readonly string[]) => void

  openingReview?: { taskId: string; reviewId: string }

  openingLongTermAlreadyReady?: boolean

  openingLongTermRevision?: number

  openingWorkingMemory?: {
    previewId: string
    decision: "go_on" | "without_memory"
  }
}

interface ActiveTurn {
  chatId: string
  provider: AgentProvider
  turn: HarnessTurn
  claudePromptSeq?: number
  model: string
  effort?: string
  serviceTier?: "fast"
  planMode: boolean
  status: ChatActivityStatus
  pendingTool: PendingToolRequest | null
  postToolFollowUp: { content: string; planMode: boolean } | null
  hasFinalResult: boolean
  cancelRequested: boolean
  cancelRecorded: boolean


  providerTurnStarted: boolean
  clientTraceId?: string
  profilingStartedAt?: number

  turnNumber?: number

  turnId: string

  taskId: string | null

  memoryPlan: MemoryInjectionPlan | null

  userText?: string

  assistantChunks: string[]

  citedIds: Set<string>

  memoryDisabled?: boolean
  memoryDeliveryAccepted?: boolean


  injectedIds: string[]
}

interface ClaudeSessionHandle {
  provider: "claude"
  stream: AsyncIterable<HarnessEvent>
  getAccountInfo?: () => Promise<any>
  interrupt: () => Promise<void>
  close: () => void
  sendPrompt: (
    content: string,
    context?: Pick<MemoryToolContext, "turn" | "engine" | "allowedMemoryIds"> & { promptSeq?: number },
  ) => Promise<void>


  discardHumanTurnReservations?: (promptSeqs: readonly number[]) => number
  setModel: (model: string) => Promise<void>
  setPermissionMode: (planMode: boolean) => Promise<void>
  supportedModels?: () => Promise<ClaudeSdkModelInfo[]>

  memoryPlan?: MemoryInjectionPlan | null
}

interface ClaudeSessionState {
  id: string
  chatId: string
  session: ClaudeSessionHandle
  localPath: string
  model: string
  effort?: string
  planMode: boolean
  sessionToken: string | null
  accountInfoLoaded: boolean
  nextPromptSeq: number
  pendingPromptSeqs: number[]

  retired: boolean
  retireReason: string | null
  pump: Promise<void> | null


  memorySetHash: string
  providerRuntimeKey: string


  memoryBaseline: Map<string, number> | null
}

interface AgentCoordinatorArgs {
  store: EventStore
  onStateChange: (chatId?: string, options?: { immediate?: boolean }) => void
  codexManager?: CodexAppServerManager
  generateTitle?: (messageContent: string, cwd: string) => Promise<GenerateChatTitleResult>

  memory?: MemoryService | null

  capture?: CaptureService | null

  memoryTrace?: TraceService | null

  forkTrace?: typeof runForkTrace
  forkCapture?: typeof runForkCapture
  forkQuery?: typeof runForkQuery

  memoryBranches?: boolean
  createMemoryBranch?: typeof createMemoryBranch

  memoryRelevance?: RelevanceService | null

  memoryUsePlan?: UsePlanService | null

  memoryRevision?: RevisionService | null

  memoryPreview?: boolean

  memoryCheckup?: CheckupService | null

  memoryTransferDetect?: TransferDetectService | null

  policy?: ConditionPolicy

  getMemoryPreviewSettings?: () => { enabled: boolean; autoProceedWhenEmpty: boolean }

  getActiveStudyTaskId?: () => string | null

  studyPromptGate?: StudyPromptGate | null

  onParticipantPromptRecorded?: (input: {
    taskId: string
    turnId: string
    chatId: string
    content: string
    attachments: ChatAttachment[]
    acceptedAt: string
  }) => void

  openingBoardBacklog?: MemoryBoardBacklogService | null

  studyMemoryStore?: StudyMemoryStore | null

  staticMemoryExtractor?: StaticMemoryExtractor | null

  claudeSessionFileExists?: (localPath: string, sessionToken: string) => boolean

  studyPreviewRuntime?: StudyAgentPreviewRuntime | null

  claudeRetireTimeoutMs?: number
  startClaudeSession?: (args: {
    localPath: string
    model: string
    effort?: string
    planMode: boolean
    sessionToken: string | null
    forkSession: boolean
    onToolRequest: (request: HarnessToolRequest) => Promise<unknown>
    memory?: MemoryService | null

    capture?: CaptureService | null
    projectId?: string
    chatId?: string
    policy?: ConditionPolicy
    subprocessEnv?: Record<string, string | undefined>

    memoryPlan?: MemoryInjectionPlan | null
    restrictMemoryIds?: string[]
    onMemoryProposal?: (created: MemoryItem[]) => void
    studyPreviewRuntime?: StudyAgentPreviewRuntime | null
  }) => Promise<ClaudeSessionHandle>
}

interface SendToStartingProfile {
  traceId: string
  startedAt: number
}

export interface StudyMemoryQualityFlag {
  code:
    | "capture_failed"
    | "trace_failed"
    | "post_turn_failed"
    | "post_turn_incomplete"
    | "focus_persistence_failed"
    | "static_extraction_failed"
    | "static_focus_persistence_failed"
    | "static_focus_pending"
  blocking: boolean
  taskId: string
  chatId: string
  turnId: string
  turn?: number
}

interface PostTurnMemoryPassArgs {
  chatId: string
  projectId?: string
  engine: string
  turnNumber?: number
  turnId: string
  taskId: string | null
  userText: string
  assistantText: string
  citedIds: string[]

  injectedIds: string[]

  memoryDisabled?: boolean

  claudeSessionToken?: string | null
  localPath?: string
  sessionToken?: string | null
  injectedMemories?: MemoryItem[]
  executionText?: string
  expectedUses?: ExpectedMemoryUse[]
  executionTools?: Array<{ toolId: string; text: string }>
  model?: string
  effort?: string
  serviceTier?: "fast"
}

function isClaudeSteerLoggingEnabled() {
  return process.env.MEMOSYNC_LOG_CLAUDE_STEER === "1"
}

function logClaudeSteer(stage: string, details?: Record<string, unknown>) {
  if (!isClaudeSteerLoggingEnabled()) return
  console.log("[memosync/claude-steer]", JSON.stringify({
    stage,
    ...details,
  }))
}

const STEERED_MESSAGE_PREFIX = `<system-message>
The user would like to inform you of something while you continue to work. Acknowledge receipt immediately with a text response, then continue with the task at hand, incorporating the user's feedback if needed.
</system-message>`

interface SendMessageOptions {
  provider?: AgentProvider
  model?: string
  modelOptions?: ModelOptions
  effort?: string
  planMode?: boolean
}

function timestamped<T extends Omit<TranscriptEntry, "_id" | "createdAt">>(
  entry: T,
  createdAt = Date.now()
): TranscriptEntry {
  return {
    _id: crypto.randomUUID(),
    createdAt,
    ...entry,
  } as TranscriptEntry
}

function stringFromUnknown(value: unknown) {
  if (typeof value === "string") return value
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

function buildSteeredMessageContent(content: string) {
  return content.trim().length > 0
    ? `${STEERED_MESSAGE_PREFIX}\n\n${content}`
    : STEERED_MESSAGE_PREFIX
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function escapeXmlAttribute(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("\"", "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
}

function isSendToStartingProfilingEnabled() {
  return process.env.MEMOSYNC_PROFILE_SEND_TO_STARTING === "1"
}

function elapsedProfileMs(startedAt: number) {
  return Number((performance.now() - startedAt).toFixed(1))
}

function logSendToStartingProfile(
  profile: SendToStartingProfile | null | undefined,
  stage: string,
  details?: Record<string, unknown>
) {
  if (!profile || !isSendToStartingProfilingEnabled()) {
    return
  }

  console.log("[memosync/send->starting][server]", JSON.stringify({
    traceId: profile.traceId,
    stage,
    elapsedMs: elapsedProfileMs(profile.startedAt),
    ...details,
  }))
}

export function buildAttachmentHintText(attachments: ChatAttachment[]) {
  if (attachments.length === 0) return ""

  const lines = attachments.map((attachment) => (
    `<attachment kind="${escapeXmlAttribute(attachment.kind)}" mime_type="${escapeXmlAttribute(attachment.mimeType)}" path="${escapeXmlAttribute(attachment.absolutePath)}" project_path="${escapeXmlAttribute(attachment.relativePath)}" size_bytes="${attachment.size}" display_name="${escapeXmlAttribute(attachment.displayName)}" />`
  ))

  return [
    "<memosync-attachments>",
    ...lines,
    "</memosync-attachments>",
  ].join("\n")
}

export function buildPromptText(content: string, attachments: ChatAttachment[]) {
  const attachmentHint = buildAttachmentHintText(attachments)
  if (!attachmentHint) {
    return content.trim()
  }

  const trimmed = content.trim()
  return [
    trimmed || "Please inspect the attached files.",
    attachmentHint,
  ].join("\n\n").trim()
}

function discardedToolResult(
  tool: NormalizedToolCall & { toolKind: "ask_user_question" | "exit_plan_mode" }
) {
  if (tool.toolKind === "ask_user_question") {
    return {
      discarded: true,
      answers: {},
    }
  }

  return {
    discarded: true,
  }
}

export function normalizeClaudeUsageSnapshot(
  value: unknown,
  maxTokens?: number,
): ContextWindowUsageSnapshot | null {
  const usage = asRecord(value)
  if (!usage) return null

  const directInputTokens = asNumber(usage.input_tokens) ?? asNumber(usage.inputTokens) ?? 0
  const cacheCreationInputTokens =
    asNumber(usage.cache_creation_input_tokens) ?? asNumber(usage.cacheCreationInputTokens) ?? 0
  const cacheReadInputTokens =
    asNumber(usage.cache_read_input_tokens) ?? asNumber(usage.cacheReadInputTokens) ?? 0
  const outputTokens = asNumber(usage.output_tokens) ?? asNumber(usage.outputTokens) ?? 0
  const reasoningOutputTokens =
    asNumber(usage.reasoning_output_tokens) ?? asNumber(usage.reasoningOutputTokens)
  const toolUses = asNumber(usage.tool_uses) ?? asNumber(usage.toolUses)
  const durationMs = asNumber(usage.duration_ms) ?? asNumber(usage.durationMs)

  const inputTokens = directInputTokens + cacheCreationInputTokens + cacheReadInputTokens
  const usedTokens = inputTokens + outputTokens
  if (usedTokens <= 0) {
    return null
  }

  return {
    usedTokens,
    inputTokens,
    ...(cacheReadInputTokens > 0 ? { cachedInputTokens: cacheReadInputTokens } : {}),
    ...(outputTokens > 0 ? { outputTokens } : {}),
    ...(reasoningOutputTokens !== undefined ? { reasoningOutputTokens } : {}),
    lastUsedTokens: usedTokens,
    lastInputTokens: inputTokens,
    ...(cacheReadInputTokens > 0 ? { lastCachedInputTokens: cacheReadInputTokens } : {}),
    ...(outputTokens > 0 ? { lastOutputTokens: outputTokens } : {}),
    ...(reasoningOutputTokens !== undefined ? { lastReasoningOutputTokens: reasoningOutputTokens } : {}),
    ...(toolUses !== undefined ? { toolUses } : {}),
    ...(durationMs !== undefined ? { durationMs } : {}),
    ...(typeof maxTokens === "number" && maxTokens > 0 ? { maxTokens } : {}),


    compactsAutomatically: true,
  }
}


export function normalizeClaudeAssistantUsageSnapshot(
  message: unknown,
  maxTokens?: number,
): ContextWindowUsageSnapshot | null {
  const record = asRecord(message)
  const nestedMessage = asRecord(record?.message)
  return normalizeClaudeUsageSnapshot(nestedMessage?.usage ?? record?.usage, maxTokens)
}

export function maxClaudeContextWindowFromModelUsage(modelUsage: unknown): number | undefined {
  const record = asRecord(modelUsage)
  if (!record) return undefined

  let maxContextWindow: number | undefined
  for (const value of Object.values(record)) {
    const usage = asRecord(value)
    const contextWindow = asNumber(usage?.contextWindow) ?? asNumber(usage?.context_window)
    if (contextWindow === undefined) continue
    maxContextWindow = Math.max(maxContextWindow ?? 0, contextWindow)
  }
  return maxContextWindow
}

function getClaudeAssistantMessageUsageId(message: any): string | null {
  if (typeof message?.message?.id === "string" && message.message.id) {
    return message.message.id
  }
  if (typeof message?.uuid === "string" && message.uuid) {
    return message.uuid
  }
  return null
}

export function normalizeClaudeStreamMessage(message: any): TranscriptEntry[] {
  const debugRaw = JSON.stringify(message)
  const messageId = typeof message.uuid === "string" ? message.uuid : undefined

  if (message.type === "system" && message.subtype === "init") {
    return [
      timestamped({
        kind: "system_init",
        messageId,
        provider: "claude",
        model: typeof message.model === "string" ? message.model : "unknown",
        tools: Array.isArray(message.tools) ? message.tools : [],
        agents: Array.isArray(message.agents) ? message.agents : [],
        slashCommands: Array.isArray(message.slash_commands)
          ? message.slash_commands.filter((entry: string) => !entry.startsWith("._"))
          : [],
        mcpServers: Array.isArray(message.mcp_servers) ? message.mcp_servers : [],
        debugRaw,
      }),
    ]
  }

  if (message.type === "assistant" && Array.isArray(message.message?.content)) {
    const entries: TranscriptEntry[] = []
    for (const content of message.message.content) {
      if (content.type === "text" && typeof content.text === "string") {
        entries.push(timestamped({
          kind: "assistant_text",
          messageId,
          text: content.text,
          debugRaw,
        }))
      }
      if (content.type === "tool_use" && typeof content.name === "string" && typeof content.id === "string") {
        entries.push(timestamped({
          kind: "tool_call",
          messageId,
          tool: normalizeToolCall({
            toolName: content.name,
            toolId: content.id,
            input: (content.input ?? {}) as Record<string, unknown>,
          }),
          debugRaw,
        }))
      }
    }
    return entries
  }

  if (message.type === "user" && Array.isArray(message.message?.content)) {
    const entries: TranscriptEntry[] = []
    for (const content of message.message.content) {
      if (content.type === "tool_result" && typeof content.tool_use_id === "string") {
        entries.push(timestamped({
          kind: "tool_result",
          messageId,
          toolId: content.tool_use_id,
          content: content.content,
          isError: Boolean(content.is_error),
          debugRaw,
        }))
      }
      if (message.message.role === "user" && typeof message.message.content === "string") {
        entries.push(timestamped({
          kind: "compact_summary",
          messageId,
          summary: message.message.content,
          debugRaw,
        }))
      }
    }
    return entries
  }

  if (message.type === "result") {
    if (message.subtype === "cancelled") {
      return [timestamped({ kind: "interrupted", messageId, debugRaw })]
    }
    return [
      timestamped({
        kind: "result",
        messageId,
        subtype: message.is_error ? "error" : "success",
        isError: Boolean(message.is_error),
        durationMs: typeof message.duration_ms === "number" ? message.duration_ms : 0,
        result: typeof message.result === "string" ? message.result : stringFromUnknown(message.result),
        costUsd: typeof message.total_cost_usd === "number" ? message.total_cost_usd : undefined,
        debugRaw,
      }),
    ]
  }

  if (message.type === "system" && message.subtype === "status" && typeof message.status === "string") {
    return [timestamped({ kind: "status", messageId, status: message.status, debugRaw })]
  }

  if (message.type === "system" && message.subtype === "compact_boundary") {
    return [timestamped({ kind: "compact_boundary", messageId, debugRaw })]
  }

  if (message.type === "system" && message.subtype === "context_cleared") {
    return [timestamped({ kind: "context_cleared", messageId, debugRaw })]
  }

  if (
    message.type === "user" &&
    message.message?.role === "user" &&
    typeof message.message.content === "string" &&
    message.message.content.startsWith("This session is being continued")
  ) {
    return [timestamped({ kind: "compact_summary", messageId, summary: message.message.content, debugRaw })]
  }

  return []
}

export async function* createClaudeHarnessStream(
  q: Query,
  onTurnOriginChange?: (origin: HarnessEvent["origin"]) => void,
  onToolOrigin?: (toolUseId: string, origin: HarnessEvent["origin"]) => void,
  outboundOrigins?: ClaudeOutboundOriginTracker,
): AsyncGenerator<HarnessEvent> {
  let seenAssistantUsageIds = new Set<string>()
  let latestUsageSnapshot: ContextWindowUsageSnapshot | null = null
  let lastKnownContextWindow: number | undefined
  const seenToolOriginIds = new Set<string>()
  const registerToolOrigin = (toolUseId: string, origin: HarnessEvent["origin"]) => {
    if (seenToolOriginIds.has(toolUseId)) return
    seenToolOriginIds.add(toolUseId)
    onToolOrigin?.(toolUseId, origin)
  }

  let streamingAssistantMessageId = ""


  let rootOrigin: HarnessEvent["origin"] = outboundOrigins?.current() ?? "unknown"
  const lineageOrigins = new Map<string, HarnessEvent["origin"]>()

  for await (const sdkMessage of q as AsyncIterable<any>) {
    const explicitOrigin = (() => {
      const kind = sdkMessage?.origin?.kind
      return kind === "human"
        || kind === "task-notification"
        || kind === "auto-continuation"
        || kind === "channel"
        || kind === "peer"
        || kind === "coordinator"
        ? kind
        : undefined
    })()
    const parentToolUseId = typeof sdkMessage?.parent_tool_use_id === "string"
      ? sdkMessage.parent_tool_use_id
      : null
    const startsQueuedTurn = sdkMessage?.type === "user"
      && sdkMessage?.message?.role === "user"
      && !parentToolUseId
    const isToolResult = sdkMessage?.tool_use_result !== undefined
      || (Array.isArray(sdkMessage?.message?.content)
        && sdkMessage.message.content.some((item: unknown) => (
          Boolean(item && typeof item === "object" && (item as { type?: unknown }).type === "tool_result")
        )))
    if (startsQueuedTurn && !isToolResult) {
      const internalOriginlessFrame = explicitOrigin === undefined && (
        sdkMessage?.isSynthetic === true
        || sdkMessage?.isReplay === true
        || sdkMessage?.shouldQuery === false
      )
      rootOrigin = explicitOrigin
        ?? (internalOriginlessFrame ? "unknown" : outboundOrigins?.current())
        ?? "human"
      outboundOrigins?.observeRoot(rootOrigin)
      onTurnOriginChange?.(rootOrigin)
    }
    if (explicitOrigin !== undefined && parentToolUseId) {
      lineageOrigins.set(parentToolUseId, explicitOrigin)
    }
    const toolResultOrigin = (() => {
      if (!isToolResult) return undefined
      if (!Array.isArray(sdkMessage?.message?.content)) return "unknown"
      let inheritedOrigin: HarnessEvent["origin"]
      let sawToolResult = false
      for (const item of sdkMessage.message.content) {
        if (item?.type !== "tool_result") continue
        sawToolResult = true
        if (typeof item.tool_use_id !== "string") return "unknown"
        const inherited = lineageOrigins.get(item.tool_use_id)


        if (inherited === undefined) return "unknown"
        if (inheritedOrigin !== undefined && inheritedOrigin !== inherited) return "unknown"
        inheritedOrigin = inherited
      }
      return sawToolResult ? inheritedOrigin ?? "unknown" : "unknown"
    })()
    if (startsQueuedTurn && isToolResult) {


      const continuedOrigin = explicitOrigin ?? toolResultOrigin ?? "unknown"
      const changed = rootOrigin !== continuedOrigin
      rootOrigin = continuedOrigin
      outboundOrigins?.observeRoot(rootOrigin)
      if (changed) onTurnOriginChange?.(rootOrigin)
    }
    if (rootOrigin === "unknown" && outboundOrigins?.current() !== "unknown") {
      rootOrigin = outboundOrigins?.current() ?? "unknown"
    }
    const nestedOrigin = parentToolUseId
      ? lineageOrigins.get(parentToolUseId) ?? "unknown"
      : undefined
    const inheritedOrigin = nestedOrigin !== undefined && toolResultOrigin !== undefined
      ? (nestedOrigin === toolResultOrigin ? nestedOrigin : "unknown")
      : nestedOrigin ?? toolResultOrigin
    const origin = explicitOrigin ?? inheritedOrigin ?? rootOrigin


    if (sdkMessage?.type === "stream_event") {
      const block = sdkMessage.event?.type === "content_block_start"
        ? sdkMessage.event.content_block
        : null
      if (block?.type === "tool_use" && typeof block.id === "string") {
        lineageOrigins.set(block.id, origin)
        registerToolOrigin(block.id, origin)
      }
    }
    if (sdkMessage?.type === "assistant") {
      for (const content of Array.isArray(sdkMessage.message?.content) ? sdkMessage.message.content : []) {
        if (content?.type === "tool_use" && typeof content.id === "string") {
          lineageOrigins.set(content.id, origin)
          registerToolOrigin(content.id, origin)
        }
      }
    }
    const sessionToken = typeof sdkMessage.session_id === "string" ? sdkMessage.session_id : null
    if (sessionToken) {
      yield { type: "session_token", sessionToken, origin }
    }


    if (sdkMessage?.type === "stream_event") {
      if (!parentToolUseId) {
        const event = sdkMessage.event
        if (event?.type === "message_start" && typeof event.message?.id === "string") {
          streamingAssistantMessageId = event.message.id
        } else if (
          event?.type === "content_block_delta"
          && event.delta?.type === "text_delta"
          && typeof event.delta.text === "string"
          && event.delta.text
        ) {
          yield { type: "assistant_delta", itemId: streamingAssistantMessageId, delta: event.delta.text, origin }
        }
      }
      continue
    }

    if (sdkMessage?.type === "assistant") {
      const usageId = getClaudeAssistantMessageUsageId(sdkMessage)
      const usageSnapshot = normalizeClaudeAssistantUsageSnapshot(sdkMessage, lastKnownContextWindow)
      if (usageId && usageSnapshot && !seenAssistantUsageIds.has(usageId)) {
        seenAssistantUsageIds.add(usageId)
        latestUsageSnapshot = usageSnapshot
        yield {
          type: "transcript",
          origin,
          entry: timestamped({
            kind: "context_window_updated",
            usage: usageSnapshot,
          }),
        }
      }
    }

    if (sdkMessage?.type === "result") {
      const resultContextWindow = maxClaudeContextWindowFromModelUsage(sdkMessage.modelUsage)
      if (resultContextWindow !== undefined) {
        lastKnownContextWindow = resultContextWindow
      }

      const accumulatedUsage = normalizeClaudeUsageSnapshot(
        sdkMessage.usage,
        resultContextWindow ?? lastKnownContextWindow,
      )
      const finalUsage = latestUsageSnapshot
        ? {
            ...latestUsageSnapshot,
            ...(typeof (resultContextWindow ?? lastKnownContextWindow) === "number"
              ? { maxTokens: resultContextWindow ?? lastKnownContextWindow }
              : {}),
            ...(accumulatedUsage && accumulatedUsage.usedTokens > latestUsageSnapshot.usedTokens
              ? { totalProcessedTokens: accumulatedUsage.usedTokens }
              : {}),
          }
        : accumulatedUsage

      if (finalUsage) {
        yield {
          type: "transcript",
          origin,
          entry: timestamped({
            kind: "context_window_updated",
            usage: finalUsage,
          }),
        }
      }

      seenAssistantUsageIds = new Set<string>()
      latestUsageSnapshot = null
    }

    for (const entry of normalizeClaudeStreamMessage(sdkMessage)) {
      yield { type: "transcript", entry, origin }
    }
    if (sdkMessage?.type === "result") {
      rootOrigin = "unknown"
      outboundOrigins?.finishResult(origin)
      rootOrigin = outboundOrigins?.current() ?? "unknown"


      for (const [toolUseId, lineageOrigin] of lineageOrigins) {
        if (lineageOrigin !== origin) continue
        lineageOrigins.delete(toolUseId)


        seenToolOriginIds.delete(toolUseId)
      }
      onTurnOriginChange?.(undefined)
    }
  }
}

export class ClaudeToolOriginResolver {
  private readonly origins = new Map<string, HarnessEvent["origin"]>()
  private readonly waiters = new Map<string, (origin: HarnessEvent["origin"]) => void>()
  private closed = false

  register(toolUseId: string, origin: HarnessEvent["origin"]) {
    if (this.closed) return
    const waiter = this.waiters.get(toolUseId)
    if (waiter) {
      this.waiters.delete(toolUseId)
      waiter(origin)
      return
    }
    this.origins.set(toolUseId, origin)
  }

  async take(toolUseId: string, signal: AbortSignal, timeoutMs = 5_000): Promise<HarnessEvent["origin"]> {
    if (this.closed) return undefined
    if (this.origins.has(toolUseId)) {
      const origin = this.origins.get(toolUseId)
      this.origins.delete(toolUseId)
      return origin
    }
    if (signal.aborted) return undefined

    return await new Promise((resolveOrigin) => {
      let settled = false
      const settle = (origin: HarnessEvent["origin"]) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        signal.removeEventListener("abort", onAbort)
        if (this.waiters.get(toolUseId) === settle) this.waiters.delete(toolUseId)
        resolveOrigin(origin)
      }
      const onAbort = () => settle(undefined)
      const timer = setTimeout(() => settle(undefined), timeoutMs)
      this.waiters.set(toolUseId, settle)
      signal.addEventListener("abort", onAbort, { once: true })
    })
  }

  clear() {
    this.closed = true
    this.origins.clear()
    for (const settle of [...this.waiters.values()]) settle(undefined)
    this.waiters.clear()
  }
}


export class ClaudeOutboundOriginTracker {


  private readonly pendingHumanTurns: number[] = []
  private nextAnonymousReservation = 0
  private root: HarnessEvent["origin"] = "unknown"

  beginHumanTurn(promptSeq?: number) {
    const reservation = promptSeq ?? -(this.nextAnonymousReservation += 1)
    if (this.pendingHumanTurns.includes(reservation)) {
      throw new Error(`Duplicate Claude human-turn reservation: ${reservation}`)
    }
    this.pendingHumanTurns.push(reservation)
    if (this.root === "unknown") this.root = "human"
  }

  cancelHumanTurn(promptSeq?: number) {
    const index = promptSeq === undefined
      ? this.pendingHumanTurns.length - 1
      : this.pendingHumanTurns.indexOf(promptSeq)
    if (index >= 0) this.pendingHumanTurns.splice(index, 1)
    if (this.pendingHumanTurns.length === 0 && this.root === "human") this.root = "unknown"
  }


  discardHumanTurnReservations(promptSeqs: readonly number[]): number {
    const discarded = new Set(promptSeqs)
    const before = this.pendingHumanTurns.length
    for (let index = this.pendingHumanTurns.length - 1; index >= 0; index -= 1) {
      if (discarded.has(this.pendingHumanTurns[index]!)) this.pendingHumanTurns.splice(index, 1)
    }
    if (this.pendingHumanTurns.length === 0 && this.root === "human") this.root = "unknown"
    return before - this.pendingHumanTurns.length
  }

  observeRoot(origin: HarnessEvent["origin"]) {
    this.root = origin ?? "unknown"
  }

  finishResult(origin: HarnessEvent["origin"]) {
    if (origin === "human") this.pendingHumanTurns.shift()
    this.root = this.pendingHumanTurns.length > 0 ? "human" : "unknown"
  }

  current(): HarnessEvent["origin"] {
    return this.root
  }

  clear() {
    this.pendingHumanTurns.splice(0, this.pendingHumanTurns.length)
    this.root = "unknown"
  }
}

export function isStudyToolOriginAllowed(origin: HarnessEvent["origin"]) {
  return origin === "human"
}

export function isStudyBackgroundToolRequest(toolName: string, input: Record<string, unknown>) {
  if (input.run_in_background === true || input.background === true) return true
  if (toolName !== "Bash") return false
  const command = typeof input.command === "string" ? input.command : ""
  return /\b(?:nohup|setsid|disown)\b/i.test(command)
    || /(?<![>&])&(?!&)\s*(?:$|[;\n])/m.test(command)
}


export function isStudyPreviewLifecycleCommand(command: string): boolean {
  const normalized = command.toLowerCase()
  return [
    /\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:dev|start(?::dev)?)\b/,
    /\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?build\b/,
    /\b(?:run\s+dev|run\s+start:dev|npx\s+next\s+dev|bunx\s+next\s+dev)\b/,
    /\b(?:next|nest)\s+(?:dev|start|build)\b/,
    /\b(?:nohup|setsid|disown)\b/,
    /\b(?:pkill|killall|kill)\b/,
    /\bfuser\b[^\n]*\s-k\b/,
  ].some((pattern) => pattern.test(normalized))
}

class AsyncMessageQueue<T> implements AsyncIterable<T> {
  private readonly values: T[] = []
  private readonly waiters: Array<(result: IteratorResult<T>) => void> = []
  private closed = false

  push(value: T) {
    if (this.closed) {
      throw new Error("Cannot push to a closed queue")
    }

    const waiter = this.waiters.shift()
    if (waiter) {
      waiter({ done: false, value })
      return
    }

    this.values.push(value)
  }

  close() {
    if (this.closed) return
    this.closed = true
    while (this.waiters.length > 0) {
      const waiter = this.waiters.shift()
      waiter?.({ done: true, value: undefined as never })
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: async () => {
        if (this.values.length > 0) {
          return { done: false, value: this.values.shift() as T }
        }

        if (this.closed) {
          return { done: true, value: undefined as never }
        }

        return await new Promise<IteratorResult<T>>((resolve) => {
          this.waiters.push(resolve)
        })
      },
    }
  }
}


const CAPTURE_NUDGE =
  "If this exchange surfaced durable knowledge (a preference, constraint, lesson, or fact worth keeping across sessions), call propose_memory. If the user explicitly asked you to remember something, always propose it."


const CITE_NUDGE =
  "When a saved memory shapes what you do or say this turn, cite it inline as [M-NN] at the point of influence — an uncited influence is invisible to the user."


const DETAIL_NUDGE =
  "Some active memories are marked [+detail]: their one-line form is a headline, not the full rule. Call load_memory_detail on any [+detail] memory that touches this task BEFORE acting on it."

export async function startClaudeSession(args: {
  localPath: string
  model: string
  effort?: string
  planMode: boolean
  sessionToken: string | null
  forkSession: boolean
  onToolRequest: (request: HarnessToolRequest) => Promise<unknown>
  memory?: MemoryService | null

  capture?: CaptureService | null
  projectId?: string
  chatId?: string

  policy?: ConditionPolicy

  subprocessEnv?: Record<string, string | undefined>

  memoryPlan?: MemoryInjectionPlan | null

  restrictMemoryIds?: string[]


  onMemoryProposal?: (created: MemoryItem[]) => void

  studyPreviewRuntime?: StudyAgentPreviewRuntime | null
}): Promise<ClaudeSessionHandle> {


  const policy = args.policy ?? resolveConditionPolicy()
  const toolOriginResolver = new ClaudeToolOriginResolver()
  const outboundOrigins = new ClaudeOutboundOriginTracker()
  const plan: MemoryInjectionPlan | null = args.memoryPlan !== undefined
    ? args.memoryPlan
    : args.memory
      ? planMemoryInjection({
        policy,
        provider: "claude",
        memory: args.memory,
        projectId: args.projectId,
        chatId: args.chatId,
        workspaceDir: args.localPath,
        restrictToIds: args.restrictMemoryIds,
      })
      : null
  let activeMemoryToolTurn: number | undefined
  let activeMemoryToolEngine: string | undefined
  let activeMemoryToolIds: readonly string[] | undefined = plan?.injectedMemories.map(item => item.id)


  const memoryToolContext: MemoryToolContext = {
    projectId: args.projectId,
    sessionId: args.chatId,
    get turn() {
      return activeMemoryToolTurn
    },
    get engine() {
      return activeMemoryToolEngine
    },
    get allowedMemoryIds() { return activeMemoryToolIds },
  }
  const memorySpecs =
    args.memory && plan?.registerTools
      ? buildMemoryToolSpecs(args.memory, {
          capture: args.capture,
          pendingCandidateTiming: 'next_turn',
          onProposed: args.onMemoryProposal,
        })
      : []
  const memoryBlock = plan?.block ?? ""


  const systemAppend = buildClaudeSystemAppend(memoryBlock)
  const canUseTool: CanUseTool = async (toolName, input, options) => {
    if (policy.studyMode) {
      const toolOrigin = await toolOriginResolver.take(options.toolUseID, options.signal)
      if (!isStudyToolOriginAllowed(toolOrigin)) {
        return {
          behavior: "deny",
          message: toolOrigin
            ? `SDK ${toolOrigin} continuations cannot use tools in a participant study session.`
            : "Tool provenance was unavailable; study tools fail closed.",
        }
      }
      if (isStudyBackgroundToolRequest(toolName, input)) {
        return {
          behavior: "deny",
          message: "Background processes are disabled in study tasks. Use foreground tests, lint, and type-check commands; the study server owns the preview and its build artifacts.",
        }
      }
    }
    if (policy.studyMode && toolName === "KillShell") {
      return {
        behavior: "deny",
        message: "The study server owns preview process lifecycle; KillShell is unavailable in study tasks.",
      }
    }
    if (
      policy.studyMode
      && toolName === "Bash"
      && isStudyPreviewLifecycleCommand(typeof input?.command === "string" ? input.command : "")
    ) {
      return {
        behavior: "deny",
        message: "The study server owns the preview on fixed ports 3000 and 3001. Edit the project and use the managed hot reload; do not start, stop, or replace preview processes.",
      }
    }
    if (toolName !== "AskUserQuestion" && toolName !== "ExitPlanMode") {
      return {
        behavior: "allow",
        updatedInput: input,
      }
    }

    const tool = normalizeToolCall({
      toolName,
      toolId: options.toolUseID,
      input: (input ?? {}) as Record<string, unknown>,
    })

    if (tool.toolKind !== "ask_user_question" && tool.toolKind !== "exit_plan_mode") {
      return {
        behavior: "deny",
        message: "Unsupported tool request",
      }
    }

    const result = await args.onToolRequest({ tool })

    if (tool.toolKind === "ask_user_question") {
      const record = result && typeof result === "object" ? result as Record<string, unknown> : {}
      return {
        behavior: "allow",
        updatedInput: {
          ...(tool.rawInput ?? {}),
          questions: record.questions ?? tool.input.questions,
          answers: record.answers ?? result,
        },
      } satisfies PermissionResult
    }

    const record = result && typeof result === "object" ? result as Record<string, unknown> : {}
    const confirmed = Boolean(record.confirmed)
    if (confirmed) {
      return {
        behavior: "allow",
        updatedInput: {
          ...(tool.rawInput ?? {}),
          ...record,
        },
      } satisfies PermissionResult
    }

    return {
      behavior: "deny",
      message: typeof record.message === "string"
        ? `User wants to suggest edits to the plan: ${record.message}`
        : "User wants to suggest edits to the plan before approving.",
    } satisfies PermissionResult
  }

  const promptQueue = new AsyncMessageQueue<SDKUserMessage>()

  const baseSubprocessEnv = args.subprocessEnv ?? buildClaudeSubprocessEnv({
    localPath: args.localPath,
    rawStudyProjects: policy.studyMode ? process.env.STUDY_PROJECTS : undefined,
  })
  const sdkRuntime = buildClaudeSdkRuntimeOptions({
    requestedModel: args.model,
    env: baseSubprocessEnv,
  })

  const q = query({
    prompt: promptQueue,
    options: {
      cwd: args.localPath,


      model: sdkRuntime.model,
      effort: args.effort as "low" | "medium" | "high" | "max" | undefined,
      resume: args.sessionToken ?? undefined,
      forkSession: args.forkSession,
      permissionMode: args.planMode ? "plan" : "acceptEdits",
      canUseTool,


      includePartialMessages: true,
      tools: [...CLAUDE_TOOLSET],
      systemPrompt: systemAppend
        ? { type: "preset", preset: "claude_code", append: systemAppend }
        : undefined,
      mcpServers: memorySpecs.length || (policy.studyMode && args.studyPreviewRuntime)
        ? {
            ...(memorySpecs.length ? { memory: toClaudeMemoryMcpServer(memorySpecs, memoryToolContext) } : {}),
            ...(policy.studyMode && args.studyPreviewRuntime
              ? { preview: toClaudeStudyPreviewMcpServer(args.studyPreviewRuntime, args.localPath) }
              : {}),
          }
        : undefined,


      settingSources: isCliIsolationEnabled(sdkRuntime.env) ? [] : policy.studyMode ? ["user"] : ["user", "project", "local"],


      settings: sdkRuntime.settings,
      pathToClaudeCodeExecutable: process.env.CLAUDE_EXECUTABLE?.replace(/^~(?=\/|$)/, homedir()) || undefined,
      env: sdkRuntime.env,
    },
  })

  return {
    provider: "claude",
    stream: createClaudeHarnessStream(q, undefined, (toolUseId, origin) => {
      if (policy.studyMode) toolOriginResolver.register(toolUseId, origin)
    }, outboundOrigins),
    getAccountInfo: async () => {
      try {
        return await q.accountInfo()
      } catch {
        return null
      }
    },
    interrupt: async () => {
      await q.interrupt()
    },
    sendPrompt: async (
      content: string,
      context?: Pick<MemoryToolContext, "turn" | "engine" | "allowedMemoryIds"> & { promptSeq?: number },
    ) => {
      activeMemoryToolTurn = context?.turn
      activeMemoryToolEngine = context?.engine
      activeMemoryToolIds = context?.allowedMemoryIds
      outboundOrigins.beginHumanTurn(context?.promptSeq)
      try {
        promptQueue.push({
          type: "user",
          message: {
            role: "user",
            content,
          },
          parent_tool_use_id: null,
          session_id: args.sessionToken ?? "",
        })
      } catch (error) {
        outboundOrigins.cancelHumanTurn(context?.promptSeq)
        throw error
      }
    },
    discardHumanTurnReservations: (promptSeqs) => (
      outboundOrigins.discardHumanTurnReservations(promptSeqs)
    ),
    setModel: async (model: string) => {
      await q.setModel(buildClaudeSdkRuntimeOptions({
        requestedModel: model,
        env: baseSubprocessEnv,
      }).model)
    },
    setPermissionMode: async (planMode: boolean) => {
      await q.setPermissionMode(planMode ? "plan" : "acceptEdits")
    },
    supportedModels: async () => await q.supportedModels(),
    memoryPlan: plan,
    close: () => {
      toolOriginResolver.clear()
      outboundOrigins.clear()
      promptQueue.close()
      q.close()
    },
  }
}

interface PreviewControlOperation {
  operationId: string
  taskId: string
  sessionId: string
  chatId: string
  surface: "working_memory"
  action: MemoryPreviewDecision
  controlType: "working_memory"
  payload: { previewId: string; requestedIds: string[]; effectiveIds: string[] }
}

interface PendingMemoryPreview {
  chatId?: string
  previewId: string
  revision: number
  published: boolean

  memoryIds: string[]

  task: string
  memories: MemoryItem[]

  expectedUseById: Map<string, string>
  proposalsId?: string
  transferId?: string
  checkupId?: string
  respond: (
    d: MemoryPreviewDecision,
    memoryIds?: string[],
    expectedUses?: ExpectedMemoryUse[],
    controlOperation?: PreviewControlOperation,
  ) => void
  reopen?: (from: "proposals" | "checkup" | "transfer", stageId: string) => void
}

type TransferGateDecision = "handled" | "skipped" | "cancelled"
type CheckupGateDecision = TransferGateDecision | "reopen_proposals" | "reopen_transfer"
type InternalGateWake<T extends string> = T | "invalidated"

export class AgentCoordinator {
  private readonly store: EventStore
  private readonly onStateChange: (chatId?: string, options?: { immediate?: boolean }) => void
  private readonly codexManager: CodexAppServerManager
  private readonly generateTitle: (messageContent: string, cwd: string) => Promise<GenerateChatTitleResult>
  private readonly startClaudeSessionFn: NonNullable<AgentCoordinatorArgs["startClaudeSession"]>
  private readonly memory: MemoryService | null
  private readonly capture: CaptureService | null
  private readonly memoryTrace: TraceService | null
  private readonly forkTraceFn: typeof runForkTrace
  private readonly forkCaptureFn: typeof runForkCapture
  private readonly forkQueryFn: typeof runForkQuery
  private readonly memoryBranches: boolean
  private readonly createMemoryBranchFn: typeof createMemoryBranch
  private readonly branchPreparations = new Map<string, {
    pipeline: MemoryBranchPipeline
    args: StartTurnArgs
    snapshots: { transfer: Map<string, string>; changes: Map<string, string> }
  }>()
  private readonly workingBranches = new Map<string, MemoryBranch>()
  private readonly memoryRelevance: RelevanceService | null
  private readonly memoryUsePlan: UsePlanService | null

  private readonly turnExpectedUses = new Map<string, ExpectedMemoryUse[]>()

  private readonly turnPayAttention = new Map<string, Array<{ id: string; quote?: string }>>()
  private readonly memoryRevision: RevisionService | null
  private readonly memoryPreview: boolean
  private readonly memoryCheckup: CheckupService | null
  private readonly memoryTransferDetect: TransferDetectService | null
  private readonly policy: ConditionPolicy
  private readonly getMemoryPreviewSettings: () => { enabled: boolean; autoProceedWhenEmpty: boolean }
  private readonly getActiveStudyTaskId: () => string | null
  private readonly studyPromptGate: StudyPromptGate | null
  private readonly onParticipantPromptRecorded: AgentCoordinatorArgs["onParticipantPromptRecorded"]
  private readonly openingBoardBacklog: MemoryBoardBacklogService | null
  private readonly studyMemoryStore: StudyMemoryStore | null
  private readonly staticMemoryExtractor: StaticMemoryExtractor | null
  private readonly claudeSessionFileExists: (localPath: string, sessionToken: string) => boolean
  private readonly studyPreviewRuntime: StudyAgentPreviewRuntime | null
  private readonly claudeRetireTimeoutMs: number
  private readonly studyTaskChats = new Map<string, Set<string>>()
  private readonly studyTaskProjectPaths = new Map<string, Set<string>>()
  private reportBackgroundError: ((message: string) => void) | null = null
  private readonly claimedPreviewControlOperationIds = new Set<string>()


  private readonly claimedPreviewResponses = new Map<string, string>()
  readonly activeTurns = new Map<string, ActiveTurn>()


  readonly pendingPreviews = new Map<string, PendingMemoryPreview>()


  readonly pendingProposalGates = new Map<
    string,
    { proposalsId: string; published: boolean; respond: (d: "reviewed" | "skipped" | "cancelled") => void }
  >()

  readonly pendingCheckupGates = new Map<
    string,
    {
      checkupId: string
      proposalsId?: string
      transferId?: string
      published: boolean
      respond: (d: CheckupGateDecision) => void
      invalidate: () => void
    }
  >()

  readonly pendingTransferGates = new Map<
    string,
    { transferId: string; published: boolean; respond: (d: TransferGateDecision) => void; invalidate: () => void }
  >()


  private readonly activePreparations = new Map<
    string,
    {
      args: StartTurnArgs
      ctx: { project: NonNullable<ReturnType<EventStore["getProject"]>>; turnNumber: number }
      proposalsId?: string
      reparks: Array<Promise<"reviewed" | "skipped" | "cancelled">>
      reopened: boolean
      cancellation: MemoryPreparationCancellation
    }
  >()

  private readonly inFlightCheckups = new Map<
    string,
    { checkupId: string; proposalsId?: string; transferId?: string; reopenProposalsRequested: boolean; reopenTransferRequested: boolean }
  >()


  private readonly turnMemoryRestriction = new Map<string, string[]>()


  private readonly startingChats = new Map<string, ChatActivityStatus>()


  private readonly cancelledDuringPreview = new Set<string>()
  readonly drainingStreams = new Map<string, { turn: HarnessTurn }>()
  readonly claudeSessions = new Map<string, ClaudeSessionState>()


  private readonly inFlightStudyMemoryJobs = new Set<{
    taskId: string
    promise: Promise<StudyMemoryQualityFlag[]>
  }>()
  private readonly studyMemoryQualityByTask = new Map<string, StudyMemoryQualityFlag[]>()
  private readonly pendingStudyMemoryQualityClears = new Map<string, {
    taskId: string
    chatId: string
    turnId: string
    code: string
  }>()


  private readonly staticFocusJobsByInjection = new Map<string, Promise<StudyMemoryQualityFlag[]>>()
  private readonly staticFocusTailByNamespace = new Map<string, Promise<void>>()


  private autoProjectCaptureTail: Promise<void> = Promise.resolve()
  private pendingAutoProjectCaptureJobs = 0

  private readonly pendingAutoCaptureStarts = new Map<string, PendingAutoCaptureStart>()

  private readonly openingBoardRecoveryTasks = new Set<string>()
  private readonly openingBoardRecoveryRetryAttempts = new Map<string, number>()
  private readonly openingBoardRecoveryRetryTimers = new Map<string, ReturnType<typeof setTimeout>>()


  private readonly streamingAssistantTexts = new Map<string, { itemId: string; text: string }>()

  constructor(args: AgentCoordinatorArgs) {
    this.store = args.store
    this.onStateChange = args.onStateChange
    this.codexManager = args.codexManager ?? new CodexAppServerManager()
    this.generateTitle = args.generateTitle ?? generateTitleForChatDetailed
    this.startClaudeSessionFn = args.startClaudeSession ?? startClaudeSession
    this.memory = args.memory ?? null
    this.capture = args.capture ?? null
    this.memoryTrace = args.memoryTrace ?? null
    this.forkTraceFn = args.forkTrace ?? runForkTrace
    this.forkCaptureFn = args.forkCapture ?? runForkCapture
    this.forkQueryFn = args.forkQuery ?? runForkQuery
    this.memoryRelevance = args.memoryRelevance ?? null
    this.memoryUsePlan = args.memoryUsePlan ?? null
    this.memoryRevision = args.memoryRevision ?? null
    this.memoryPreview = args.memoryPreview ?? false
    this.memoryCheckup = args.memoryCheckup ?? null
    this.memoryTransferDetect = args.memoryTransferDetect ?? null
    this.policy = args.policy ?? resolveConditionPolicy()
    this.memoryBranches = this.policy.condition === "memosync" && (args.memoryBranches ?? Boolean(args.createMemoryBranch))
    this.createMemoryBranchFn = args.createMemoryBranch ?? createMemoryBranch
    this.getMemoryPreviewSettings =
      args.getMemoryPreviewSettings ?? (() => ({ enabled: true, autoProceedWhenEmpty: true }))
    this.getActiveStudyTaskId = args.getActiveStudyTaskId ?? (() => null)
    this.studyPromptGate = args.studyPromptGate ?? null
    this.onParticipantPromptRecorded = args.onParticipantPromptRecorded
    this.openingBoardBacklog = args.openingBoardBacklog ?? null
    this.studyMemoryStore = args.studyMemoryStore ?? null
    this.staticMemoryExtractor = args.staticMemoryExtractor ?? null
    this.claudeSessionFileExists = args.claudeSessionFileExists ?? claudeSessionFileExists
    this.studyPreviewRuntime = args.studyPreviewRuntime ?? null
    this.claudeRetireTimeoutMs = args.claudeRetireTimeoutMs ?? 10_000
  }

  private newMemoryBranch(args: Pick<StartTurnArgs, "chatId" | "provider" | "model" | "effort" | "serviceTier">, purpose: string, parent?: string | null) {
    const chat = this.store.requireChat(args.chatId)
    const project = this.store.getProject(chat.projectId)
    if (!project) throw new Error("Memory branch project is unavailable")
    const runtime = args.provider === "claude" ? buildClaudeSdkRuntimeOptions({
      requestedModel: args.model,
      env: buildClaudeSubprocessEnv({ localPath: project.localPath, rawStudyProjects: process.env.STUDY_PROJECTS }),
    }) : null
    const branch = this.createMemoryBranchFn({
      provider: args.provider,
      parentSessionToken: parent === undefined ? chat.pendingForkSessionToken ?? chat.sessionToken : parent,
      localPath: project.localPath,
      model: runtime?.model ?? args.model,
      effort: args.effort,
      serviceTier: args.serviceTier,
      subprocessEnv: runtime?.env,
      purpose,
    })
    this.memory?.logger.event({ type: "memory.branch", sessionId: args.chatId, engine: args.provider, purpose, branchId: branch.id, mode: branch.mode })
    return branch
  }

  private memoryBranchSnapshot(): Map<string, string> {
    return new Map((this.memory?.store.list() ?? []).map(item => [item.id, JSON.stringify({
      id: item.id, version: item.version, status: item.status, content: item.content, detail: item.detail,
      scope: item.scope, projectId: item.projectId, sessionId: item.sessionId,
      relations: this.memory!.store.getRelations(item.id),
      pendingRevision: this.memory!.store.hasOpenRevision(item.id),
    })]))
  }

  memoryRuntimeChoice(chatId: string) {
    const current = this.activeTurns.get(chatId) ?? this.branchPreparations.get(chatId)?.args
    if (current) return { provider: current.provider, model: current.model, effort: current.effort, serviceTier: current.serviceTier }
    return undefined
  }

  private startMemoryBranches(args: StartTurnArgs, ctx: { project: NonNullable<ReturnType<EventStore["getProject"]>>; turnNumber: number }) {
    if (!this.memoryBranches) return
    this.disposeMemoryBranches(args.chatId)
    const captureInput = { projectId: ctx.project.id, sessionId: args.chatId, turn: ctx.turnNumber, engine: args.provider, userText: args.memoryUserText ?? args.content }
    const candidate = this.capture?.buildBranchPrompt?.(captureInput)
    const transfer = this.memoryTransferDetect?.buildTaskBranchPrompt?.({ ...captureInput, projectTitle: ctx.project.title, taskText: captureInput.userText })
    const changes = this.memoryCheckup?.buildBranchPrompt?.(captureInput, captureInput.userText)
    const empty = (schema: string): BranchRequest => ({ prompt: `The current memory store is empty. Analyze the current task only if it yields a valid proposal. Otherwise return ${schema}. Current task: ${JSON.stringify(captureInput.userText)}`, dependencyKey: "" })
    const snapshot = this.memoryBranchSnapshot()
    this.branchPreparations.set(args.chatId, {
      args,
      snapshots: { transfer: new Map(snapshot), changes: new Map(snapshot) },
      pipeline: new MemoryBranchPipeline({
        createBranch: purpose => this.newMemoryBranch(args, purpose),
        requests: {
          candidate: candidate ?? empty('{"candidates":[]}'),
          transfer: transfer ?? empty('{"suggestions":[]}'),
          changes: changes ?? empty('{"conflicts":[],"redundancy":[],"staleness":[]}'),
        },
      }),
    })
  }

  private async continueMemoryBranch(chatId: string, stage: "transfer" | "changes", review: string, dependencyKey: string) {
    const preparation = this.branchPreparations.get(chatId)
    if (!preparation) throw new Error("Memory preparation branch is unavailable")
    const previous = preparation.snapshots[stage]
    const next = this.memoryBranchSnapshot()
    const upsert = [...next].filter(([id, value]) => previous.get(id) !== value).map(([, value]) => JSON.parse(value))
    const remove = [...previous.keys()].filter(id => !next.has(id))
    preparation.snapshots[stage] = next
    const chat = this.store.requireChat(chatId)
    const decisions = this.store.getMessages(chatId).filter(message =>
      (message.kind === "memory_proposals_decision" || message.kind === "memory_transfer_decision" || message.kind === "memory_checkup_decision")
      && message.createdAt >= (this.store.getMessages(chatId).find(entry => entry._id === preparation.args.turnId)?.createdAt ?? Infinity),
    ).map(({ _id, createdAt, ...decision }) => decision)
    const declinedSources = (this.memory?.store.list() ?? []).filter(item => this.memory!.store.getKv(`transfer_declined:${item.id}:${chat.projectId ?? chatId}`)).map(item => item.id)
    return await preparation.pipeline.continue(stage, { review, changes: { upsert, remove, decisions, declinedSources }, dependencyKey })
  }

  private disposeMemoryBranches(chatId: string) {
    this.branchPreparations.get(chatId)?.pipeline.dispose()
    this.branchPreparations.delete(chatId)
    this.workingBranches.get(chatId)?.dispose()
    this.workingBranches.delete(chatId)
  }

  private restoreUndeliveredEnforcement(chatId: string) {
    if (this.activeTurns.get(chatId)?.memoryDeliveryAccepted) return
    const entries = this.turnPayAttention.get(chatId)
    if (!entries?.length || !this.memory) return
    const queued = this.memory.store.getKv<Array<string | { id: string; quote?: string }>>(`pay_attention:${chatId}`) ?? []
    const merged = new Map(queued.map(item => typeof item === "string" ? [item, { id: item }] : [item.id, item]))
    for (const item of entries) if (!merged.has(item.id)) merged.set(item.id, item)
    this.memory.store.setKv(`pay_attention:${chatId}`, [...merged.values()])
    this.turnPayAttention.delete(chatId)
  }

  private async refreshTransferAfterCandidateReview(args: StartTurnArgs, turnNumber: number) {
    if (!this.memoryBranches || !this.memoryTransferDetect) return false
    const chat = this.store.requireChat(args.chatId)
    const project = this.store.getProject(chat.projectId)
    if (!project) throw new Error("Transfer project is unavailable")
    const transferId = this.store.getMessages(args.chatId).filter(message => message.kind === "memory_transfer").at(-1)?.transferId
    const stage = await this.runTransferGate(args, { chat, project, turnNumber }, Promise.resolve(), { transferId, recompute: true })
    return stage.decision === "cancelled"
  }

  private async assessWorkingMemory(args: StartTurnArgs, memories: MemoryItem[], mandatoryIds: string[]): Promise<RelevantMemory[]> {
    if (!this.memoryBranches) return this.memoryRelevance?.assess(args.memoryUserText ?? args.content, memories, {
      mustInclude: mandatoryIds, recentContext: this.recentConversationDigest(args.chatId),
    }) ?? []
    this.workingBranches.get(args.chatId)?.dispose()
    const branch = this.newMemoryBranch(args, "working-memory")
    this.workingBranches.set(args.chatId, branch)
    const input = { task: args.memoryUserText ?? args.content, memories, mandatoryIds }
    const raw = await branch.ask(buildWorkingMemoryBranchPrompt(input), { schema: memoryStageSchema("working-memory") })
    const result = parseWorkingMemoryBranchResult(raw, input)
    const expected = new Map(result.expectedUses.map(use => [use.id, use.expectedUse]))
    return result.relevant.map(item => ({ ...item, expectedUse: expected.get(item.id) }))
  }

  private async reportWorkingMemoryFailure(chatId: string, previewId: string, revision: number) {
    const pending = this.pendingPreviews.get(chatId)
    if (pending?.previewId !== previewId || pending.revision !== revision) return
    await this.store.appendMessage(chatId, timestamped({
      kind: "memory_preview_relevance", previewId, revision, relevant: [], expectedUses: [],
      error: "Working-memory selection failed. Select the memories to use and confirm to retry their expected-use planning, or reopen preparation.",
    }))
    this.emitStateChange(chatId)
  }

  private hasPendingPreviewActivity(chatId: string) {
    return this.pendingPreviews.has(chatId) || this.claimedPreviewResponses.has(chatId)
  }


  private claimPendingPreviewResponse(chatId: string, pending: PendingMemoryPreview) {
    if (this.claimedPreviewResponses.has(chatId)) return false
    if (this.pendingPreviews.get(chatId) !== pending) return false
    this.pendingPreviews.delete(chatId)
    this.claimedPreviewResponses.set(chatId, pending.previewId)
    return true
  }

  private restorePendingPreviewResponse(chatId: string, pending: PendingMemoryPreview) {
    if (this.claimedPreviewResponses.get(chatId) !== pending.previewId) return
    this.claimedPreviewResponses.delete(chatId)
    if (!this.pendingPreviews.has(chatId)) this.pendingPreviews.set(chatId, pending)
  }

  private releasePendingPreviewResponse(chatId: string, previewId: string) {
    if (this.claimedPreviewResponses.get(chatId) === previewId) {
      this.claimedPreviewResponses.delete(chatId)
    }
  }

  private deletePendingPreviewIfCurrent(chatId: string, pending: PendingMemoryPreview) {
    if (this.pendingPreviews.get(chatId) === pending) this.pendingPreviews.delete(chatId)
  }


  async respondMemoryPreview(command: {
    chatId: string
    previewId: string
    decision: MemoryPreviewDecision
    memoryIds?: string[]
    expectedUses?: ExpectedMemoryUse[]
    operationId?: string
  }) {
    const suppliedOperationId = command.operationId?.trim()
    if (suppliedOperationId && this.claimedPreviewControlOperationIds.has(suppliedOperationId)) {
      throw new Error("This Working Memory Control operation was already recorded")
    }
    if (this.claimedPreviewResponses.get(command.chatId) === command.previewId) {
      throw new Error("This Working Memory preview is already being handled")
    }


    const pending = this.pendingPreviews.get(command.chatId)
    if (!pending || pending.previewId !== command.previewId) {


      if (await this.expireOrphanedPreview(command.chatId, command.previewId)) return
      throw new Error("No matching pending memory preview")
    }
    const requestedIds = command.decision === "go_on"
      ? [...(command.memoryIds ?? pending.memoryIds)]
      : [...(command.memoryIds ?? [])]
    const taskId = this.getActiveStudyTaskId()
    const isFormalMemoSync = this.policy.studyMode && this.policy.condition === "memosync" && Boolean(taskId)
    let effectiveIds = [...requestedIds]
    if ((isFormalMemoSync || this.memoryBranches) && command.decision === "go_on") {
      if (!this.memory) throw new Error("Memory service is unavailable")
      const chat = this.store.requireChat(command.chatId)
      const previewPool = new Set(pending.memoryIds)
      effectiveIds = normalizeMemorySelection({
        memory: this.memory,
        projectId: chat.projectId,
        chatId: command.chatId,
        selectedIds: requestedIds.filter((id) => previewPool.has(id)),
      })
    }
    if (command.decision !== "go_on") effectiveIds = []
    let controlOperation: PreviewControlOperation | undefined
    if (isFormalMemoSync && taskId) {
      const operationId = suppliedOperationId || `control:${taskId}:working-memory:${command.previewId}:${command.decision}`
      if (operationId.length > 200) throw new Error("operationId must be at most 200 characters")
      controlOperation = {
        operationId,
        taskId,
        sessionId: taskId,
        chatId: command.chatId,
        surface: "working_memory",
        action: command.decision,
        controlType: "working_memory",
        payload: { previewId: command.previewId, requestedIds, effectiveIds },
      }
    }


    if (!this.claimPendingPreviewResponse(command.chatId, pending)) {
      throw new Error("This Working Memory preview is already being handled")
    }

    let handedOff = false
    let attemptedRecorded = false
    try {
      if (controlOperation) {
        const attempted = this.memory?.logger.event({
          type: "study.control_operation",
          ...controlOperation,
          phase: "attempted",
        })
        if (
          attempted !== null
          && typeof attempted === "object"
          && "durableCreated" in attempted
          && attempted.durableCreated === false
        ) {
          throw new Error("This Working Memory Control operation was already recorded")
        }
        attemptedRecorded = true
        this.claimedPreviewControlOperationIds.add(controlOperation.operationId)
      }

      let authoritativeExpectedUses = command.expectedUses
      if (isFormalMemoSync || this.memoryBranches) {
        authoritativeExpectedUses = command.decision === "go_on"
          ? await this.ensurePendingPreviewExpectedUses(pending, effectiveIds)
          : []
      }

      handedOff = true
      pending.respond(
        command.decision,
        command.decision === "go_on"
          ? isFormalMemoSync || this.memoryBranches ? effectiveIds : command.memoryIds
          : undefined,
        authoritativeExpectedUses,
        controlOperation,
      )
    } catch (error) {
      if (!handedOff) this.restorePendingPreviewResponse(command.chatId, pending)
      if (attemptedRecorded && controlOperation) {
        try {
          this.memory?.logger.event({
            type: "study.control_operation",
            ...controlOperation,
            phase: "failed",
            errorClass: error instanceof Error ? error.constructor.name : typeof error,
          })
        } catch {

        }
      }
      throw error
    }
  }


  async planMemoryPreviewUses(input: {
    chatId: string
    previewId: string
    selectedIds: string[]
  }): Promise<ExpectedMemoryUse[]> {
    const pending = this.pendingPreviews.get(input.chatId)
    if (!pending?.published || pending.previewId !== input.previewId) {
      throw new Error("No matching pending memory preview")
    }
    if (!this.memory) throw new Error("Memory service is unavailable")
    const chat = this.store.requireChat(input.chatId)
    const previewPool = new Set(pending.memoryIds)
    const effectiveIds = normalizeMemorySelection({
      memory: this.memory,
      projectId: chat.projectId,
      chatId: input.chatId,
      selectedIds: input.selectedIds.filter((id) => previewPool.has(id)),
    })
    return await this.ensurePendingPreviewExpectedUses(pending, effectiveIds)
  }

  async reviseMemoryPreview(input: { chatId: string; previewId: string; instruction: string; selectedIds: string[] }) {
    const pending = this.pendingPreviews.get(input.chatId)
    const branch = this.workingBranches.get(input.chatId)
    if (!pending?.published || pending.previewId !== input.previewId || !branch) throw new Error("No matching working-memory branch")
    const selected = new Set(input.selectedIds)
    const mandatoryIds = (this.turnPayAttention.get(input.chatId) ?? []).filter(item => selected.has(item.id)).map(item => item.id)
    const branchInput = { task: pending.task, memories: pending.memories, mandatoryIds }
    const raw = await branch.ask([
      'The developer is adjusting working memory. Continue in this same branch. Answer questions while preserving the selection; follow instructions about selection with minimal changes. Include a short reply field.',
      `Current selection: ${JSON.stringify(input.selectedIds)}. Developer message: ${JSON.stringify(input.instruction)}`,
      buildWorkingMemoryBranchPrompt(branchInput),
    ].join('\n\n'), { schema: memoryStageSchema("working-memory"), budget: { maxTurns: 3, maxToolCalls: 1 } })
    if (this.pendingPreviews.get(input.chatId) !== pending) throw new Error("Working-memory preview changed during revision")
    const result = parseWorkingMemoryBranchResult(raw, branchInput)
    for (const use of result.expectedUses) pending.expectedUseById.set(use.id, use.expectedUse)
    return { selectedIds: result.relevant.map(item => item.id), reply: typeof raw.reply === "string" ? raw.reply : "Updated working memory for this task." }
  }


  async reopenMemoryPreparation(command: {
    chatId: string
    from: "proposals" | "checkup" | "transfer"
    stageId: string
  }) {
    const pending = this.pendingPreviews.get(command.chatId)
    if (pending?.published && pending.reopen) {
      const expectedId =
        command.from === "proposals"
          ? pending.proposalsId
          : command.from === "transfer"
            ? pending.transferId
            : pending.checkupId
      if (!expectedId || expectedId !== command.stageId) {
        throw new Error("This memory review is no longer the active version")
      }
      pending.reopen(command.from, command.stageId)
      return
    }


    if (command.from === "proposals") {
      const running = this.inFlightCheckups.get(command.chatId)
      if (running?.proposalsId === command.stageId) {
        running.reopenProposalsRequested = true
        return
      }
      const checkup = this.pendingCheckupGates.get(command.chatId)
      if (checkup?.published && checkup.proposalsId === command.stageId) {
        checkup.respond("reopen_proposals")
        return
      }
    }
    if (command.from === "transfer") {
      const running = this.inFlightCheckups.get(command.chatId)
      if (running?.transferId === command.stageId) {
        running.reopenTransferRequested = true
        return
      }
      const checkup = this.pendingCheckupGates.get(command.chatId)
      if (checkup?.published && checkup.transferId === command.stageId) {
        checkup.respond("reopen_transfer")
        return
      }
    }


    if (command.from === "proposals") {
      const prep = this.activePreparations.get(command.chatId)
      if (prep && prep.proposalsId === command.stageId && !this.pendingProposalGates.has(command.chatId)) {
        prep.reopened = true
        const repark = (async (): Promise<"reviewed" | "skipped" | "cancelled"> => {
          await this.store.appendMessage(
            command.chatId,
            timestamped({
              kind: "memory_preparation_reset",
              revision: prep.reparks.length + 1,
              from: "proposals",
              proposalsId: command.stageId,
            }),
          )
          this.emitStateChange(command.chatId, { immediate: true })
          return await this.parkExistingProposalsGate(prep.args, prep.ctx, command.stageId)
        })()
        prep.reparks.push(repark)
        return
      }
    }


    if (await this.expireOrphanedPreparation(command.chatId)) return

    throw new Error("Memory review can only be changed before the agent starts")
  }


  private async expireOrphanedPreparation(chatId: string): Promise<boolean> {
    if (
      this.activeTurns.has(chatId) ||
      this.hasPendingPreviewActivity(chatId) ||
      this.pendingProposalGates.has(chatId) ||
      this.pendingCheckupGates.has(chatId) ||
      this.pendingTransferGates.has(chatId) ||
      this.inFlightCheckups.has(chatId) ||
      this.startingChats.has(chatId)
    ) {
      return false
    }
    const messages = this.store.getMessages(chatId)
    const decidedProposals = new Set(
      messages.filter((m) => m.kind === "memory_proposals_decision").map((m) => m.proposalsId),
    )
    const decidedCheckups = new Set(
      messages.filter((m) => m.kind === "memory_checkup_decision").map((m) => m.checkupId),
    )
    const decidedTransfers = new Set(
      messages.filter((m) => m.kind === "memory_transfer_decision").map((m) => m.transferId),
    )
    const decidedPreviews = new Set(
      messages.filter((m) => m.kind === "memory_preview_decision").map((m) => m.previewId),
    )
    let settled = false
    for (const message of messages) {
      if (message.kind === "memory_proposals" && !decidedProposals.has(message.proposalsId)) {
        decidedProposals.add(message.proposalsId)
        await this.store.appendMessage(
          chatId,
          timestamped({ kind: "memory_proposals_decision", proposalsId: message.proposalsId, decision: "expired" }),
        )
        settled = true
      }
      if (message.kind === "memory_transfer" && !decidedTransfers.has(message.transferId)) {
        decidedTransfers.add(message.transferId)
        await this.store.appendMessage(
          chatId,
          timestamped({ kind: "memory_transfer_decision", transferId: message.transferId, decision: "expired" }),
        )
        settled = true
      }
      if (message.kind === "memory_checkup" && !decidedCheckups.has(message.checkupId)) {
        decidedCheckups.add(message.checkupId)
        await this.store.appendMessage(
          chatId,
          timestamped({ kind: "memory_checkup_decision", checkupId: message.checkupId, decision: "expired" }),
        )
        settled = true
      }
      if (message.kind === "memory_preview" && !decidedPreviews.has(message.previewId)) {
        decidedPreviews.add(message.previewId)
        await this.store.appendMessage(
          chatId,
          timestamped({ kind: "memory_preview_decision", previewId: message.previewId, decision: "expired" }),
        )
        settled = true
      }
    }
    if (!settled) return false
    await this.store.recordTurnCancelled(chatId)
    this.emitStateChange(chatId, { immediate: true })
    return true
  }


  private async expireOrphanedPreview(chatId: string, previewId: string): Promise<boolean> {
    if (this.activeTurns.has(chatId) || this.hasPendingPreviewActivity(chatId) || this.startingChats.has(chatId)) {
      return false
    }
    const messages = this.store.getMessages(chatId)
    const preview = messages.find(
      (m): m is Extract<TranscriptEntry, { kind: "memory_preview" }> =>
        m.kind === "memory_preview" && m.previewId === previewId,
    )
    if (!preview) return false
    const decided = messages.some((m) => m.kind === "memory_preview_decision" && m.previewId === previewId)
    if (decided) return false

    await this.store.appendMessage(
      chatId,
      timestamped({ kind: "memory_preview_decision", previewId, decision: "expired" }),
    )
    await this.store.recordTurnCancelled(chatId)
    this.memory?.logger.event({
      type: "memory.preview",
      sessionId: chatId,
      turn: preview.turn,
      memoryIds: preview.memories.map((m) => m.id),
      decision: "expired",
    })
    this.emitStateChange(chatId, { immediate: true })
    return true
  }


  async respondMemoryCheckup(command: { chatId: string; checkupId: string; decision: "handled" | "skipped" }) {
    const pending = this.pendingCheckupGates.get(command.chatId)
    if (!pending || pending.checkupId !== command.checkupId) {
      if (this.isMemoryGateDecided(command.chatId, "memory_checkup_decision", "checkupId", command.checkupId)) return
      if (await this.expireOrphanedCheckup(command.chatId, command.checkupId)) return
      throw new Error("No matching pending memory checkup gate")
    }
    pending.respond(command.decision)
  }


  private async expireOrphanedCheckup(chatId: string, checkupId: string): Promise<boolean> {
    if (
      this.activeTurns.has(chatId) ||
      this.pendingCheckupGates.has(chatId) ||
      this.pendingProposalGates.has(chatId) ||
      this.pendingTransferGates.has(chatId) ||
      this.hasPendingPreviewActivity(chatId) ||
      this.startingChats.has(chatId)
    ) {
      return false
    }
    const messages = this.store.getMessages(chatId)
    const gate = messages.find(
      (m): m is Extract<TranscriptEntry, { kind: "memory_checkup" }> =>
        m.kind === "memory_checkup" && m.checkupId === checkupId,
    )
    if (!gate) return false
    const decided = messages.some((m) => m.kind === "memory_checkup_decision" && m.checkupId === checkupId)
    if (decided) return false

    await this.store.appendMessage(
      chatId,
      timestamped({ kind: "memory_checkup_decision", checkupId, decision: "expired" }),
    )
    await this.store.recordTurnCancelled(chatId)
    const result = messages.find(
      (m): m is Extract<TranscriptEntry, { kind: "memory_checkup_result" }> =>
        m.kind === "memory_checkup_result" && m.checkupId === checkupId,
    )
    this.memory?.logger.event({
      type: "memory.checkup",
      sessionId: chatId,
      turn: gate.turn,
      suggestions: result?.suggestions.length ?? 0,
      ...(result?.failedKinds?.length ? { failedKinds: result.failedKinds } : {}),
      decision: "expired",
    })
    this.emitStateChange(chatId, { immediate: true })
    return true
  }


  async respondMemoryTransfer(command: { chatId: string; transferId: string; decision: "handled" | "skipped" }) {
    const pending = this.pendingTransferGates.get(command.chatId)
    if (!pending || pending.transferId !== command.transferId) {


      if (this.isMemoryGateDecided(command.chatId, "memory_transfer_decision", "transferId", command.transferId)) return
      if (await this.expireOrphanedTransfer(command.chatId, command.transferId)) return
      throw new Error("No matching pending memory transfer card")
    }
    pending.respond(command.decision)
  }


  private isMemoryGateDecided(
    chatId: string,
    kind: "memory_transfer_decision" | "memory_checkup_decision" | "memory_proposals_decision",
    idField: "transferId" | "checkupId" | "proposalsId",
    gateId: string
  ): boolean {
    return this.store
      .getMessages(chatId)
      .some((m) => m.kind === kind && (m as unknown as Record<string, string>)[idField] === gateId)
  }


  private async expireOrphanedTransfer(chatId: string, transferId: string): Promise<boolean> {
    if (
      this.activeTurns.has(chatId) ||
      this.pendingTransferGates.has(chatId) ||
      this.pendingCheckupGates.has(chatId) ||
      this.pendingProposalGates.has(chatId) ||
      this.hasPendingPreviewActivity(chatId) ||
      this.startingChats.has(chatId)
    ) {
      return false
    }
    const messages = this.store.getMessages(chatId)
    const gate = messages.find(
      (m): m is Extract<TranscriptEntry, { kind: "memory_transfer" }> =>
        m.kind === "memory_transfer" && m.transferId === transferId,
    )
    if (!gate) return false
    const decided = messages.some((m) => m.kind === "memory_transfer_decision" && m.transferId === transferId)
    if (decided) return false

    await this.store.appendMessage(
      chatId,
      timestamped({ kind: "memory_transfer_decision", transferId, decision: "expired" }),
    )
    await this.store.recordTurnCancelled(chatId)
    this.memory?.logger.event({
      type: "memory.transfer_card",
      sessionId: chatId,
      turn: gate.turn,
      suggestions: gate.suggestions.length,
      decision: "expired",
    })
    this.emitStateChange(chatId, { immediate: true })
    return true
  }


  async respondMemoryProposals(command: { chatId: string; proposalsId: string; decision: "reviewed" | "skipped" }) {
    const pending = this.pendingProposalGates.get(command.chatId)
    if (!pending || pending.proposalsId !== command.proposalsId) {
      if (this.isMemoryGateDecided(command.chatId, "memory_proposals_decision", "proposalsId", command.proposalsId)) return
      if (await this.expireOrphanedProposals(command.chatId, command.proposalsId)) return
      throw new Error("No matching pending memory proposals gate")
    }
    pending.respond(command.decision)
  }


  private async expireOrphanedProposals(chatId: string, proposalsId: string): Promise<boolean> {
    if (this.activeTurns.has(chatId) || this.pendingProposalGates.has(chatId) || this.pendingTransferGates.has(chatId) || this.hasPendingPreviewActivity(chatId) || this.startingChats.has(chatId)) {
      return false
    }
    const messages = this.store.getMessages(chatId)
    const gate = messages.find(
      (m): m is Extract<TranscriptEntry, { kind: "memory_proposals" }> =>
        m.kind === "memory_proposals" && m.proposalsId === proposalsId,
    )
    if (!gate) return false
    const decided = messages.some((m) => m.kind === "memory_proposals_decision" && m.proposalsId === proposalsId)
    if (decided) return false

    await this.store.appendMessage(
      chatId,
      timestamped({ kind: "memory_proposals_decision", proposalsId, decision: "expired" }),
    )
    await this.store.recordTurnCancelled(chatId)
    this.memory?.logger.event({
      type: "memory.proposals",
      sessionId: chatId,
      turn: gate.turn,
      count: gate.candidates.length,
      decision: "expired",
    })
    this.emitStateChange(chatId, { immediate: true })
    return true
  }


  private recordMemoryCitations(text: string, sessionId?: string): string[] {
    if (!this.memory || !text) return []
    const cited = extractCitations(text)
    if (!cited.length) return []
    const counted: string[] = []
    for (const id of cited) {
      const m = this.memory.store.getById(id)
      if (m && m.status === "active") {
        this.memory.store.recordUse(id, { actor: "agent", sessionId, via: "citation" })
        counted.push(id)
      }
    }
    const injected = new Set(sessionId ? this.activeTurns.get(sessionId)?.injectedIds ?? [] : [])
    const carryoverIds = counted.filter((id) => !injected.has(id))
    this.memory.logger.event({
      type: "memory.cite",
      sessionId,
      citedIds: cited,
      countedIds: counted,
      ...(carryoverIds.length ? { carryoverIds } : {}),
    })
    return counted
  }


  private autoApplyProposals(
    proposals: MemoryItem[],
    args: { chatId: string; turnNumber?: number },
  ): Set<string> {
    const applied = new Set<string>()
    if (!this.memory || this.policy.capture !== "review") return applied
    const mode = this.memory.store.getKv<{ mode?: string }>("evolution_policy")?.mode ?? "ask"
    if (mode !== "auto") return applied
    const touchedProjects = new Set<string | undefined>()
    for (const proposal of proposals) {
      if (proposal.sensitive) continue
      try {
        const meta = { actor: "system" as const, sessionId: args.chatId, turn: args.turnNumber }
        if (this.memory.store.revisionTargetOf(proposal.id)) {
          const outcome = this.memory.store.acceptRevision(proposal.id, meta)


          for (const replaced of outcome.replaced) {
            touchedProjects.add(replaced.projectId)
            this.memory.logger.event({
              type: "memory.decision",
              sessionId: args.chatId,
              action: "archive",
              id: replaced.id,
              fromScope: replaced.scope,
              via: "revision_accept",
            })
          }
        } else {
          this.memory.store.update(proposal.id, { status: "active" }, meta)
        }
        applied.add(proposal.id)
        touchedProjects.add(proposal.projectId)
        this.memory.logger.event({
          type: "memory.decision",
          sessionId: args.chatId,
          action: "accept",
          id: proposal.id,
          via: "auto",
        })
      } catch {

      }
    }


    if (applied.size) {
      const projectIds = [...touchedProjects].filter((p): p is string => Boolean(p))
      if (projectIds.length === 0) this.memory.syncProjection()
      else for (const projectId of projectIds) this.memory.syncProjection(projectId)
    }
    return applied
  }


  private noteStudyMemoryQualityFlag(flag: StudyMemoryQualityFlag): void {
    const existing = this.studyMemoryQualityByTask.get(flag.taskId) ?? []
    const duplicate = existing.some((candidate) => (
      candidate.code === flag.code
      && candidate.chatId === flag.chatId
      && candidate.turnId === flag.turnId
    ))
    try {
      this.studyMemoryStore?.recordStudyMemoryQualityFlag(flag)
    } catch (error) {
      this.reportBackgroundError?.(
        `[study-quality] failed to persist ${flag.code}: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
    if (duplicate) return
    this.studyMemoryQualityByTask.set(flag.taskId, [...existing, flag])
  }

  private clearStudyMemoryQualityFlag(args: {
    taskId: string
    chatId: string
    turnId: string
    code: string
  }): void {
    const existing = this.studyMemoryQualityByTask.get(args.taskId) ?? []
    const remaining = existing.filter((flag) => !(
      flag.code === args.code
      && flag.chatId === args.chatId
      && flag.turnId === args.turnId
    ))
    if (remaining.length) this.studyMemoryQualityByTask.set(args.taskId, remaining)
    else this.studyMemoryQualityByTask.delete(args.taskId)
    const clearKey = `${args.taskId}\0${args.code}\0${args.chatId}\0${args.turnId}`
    try {
      this.studyMemoryStore?.clearStudyMemoryQualityFlag(args)
      this.pendingStudyMemoryQualityClears.delete(clearKey)
    } catch (error) {
      this.pendingStudyMemoryQualityClears.set(clearKey, args)
      this.reportBackgroundError?.(
        `[study-quality] failed to clear ${args.code}: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }

  private trackStudyMemoryJob(
    taskId: string,
    promise: Promise<StudyMemoryQualityFlag[]>,
    pendingFlag?: StudyMemoryQualityFlag,
  ): void {
    const tracked = { taskId, promise }
    this.inFlightStudyMemoryJobs.add(tracked)
    void promise.then((flags) => {
      for (const flag of flags) this.noteStudyMemoryQualityFlag(flag)
      if (pendingFlag) this.clearStudyMemoryQualityFlag(pendingFlag)
    }).finally(() => {
      this.inFlightStudyMemoryJobs.delete(tracked)
    })
  }

  private enqueueAutoProjectCapture<T>(job: () => Promise<T>): Promise<T> {
    this.pendingAutoProjectCaptureJobs += 1
    const execution = this.autoProjectCaptureTail
      .catch(() => undefined)
      .then(job)
    const tracked = execution.finally(() => {
      this.pendingAutoProjectCaptureJobs = Math.max(0, this.pendingAutoProjectCaptureJobs - 1)
    })
    this.autoProjectCaptureTail = tracked.then(
      () => undefined,
      () => undefined,
    )
    return tracked
  }

  private async awaitAutoProjectCaptureBarrier(): Promise<void> {
    while (true) {
      const observed = this.autoProjectCaptureTail
      await observed
      if (observed === this.autoProjectCaptureTail) return
    }
  }

  private shouldQueueBehindAutoCapture(provider: AgentProvider): boolean {
    return this.policy.studyMode
      && this.policy.condition === "auto"
      && provider === "claude"
      && this.pendingAutoProjectCaptureJobs > 0
  }

  private async recordDeferredTurnStartFailure(chatId: string, error: unknown): Promise<void> {
    const message = error instanceof Error ? error.message : String(error)
    try {
      await this.store.appendMessage(
        chatId,
        timestamped({ kind: "result", subtype: "error", isError: true, durationMs: 0, result: message }),
      )
      await this.store.recordTurnFailed(chatId, message)
      this.emitStateChange(chatId)
    } catch (recordError) {
      this.reportBackgroundError?.(
        `[auto-deferred-start] chat ${chatId}: could not record failure: ${recordError instanceof Error ? recordError.message : String(recordError)}`,
      )
    }
  }

  private isCancelledDeferredQueueRow(chatId: string, queuedMessageId: string): boolean {
    return this.store.getMessages(chatId).some((entry) => (
      entry.kind === "interrupted"
      && entry.cancelledQueuedMessageId === queuedMessageId
    ))
  }


  private async nextDispatchableQueuedMessage(chatId: string): Promise<QueuedChatMessage | null> {
    while (true) {
      const head = this.store.getQueuedMessages(chatId)[0]
      if (!head) return null
      if (!this.isCancelledDeferredQueueRow(chatId, head.id)) return head
      try {
        await this.store.removeQueuedMessage(chatId, head.id)
      } catch (error) {
        if (this.store.getQueuedMessage(chatId, head.id)) {
          this.reportBackgroundError?.(
            `[auto-deferred-stop] chat ${chatId}: stopped queue row remains blocked: ${error instanceof Error ? error.message : String(error)}`,
          )
          return null
        }
      }
    }
  }

  private resumeNextQueuedMessage(chatId: string): void {
    void this.maybeStartNextQueuedMessage(chatId).catch((error) => {
      void this.recordDeferredTurnStartFailure(chatId, error)
    })
  }


  private scheduleAutoCaptureQueueDrain(chatId: string, queuedMessageId: string): void {
    if (this.pendingAutoCaptureStarts.has(chatId)) return
    const pending = new PendingAutoCaptureStart(queuedMessageId)
    this.pendingAutoCaptureStarts.set(chatId, pending)
    this.emitStateChange(chatId, { immediate: true })

    void (async () => {
      try {
        const outcome = await Promise.race([
          this.awaitAutoProjectCaptureBarrier().then(() => "ready" as const),
          pending.cancellation.requested.then(() => "cancelled" as const),
        ])
        if (outcome === "cancelled" || pending.cancellation.signal.aborted) return
        pending.phase = "dispatching"
        while (!pending.cancellation.signal.aborted) {


          const queued = await this.nextDispatchableQueuedMessage(chatId)
          if (!queued) return
          pending.queuedMessageId = queued.id
          const dispatch = await this.dequeueAndStartQueuedMessage(chatId, queued, {
            deferredAutoStart: pending.guard,
          })
          if (dispatch !== "missing") return
        }
      } catch (error) {


        if (!pending.cancellation.signal.aborted && !pending.cancelCommittedDelivery) {
          await this.recordDeferredTurnStartFailure(chatId, error)
        }
      } finally {
        pending.settleWithoutTurnStart()
        let continueQueue = false
        if (
          pending.phase === "dispatching"
          && (pending.cancellation.signal.aborted || pending.cancelCommittedDelivery)
          && pending.cancellationReceipt
        ) {


          let receiptDurable = true
          await pending.cancellationReceipt.catch(() => {
            receiptDurable = false
          })
          if (pending.cancellation.signal.aborted && this.store.getQueuedMessage(chatId, pending.queuedMessageId)) {
            try {
              await this.store.removeQueuedMessage(chatId, pending.queuedMessageId)
            } catch (error) {
              if (this.store.getQueuedMessage(chatId, pending.queuedMessageId)) {
                this.reportBackgroundError?.(
                  `[auto-deferred-stop] chat ${chatId}: could not remove stopped queue row: ${error instanceof Error ? error.message : String(error)}`,
                )
              }
            }
          }


          continueQueue = receiptDurable
            && !this.store.getQueuedMessage(chatId, pending.queuedMessageId)
        }
        if (this.pendingAutoCaptureStarts.get(chatId) === pending) {
          this.pendingAutoCaptureStarts.delete(chatId)
        }
        pending.cancellation.settle()
        this.emitStateChange(chatId)

        if (continueQueue) this.resumeNextQueuedMessage(chatId)
      }
    })()
  }

  private cancelAutoCaptureQueueDrain(
    chatId: string,
    pending: PendingAutoCaptureStart,
    hideInterrupted?: boolean,
  ): Promise<void> {
    if (pending.cancellationOperation) return pending.cancellationOperation

    const stoppedDuringDispatch = pending.phase === "dispatching"
    const committedDelivery = pending.deliveryCommitted
    if (committedDelivery) pending.cancelCommittedDelivery = true
    const barrierSettlement = committedDelivery ? null : pending.cancellation.cancelAndWait()

    pending.cancellationReceipt = (async () => {
      if (!stoppedDuringDispatch) await barrierSettlement
      if (committedDelivery) await pending.turnStartSettlement
      await this.store.appendMessage(chatId, committedDelivery
        ? timestamped({ kind: "interrupted", hidden: hideInterrupted })
        : timestamped({
            kind: "interrupted",
            hidden: hideInterrupted,
            cancelledQueuedMessageId: pending.queuedMessageId,
          }))
      await this.store.recordTurnCancelled(chatId)


      if (!stoppedDuringDispatch && !committedDelivery) {
        try {
          if (this.store.getQueuedMessage(chatId, pending.queuedMessageId)) {
            await this.store.removeQueuedMessage(chatId, pending.queuedMessageId)
          }
        } catch (error) {
          if (this.store.getQueuedMessage(chatId, pending.queuedMessageId)) {
            this.reportBackgroundError?.(
              `[auto-deferred-stop] chat ${chatId}: could not remove stopped barrier row: ${error instanceof Error ? error.message : String(error)}`,
            )
          }
        }
      }
    })()

    pending.cancellationOperation = pending.cancellationReceipt.then(() => {
      this.emitStateChange(chatId, { immediate: true })
      if (!stoppedDuringDispatch) this.resumeNextQueuedMessage(chatId)
    })
    return pending.cancellationOperation
  }

  private launchPostTurnMemoryPasses(args: PostTurnMemoryPassArgs): void {
    const active = this.activeTurns.get(args.chatId)
    if (this.memoryBranches && active) {
      args.injectedMemories = active.memoryPlan?.injectedMemories.map(item => ({ ...item }))
      args.expectedUses = this.turnExpectedUses.get(args.chatId)
      args.model = active.model
      args.effort = active.effort
      args.serviceTier = active.serviceTier
      const messages = this.store.getMessages(args.chatId)
      const start = messages.findIndex(message => message._id === args.turnId)
      const turnMessages = start >= 0 ? messages.slice(start + 1) : []
      args.executionText = turnMessages.filter(message => message.kind === "tool_call" || message.kind === "tool_result")
        .map(message => JSON.stringify(message)).join("\n")
      args.executionTools = turnMessages.flatMap(message => {
        if (message.kind === "tool_call") return [{ toolId: message.tool.toolId, text: JSON.stringify(message.tool) }]
        if (message.kind === "tool_result") return [{ toolId: message.toolId, text: typeof message.content === "string" ? message.content : JSON.stringify(message.content) }]
        return []
      })
      const chat = this.store.getChat(args.chatId)
      args.sessionToken = chat?.sessionToken
      args.localPath = chat?.projectId ? this.store.getProject(chat.projectId)?.localPath : undefined
    }
    if (args.engine !== "claude" || !args.taskId) {
      const run = () => this.runPostTurnMemoryPasses(args)
      void (this.policy.condition === "auto" && args.engine === "claude"
        ? this.enqueueAutoProjectCapture(run)
        : run())
      return
    }

    const taskId = args.taskId
    let resolved = false
    let resolveSettlement!: (flags: StudyMemoryQualityFlag[]) => void
    const promise = new Promise<StudyMemoryQualityFlag[]>((resolve) => {
      resolveSettlement = resolve
    })
    const settle = (flags: StudyMemoryQualityFlag[]) => {
      if (resolved) return
      resolved = true
      resolveSettlement(flags)
    }
    const pendingFlag: StudyMemoryQualityFlag = {
      code: "post_turn_incomplete",
      blocking: false,
      taskId,
      chatId: args.chatId,
      turnId: args.turnId,
      ...(args.turnNumber !== undefined ? { turn: args.turnNumber } : {}),
    }
    this.noteStudyMemoryQualityFlag(pendingFlag)
    this.trackStudyMemoryJob(taskId, promise, pendingFlag)

    const run = () => this.runPostTurnMemoryPasses({
      ...args,
      onStudyMeasurementSettled: settle,
    })
    const execution = this.policy.condition === "auto"
      ? this.enqueueAutoProjectCapture(run)
      : run()
    void execution.catch((error) => {
      this.reportBackgroundError?.(
        `[memory-post-turn] chat ${args.chatId} turn ${args.turnNumber ?? "?"}: ${error instanceof Error ? error.message : String(error)}`
      )
      settle([{
        code: "post_turn_failed",
        blocking: false,
        taskId,
        chatId: args.chatId,
        turnId: args.turnId,
        ...(args.turnNumber !== undefined ? { turn: args.turnNumber } : {}),
      }])
    })
  }

  private staticFocusFailure(
    pending: Pick<PendingStaticFocusDelivery, "taskId" | "chatId" | "turnId" | "turn">,
    code: "static_extraction_failed" | "static_focus_persistence_failed" | "static_focus_pending",
  ): StudyMemoryQualityFlag {
    return {
      code,
      blocking: true,
      taskId: pending.taskId,
      chatId: pending.chatId,
      turnId: pending.turnId,
      turn: pending.turn,
    }
  }

  private enqueuePendingStaticFocus(pending: PendingStaticFocusDelivery): void {
    if (!this.studyMemoryStore || !this.staticMemoryExtractor) return
    if (this.staticFocusJobsByInjection.has(pending.injectionId)) return

    const previous = this.staticFocusTailByNamespace.get(pending.namespace) ?? Promise.resolve()
    const job = previous
      .catch(() => undefined)
      .then(async () => {
        await materializePendingStaticFocus({
          store: this.studyMemoryStore!,
          extractor: this.staticMemoryExtractor!,
          logger: this.memory?.logger ?? { event: () => {} },
          pending,
        })
        this.clearStudyMemoryQualityFlag({
          taskId: pending.taskId,
          chatId: pending.chatId,
          turnId: pending.turnId,
          code: "static_extraction_failed",
        })
        return [] as StudyMemoryQualityFlag[]
      })
      .catch((error) => {
        this.reportBackgroundError?.(
          `[study-static-focus] chat ${pending.chatId} turn ${pending.turn}: ${error instanceof Error ? error.message : String(error)}`,
        )
        return [this.staticFocusFailure(pending, "static_extraction_failed")]
      })
    const tail = job.then(() => undefined)
    this.staticFocusJobsByInjection.set(pending.injectionId, job)
    this.staticFocusTailByNamespace.set(pending.namespace, tail)
    this.trackStudyMemoryJob(pending.taskId, job)
    void tail.finally(() => {
      this.staticFocusJobsByInjection.delete(pending.injectionId)
      if (this.staticFocusTailByNamespace.get(pending.namespace) === tail) {
        this.staticFocusTailByNamespace.delete(pending.namespace)
      }
    })
  }


  resumePendingStaticFocusMaterializations(taskId?: string): void {
    if (!this.studyMemoryStore || !this.staticMemoryExtractor) return
    for (const pending of this.studyMemoryStore.listPendingStaticFocusDeliveries(
      taskId ? { taskId } : {},
    )) {
      this.enqueuePendingStaticFocus(pending)
    }
  }

  private launchStaticFocusMaterialization(args: {
    taskId: string | null
    projectId?: string
    chatId: string
    turnId: string
    turn: number
    promptText: string
    plan: MemoryInjectionPlan | null
  }): void {
    const taskId = args.taskId
    if (!taskId) return
    const occurrence = {
      taskId,
      chatId: args.chatId,
      turnId: args.turnId,
      turn: args.turn,
    }
    if (!this.studyMemoryStore || !args.plan?.staticPayload || !args.projectId) {
      this.noteStudyMemoryQualityFlag(this.staticFocusFailure(occurrence, "static_focus_persistence_failed"))
      this.reportBackgroundError?.(
        `[study-static-focus] chat ${args.chatId} turn ${args.turn}: Static measurement is unavailable`,
      )
      return
    }
    let pending: PendingStaticFocusDelivery
    try {
      pending = reserveDeliveredStaticFocus({
        store: this.studyMemoryStore,
        taskId,
        namespace: args.projectId,
        chatId: args.chatId,
        turnId: args.turnId,
        turn: args.turn,
        promptText: args.promptText,
        payload: args.plan.staticPayload,
      })
    } catch (error) {
      this.noteStudyMemoryQualityFlag(this.staticFocusFailure(occurrence, "static_focus_persistence_failed"))
      this.reportBackgroundError?.(
        `[study-static-focus] chat ${args.chatId} turn ${args.turn}: could not reserve delivery: ${error instanceof Error ? error.message : String(error)}`,
      )
      return
    }
    if (!this.staticMemoryExtractor) {
      this.noteStudyMemoryQualityFlag(this.staticFocusFailure(pending, "static_extraction_failed"))
      this.reportBackgroundError?.(
        `[study-static-focus] chat ${args.chatId} turn ${args.turn}: Static extractor is unavailable`,
      )
      return
    }
    this.enqueuePendingStaticFocus(pending)
  }

  private async runPostTurnMemoryPasses(
    args: PostTurnMemoryPassArgs & {
      onStudyMeasurementSettled?: (flags: StudyMemoryQualityFlag[]) => void
    },
  ) {
    if (!this.memory || (!args.userText.trim() && !args.assistantText.trim())) {
      args.onStudyMeasurementSettled?.([])
      return
    }

    const qualityFlag = (
      code: StudyMemoryQualityFlag["code"],
    ): StudyMemoryQualityFlag | null => args.taskId
      ? {
          code,
          blocking: code === "focus_persistence_failed" || code === "static_extraction_failed",
          taskId: args.taskId,
          chatId: args.chatId,
          turnId: args.turnId,
          ...(args.turnNumber !== undefined ? { turn: args.turnNumber } : {}),
        }
      : null


    const capturePass = async (): Promise<StudyMemoryQualityFlag[]> => {


      if (this.memoryBranches) return []
      if (!this.capture) return []
      try {
        const captureInput = {
          projectId: args.projectId,
          sessionId: args.chatId,
          turn: args.turnNumber,
          engine: args.engine,
          ...(this.policy.studyMode && this.policy.condition === "auto" && args.engine === "claude"
            ? { profile: "auto-project-copy" as const }
            : {}),
          userText: args.userText,
          assistantText: args.assistantText,
        }


        let outcome: CaptureOutcome | null = null
        if (
          args.engine === "claude" &&
          args.claudeSessionToken &&
          args.localPath &&
          process.env.MEMOSYNC_CAPTURE_FORK !== "0"
        ) {
          const raw = await this.forkCaptureFn({
            sessionToken: args.claudeSessionToken,
            localPath: args.localPath,
            profile:
              this.policy.studyMode && this.policy.condition === "auto"
                ? "auto-project-copy"
                : "review",
          })
          if (raw && this.capture.captureFromExtraction) {
            try {
              outcome = await this.capture.captureFromExtraction(raw, captureInput)
            } catch {
              outcome = null
            }
          }
        }
        if (!outcome) outcome = await this.capture.capture(captureInput)
        if (outcome.created.length) {
          const autoIds = this.autoApplyProposals(outcome.created, args)


          const autoApplied = outcome.created.filter(({ id }) => autoIds.has(id))
          if (autoApplied.length) {
            await this.store.appendMessage(
              args.chatId,
              timestamped({
                kind: "memory_candidates",
                turn: args.turnNumber,


                candidates: autoApplied.map(({ id }) => ({ id, auto: true })),
              })
            )
          }
          this.emitStateChange(args.chatId)
        }
        return []
      } catch (error) {
        this.reportBackgroundError?.(
          `[memory-capture] chat ${args.chatId} turn ${args.turnNumber ?? "?"}: ${error instanceof Error ? error.message : String(error)}`
        )
        const flag = qualityFlag("capture_failed")
        return flag ? [flag] : []
      }
    }

    const tracePass = async (): Promise<StudyMemoryQualityFlag[]> => {
      if ((!this.memoryTrace && !this.memoryBranches) || args.memoryDisabled) return []
      try {


        const usedIds = [...new Set([...args.injectedIds, ...args.citedIds])]
        const injectedById = new Map((args.injectedMemories ?? []).map(item => [item.id, item]))
        const usedMemories = usedIds
          .map((id) => injectedById.get(id) ?? this.memory!.store.getById(id))
          .filter((m): m is MemoryItem => Boolean(m && m.status === "active"))
        if (usedMemories.length) {


          await this.store.appendMessage(
            args.chatId,
            timestamped({ kind: "memory_trace", turn: args.turnNumber, status: "pending", labels: [] })
          )
          this.emitStateChange(args.chatId)
          const usedById = new Map(usedMemories.map((m) => [m.id, m]))


          let outcome: TraceOutcome | null = null
          let tracedVia: "fork" | "sidecar" = "sidecar"
          if (this.memoryBranches) {
            const chat = this.store.requireChat(args.chatId)
            const provider = args.engine as AgentProvider
            const settings = { ...this.getProviderSettings(provider, { model: args.model, effort: args.effort }), serviceTier: args.serviceTier }
            const branch = this.newMemoryBranch({ chatId: args.chatId, provider, ...settings }, "audit", args.sessionToken ?? args.claudeSessionToken ?? chat.sessionToken)
            const auditInput = { usedMemories, assistantText: args.assistantText, executionText: args.executionText, executionTools: args.executionTools, task: args.userText, expectedUses: args.expectedUses }
            try {
              const raw = await branch.ask(buildAuditBranchPrompt(auditInput), { schema: memoryStageSchema("audit") })
              try {
                outcome = parseAuditBranchResult(raw, auditInput)
              } catch (error) {
                if (!(error instanceof MemoryBranchResultError)) throw error
                const repaired = await branch.ask([
                  `The audit response did not satisfy its required format: ${error.message}`,
                  "Correct only the structured response using the evidence and analysis already in this conversation. Do not inspect more files or run a new analysis.",
                  "Return every supplied memory ID exactly once. not_applicable requires a separate missing field; violated requires cause and impact. Use null for optional fields with no evidence. Never invent a verdict or evidence to fill a field.",
                ].join("\n\n"), { schema: memoryStageSchema("audit"), budget: { maxTurns: 2, maxToolCalls: 0 } })
                outcome = parseAuditBranchResult(repaired, auditInput)
              }
              tracedVia = "fork"
            } finally { branch.dispose() }
          }
          if (
            !this.memoryBranches &&
            args.engine === "claude" &&
            args.claudeSessionToken &&
            args.localPath &&
            process.env.MEMOSYNC_TRACE_FORK !== "0"
          ) {
            const raw = await this.forkTraceFn({
              sessionToken: args.claudeSessionToken,
              localPath: args.localPath,
              usedMemories,
            })
            if (raw) {
              outcome = coerceTraceOutcome(raw, { usedMemories, assistantText: args.assistantText })
              tracedVia = "fork"
            }
          }
          if (!outcome) {
            outcome = await this.memoryTrace!.trace({
              sessionId: args.chatId,
              engine: args.engine,
              turn: args.turnNumber,
              userText: args.userText,
              assistantText: args.assistantText,
              usedMemories,
            })
          }


          const labels = outcome.labels.filter((l) => {
            const now = this.memory!.store.getById(l.id)
            const snap = usedById.get(l.id)
            return Boolean(now && snap && now.status === "active" && now.version === snap.version && now.content === snap.content && now.detail === snap.detail)
          })
          const droppedIds = new Set(outcome.labels.map((l) => l.id).filter((id) => !labels.some((l) => l.id === id)))
          const summary =
            outcome.summary && droppedIds.size
              ? outcome.summary.replace(/\[(M-\d+)\]/g, (whole, id: string) => (droppedIds.has(id) ? id : whole))
              : outcome.summary
          if (labels.length) {


            const citedSet = new Set(args.citedIds)
            const labelsWithSource = labels.map((l) => ({ ...l, ...(citedSet.has(l.id) ? { cited: true } : {}) }))
            await this.store.appendMessage(
              args.chatId,
              timestamped({
                kind: "memory_trace",
                turn: args.turnNumber,
                status: "ok",
                labels: labelsWithSource,
                summary,
                ...(droppedIds.size ? { dropped: droppedIds.size } : {}),
              })
            )
            this.memory!.logger.event({
              type: "memory.trace",
              sessionId: args.chatId,
              engine: args.engine,
              turn: args.turnNumber,
              status: "ok",
              via: tracedVia,
              labels: labels.map(({ id, label }) => ({ id, label })),
              ...(droppedIds.size ? { dropped: droppedIds.size } : {}),
            })


            const cited = new Set(args.citedIds)
            for (const l of labels) {
              this.memory!.store.recordTraceLabel(l.id, l.label, { actor: "agent", sessionId: args.chatId, turn: args.turnNumber })
              if (l.label !== "operational" || cited.has(l.id)) continue
              this.memory!.store.recordUse(l.id, { actor: "agent", sessionId: args.chatId, via: "trace_operational" })
            }
            this.emitStateChange(args.chatId)


            if (this.memoryRevision) {
              try {
                const proposals = await this.memoryRevision.scanAndPropose({
                  sessionId: args.chatId,
                  engine: args.engine,
                  turn: args.turnNumber,
                  labels: labels.map((l) => ({ id: l.id, label: l.label })),
                })
                if (proposals.length) {
                  const autoIds = this.autoApplyProposals(proposals, args)


                  const autoApplied = proposals.filter(({ id }) => autoIds.has(id))
                  if (autoApplied.length) {
                    await this.store.appendMessage(
                      args.chatId,
                      timestamped({
                        kind: "memory_candidates",
                        turn: args.turnNumber,
                        candidates: autoApplied.map(({ id }) => ({ id, auto: true })),
                      })
                    )
                  }
                  this.emitStateChange(args.chatId)
                }
              } catch (error) {
                this.reportBackgroundError?.(
                  `[memory-revision] chat ${args.chatId} turn ${args.turnNumber ?? "?"}: ${error instanceof Error ? error.message : String(error)}`
                )
              }
            }
          } else {
            await this.store.appendMessage(
              args.chatId,
              timestamped({
                kind: "memory_trace",
                turn: args.turnNumber,
                status: "discarded",
                labels: [],
                dropped: droppedIds.size || usedMemories.length,
              })
            )
            this.memory!.logger.event({
              type: "memory.trace",
              sessionId: args.chatId,
              engine: args.engine,
              turn: args.turnNumber,
              status: "discarded",
              stage: "cas",
              labels: [],
              dropped: droppedIds.size || usedMemories.length,
            })
            this.emitStateChange(args.chatId)
          }
        } else if (usedIds.length) {
          await this.store.appendMessage(
            args.chatId,
            timestamped({
              kind: "memory_trace",
              turn: args.turnNumber,
              status: "discarded",
              labels: [],
              dropped: usedIds.length,
            })
          )
          this.memory!.logger.event({
            type: "memory.trace",
            sessionId: args.chatId,
            engine: args.engine,
            turn: args.turnNumber,
            status: "discarded",
            stage: "cas",
            labels: [],
            dropped: usedIds.length,
          })
          this.emitStateChange(args.chatId)
        } else {


          await this.store.appendMessage(
            args.chatId,
            timestamped({
              kind: "memory_trace",
              turn: args.turnNumber,
              status: "empty",
              labels: [],
            })
          )
          this.memory!.logger.event({
            type: "memory.trace",
            sessionId: args.chatId,
            engine: args.engine,
            turn: args.turnNumber,
            status: "empty",
            labels: [],
          })
          this.emitStateChange(args.chatId)
        }
        return []
      } catch (error) {
        const errorClass = error instanceof Error ? error.name || "Error" : "Error"
        try {
          await this.store.appendMessage(
            args.chatId,
            timestamped({
              kind: "memory_trace",
              turn: args.turnNumber,
              status: "failed",
              labels: [],
              errorClass,
            })
          )
          this.emitStateChange(args.chatId)
        } catch (persistError) {
          this.reportBackgroundError?.(
            `[memory-trace] chat ${args.chatId} turn ${args.turnNumber ?? "?"}: failed to persist terminal: ${persistError instanceof Error ? persistError.message : String(persistError)}`
          )
        }
        this.memory!.logger.event({
          type: "memory.trace",
          sessionId: args.chatId,
          engine: args.engine,
          turn: args.turnNumber,
          status: "failed",
          stage: "trace_pass",
          labels: [],
          errorClass,
        })
        this.reportBackgroundError?.(
          `[memory-trace] chat ${args.chatId} turn ${args.turnNumber ?? "?"}: ${error instanceof Error ? error.message : String(error)}`
        )
        const flag = qualityFlag("trace_failed")
        return flag ? [flag] : []
      }
    }

    const qualityFlags = (await Promise.all([capturePass(), tracePass()])).flat()
    args.onStudyMeasurementSettled?.(qualityFlags)
    if (this.memoryBranches) return

    const precomputeCheckup = async () => {


      if (this.memoryCheckup && this.policy.capture === "review") {
        try {
          const checkupCtx = { projectId: args.projectId, sessionId: args.chatId }
          if (this.memoryCheckup.needsRecompute(checkupCtx)) {
            let primed = false
            if (
              args.engine === "claude" &&
              args.claudeSessionToken &&
              args.localPath &&
              process.env.MEMOSYNC_CHECKUP_FORK !== "0" &&
              this.memoryCheckup.buildForkPrompt &&
              this.memoryCheckup.primeFromForkResult
            ) {
              const request = this.memoryCheckup.buildForkPrompt(checkupCtx)
              if (request) {
                const raw = await this.forkQueryFn({
                  sessionToken: args.claudeSessionToken,
                  localPath: args.localPath,
                  prompt: request.prompt,
                })
                if (
                  raw &&
                  (await this.memoryCheckup.primeFromForkResult(checkupCtx, request.dependencyKey, raw))
                ) primed = true
              }
            }
            if (!primed) await this.memoryCheckup.run(checkupCtx)
          }
        } catch (error) {
          this.reportBackgroundError?.(
            `[memory-checkup-prewarm] chat ${args.chatId} turn ${args.turnNumber ?? "?"}: ${error instanceof Error ? error.message : String(error)}`,
          )
        }
      }
    }

    const prepareTransferSources = async () => {


      if (this.memoryTransferDetect && this.policy.capture === "review") {
        try {
          await this.memoryTransferDetect.prepareSources({
            projectId: args.projectId,
            sessionId: args.chatId,
            projectTitle: args.projectId ? this.store.getProject(args.projectId)?.title : undefined,
          })
        } catch (error) {
          this.reportBackgroundError?.(
            `[memory-transfer-prepare] chat ${args.chatId} turn ${args.turnNumber ?? "?"}: ${error instanceof Error ? error.message : String(error)}`,
          )
        }
      }
    }


    await Promise.all([precomputeCheckup(), prepareTransferSources()])
  }

  setBackgroundErrorReporter(report: ((message: string) => void) | null) {
    this.reportBackgroundError = report
  }


  studyFreezeBlocker(): string | null {
    if (
      this.startingChats.size > 0
      || this.pendingAutoCaptureStarts.size > 0
      || this.activeTurns.size > 0
      || this.pendingPreviews.size > 0
      || this.claimedPreviewResponses.size > 0
      || this.pendingProposalGates.size > 0
      || this.pendingCheckupGates.size > 0
      || this.pendingTransferGates.size > 0
      || this.activePreparations.size > 0
      || this.inFlightCheckups.size > 0
    ) {
      return "The agent is still working or waiting for a memory decision. Finish or stop that turn first."
    }
    if (this.store.getChatIdsWithQueuedMessages().length > 0) {
      return "A queued message still belongs to this session. Let it finish or remove it first."
    }
    return null
  }


  studyTaskRunEvidence(taskId: string): {
    participantPromptCount: number
    completedAgentTurnCount: number
    unresolvedMemoryInterruptCount: number
  } {
    const promptEvents = (this.studyMemoryStore?.listStudyTelemetryEvents() ?? [])
      .filter((event) => event.kind === "participant_prompt" && event.taskId !== null)
    const promptTaskByTurnId = new Map<string, string>()
    for (const event of promptEvents) {
      const payloadTurnId = typeof event.payload.turnId === "string" ? event.payload.turnId : null
      const fallbackTurnId = event.eventId.split(":").at(-1) ?? null
      const turnId = payloadTurnId?.trim() || fallbackTurnId?.trim()
      if (turnId) promptTaskByTurnId.set(turnId, event.taskId!)
    }

    let completedAgentTurnCount = 0
    const interruptTaskById = new Map<string, string>()
    const resolvedInterruptIds = new Set<string>()
    const chatIds = new Set(promptEvents.map((event) => event.chatId).filter((id): id is string => Boolean(id)))
    for (const chatId of chatIds) {
      let currentTaskId: string | null = null
      let countedSuccessForPrompt = false
      for (const entry of this.store.getMessages(chatId)) {
        if (entry.kind === "user_prompt") {


          currentTaskId = promptTaskByTurnId.get(entry._id) ?? interruptTaskById.get(entry._id) ?? null
          countedSuccessForPrompt = false
          continue
        }
        if (
          entry.kind === "result"
          && entry.subtype === "success"
          && !entry.isError
          && currentTaskId === taskId
          && !countedSuccessForPrompt
        ) {
          completedAgentTurnCount += 1
          countedSuccessForPrompt = true
          continue
        }
        if (entry.kind === "memory_interrupt" && currentTaskId) {
          interruptTaskById.set(entry.interruptId, currentTaskId)
        } else if (entry.kind === "memory_interrupt_resolution") {
          resolvedInterruptIds.add(entry.interruptId)
        }
      }
    }

    return {
      participantPromptCount: promptEvents.filter((event) => event.taskId === taskId).length,
      completedAgentTurnCount,
      unresolvedMemoryInterruptCount: [...interruptTaskById]
        .filter(([interruptId, ownerTaskId]) => ownerTaskId === taskId && !resolvedInterruptIds.has(interruptId))
        .length,
    }
  }


  async awaitStudyMemorySettled(taskId: string): Promise<StudyMemoryQualityFlag[]> {


    this.resumePendingStaticFocusMaterializations(taskId)
    while (true) {
      const pending = [...this.inFlightStudyMemoryJobs]
        .filter((job) => job.taskId === taskId)
        .map((job) => job.promise)
      if (pending.length === 0) {
        for (const pendingClear of [...this.pendingStudyMemoryQualityClears.values()]) {
          if (pendingClear.taskId !== taskId) continue
          this.clearStudyMemoryQualityFlag(pendingClear)
        }
        const flags = [...(this.studyMemoryQualityByTask.get(taskId) ?? [])]


        for (const flag of flags) this.noteStudyMemoryQualityFlag(flag)
        for (const durable of this.studyMemoryStore?.listStudyMemoryQualityFlags(taskId) ?? []) {
          if (flags.some((flag) => (
            flag.code === durable.code
            && flag.chatId === durable.chatId
            && flag.turnId === durable.turnId
          ))) continue
          flags.push(durable as StudyMemoryQualityFlag)
        }
        for (const delivery of this.studyMemoryStore?.listPendingStaticFocusDeliveries({ taskId }) ?? []) {
          if (flags.some((flag) => (
            flag.blocking
            && flag.chatId === delivery.chatId
            && flag.turnId === delivery.turnId
          ))) continue
          flags.push(this.staticFocusFailure(delivery, "static_focus_pending"))
        }
        return flags
      }
      await Promise.all(pending)
    }
  }

  getActiveStatuses() {
    const statuses = new Map<string, ChatActivityStatus>()


    for (const [chatId, status] of this.startingChats.entries()) {
      statuses.set(chatId, status)
    }
    for (const chatId of this.pendingAutoCaptureStarts.keys()) {
      statuses.set(chatId, "starting")
    }
    for (const [chatId, turn] of this.activeTurns.entries()) {
      statuses.set(chatId, turn.status)
    }
    return statuses
  }

  getPendingTool(chatId: string): PendingToolSnapshot | null {
    const pending = this.activeTurns.get(chatId)?.pendingTool
    if (!pending) return null
    return { toolUseId: pending.toolUseId, toolKind: pending.tool.toolKind }
  }

  getDrainingChatIds(): Set<string> {
    return new Set(this.drainingStreams.keys())
  }

  getStreamingAssistantTexts(): Map<string, string> {
    const texts = new Map<string, string>()
    for (const [chatId, buffer] of this.streamingAssistantTexts.entries()) {
      if (buffer.text) texts.set(chatId, buffer.text)
    }
    return texts
  }


  private appendAssistantDelta(chatId: string, event: HarnessEvent) {
    if (!event.delta) return
    const itemId = event.itemId ?? ""
    const current = this.streamingAssistantTexts.get(chatId)
    this.streamingAssistantTexts.set(chatId, {
      itemId,

      text: current && current.itemId === itemId ? current.text + event.delta : event.delta,
    })
    this.emitStateChange(chatId)
  }

  private clearStreamingAssistantText(chatId: string) {
    this.streamingAssistantTexts.delete(chatId)
  }

  private emitStateChange(chatId?: string, options?: { immediate?: boolean }) {
    this.onStateChange(chatId, options)
  }

  private refreshClaudeModelCatalog(session: ClaudeSessionHandle) {
    if (!session.supportedModels) return
    void session.supportedModels()
      .then((models) => {
        if (applyClaudeSdkModels(models)) {
          this.emitStateChange(undefined, { immediate: true })
        }
      })
      .catch((error) => {
        const message = error instanceof Error ? error.message : String(error)
        this.reportBackgroundError?.(`[claude-models] failed to refresh Claude model catalog: ${message}`)
      })
  }

  getActiveTurnProfile(chatId: string): SendToStartingProfile | null {
    const active = this.activeTurns.get(chatId)
    if (!active?.clientTraceId || active.profilingStartedAt === undefined) {
      return null
    }

    return {
      traceId: active.clientTraceId,
      startedAt: active.profilingStartedAt,
    }
  }

  async stopDraining(chatId: string) {
    const draining = this.drainingStreams.get(chatId)
    if (!draining) return
    draining.turn.close()
    this.drainingStreams.delete(chatId)
    this.emitStateChange(chatId)
  }

  async closeChat(chatId: string) {
    await this.stopDraining(chatId)
    const claudeSession = this.claudeSessions.get(chatId)
    if (claudeSession) {
      await this.retireClaudeSession(claudeSession, "chat_closed")
    }
    this.emitStateChange(chatId)
  }


  handleBoardBacklogInvalidated(input: { kind: "transfer" | "checkup"; chatId: string; gateId: string }) {
    if (input.kind === "transfer") {
      const pending = this.pendingTransferGates.get(input.chatId)
      if (pending?.transferId === input.gateId) pending.invalidate()
    } else {
      const pending = this.pendingCheckupGates.get(input.chatId)
      if (pending?.checkupId === input.gateId) pending.invalidate()
    }
    this.emitStateChange(input.chatId, { immediate: true })
  }


  private async prepareStudyProjectRuntime(projectPath: string) {
    if (!this.studyPreviewRuntime) return
    const oldSessions = [...this.claudeSessions.values()].filter((session) => session.localPath !== projectPath)
    await Promise.all(oldSessions.map((session) => this.retireClaudeSession(session, "study_project_switch")))
    await this.studyPreviewRuntime.ensure(projectPath)
    const taskId = this.getActiveStudyTaskId()
    if (taskId) {
      const taskPaths = this.studyTaskProjectPaths.get(taskId) ?? new Set<string>()
      taskPaths.add(projectPath)
      this.studyTaskProjectPaths.set(taskId, taskPaths)
    }
  }


  async retireStudyTaskRuntime(taskId: string) {
    const chatIds = this.studyTaskChats.get(taskId) ?? new Set<string>()
    const sessions = [...chatIds]
      .map((chatId) => this.claudeSessions.get(chatId))
      .filter((session): session is ClaudeSessionState => Boolean(session))
    await Promise.all(sessions.map((session) => this.retireClaudeSession(session, `study_task_freeze:${taskId}`)))
    for (const projectPath of this.studyTaskProjectPaths.get(taskId) ?? []) {
      await this.studyPreviewRuntime?.stop(projectPath)
    }
  }

  async shutdownStudyRuntime() {
    for (const chatId of new Set([...this.branchPreparations.keys(), ...this.workingBranches.keys()])) this.disposeMemoryBranches(chatId)
    await Promise.all(
      [...this.claudeSessions.values()].map((session) => this.retireClaudeSession(session, "server_shutdown")),
    )
    await this.studyPreviewRuntime?.stop()
  }

  private async retireClaudeSession(session: ClaudeSessionState, reason: string) {
    if (!session.retired) {
      session.retired = true
      session.retireReason = reason
      this.clearStreamingAssistantText(session.chatId)
      session.session.close()
    }
    if (!session.pump) return
    let timer: ReturnType<typeof setTimeout> | undefined
    const drained = await Promise.race([
      session.pump.then(() => true),
      new Promise<false>((resolveTimeout) => {
        timer = setTimeout(() => resolveTimeout(false), this.claudeRetireTimeoutMs)
      }),
    ])
    if (timer) clearTimeout(timer)
    if (!drained) {
      const message = `[claude-retire-timeout] query pump for chat ${session.chatId} did not close within ${this.claudeRetireTimeoutMs}ms after ${reason}; refusing to replace the preview while the retired CLI may still mutate the workspace`
      this.reportBackgroundError?.(message)
      throw new Error(message)
    }
    if (this.claudeSessions.get(session.chatId) === session) {
      this.claudeSessions.delete(session.chatId)
    }
  }

  private resolveProvider(options: SendMessageOptions, currentProvider: AgentProvider | null) {
    if (currentProvider) return currentProvider
    return options.provider ?? "claude"
  }

  private getProviderSettings(provider: AgentProvider, options: SendMessageOptions) {
    const catalog = getServerProviderCatalog(provider)
    if (provider === "claude") {
      const model = normalizeServerModel(provider, options.model)
      const modelOptions = normalizeClaudeModelOptions(model, options.modelOptions, options.effort)
      return {
        model: resolveClaudeApiModelId(model, modelOptions.contextWindow),
        effort: modelOptions.reasoningEffort,
        serviceTier: undefined,
        planMode: catalog.supportsPlanMode ? Boolean(options.planMode) : false,
      }
    }

    const modelOptions = normalizeCodexModelOptions(options.modelOptions, options.effort)
    return {
      model: normalizeServerModel(provider, options.model),
      effort: modelOptions.reasoningEffort,
      serviceTier: codexServiceTierFromModelOptions(modelOptions),
      planMode: catalog.supportsPlanMode ? Boolean(options.planMode) : false,
    }
  }

  private assertStudyPromptAllowed(input: StudyPromptGateInput): void {
    const refusal = this.studyPromptGate?.(input)
    if (refusal) throw new Error(refusal)
  }

  private async enqueueMessage(
    chatId: string,
    content: string,
    attachments: ChatAttachment[],
    options?: SendMessageOptions,
    channel: "chat.send" | "message.enqueue" = "chat.send",
  ) {
    this.assertStudyPromptAllowed({ chatId, content, channel, attachments })
    const queued = await this.store.enqueueMessage(chatId, {
      content,
      attachments,
      provider: options?.provider,
      model: options?.model,
      modelOptions: options?.modelOptions,
      planMode: options?.planMode,
    })
    this.emitStateChange(chatId)
    return queued
  }

  private async dequeueAndStartQueuedMessage(
    chatId: string,
    queuedMessage: QueuedChatMessage,
    options?: {
      steered?: boolean
      deferredAutoStart?: DeferredAutoStartGuard
    },
  ): Promise<"started" | "cancelled" | "missing"> {
    const deferred = options?.deferredAutoStart
    if (deferred?.signal.aborted) return "cancelled"
    if (!this.store.getQueuedMessage(chatId, queuedMessage.id)) return "missing"
    if (this.isCancelledDeferredQueueRow(chatId, queuedMessage.id)) {
      try {
        await this.store.removeQueuedMessage(chatId, queuedMessage.id)
      } catch (error) {
        if (this.store.getQueuedMessage(chatId, queuedMessage.id)) {
          this.reportBackgroundError?.(
            `[auto-deferred-stop] chat ${chatId}: refused tombstoned queue row: ${error instanceof Error ? error.message : String(error)}`,
          )
        }
      }
      return "cancelled"
    }


    this.assertStudyPromptAllowed({
      chatId,
      content: queuedMessage.content,
      channel: "queue.dispatch",
      attachments: queuedMessage.attachments,
    })
    if (deferred?.signal.aborted) return "cancelled"
    try {
      await this.store.removeQueuedMessage(chatId, queuedMessage.id)
    } catch (error) {


      if (!this.store.getQueuedMessage(chatId, queuedMessage.id)) return "missing"
      throw error
    }
    if (deferred?.signal.aborted) return "cancelled"
    const chat = this.store.requireChat(chatId)
    const provider = this.resolveProvider(queuedMessage, chat.provider)
    const settings = this.getProviderSettings(provider, queuedMessage)
    if (deferred?.signal.aborted) return "cancelled"
    await this.startTurnForChat({
      chatId,
      provider,
      content: options?.steered ? buildSteeredMessageContent(queuedMessage.content) : queuedMessage.content,

      memoryUserText: options?.steered ? queuedMessage.content : undefined,
      attachments: queuedMessage.attachments,
      model: settings.model,
      effort: settings.effort,
      serviceTier: settings.serviceTier,
      planMode: settings.planMode,
      appendUserPrompt: true,
      steered: options?.steered,
      deferredAutoStart: deferred,
    })
    return deferred?.signal.aborted || deferred?.isCommittedCancellationRequested()
      ? "cancelled"
      : "started"
  }


  async drainOrphanedQueues(): Promise<void> {
    for (const chatId of this.store.getChatIdsWithQueuedMessages()) {
      if (
        this.activeTurns.has(chatId)
        || this.hasPendingPreviewActivity(chatId)
        || this.startingChats.has(chatId)
        || this.pendingAutoCaptureStarts.has(chatId)
      ) {
        continue
      }
      try {
        await this.maybeStartNextQueuedMessage(chatId)
      } catch (error) {
        console.error(`[agent] failed to drain queued messages for chat ${chatId} on startup`, error)
      }
    }
  }

  private scheduleOpeningBoardRecovery(taskId: string): void {
    if (this.openingBoardRecoveryRetryTimers.has(taskId)) return
    const attempt = (this.openingBoardRecoveryRetryAttempts.get(taskId) ?? 0) + 1
    if (attempt > 3) return
    this.openingBoardRecoveryRetryAttempts.set(taskId, attempt)
    const delayMs = [100, 500, 1_500][attempt - 1]!
    const timer = setTimeout(() => {
      this.openingBoardRecoveryRetryTimers.delete(taskId)
      if (this.getActiveStudyTaskId() !== taskId) return
      try {
        this.resumeOpeningBoardPreparation()
      } catch (error) {


        this.reportBackgroundError?.(
          `[opening-board-recovery] task ${taskId}: ${error instanceof Error ? error.message : String(error)}`,
        )
      }
    }, delayMs)
    timer.unref?.()
    this.openingBoardRecoveryRetryTimers.set(taskId, timer)
  }


  resumeOpeningBoardPreparation(): void {
    const taskId = this.getActiveStudyTaskId()
    if (
      !taskId
      || !this.openingBoardBacklog
      || !this.policy.studyMode
      || this.policy.condition !== "memosync"
      || this.openingBoardRecoveryTasks.has(taskId)
    ) return
    const opening = this.openingBoardBacklog.recoverOpeningPrompt(taskId)
    if (!opening) return

    this.openingBoardRecoveryTasks.add(taskId)
    const recover = async () => {
      if (opening.attachmentFailure) {
        this.reportBackgroundError?.(
          `[opening-board-attachment] task ${taskId}: ${opening.attachmentFailure}`,
        )
        return
      }


      this.assertStudyPromptAllowed({
        chatId: opening.chatId,
        channel: "chat.send",
        content: opening.content,
        attachments: opening.providerAttachments,
        openingReviewId: opening.reviewId,
        verifiedOpeningSnapshot: true,
      })
      const provider = opening.dispatch?.provider ?? "claude"
      if (provider !== "claude") throw new Error("Opening Memory Board recovery only supports the study Claude provider")
      const settings = this.getProviderSettings(provider, opening.dispatch ?? {})
      if (opening.phase === "completed") {
        const messages = this.store.getMessages(opening.chatId)
        const promptIndex = messages.findIndex(
          (message) => message.kind === "user_prompt" && message._id === opening.reviewId,
        )
        const nextPromptIndex = promptIndex < 0
          ? -1
          : messages.findIndex((message, index) => index > promptIndex && message.kind === "user_prompt")
        const turnEntries = promptIndex < 0
          ? []
          : messages.slice(promptIndex + 1, nextPromptIndex < 0 ? undefined : nextPromptIndex)
        const preview = turnEntries.find(
          (message): message is Extract<TranscriptEntry, { kind: "memory_preview" }> => message.kind === "memory_preview",
        )
        if (preview) {
          const decision = turnEntries.filter(
            (message): message is Extract<TranscriptEntry, { kind: "memory_preview_decision" }> =>
              message.kind === "memory_preview_decision" && message.previewId === preview.previewId,
          ).at(-1)
          if (!decision) {
            this.restoreOpeningWorkingMemoryPreview(opening, settings, preview)
            return
          }
          const terminalResult = turnEntries.some((message) => message.kind === "result")
          if (decision.decision === "dismiss") {
            if (terminalResult) return


            await this.store.appendMessage(
              opening.chatId,
              timestamped({
                kind: "result",
                subtype: "cancelled",
                isError: false,
                durationMs: 0,
                result: "The first prompt was cancelled from Working Memory review.",
              }),
            )
            await this.store.recordTurnCancelled(opening.chatId)
            this.emitStateChange(opening.chatId, { immediate: true })
            return
          }
          if (decision.decision !== "go_on" && decision.decision !== "without_memory") return

          const exactDispatch = {
            taskId: opening.taskId,
            chatId: opening.chatId,
            reviewId: opening.reviewId,
            phase: opening.phase,
            previewId: preview.previewId,
            decision: decision.decision,
          } as const
          let delivered = this.studyMemoryStore?.listTaskDeliveries(opening.taskId).some((delivery) =>
            delivery.chatId === opening.chatId && delivery.turnId === opening.reviewId,
          ) ?? false
          let acceptedWithFailedFocusReceipt = this.studyMemoryStore
            ?.listStudyMemoryQualityFlags(opening.taskId)
            .some((flag) => flag.code === "focus_persistence_failed"
              && flag.chatId === opening.chatId
              && flag.turnId === opening.reviewId) ?? false
          if (opening.providerDispatch?.phase === "delivered" && !delivered && !acceptedWithFailedFocusReceipt) {
            try {
              const focus = opening.providerDispatch.focusDelivery
              const selectedIds = decision.decision === "without_memory"
                ? []
                : [...(decision.selectedIds ?? preview.memories.map((memory) => memory.id))]
              const selected = new Set(selectedIds)
              const previewById = new Map(preview.memories.map((memory) => [memory.id, memory]))
              const focusedIds = focus?.memories.map((memory) => memory.id) ?? []
              const expectedOutcome = decision.decision === "without_memory"
                ? "disabled"
                : selectedIds.length > 0 ? "delivered" : "empty"
              const validFocus = Boolean(
                focus
                && focus.taskId === opening.taskId
                && focus.chatId === opening.chatId
                && focus.sessionId === opening.chatId
                && focus.turnId === opening.reviewId
                && focus.turn === preview.turn
                && focus.engine === "claude"
                && focus.mode === "skills"
                && focus.deliveryStage === "queued_to_claude"
                && focus.outcome === expectedOutcome
                && focusedIds.length === selected.size
                && focusedIds.every((id) => selected.has(id))
                && focus.memories.every((memory) => {
                  const snapshot = previewById.get(memory.id)
                  return snapshot?.content === memory.content
                    && snapshot.scope === memory.scope
                    && memory.sourceRef.kind === "memosync_store"
                }),
              )
              if (!validFocus || !focus || !this.memory) {
                throw new Error("The accepted opening focus receipt is missing or does not match its Working Memory decision")
              }
              persistDeliveredStoreFocusEvent({
                event: focus,
                condition: "memosync",
                logger: this.memory.logger,
                studyStore: this.studyMemoryStore ?? undefined,
              })
              delivered = true
            } catch (error) {
              this.noteStudyMemoryQualityFlag({
                code: "focus_persistence_failed",
                blocking: true,
                taskId: opening.taskId,
                chatId: opening.chatId,
                turnId: opening.reviewId,
                turn: preview.turn,
              })
              acceptedWithFailedFocusReceipt = true
              this.reportBackgroundError?.(
                `[study-focus-recovery] chat ${opening.chatId} turn ${preview.turn}: ${error instanceof Error ? error.message : String(error)}`,
              )
            }
          }
          if (terminalResult) return
          const liveOwner = this.activeTurns.has(opening.chatId) || this.startingChats.has(opening.chatId)
          if (opening.providerDispatch?.phase === "dispatching" && delivered) {
            this.openingBoardBacklog!.settleOpeningProviderDispatch(exactDispatch, "delivered")
          }
          if (
            delivered
            || acceptedWithFailedFocusReceipt
            || opening.providerDispatch?.phase === "delivered"
            || opening.providerDispatch?.phase === "failed"
          ) {


            if (liveOwner) return
            const message = opening.providerDispatch?.phase === "failed"
              ? "The first prompt was not accepted by the provider and could not complete."
              : "The first prompt was accepted, but its reply was interrupted by a server restart. It was not sent again."
            await this.store.appendMessage(
              opening.chatId,
              timestamped({ kind: "result", subtype: "error", isError: true, durationMs: 0, result: message }),
            )
            await this.store.recordTurnFailed(opening.chatId, message)
            this.emitStateChange(opening.chatId, { immediate: true })
            return
          }
          if (opening.providerDispatch?.phase === "dispatching") {


            this.openingBoardBacklog!.settleOpeningProviderDispatch(exactDispatch, "failed")
            const message = "The first prompt could not be safely resumed after provider dispatch was interrupted."
            await this.store.appendMessage(
              opening.chatId,
              timestamped({ kind: "result", subtype: "error", isError: true, durationMs: 0, result: message }),
            )
            await this.store.recordTurnFailed(opening.chatId, message)
            this.emitStateChange(opening.chatId, { immediate: true })
            return
          }
          await this.resumeOpeningWorkingMemoryDecision(opening, settings, preview, decision)
          return
        }
      }
      if (opening.phase === "dispatch_pending") {
        this.openingBoardBacklog!.claimOpeningPromptDispatch(opening)
      }
      const chat = this.store.getChat(opening.chatId)
      if (!chat) throw new Error("The opening Memory Board chat no longer exists")
      await this.startTurnForChat({
        chatId: opening.chatId,
        provider,
        content: opening.content,
        attachments: opening.attachments,
        providerAttachments: opening.providerAttachments,
        model: settings.model,
        effort: settings.effort,
        serviceTier: settings.serviceTier,
        planMode: settings.planMode,
        appendUserPrompt: true,
        turnId: opening.reviewId,
        openingReview: { taskId: opening.taskId, reviewId: opening.reviewId },
        openingLongTermAlreadyReady: opening.phase === "long_term_ready" || opening.phase === "completed",
        openingLongTermRevision: opening.longTermRevision ?? 0,
      })
    }
    void recover()
      .catch((error) => {
        this.reportBackgroundError?.(
          `[opening-board-recovery] task ${taskId}: ${error instanceof Error ? error.message : String(error)}`,
        )
        this.scheduleOpeningBoardRecovery(taskId)
      })
      .finally(() => this.openingBoardRecoveryTasks.delete(taskId))
  }

  private restoreOpeningWorkingMemoryPreview(
    opening: MemoryBoardOpeningPromptRecovery,
    settings: ReturnType<AgentCoordinator["getProviderSettings"]>,
    preview: Extract<TranscriptEntry, { kind: "memory_preview" }>,
  ) {
    if (!this.memory || this.pendingPreviews.has(opening.chatId)) return
    const chat = this.store.requireChat(opening.chatId)
    const project = this.store.getProject(chat.projectId)
    if (!project) throw new Error("The opening Memory Board project no longer exists")
    const memories = preview.memories.map(({ id }) => this.memory!.store.getById(id))
    if (memories.some((memory) => !memory)) {
      throw new Error("The durable Working Memory pool no longer matches the memory store")
    }
    const messages = this.store.getMessages(opening.chatId)
    const expectedUses = messages.filter(
      (message): message is Extract<TranscriptEntry, { kind: "memory_preview_relevance" }> =>
        message.kind === "memory_preview_relevance" && message.previewId === preview.previewId,
    ).at(-1)?.expectedUses ?? []
    const args: StartTurnArgs = {
      chatId: opening.chatId,
      provider: "claude",
      content: opening.content,
      attachments: opening.attachments,
      providerAttachments: opening.providerAttachments,
      model: settings.model,
      effort: settings.effort,
      serviceTier: settings.serviceTier,
      planMode: settings.planMode,
      appendUserPrompt: true,
      turnId: opening.reviewId,
      openingReview: { taskId: opening.taskId, reviewId: opening.reviewId },
      openingLongTermAlreadyReady: true,
    }
    const memoryIds = preview.memories.map(({ id }) => id)
    const pending: PendingMemoryPreview = {
      previewId: preview.previewId,
      revision: 0,
      published: true,
      memoryIds,
      task: preview.task ?? opening.content,
      memories: memories as MemoryItem[],
      expectedUseById: new Map(expectedUses.map((use) => [use.id, use.expectedUse])),
      respond: (decision, selectedIds, authoritativeExpectedUses, controlOperation) => {
        void this.finishMemoryPreview({
          args,
          chat,
          project,
          turnNumber: preview.turn ?? 1,
          previewId: preview.previewId,
          memoryIds,
          decision,
          selectedIds,
          expectedUses: authoritativeExpectedUses,
          controlOperation,
        })
      },
    }
    this.pendingPreviews.set(opening.chatId, pending)
    this.emitStateChange(opening.chatId, { immediate: true })
  }


  private async resumeOpeningWorkingMemoryDecision(
    opening: MemoryBoardOpeningPromptRecovery,
    settings: ReturnType<AgentCoordinator["getProviderSettings"]>,
    preview: Extract<TranscriptEntry, { kind: "memory_preview" }>,
    decision: Extract<TranscriptEntry, { kind: "memory_preview_decision" }>,
  ) {
    if (decision.decision !== "go_on" && decision.decision !== "without_memory") return
    const chat = this.store.requireChat(opening.chatId)
    const project = this.store.getProject(chat.projectId)
    if (!project) throw new Error("The opening Memory Board project no longer exists")
    if (decision.decision === "go_on" && decision.selectedIds) {
      this.turnMemoryRestriction.set(opening.chatId, decision.selectedIds)
    }
    if (decision.decision === "go_on" && decision.expectedUses?.length) {
      this.turnExpectedUses.set(opening.chatId, decision.expectedUses)
    }
    const args: StartTurnArgs = {
      chatId: opening.chatId,
      provider: "claude",
      content: opening.content,
      attachments: opening.attachments,
      providerAttachments: opening.providerAttachments,
      model: settings.model,
      effort: settings.effort,
      serviceTier: settings.serviceTier,
      planMode: settings.planMode,
      appendUserPrompt: true,
      turnId: opening.reviewId,
      openingReview: { taskId: opening.taskId, reviewId: opening.reviewId },
      openingLongTermAlreadyReady: true,
      openingWorkingMemory: { previewId: preview.previewId, decision: decision.decision },
    }
    this.startingChats.set(opening.chatId, "starting")
    try {
      await this.bootEngineTurn(this.refreshOpeningProviderAttachments(args), {
        chat,
        project,
        turnNumber: preview.turn ?? 1,
        memoryDisabledForTurn: decision.decision === "without_memory",
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      await this.store.appendMessage(
        opening.chatId,
        timestamped({ kind: "result", subtype: "error", isError: true, durationMs: 0, result: message }),
      )
      await this.store.recordTurnFailed(opening.chatId, message)
      this.emitStateChange(opening.chatId, { immediate: true })
      throw error
    } finally {
      this.startingChats.delete(opening.chatId)
    }
  }

  private async maybeStartNextQueuedMessage(chatId: string) {
    if (this.activeTurns.has(chatId)) return false
    const nextQueuedMessage = await this.nextDispatchableQueuedMessage(chatId)
    if (!nextQueuedMessage) return false
    const chat = this.store.getChat(chatId)
    const provider = this.resolveProvider(nextQueuedMessage, chat?.provider ?? null)
    if (this.shouldQueueBehindAutoCapture(provider)) {


      this.scheduleAutoCaptureQueueDrain(chatId, nextQueuedMessage.id)
      return true
    }
    await this.dequeueAndStartQueuedMessage(chatId, nextQueuedMessage)
    return true
  }

  private async startTurnForChat(args: StartTurnArgs) {
    const deferred = args.deferredAutoStart
    if (deferred?.signal.aborted) return
    const logicalTurnId = args.turnId ?? crypto.randomUUID()
    args.turnId = logicalTurnId
    logSendToStartingProfile(args.profile, "start_turn.begin", {
      chatId: args.chatId,
      provider: args.provider,
      appendUserPrompt: args.appendUserPrompt,
      planMode: args.planMode,
    })


    const draining = this.drainingStreams.get(args.chatId)
    if (draining) {
      draining.turn.close()
      this.drainingStreams.delete(args.chatId)
    }

    const chat = this.store.requireChat(args.chatId)
    if (this.activeTurns.has(args.chatId) || this.hasPendingPreviewActivity(args.chatId) || this.startingChats.has(args.chatId)) {
      throw new Error("Chat is already running")
    }


    this.startingChats.set(args.chatId, "starting")


    this.turnMemoryRestriction.delete(args.chatId)
    let reservationHandedOff = false
    try {
    if (!chat.provider) {
      await this.store.setChatProvider(args.chatId, args.provider)
      logSendToStartingProfile(args.profile, "start_turn.provider_set", {
        chatId: args.chatId,
        provider: args.provider,
      })
    }
    await this.store.setPlanMode(args.chatId, args.planMode)
    logSendToStartingProfile(args.profile, "start_turn.plan_mode_set", {
      chatId: args.chatId,
      planMode: args.planMode,
    })

    const existingMessages = this.store.getMessages(args.chatId)


    let userPromptEntry = (args.resume || args.openingReview)
      ? existingMessages.find(
          (message): message is Extract<TranscriptEntry, { kind: "user_prompt" }> =>
            message.kind === "user_prompt" && message._id === logicalTurnId,
        )
      : undefined
    const logicalPromptAlreadyAppended = Boolean(userPromptEntry)
    const shouldAppendUserPrompt = args.appendUserPrompt && !logicalPromptAlreadyAppended
    const shouldGenerateTitle = shouldAppendUserPrompt && chat.title === "New Chat" && existingMessages.length === 0
    const optimisticTitle = shouldGenerateTitle ? fallbackTitleFromMessage(args.content) : null

    const turnNumber =
      existingMessages.filter((m) => m.kind === "user_prompt").length + (shouldAppendUserPrompt ? 1 : 0)

    if (optimisticTitle) {
      await this.store.renameChat(args.chatId, optimisticTitle)
      logSendToStartingProfile(args.profile, "start_turn.optimistic_title_set", {
        chatId: args.chatId,
        title: optimisticTitle,
      })
    }

    const project = this.store.getProject(chat.projectId)
    if (!project) {
      throw new Error("Project not found")
    }

    if (this.policy.condition === "auto" && args.provider === "claude") {
      await this.awaitAutoProjectCaptureBarrier()
    }


    if (deferred?.signal.aborted) return

    if (shouldAppendUserPrompt) {
      userPromptEntry = {
        ...timestamped(
          {
            kind: "user_prompt",
            content: args.content,
            participantContent: args.memoryUserText ?? args.content,
            attachments: args.attachments,
            steered: args.steered,
          },
          Date.now(),
        ),
        _id: logicalTurnId,
      } as Extract<TranscriptEntry, { kind: "user_prompt" }>
      const appended = await this.store.appendMessage(
        args.chatId,
        userPromptEntry,
        deferred
          ? { shouldAppend: deferred.authorizeDelivery }
          : undefined,
      )


      if (appended === false) return
      logSendToStartingProfile(args.profile, "start_turn.user_prompt_appended", {
        chatId: args.chatId,
        entryId: userPromptEntry._id,
      })
    }

    const openingIdentity = args.openingReview
      ? { taskId: args.openingReview.taskId, chatId: args.chatId, reviewId: args.openingReview.reviewId }
      : null
    const openingBookkeeping = openingIdentity && this.openingBoardBacklog
      ? this.openingBoardBacklog.openingPromptBookkeeping(openingIdentity)
      : null
    const openingPromptIndex = userPromptEntry
      ? existingMessages.findIndex((message) => message._id === userPromptEntry?._id)
      : -1
    const hasDurableOpeningProgress = openingPromptIndex >= 0
      && existingMessages.some((_message, index) => index > openingPromptIndex)
    const shouldReconcileOpeningPrompt = Boolean(
      logicalPromptAlreadyAppended
      && openingIdentity
      && !args.openingLongTermAlreadyReady
      && !hasDurableOpeningProgress,
    )
    if (userPromptEntry && (shouldAppendUserPrompt || (
      shouldReconcileOpeningPrompt && !openingBookkeeping?.participantPromptRecorded
    ))) {
      const telemetryTaskId = this.onParticipantPromptRecorded ? this.getActiveStudyTaskId() : null
      if (this.onParticipantPromptRecorded && telemetryTaskId) {
        const telemetryInput = {
          taskId: telemetryTaskId,
          turnId: logicalTurnId,
          chatId: args.chatId,
          content: userPromptEntry.participantContent ?? userPromptEntry.content,
          attachments: userPromptEntry.attachments ?? [],
          acceptedAt: new Date(userPromptEntry.createdAt).toISOString(),
        }
        const persist = () => {
          try {
            this.onParticipantPromptRecorded?.(telemetryInput)
            if (openingIdentity) {
              this.openingBoardBacklog?.markOpeningPromptBookkeeping(openingIdentity, {
                participantPromptRecorded: true,
              })
            }
          } catch (error) {


            this.reportBackgroundError?.(
              `[study-telemetry] prompt ${logicalTurnId}: ${error instanceof Error ? error.message : String(error)}`,
            )
            setTimeout(persist, 1_000)
          }
        }
        persist()
      }
    }
    if (!logicalPromptAlreadyAppended || (
      shouldReconcileOpeningPrompt && !openingBookkeeping?.turnStarted
    )) {
      await this.store.recordTurnStarted(args.chatId)
      if (openingIdentity) {
        this.openingBoardBacklog?.markOpeningPromptBookkeeping(openingIdentity, { turnStarted: true })
      }
      deferred?.markTurnStarted()
      logSendToStartingProfile(args.profile, "start_turn.turn_started_recorded", {
        chatId: args.chatId,
      })
    }


    if (deferred?.isCommittedCancellationRequested()) return

    if (shouldGenerateTitle) {
      void this.generateTitleInBackground(args.chatId, args.content, project.localPath, optimisticTitle ?? "New Chat")
    }

    if (deferred?.signal.aborted || deferred?.isCommittedCancellationRequested()) return


    const previewSettings = this.getMemoryPreviewSettings()


    if (this.memoryPreview && this.memory && args.appendUserPrompt && previewSettings.enabled && !args.resume) {

      const plan = planMemoryInjection({
        policy: this.policy,
        provider: args.provider,
        memory: this.memory,
        projectId: chat.projectId,
        chatId: args.chatId,
        workspaceDir: project.localPath,
      })


      if (plan.mode !== "file") {


        this.startingChats.set(args.chatId, "previewing_memory")
        this.emitStateChange(args.chatId, { immediate: true })
        reservationHandedOff = true
        void this.runPreviewGateThenBoot(args, { chat, project, turnNumber, injected: plan.injectedMemories })
        return
      }
    }

    if (deferred?.signal.aborted || deferred?.isCommittedCancellationRequested()) return
    await this.bootEngineTurn(args, { chat, project, turnNumber, memoryDisabledForTurn: false })
    } finally {


      if (!reservationHandedOff) this.startingChats.delete(args.chatId)
    }
  }


  private async runProposalsGate(
    args: StartTurnArgs,
    ctx: { project: NonNullable<ReturnType<EventStore["getProject"]>>; turnNumber: number },
    options?: { proposalsId?: string; recompute?: boolean },
  ): Promise<{ decision: "none" | "reviewed" | "skipped" | "cancelled"; proposalsId: string }> {
    const existingMessages = args.openingReview ? this.store.getMessages(args.chatId) : []
    const existingParent = existingMessages.filter(
      (message): message is Extract<TranscriptEntry, { kind: "memory_proposals" }> =>
        message.kind === "memory_proposals" && message.openingReviewId === args.openingReview?.reviewId,
    ).at(-1)
    const proposalsId = options?.proposalsId ?? existingParent?.proposalsId ?? crypto.randomUUID()
    if (existingParent && !options?.recompute) {
      const existingDecision = existingMessages.filter(
        (message): message is Extract<TranscriptEntry, { kind: "memory_proposals_decision" }> =>
          message.kind === "memory_proposals_decision" && message.proposalsId === proposalsId,
      ).at(-1)?.decision
      if (existingDecision === "reviewed" || existingDecision === "skipped" || existingDecision === "cancelled") {
        return { decision: existingDecision, proposalsId }
      }
      if (existingDecision === "empty") return { decision: "none", proposalsId }
      if (existingDecision === "expired") return { decision: "cancelled", proposalsId }

      const existingResult = existingMessages.filter(
        (message): message is Extract<TranscriptEntry, { kind: "memory_proposals_result" }> =>
          message.kind === "memory_proposals_result" && message.proposalsId === proposalsId,
      ).at(-1)
      if (existingResult) {
        if (existingResult.candidates.length === 0) {
          await this.store.appendMessage(
            args.chatId,
            timestamped({ kind: "memory_proposals_decision", proposalsId, decision: "empty" }),
          )
          this.memory!.logger.event({
            type: "memory.proposals",
            sessionId: args.chatId,
            engine: args.provider,
            turn: ctx.turnNumber,
            count: 0,
            decision: "empty",
          })
          return { decision: "none", proposalsId }
        }
        const decision = await this.parkExistingProposalsGate(args, ctx, proposalsId)
        return { decision, proposalsId }
      }
    }
    const prep = this.activePreparations.get(args.chatId)
    if (prep) prep.proposalsId = proposalsId


    if (!existingParent) {
      await this.store.appendMessage(
        args.chatId,
        timestamped({
          kind: "memory_proposals",
          proposalsId,
          openingReviewId: args.openingReview?.reviewId,
          turn: ctx.turnNumber,
          pending: true,
          candidates: [],
        }),
      )
      this.emitStateChange(args.chatId, { immediate: true })
    }


    if (!prep?.cancellation.signal.aborted) {
      const captureInput = {
        projectId: ctx.project.id,
        sessionId: args.chatId,
        turn: ctx.turnNumber,
        engine: args.provider,
        userText: args.memoryUserText ?? args.content,
        signal: prep?.cancellation.signal,
      }
      const branches = this.branchPreparations.get(args.chatId)
      const captureTask = (branches
        ? branches.pipeline.result("candidate").then(result => this.capture!.captureFromBranch!(result.raw, captureInput, result.dependencyKey))
        : this.capture!.captureFromPrompt(captureInput)).then(
        () => ({ kind: "done" as const }),
        (error: unknown) => ({ kind: "error" as const, error }),
      )
      const captureOutcome = prep
        ? await Promise.race([
            captureTask,
            prep.cancellation.requested.then(() => ({ kind: "cancelled" as const })),
          ])
        : await captureTask
      if (captureOutcome.kind === "error") {
        const error = captureOutcome.error
        if (this.memoryBranches) throw error
        this.reportBackgroundError?.(
          `[memory-proposals] chat ${args.chatId} turn ${ctx.turnNumber}: ${error instanceof Error ? error.message : String(error)}`,
        )
      }
    }


    const pending = this.memory!.store
      .list({ status: "candidate" })
      .filter((m) => m.provenanceSessionId === args.chatId || m.sessionId === args.chatId)
    await this.store.appendMessage(
      args.chatId,
      timestamped({
        kind: "memory_proposals_result",
        proposalsId,
        candidates: pending.map((candidate) => ({ id: candidate.id })),
      }),
    )


    if (prep?.cancellation.signal.aborted || this.cancelledDuringPreview.has(args.chatId)) {
      await this.store.appendMessage(
        args.chatId,
        timestamped({ kind: "memory_proposals_decision", proposalsId, decision: "cancelled" }),
      )
      this.memory!.logger.event({
        type: "memory.proposals",
        sessionId: args.chatId,
        engine: args.provider,
        turn: ctx.turnNumber,
        count: pending.length,
        decision: "cancelled",
      })
      this.emitStateChange(args.chatId, { immediate: true })
      return { decision: "cancelled", proposalsId }
    }

    if (pending.length === 0) {


      await this.store.appendMessage(
        args.chatId,
        timestamped({ kind: "memory_proposals_decision", proposalsId, decision: "empty" }),
      )
      this.memory!.logger.event({
        type: "memory.proposals",
        sessionId: args.chatId,
        engine: args.provider,
        turn: ctx.turnNumber,
        count: 0,
        decision: "empty",
      })
      return { decision: "none", proposalsId }
    }

    const decision = await new Promise<"reviewed" | "skipped" | "cancelled">((resolve) => {
      this.pendingProposalGates.set(args.chatId, {
        proposalsId,
        published: true,
        respond: (d) => {
          this.pendingProposalGates.delete(args.chatId)
          resolve(d)
        },
      })
      this.emitStateChange(args.chatId, { immediate: true })
    })

    await this.store.appendMessage(
      args.chatId,
      timestamped({ kind: "memory_proposals_decision", proposalsId, decision }),
    )
    this.memory!.logger.event({
      type: "memory.proposals",
      sessionId: args.chatId,
      engine: args.provider,
      turn: ctx.turnNumber,
      count: pending.length,
      decision,
    })


    if (decision === "cancelled") this.emitStateChange(args.chatId, { immediate: true })
    return { decision, proposalsId }
  }


  private async parkExistingProposalsGate(
    args: StartTurnArgs,
    ctx: { turnNumber: number },
    proposalsId: string,
  ): Promise<"reviewed" | "skipped" | "cancelled"> {
    const messages = this.store.getMessages(args.chatId)
    const parent = messages.find(
      (message): message is Extract<TranscriptEntry, { kind: "memory_proposals" }> =>
        message.kind === "memory_proposals" && message.proposalsId === proposalsId,
    )
    const result = messages
      .filter(
        (message): message is Extract<TranscriptEntry, { kind: "memory_proposals_result" }> =>
          message.kind === "memory_proposals_result" && message.proposalsId === proposalsId,
      )
      .at(-1)
    if (!parent) throw new Error("Memory candidate review is no longer available")
    const candidates = result?.candidates ?? parent.candidates

    const decision = await new Promise<"reviewed" | "skipped" | "cancelled">((resolve) => {
      this.pendingProposalGates.set(args.chatId, {
        proposalsId,
        published: true,
        respond: (next) => {
          this.pendingProposalGates.delete(args.chatId)
          resolve(next)
        },
      })
      this.emitStateChange(args.chatId, { immediate: true })
    })

    await this.store.appendMessage(
      args.chatId,
      timestamped({ kind: "memory_proposals_decision", proposalsId, decision }),
    )
    this.memory!.logger.event({
      type: "memory.proposals",
      sessionId: args.chatId,
      engine: args.provider,
      turn: ctx.turnNumber,
      count: candidates.length,
      decision,
    })

    if (decision === "cancelled") this.emitStateChange(args.chatId, { immediate: true })
    return decision
  }


  private async reopenProposalsBeforeCheckup(input: {
    args: StartTurnArgs
    ctx: { turnNumber: number }
    proposalsId: string
    checkupId: string
    revision: number
    previewId?: string
  }): Promise<{ cancelled: boolean; revision: number }> {
    const { args, ctx, proposalsId, checkupId, previewId } = input
    const revision = input.revision + 1
    this.memory!.logger.event({
      type: "memory.preparation_reopen",
      sessionId: args.chatId,
      engine: args.provider,
      turn: ctx.turnNumber,
      from: "proposals",
      revision,
    })
    await this.store.appendMessage(
      args.chatId,
      timestamped({
        kind: "memory_preparation_reset",
        ...(previewId ? { previewId } : {}),
        revision,
        from: "proposals",
        proposalsId,
        checkupId,
      }),
    )
    this.emitStateChange(args.chatId, { immediate: true })

    const proposalsDecision = await this.parkExistingProposalsGate(args, ctx, proposalsId)
    if (proposalsDecision === "cancelled") return { cancelled: true, revision }
    if (await this.refreshTransferAfterCandidateReview(args, ctx.turnNumber)) return { cancelled: true, revision }

    await this.store.appendMessage(
      args.chatId,
      timestamped({
        kind: "memory_preparation_reset",
        ...(previewId ? { previewId } : {}),
        revision,
        from: "checkup",
        proposalsId,
        checkupId,
      }),
    )
    this.emitStateChange(args.chatId, { immediate: true })
    return { cancelled: false, revision }
  }


  private async reopenTransferBeforeCheckup(input: {
    args: StartTurnArgs
    ctx: {
      chat: ReturnType<EventStore["requireChat"]>
      project: NonNullable<ReturnType<EventStore["getProject"]>>
      turnNumber: number
    }
    transferId: string
    checkupId: string
    revision: number
    previewId?: string
  }): Promise<{ cancelled: boolean; revision: number }> {
    const { args, ctx, transferId, checkupId, previewId } = input
    const revision = input.revision + 1
    this.memory!.logger.event({
      type: "memory.preparation_reopen",
      sessionId: args.chatId,
      engine: args.provider,
      turn: ctx.turnNumber,
      from: "transfer",
      revision,
    })
    await this.store.appendMessage(
      args.chatId,
      timestamped({
        kind: "memory_preparation_reset",
        ...(previewId ? { previewId } : {}),
        revision,
        from: "transfer",
        transferId,
        checkupId,
      }),
    )
    this.emitStateChange(args.chatId, { immediate: true })

    const transferDecision = await this.parkExistingTransferGate(args, ctx, transferId)
    if (transferDecision === "cancelled") return { cancelled: true, revision }

    await this.store.appendMessage(
      args.chatId,
      timestamped({
        kind: "memory_preparation_reset",
        ...(previewId ? { previewId } : {}),
        revision,
        from: "checkup",
        transferId,
        checkupId,
      }),
    )
    this.emitStateChange(args.chatId, { immediate: true })
    return { cancelled: false, revision }
  }


  private async parkExistingTransferGate(
    args: StartTurnArgs,
    ctx: {
      chat: ReturnType<EventStore["requireChat"]>
      project: NonNullable<ReturnType<EventStore["getProject"]>>
      turnNumber: number
    },
    transferId: string,
  ): Promise<"none" | TransferGateDecision> {
    const messages = this.store.getMessages(args.chatId)
    const parent = messages.find(
      (message): message is Extract<TranscriptEntry, { kind: "memory_transfer" }> =>
        message.kind === "memory_transfer" && message.transferId === transferId,
    )
    if (!parent) throw new Error("Memory transfer review is no longer available")
    const result = messages
      .filter(
        (message): message is Extract<TranscriptEntry, { kind: "memory_transfer_result" }> =>
          message.kind === "memory_transfer_result" && message.transferId === transferId,
      )
      .at(-1)
    const suggestions = result?.suggestions ?? parent.suggestions

    const decision = await new Promise<InternalGateWake<TransferGateDecision>>((resolve) => {
      this.pendingTransferGates.set(args.chatId, {
        transferId,
        published: true,
        respond: (next) => {
          this.pendingTransferGates.delete(args.chatId)
          resolve(next)
        },
        invalidate: () => {
          this.pendingTransferGates.delete(args.chatId)
          resolve("invalidated")
        },
      })
      this.emitStateChange(args.chatId, { immediate: true })
    })

    if (decision === "invalidated") {
      return (await this.runTransferGate(args, ctx, Promise.resolve(), {
        transferId,
        recompute: true,
      })).decision
    }

    await this.store.appendMessage(
      args.chatId,
      timestamped({ kind: "memory_transfer_decision", transferId, decision }),
    )
    this.memory!.logger.event({
      type: "memory.transfer_card",
      sessionId: args.chatId,
      engine: args.provider,
      turn: ctx.turnNumber,
      suggestions: suggestions.length,
      decision,
    })

    if (decision === "cancelled") this.emitStateChange(args.chatId, { immediate: true })
    return decision
  }

  private transferSnapshotOf(card: TransferSuggestionProgress | TransferSuggestionCard) {
    return {
      sourceId: card.sourceId,
      sourceContent: card.sourceContent,
      sourceScope: card.sourceScope,
      sourceVersion: card.sourceVersion,
      sourceLabel: card.sourceLabel,
      ...(card.encoding ? { rule: card.encoding.rule } : {}),
      ...(card.encoding?.applicability ? { applicability: card.encoding.applicability } : {}),
      ...(card.encoding?.stripped?.length ? { stripped: card.encoding.stripped } : {}),
      ...(card.decoding
        ? {
            content: card.decoding.content,
            abstractionLevel: card.decoding.abstractionLevel,
            suggestedScope: card.decoding.suggestedScope,
            landing: card.decoding.landing,
          }
        : {}),
      ...(card.decoding?.bound?.length ? { bound: card.decoding.bound } : {}),
      ...(card.decoding?.detail ? { detail: card.decoding.detail } : {}),
      ...(card.decoding?.note ? { note: card.decoding.note } : {}),
    }
  }


  private async runTransferGate(
    args: StartTurnArgs,
    ctx: {
      chat: ReturnType<EventStore["requireChat"]>
      project: NonNullable<ReturnType<EventStore["getProject"]>>
      turnNumber: number
    },
    stepOneSettled: Promise<unknown> | null,
    options?: { transferId?: string; recompute?: boolean },
  ): Promise<{ decision: "none" | "handled" | "skipped" | "cancelled"; transferId: string }> {
    const existingMessages = args.openingReview || options?.transferId ? this.store.getMessages(args.chatId) : []
    const existingParent = existingMessages.filter(
      (message): message is Extract<TranscriptEntry, { kind: "memory_transfer" }> =>
        message.kind === "memory_transfer" && (options?.transferId ? message.transferId === options.transferId : message.openingReviewId === args.openingReview?.reviewId),
    ).at(-1)
    const transferId = options?.transferId ?? existingParent?.transferId ?? crypto.randomUUID()
    if (existingParent && !options?.recompute) {
      const existingDecision = existingMessages.filter(
        (message): message is Extract<TranscriptEntry, { kind: "memory_transfer_decision" }> =>
          message.kind === "memory_transfer_decision" && message.transferId === transferId,
      ).at(-1)?.decision
      if (existingDecision === "handled" || existingDecision === "skipped" || existingDecision === "cancelled") {
        return { decision: existingDecision, transferId }
      }
      if (existingDecision === "empty") return { decision: "none", transferId }
      if (existingDecision === "expired") return { decision: "cancelled", transferId }

      const finalResult = existingMessages.filter(
        (message): message is Extract<TranscriptEntry, { kind: "memory_transfer_result" }> =>
          message.kind === "memory_transfer_result" && message.transferId === transferId && message.done === true,
      ).at(-1)
      const settledSuggestions = finalResult?.suggestions
        ?? (existingParent.pending ? undefined : existingParent.suggestions)
      if (settledSuggestions) {
        if (settledSuggestions.length === 0) {
          await this.store.appendMessage(
            args.chatId,
            timestamped({ kind: "memory_transfer_decision", transferId, decision: "empty" }),
          )
          this.memory!.logger.event({
            type: "memory.transfer_card",
            sessionId: args.chatId,
            engine: args.provider,
            turn: ctx.turnNumber,
            suggestions: 0,
            decision: "empty",
          })
          return { decision: "none", transferId }
        }
        const decision = await this.parkExistingTransferGate(args, ctx, transferId)
        return { decision, transferId }
      }
    }


    if (!options?.recompute) this.memory?.clearTransferLandings(args.chatId)
    const taskCtx = {
      projectId: ctx.project.id,
      sessionId: args.chatId,
      projectTitle: ctx.project.title,
      taskText: args.memoryUserText ?? args.content,
      recentContext: this.recentConversationDigest(args.chatId),
    }
    let searched = false
    let taskFinished = false
    let shellPublished = Boolean(existingParent)
    let latestProgress: { cards: TransferSuggestionProgress[]; targetKey: string } | null = null
    const preparation = this.activePreparations.get(args.chatId)
    const cancellation = preparation?.cancellation ?? createMemoryPreparationCancellation()
    const cancelRequested = () => cancellation.signal.aborted


    let stepOneDone = false
    const stepOneGate = (stepOneSettled ?? Promise.resolve())
      .catch(() => {})
      .then(() => {
        stepOneDone = true
      })


    let chain: Promise<void> = Promise.resolve()
    const enqueue = <T extends Omit<TranscriptEntry, "_id" | "createdAt">>(
      entry: T,
      shouldAppend?: () => boolean,
    ) => {
      const write = chain.then(async () => {
        const appended = await this.store.appendMessage(
          args.chatId,
          timestamped(entry),
          shouldAppend ? { shouldAppend } : undefined,
        )
        if (appended === false) return false
        this.emitStateChange(args.chatId, { immediate: true })
        return true
      })
      chain = write.then(() => {})
      return write
    }
    const publishShell = () => {
      if (shellPublished) return chain
      shellPublished = true
      return enqueue({
        kind: "memory_transfer",
        transferId,
        openingReviewId: args.openingReview?.reviewId,
        turn: ctx.turnNumber,
        pending: true,
        suggestions: [],
      })
    }
    const settleCancelledScan = async () => {
      taskFinished = true
      await chain
      if (shellPublished) {
        await enqueue({ kind: "memory_transfer_result", transferId, suggestions: [], done: true })
        await enqueue({ kind: "memory_transfer_decision", transferId, decision: "cancelled" })
      }
      return { decision: "cancelled" as const, transferId }
    }

    const maybePublishShell = () => {
      if (stepOneDone && searched && !taskFinished && !cancelRequested() && !this.cancelledDuringPreview.has(args.chatId)) {
        void publishShell()
      }
    }
    const flushProgress = () => {
      if (!stepOneDone || !latestProgress || cancelRequested() || this.cancelledDuringPreview.has(args.chatId)) return


      if (!this.memoryTransferDetect!.landingsStillCurrent(taskCtx, latestProgress.targetKey)) return
      const progress = latestProgress
      void publishShell()
      void enqueue({
        kind: "memory_transfer_result",
        transferId,
        suggestions: progress.cards.map((card) => this.transferSnapshotOf(card)),
      }, () => {
        if (cancelRequested() || this.cancelledDuringPreview.has(args.chatId)) return false
        if (!this.memoryTransferDetect!.landingsStillCurrent(taskCtx, progress.targetKey)) return false
        return progress.cards.every((card) => {
          const source = this.memory!.store.getById(card.sourceId)
          return Boolean(source && source.status === "active" && source.version === card.sourceVersion)
        })
      })
    }
    const onProgress = (cards: TransferSuggestionProgress[], targetKey: string) => {
      if (cancelRequested()) return
      latestProgress = { cards, targetKey }
      flushProgress()
    }


    searched = this.memoryTransferDetect!.hasSourceCandidates(taskCtx)
    maybePublishShell()
    const computeTask = async (): Promise<TransferTaskResult | null> => {
      const branches = this.branchPreparations.get(args.chatId)
      if (branches) {
        await branches.pipeline.result("transfer")
        return null
      }


      await this.memoryTransferDetect!.prepareSources(taskCtx)
      if (cancelRequested()) return null
      const forkPrompt = this.memoryTransferDetect!.buildTaskForkPrompt(taskCtx)
      if (!forkPrompt) return this.memoryTransferDetect!.runTask(taskCtx, { onProgress })
      searched = true
      maybePublishShell()
      const transferForkSessionToken = ctx.chat.pendingForkSessionToken ?? ctx.chat.sessionToken

      if (
        args.provider === "claude" &&
        transferForkSessionToken &&
        ctx.project.localPath &&
        process.env.MEMOSYNC_TRANSFER_FORK !== "0"
      ) {
        try {
          const raw = await this.forkQueryFn({
            sessionToken: transferForkSessionToken,
            localPath: ctx.project.localPath,
            prompt: forkPrompt,
          })
          if (cancelRequested()) return null
          if (raw) {
            const fromFork = await this.memoryTransferDetect!.materializeTaskFromFork(taskCtx, raw, { onProgress })
            if (cancelRequested()) return null
            if (fromFork) return fromFork
          }
        } catch {

        }
        if (cancelRequested()) return null
      }
      const result = await this.memoryTransferDetect!.runTask(taskCtx, { onProgress })
      return cancelRequested() ? null : result
    }

    let result: TransferTaskResult | null = null
    const taskRun = computeTask().then(
      (value) => ({ kind: "result" as const, value }),
      (error: unknown) => ({ kind: "error" as const, error }),
    )
    void stepOneGate.then(() => {
      maybePublishShell()
      flushProgress()
    })
    const taskOutcome = await Promise.race([
      taskRun,
      cancellation.requested.then(() => ({ kind: "cancelled" as const })),
    ])
    if (taskOutcome.kind === "result") {
      result = taskOutcome.value
    } else if (taskOutcome.kind === "error") {
      const error = taskOutcome.error
      this.reportBackgroundError?.(
        `[memory-transfer-live] chat ${args.chatId} turn ${ctx.turnNumber}: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
    taskFinished = true
    if (taskOutcome.kind === "cancelled") return settleCancelledScan()
    const stepOneOutcome = await Promise.race([
      stepOneGate.then(() => "settled" as const),
      cancellation.requested.then(() => "cancelled" as const),
    ])
    if (stepOneOutcome === "cancelled") return settleCancelledScan()
    await chain


    if (this.cancelledDuringPreview.has(args.chatId)) return settleCancelledScan()

    if (this.memoryBranches) {
      const request = this.memoryTransferDetect!.buildTaskBranchPrompt!(taskCtx)
      const updated = await this.continueMemoryBranch(args.chatId, "transfer", "Candidate review", request.dependencyKey)
      result = await this.memoryTransferDetect!.materializeTaskFromBranch!(taskCtx, updated.raw, updated.dependencyKey)
      if (!result) throw new Error("Memory transfer dependencies changed during review; prepare this turn again")
    }


    if (result) {
      try {
        let refreshes = 0
        while (
          result
          && !this.memoryTransferDetect!.landingsStillCurrent(taskCtx, result.targetKey)
          && refreshes < MAX_TRANSFER_TARGET_REFRESHES
        ) {
          taskFinished = false
          maybePublishShell()
          const refreshOutcome:
            | { kind: "result"; value: TransferTaskResult }
            | { kind: "error"; error: unknown }
            | { kind: "cancelled" } = await Promise.race([
            (this.memoryBranches ? (async () => {
              const request = this.memoryTransferDetect!.buildTaskBranchPrompt!(taskCtx)
              const updated = await this.continueMemoryBranch(args.chatId, "transfer", "Candidate edits", request.dependencyKey)
              const fresh = await this.memoryTransferDetect!.materializeTaskFromBranch!(taskCtx, updated.raw, updated.dependencyKey)
              if (!fresh) throw new Error("Memory transfer dependencies changed")
              return fresh
            })() : this.memoryTransferDetect!.refreshLandingsIfTargetChanged(taskCtx, result, { onProgress })).then(
              (value) => ({ kind: "result" as const, value }),
              (error: unknown) => ({ kind: "error" as const, error }),
            ),
            cancellation.requested.then(() => ({ kind: "cancelled" as const })),
          ])
          if (refreshOutcome.kind === "cancelled") return settleCancelledScan()
          if (refreshOutcome.kind === "error") throw refreshOutcome.error
          result = refreshOutcome.value
          refreshes += 1
        }
        taskFinished = true
      } catch (error) {
        taskFinished = true
        this.reportBackgroundError?.(
          `[memory-transfer-landing-refresh] chat ${args.chatId} turn ${ctx.turnNumber}: ${error instanceof Error ? error.message : String(error)}`,
        )
        result = null
      }
    }
    await chain


    if (result && !this.memoryTransferDetect!.landingsStillCurrent(taskCtx, result.targetKey)) result = null


    if (this.cancelledDuringPreview.has(args.chatId)) return settleCancelledScan()

    const settleEmpty = async () => {
      if (shellPublished) {


        await enqueue({ kind: "memory_transfer_result", transferId, suggestions: [], done: true })
        await enqueue({ kind: "memory_transfer_decision", transferId, decision: "empty" })
        this.memory!.logger.event({
          type: "memory.transfer_card",
          sessionId: args.chatId,
          engine: args.provider,
          turn: ctx.turnNumber,
          suggestions: 0,
          decision: "empty",
        })
      }
      return { decision: "none" as const, transferId }
    }


    const finalResult = result
    const live = (finalResult?.cards ?? []).filter((card) => {
      const now = this.memory!.store.getById(card.sourceId)
      return Boolean(now && now.status === "active" && now.version === card.sourceVersion)
    })
    if (live.length === 0) return settleEmpty()

    const finalStillFresh = () => {
      if (cancelRequested() || this.cancelledDuringPreview.has(args.chatId)) return false
      if (!finalResult || !this.memoryTransferDetect!.landingsStillCurrent(taskCtx, finalResult.targetKey)) return false
      return live.every((card) => {
        const source = this.memory!.store.getById(card.sourceId)
        return Boolean(source && source.status === "active" && source.version === card.sourceVersion)
      })
    }


    let resolveDecision!: (d: InternalGateWake<TransferGateDecision>) => void
    const decisionPromise = new Promise<InternalGateWake<TransferGateDecision>>((resolve) => {
      resolveDecision = resolve
    })
    this.pendingTransferGates.set(args.chatId, {
      transferId,
      published: true,
      respond: (d) => {
        this.pendingTransferGates.delete(args.chatId)
        resolveDecision(d)
      },
      invalidate: () => {
        this.pendingTransferGates.delete(args.chatId)
        resolveDecision("invalidated")
      },
    })
    const finalAppended = shellPublished
      ? await enqueue({
          kind: "memory_transfer_result",
          transferId,
          suggestions: live.map((card) => this.transferSnapshotOf(card)),
          done: true,
        }, finalStillFresh)
      : await enqueue({
        kind: "memory_transfer",
        transferId,
        openingReviewId: args.openingReview?.reviewId,
        turn: ctx.turnNumber,
          suggestions: live.map((card) => this.transferSnapshotOf(card)),
        }, finalStillFresh)
    if (!finalAppended) {
      this.pendingTransferGates.delete(args.chatId)


      resolveDecision("cancelled")
      if (cancelRequested() || this.cancelledDuringPreview.has(args.chatId)) return settleCancelledScan()
      return settleEmpty()
    }
    this.emitStateChange(args.chatId, { immediate: true })
    const decision = await decisionPromise

    if (decision === "invalidated") {
      return await this.runTransferGate(args, ctx, Promise.resolve(), {
        transferId,
        recompute: true,
      })
    }

    await this.store.appendMessage(
      args.chatId,
      timestamped({ kind: "memory_transfer_decision", transferId, decision }),
    )
    this.memory!.logger.event({
      type: "memory.transfer_card",
      sessionId: args.chatId,
      engine: args.provider,
      turn: ctx.turnNumber,
      suggestions: live.length,
      decision,
    })

    if (decision === "cancelled") this.emitStateChange(args.chatId, { immediate: true })
    return { decision, transferId }
  }

  private async runCheckupGate(
    args: StartTurnArgs,
    ctx: { project: NonNullable<ReturnType<EventStore["getProject"]>>; turnNumber: number },
    options?: { checkupId?: string; proposalsId?: string; transferId?: string; reuseParent?: boolean },
  ): Promise<{ decision: "none" | "handled" | "skipped" | "cancelled" | "reopen_proposals" | "reopen_transfer"; checkupId: string }> {
    const existingMessages = args.openingReview ? this.store.getMessages(args.chatId) : []
    const existingParent = !options?.checkupId
      ? existingMessages.filter(
          (message): message is Extract<TranscriptEntry, { kind: "memory_checkup" }> =>
            message.kind === "memory_checkup" && message.openingReviewId === args.openingReview?.reviewId,
        ).at(-1)
      : undefined
    const checkupId = options?.checkupId ?? existingParent?.checkupId ?? crypto.randomUUID()
    const reuseParent = Boolean(options?.reuseParent || existingParent)
    if (existingParent) {
      const existingDecision = existingMessages.filter(
        (message): message is Extract<TranscriptEntry, { kind: "memory_checkup_decision" }> =>
          message.kind === "memory_checkup_decision" && message.checkupId === checkupId,
      ).at(-1)?.decision
      if (existingDecision === "handled" || existingDecision === "skipped" || existingDecision === "cancelled") {
        return { decision: existingDecision, checkupId }
      }
      if (existingDecision === "empty" || existingDecision === "failed") return { decision: "none", checkupId }
      if (existingDecision === "expired") return { decision: "cancelled", checkupId }

      const existingResult = existingMessages.filter(
        (message): message is Extract<TranscriptEntry, { kind: "memory_checkup_result" }> =>
          message.kind === "memory_checkup_result" && message.checkupId === checkupId,
      ).at(-1)
      if (existingResult) {
        if (existingResult.suggestions.length === 0) {
          const failedKinds = [...new Set(existingResult.failedKinds ?? [])]
          const failed = failedKinds.length > 0
          await this.store.appendMessage(
            args.chatId,
            timestamped({ kind: "memory_checkup_decision", checkupId, decision: failed ? "failed" : "empty" }),
          )
          this.memory!.logger.event({
            type: "memory.checkup",
            sessionId: args.chatId,
            engine: args.provider,
            turn: ctx.turnNumber,
            suggestions: 0,
            cached: false,
            ...(failedKinds.length ? { failedKinds } : {}),
            decision: failed ? "failed" : "clear",
          })
          return { decision: "none", checkupId }
        }
        const decision = await new Promise<InternalGateWake<CheckupGateDecision>>((resolve) => {
          this.pendingCheckupGates.set(args.chatId, {
            checkupId,
            proposalsId: options?.proposalsId,
            transferId: options?.transferId,
            published: true,
            respond: (next) => {
              this.pendingCheckupGates.delete(args.chatId)
              resolve(next)
            },
            invalidate: () => {
              this.pendingCheckupGates.delete(args.chatId)
              resolve("invalidated")
            },
          })
          this.emitStateChange(args.chatId, { immediate: true })
        })
        if (decision === "invalidated") {
          return await this.runCheckupGate(args, ctx, {
            ...options,
            checkupId,
            reuseParent: true,
          })
        }
        if (decision === "reopen_proposals" || decision === "reopen_transfer") {
          return { decision, checkupId }
        }
        await this.store.appendMessage(
          args.chatId,
          timestamped({ kind: "memory_checkup_decision", checkupId, decision }),
        )
        this.memory!.logger.event({
          type: "memory.checkup",
          sessionId: args.chatId,
          engine: args.provider,
          turn: ctx.turnNumber,
          suggestions: existingResult.suggestions.length,
          cached: false,
          ...(existingResult.failedKinds?.length ? { failedKinds: existingResult.failedKinds } : {}),
          decision,
        })
        return { decision, checkupId }
      }
    }
    const checkupCtx = { projectId: ctx.project.id, sessionId: args.chatId }
    const runState = {
      checkupId,
      proposalsId: options?.proposalsId,
      transferId: options?.transferId,
      reopenProposalsRequested: false,
      reopenTransferRequested: false,
    }
    this.inFlightCheckups.set(args.chatId, runState)
    let skeletonShown = false
    let result: CheckupResult = { suggestions: [], cached: true }
    try {
      if (this.memoryCheckup!.needsRecompute(checkupCtx)) {
        skeletonShown = true
        if (!reuseParent) {
          await this.store.appendMessage(
            args.chatId,
            timestamped({
              kind: "memory_checkup",
              checkupId,
              openingReviewId: args.openingReview?.reviewId,
              turn: ctx.turnNumber,
              pending: true,
            }),
          )
        }
        this.emitStateChange(args.chatId, { immediate: true })
      }
      if (this.memoryBranches) {
        const request = this.memoryCheckup!.buildBranchPrompt?.(checkupCtx, args.memoryUserText ?? args.content)
          ?? this.memoryCheckup!.buildForkPrompt!(checkupCtx)
        const prepared = await this.continueMemoryBranch(args.chatId, "changes", "Transfer and memory review", request?.dependencyKey ?? "")
        const checked = await this.memoryCheckup!.primeFromBranchResult!(checkupCtx, prepared.dependencyKey, prepared.raw)
        if (!checked) throw new Error("Memory change dependencies changed during analysis")
        result = checked
      } else {
        result = await this.memoryCheckup!.run(checkupCtx)
      }
    } catch (error) {
      this.reportBackgroundError?.(
        `[memory-checkup] chat ${args.chatId} turn ${ctx.turnNumber}: ${error instanceof Error ? error.message : String(error)}`,
      )
      result = {
        suggestions: [],
        cached: false,
        failedKinds: ["conflict", "redundancy", "staleness"],
      }
    }
    if (runState.reopenProposalsRequested || runState.reopenTransferRequested) {
      this.inFlightCheckups.delete(args.chatId)
      return { decision: runState.reopenProposalsRequested ? "reopen_proposals" : "reopen_transfer", checkupId }
    }
    let cancelledDuringRun = this.cancelledDuringPreview.delete(args.chatId)
    const failedKinds = cancelledDuringRun ? [] : [...new Set(result.failedKinds ?? [])]


    if (!skeletonShown && !cancelledDuringRun && !reuseParent) {
      await this.store.appendMessage(args.chatId, timestamped({
        kind: "memory_checkup",
        checkupId,
        openingReviewId: args.openingReview?.reviewId,
        turn: ctx.turnNumber,
      }))
    }
    if (skeletonShown || !cancelledDuringRun) {
      await this.store.appendMessage(
        args.chatId,
        timestamped({
          kind: "memory_checkup_result",
          checkupId,
          suggestions: cancelledDuringRun ? [] : result.suggestions,
          ...(failedKinds.length ? { failedKinds } : {}),
        }),
      )
    }


    if (!cancelledDuringRun && this.cancelledDuringPreview.delete(args.chatId)) {
      cancelledDuringRun = true
    }
    if (runState.reopenProposalsRequested || runState.reopenTransferRequested) {
      this.inFlightCheckups.delete(args.chatId)
      return { decision: runState.reopenProposalsRequested ? "reopen_proposals" : "reopen_transfer", checkupId }
    }
    if (cancelledDuringRun) {
      this.inFlightCheckups.delete(args.chatId)
      await this.store.appendMessage(
        args.chatId,
        timestamped({ kind: "memory_checkup_decision", checkupId, decision: "cancelled" }),
      )
      this.memory!.logger.event({
        type: "memory.checkup",
        sessionId: args.chatId,
        engine: args.provider,
        turn: ctx.turnNumber,
        suggestions: 0,
        cached: result.cached,
        decision: "cancelled",
      })
      this.emitStateChange(args.chatId, { immediate: true })
      return { decision: "cancelled", checkupId }
    }
    if (result.suggestions.length === 0) {
      this.inFlightCheckups.delete(args.chatId)
      const analysisFailed = failedKinds.length > 0


      await this.store.appendMessage(
        args.chatId,
        timestamped({
          kind: "memory_checkup_decision",
          checkupId,
          decision: analysisFailed ? "failed" : "empty",
        }),
      )
      this.memory!.logger.event({
        type: "memory.checkup",
        sessionId: args.chatId,
        engine: args.provider,
        turn: ctx.turnNumber,
        suggestions: 0,
        cached: result.cached,
        ...(failedKinds.length ? { failedKinds } : {}),
        decision: analysisFailed ? "failed" : "clear",
      })
      this.emitStateChange(args.chatId)
      if (analysisFailed && this.memoryBranches) throw new Error("Memory-change analysis failed. Retry preparation before running the coding agent.")
      return { decision: "none", checkupId }
    }

    const decision = await new Promise<InternalGateWake<CheckupGateDecision>>((resolve) => {
      this.pendingCheckupGates.set(args.chatId, {
        checkupId,
        proposalsId: options?.proposalsId,
        transferId: options?.transferId,


        published: true,
        respond: (d) => {
          this.pendingCheckupGates.delete(args.chatId)
          resolve(d)
        },
        invalidate: () => {
          this.pendingCheckupGates.delete(args.chatId)
          resolve("invalidated")
        },
      })
      this.inFlightCheckups.delete(args.chatId)
      this.emitStateChange(args.chatId, { immediate: true })
    })

    if (decision === "invalidated") {
      return await this.runCheckupGate(args, ctx, {
        ...options,
        checkupId,
        reuseParent: true,
      })
    }

    if (decision === "reopen_proposals" || decision === "reopen_transfer") return { decision, checkupId }

    await this.store.appendMessage(
      args.chatId,
      timestamped({ kind: "memory_checkup_decision", checkupId, decision }),
    )
    this.memory!.logger.event({
      type: "memory.checkup",
      sessionId: args.chatId,
      engine: args.provider,
      turn: ctx.turnNumber,
      suggestions: result.suggestions.length,
      cached: result.cached,
      ...(failedKinds.length ? { failedKinds } : {}),
      decision,
    })

    if (decision === "cancelled") this.emitStateChange(args.chatId, { immediate: true })
    return { decision, checkupId }
  }


  private async runReopenedMemoryPreparation(input: {
    args: StartTurnArgs
    ctx: {
      chat: ReturnType<EventStore["requireChat"]>
      project: NonNullable<ReturnType<EventStore["getProject"]>>
      turnNumber: number
      injected: MemoryItem[]
    }
    previewId: string
    revision: number
    proposalsId?: string
    transferId?: string
    checkupId?: string
    from: "proposals" | "checkup" | "transfer"
    stageId: string
  }) {
    const { args, previewId, from } = input
    let revision = input.revision
    try {
      if (
        !input.checkupId ||
        (from === "proposals" && !input.proposalsId) ||
        (from === "transfer" && !input.transferId)
      ) {
        throw new Error("This memory review step is no longer available")
      }

      this.memory!.logger.event({
        type: "memory.preparation_reopen",
        sessionId: args.chatId,
        engine: args.provider,
        turn: input.ctx.turnNumber,
        from,
        revision,
      })

      await this.store.appendMessage(
        args.chatId,
        timestamped({
          kind: "memory_preparation_reset",
          previewId,
          revision,
          from,
          proposalsId: input.proposalsId,
          transferId: input.transferId,
          checkupId: input.checkupId,
        }),
      )
      this.emitStateChange(args.chatId, { immediate: true })

      if (from === "transfer") {
        const decision = await this.parkExistingTransferGate(args, input.ctx, input.transferId!)
        if (decision === "cancelled") return


        await this.store.appendMessage(
          args.chatId,
          timestamped({
            kind: "memory_preparation_reset",
            previewId,
            revision,
            from: "checkup",
            proposalsId: input.proposalsId,
            checkupId: input.checkupId,
          }),
        )
        this.emitStateChange(args.chatId, { immediate: true })
      }

      if (from === "proposals") {
        const decision = await this.parkExistingProposalsGate(args, input.ctx, input.proposalsId!)
        if (decision === "cancelled") return
        if (await this.refreshTransferAfterCandidateReview(args, input.ctx.turnNumber)) return


        await this.store.appendMessage(
          args.chatId,
          timestamped({
            kind: "memory_preparation_reset",
            previewId,
            revision,
            from: "checkup",
            proposalsId: input.proposalsId,
            checkupId: input.checkupId,
          }),
        )
        this.emitStateChange(args.chatId, { immediate: true })
      }

      while (true) {
        const checkup = await this.runCheckupGate(args, input.ctx, {
          checkupId: input.checkupId,
          proposalsId: input.proposalsId,
          transferId: input.transferId,
          reuseParent: true,
        })
        if (checkup.decision === "cancelled") return
        if (checkup.decision === "reopen_transfer") {
          if (!input.transferId) throw new Error("Memory transfer review is no longer available")
          const reopened = await this.reopenTransferBeforeCheckup({
            args,
            ctx: input.ctx,
            transferId: input.transferId,
            checkupId: input.checkupId,
            revision,
            previewId,
          })
          revision = reopened.revision
          if (reopened.cancelled) return
          continue
        }
        if (checkup.decision !== "reopen_proposals") break
        if (!input.proposalsId) throw new Error("Memory candidate review is no longer available")
        const reopened = await this.reopenProposalsBeforeCheckup({
          args,
          ctx: input.ctx,
          proposalsId: input.proposalsId,
          checkupId: input.checkupId,
          revision,
          previewId,
        })
        revision = reopened.revision
        if (reopened.cancelled) return
      }

      const injected = planMemoryInjection({
        policy: this.policy,
        provider: args.provider,
        memory: this.memory!,
        projectId: input.ctx.project.id,
        chatId: args.chatId,
        workspaceDir: input.ctx.project.localPath,
      }).injectedMemories

      await this.refreshMemoryPreviewGate({
        ...input,
        revision,
        ctx: { ...input.ctx, injected },
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      await this.store.appendMessage(
        args.chatId,
        timestamped({ kind: "result", subtype: "error", isError: true, durationMs: 0, result: message }),
      )
      await this.store.recordTurnFailed(args.chatId, message)
      this.emitStateChange(args.chatId)
    } finally {
      this.startingChats.delete(args.chatId)
      this.cancelledDuringPreview.delete(args.chatId)
    }
  }


  private recentConversationDigest(
    chatId: string,
    maxTurns = 2,
    maxCharsPerText = 600,
    maxTotalChars = 3000,


    options?: { includeCurrentTurn?: boolean },
  ): string {
    const messages = this.store.getMessages(chatId)
    const parts: string[] = []
    let priorPrompts = 0
    let skippedCurrentPrompt = options?.includeCurrentTurn === true
    let total = 0
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i]!
      if (m.kind === "user_prompt") {
        if (!skippedCurrentPrompt) {
          skippedCurrentPrompt = true
          continue
        }
        priorPrompts += 1
        const text = `User: ${m.content.slice(0, maxCharsPerText)}`
        parts.unshift(text)
        total += text.length
        if (priorPrompts >= maxTurns || total >= maxTotalChars) break
      } else if (m.kind === "assistant_text" && skippedCurrentPrompt && m.text.trim()) {
        const text = `Assistant: ${m.text.slice(0, maxCharsPerText)}`
        parts.unshift(text)
        total += text.length
        if (total >= maxTotalChars) break
      }
    }
    return parts.join("\n")
  }


  private async resolveExpectedUses(
    task: string,
    memories: MemoryItem[],
    selectedIds: string[],
    relevant: RelevantMemory[],
  ): Promise<ExpectedMemoryUse[]> {
    const fromRelevance = new Map(
      relevant
        .filter((item) => typeof item.expectedUse === "string" && item.expectedUse.trim())
        .map((item) => [item.id, item.expectedUse!.trim().slice(0, 220)]),
    )
    const missing = selectedIds.filter((id) => !fromRelevance.has(id))
    const planned = missing.length ? await this.planExpectedMemoryUses(task, memories, missing) : []
    const plannedById = new Map(planned.map((use) => [use.id, use.expectedUse]))
    return selectedIds
      .map((id) => ({ id, expectedUse: fromRelevance.get(id) ?? plannedById.get(id) ?? "" }))
      .filter((use) => use.expectedUse)
  }

  private async planExpectedMemoryUses(
    task: string,
    memories: MemoryItem[],
    selectedIds: string[],
  ): Promise<ExpectedMemoryUse[]> {
    const selected = new Set(selectedIds)
    const inputs = memories
      .filter((memory) => selected.has(memory.id))
      .map((memory) => ({
        id: memory.id,
        content: memory.content,
        hasDetail: Boolean(memory.detail),
      }))
    if (!inputs.length) return []
    if (this.memoryUsePlan) return await this.memoryUsePlan.plan({ task, memories: inputs })
    return inputs.map((memory) => ({
      id: memory.id,
      expectedUse: memory.hasDetail
        ? "Load the detailed memory, then apply it while completing this task."
        : "Apply this memory while completing the task.",
    }))
  }

  private async ensurePendingPreviewExpectedUses(
    pending: PendingMemoryPreview,
    selectedIds: string[],
  ): Promise<ExpectedMemoryUse[]> {
    const allowed = new Set(pending.memoryIds)
    const selected = [...new Set(selectedIds)].filter((id) => allowed.has(id))
    if (this.memoryBranches) {
      for (const id of selected) {
        const snapshot = pending.memories.find(item => item.id === id)
        const current = this.memory?.store.getById(id)
        if (!snapshot || !current || current.status !== "active" || current.version !== snapshot.version || current.content !== snapshot.content || current.detail !== snapshot.detail) {
          throw new Error("Working memory changed during review. Reopen preparation to review the updated items.")
        }
      }
    }
    const missing = selected.filter((id) => !pending.expectedUseById.has(id))
    if (missing.length) {
      let planned: ExpectedMemoryUse[] = []
      try {
        const branch = pending.chatId ? this.workingBranches.get(pending.chatId) : undefined
        if (this.memoryBranches) {
          if (!branch) throw new Error("Working-memory branch is unavailable; reopen memory preparation")
          const input = { task: pending.task, memories: pending.memories.filter(item => selected.includes(item.id)), mandatoryIds: selected }
          const raw = await branch.ask(`The developer confirmed these items. Continue your selection analysis and provide an expected use for each.\n${buildWorkingMemoryBranchPrompt(input)}`, { schema: memoryStageSchema("working-memory"), budget: { maxTurns: 3, maxToolCalls: 1 } })
          planned = parseWorkingMemoryBranchResult(raw, input).expectedUses
        } else planned = await this.planExpectedMemoryUses(pending.task, pending.memories, missing)
      } catch (error) {
        if (this.memoryBranches) throw error


      }
      const plannedById = new Map(
        planned
          .filter((use) => missing.includes(use.id) && typeof use.expectedUse === "string" && use.expectedUse.trim())
          .map((use) => [use.id, use.expectedUse.trim().slice(0, 220)]),
      )
      for (const id of missing) {
        const memory = pending.memories.find((item) => item.id === id)
        if (!memory) continue
        pending.expectedUseById.set(
          id,
          plannedById.get(id)
            ?? (memory.detail
              ? "Load the detailed memory, then apply it while completing this task."
              : "Apply this memory while completing the task."),
        )
      }
    }
    return selected.flatMap((id) => {
      const expectedUse = pending.expectedUseById.get(id)
      return expectedUse ? [{ id, expectedUse }] : []
    })
  }


  private async refreshMemoryPreviewGate(input: {
    args: StartTurnArgs
    ctx: {
      chat: ReturnType<EventStore["requireChat"]>
      project: NonNullable<ReturnType<EventStore["getProject"]>>
      turnNumber: number
      injected: MemoryItem[]
    }
    previewId: string
    revision: number
    proposalsId?: string
    transferId?: string
    checkupId?: string
  }) {
    const { args, ctx, previewId, revision } = input
    const memoryIds = ctx.injected.map((memory) => memory.id)
    const attentionIds = (this.turnPayAttention.get(args.chatId) ?? []).map((e) => e.id).filter((id) => memoryIds.includes(id))
    const willAssessRelevance = (this.memoryBranches || Boolean(this.memoryRelevance)) && ctx.injected.length > 0

    this.turnExpectedUses.delete(args.chatId)
    const pending: PendingMemoryPreview = {
      chatId: args.chatId,
      previewId,
      revision,
      published: false,
      memoryIds,
      task: args.memoryUserText ?? args.content,
      memories: ctx.injected,
      expectedUseById: new Map(),
      proposalsId: input.proposalsId,
      transferId: input.transferId,
      checkupId: input.checkupId,
      respond: (decision, selectedIds, expectedUses, controlOperation) => {
        this.deletePendingPreviewIfCurrent(args.chatId, pending)
        void this.finishMemoryPreview({
          args,
          chat: ctx.chat,
          project: ctx.project,
          turnNumber: ctx.turnNumber,
          previewId,
          memoryIds,
          decision,
          selectedIds,
          expectedUses,
          controlOperation,
        })
      },
      reopen: (from, stageId) => {
        this.deletePendingPreviewIfCurrent(args.chatId, pending)
        this.startingChats.set(args.chatId, "previewing_memory")
        void this.runReopenedMemoryPreparation({
          ...input,
          ctx,
          revision: revision + 1,
          from,
          stageId,
        })
      },
    }
    this.pendingPreviews.set(args.chatId, pending)

    await this.store.appendMessage(
      args.chatId,
      timestamped({
        kind: "memory_preview_update",
        previewId,
        ...(this.policy.studyMode && this.policy.condition === "memosync"
          ? { taskId: this.getActiveStudyTaskId() ?? undefined }
          : {}),
        revision,
        memories: ctx.injected.map((memory) => ({ id: memory.id, content: memory.content, scope: memory.scope })),
        relevancePending: willAssessRelevance,
        ...(attentionIds.length ? { attentionIds } : {}),
      }),
    )
    const parked = this.pendingPreviews.get(args.chatId)
    if (parked?.previewId === previewId && parked.revision === revision) parked.published = true

    if (this.cancelledDuringPreview.delete(args.chatId)) {
      this.pendingPreviews.delete(args.chatId)
      this.emitStateChange(args.chatId, { immediate: true })
      return
    }
    this.emitStateChange(args.chatId, { immediate: true })

    if (willAssessRelevance) {
      const userText = args.memoryUserText ?? args.content
      const settle = async (relevant: RelevantMemory[]) => {
        const current = this.pendingPreviews.get(args.chatId)
        if (current?.previewId !== previewId || current.revision !== revision) return
        const selectedIds = [...new Set([...attentionIds, ...relevant.map((item) => item.id)])]
        const expectedUses = await this.resolveExpectedUses(userText, ctx.injected, selectedIds, relevant)
        const stillCurrent = this.pendingPreviews.get(args.chatId)
        if (stillCurrent?.previewId !== previewId || stillCurrent.revision !== revision) return
        for (const use of expectedUses) stillCurrent.expectedUseById.set(use.id, use.expectedUse)
        this.turnExpectedUses.set(args.chatId, expectedUses)
        await this.store.appendMessage(
          args.chatId,
          timestamped({ kind: "memory_preview_relevance", previewId, revision, relevant: relevant.map(({ id, why }) => ({ id, why })), expectedUses }),
        )
        this.emitStateChange(args.chatId)
      }
      void this.assessWorkingMemory(args, ctx.injected, attentionIds)
        .then(settle)
        .catch(() => this.memoryBranches
          ? this.reportWorkingMemoryFailure(args.chatId, previewId, revision)
          : settle([]).catch(() => {}))
    }
  }


  private async runPreviewGateThenBoot(
    args: StartTurnArgs,
    ctx: {
      chat: ReturnType<EventStore["requireChat"]>
      project: NonNullable<ReturnType<EventStore["getProject"]>>
      turnNumber: number
      injected: MemoryItem[]
    },
  ) {
    try {
      let gated = false


      let claimed = false
      let automaticOpeningWorkingMemory: StartTurnArgs["openingWorkingMemory"]
      try {


        if (this.cancelledDuringPreview.delete(args.chatId)) return


        let stepOneTouched = false
        let proposalsId: string | undefined
        let transferId: string | undefined
        let checkupId: string | undefined
        let durableParents: TranscriptEntry[] = []
        if (args.openingReview) {
          durableParents = this.store.getMessages(args.chatId)
          proposalsId = durableParents.filter(
            (message): message is Extract<TranscriptEntry, { kind: "memory_proposals" }> =>
              message.kind === "memory_proposals" && message.openingReviewId === args.openingReview?.reviewId,
          ).at(-1)?.proposalsId
          transferId = durableParents.filter(
            (message): message is Extract<TranscriptEntry, { kind: "memory_transfer" }> =>
              message.kind === "memory_transfer" && message.openingReviewId === args.openingReview?.reviewId,
          ).at(-1)?.transferId
          checkupId = durableParents.filter(
            (message): message is Extract<TranscriptEntry, { kind: "memory_checkup" }> =>
              message.kind === "memory_checkup" && message.openingReviewId === args.openingReview?.reviewId,
          ).at(-1)?.checkupId
        }


        if (!args.openingLongTermAlreadyReady) {
        const recomputeOpeningLongTerm = Boolean(args.openingReview && (args.openingLongTermRevision ?? 0) > 0)
        let recomputeProposals = recomputeOpeningLongTerm
        let recomputeTransfer = recomputeOpeningLongTerm
        let recomputeCheckup = recomputeOpeningLongTerm
        if (recomputeOpeningLongTerm && args.openingReview) {
          const revision = args.openingLongTermRevision!
          let resetIndex = durableParents.findIndex((message) => (
            message.kind === "memory_preparation_reset"
            && message.openingReviewId === args.openingReview?.reviewId
            && message.revision === revision
          ))
          if (resetIndex < 0) {
            const resetFrom = proposalsId ? "proposals" : transferId ? "transfer" : "checkup"
            await this.store.appendMessage(
              args.chatId,
              timestamped({
                kind: "memory_preparation_reset",
                openingReviewId: args.openingReview.reviewId,
                revision,
                from: resetFrom,
                proposalsId,
                transferId,
                checkupId,
              }),
            )
            this.emitStateChange(args.chatId, { immediate: true })
            durableParents = this.store.getMessages(args.chatId)
            resetIndex = durableParents.findIndex((message) => (
              message.kind === "memory_preparation_reset"
              && message.openingReviewId === args.openingReview?.reviewId
              && message.revision === revision
            ))
          }
          const afterReset = resetIndex < 0 ? [] : durableParents.slice(resetIndex + 1)
          recomputeProposals = !proposalsId || !afterReset.some((message) => (
            message.kind === "memory_proposals_decision" && message.proposalsId === proposalsId
          ))
          recomputeTransfer = !transferId || !afterReset.some((message) => (
            message.kind === "memory_transfer_decision" && message.transferId === transferId
          ))
          recomputeCheckup = !checkupId || !afterReset.some((message) => (
            message.kind === "memory_checkup_decision" && message.checkupId === checkupId
          ))
        }
        this.activePreparations.set(args.chatId, {
          args,
          ctx,
          reparks: [],
          reopened: false,
          cancellation: createMemoryPreparationCancellation(),
        })
        this.startMemoryBranches(args, ctx)
        const proposalsRun =
          this.capture && this.policy.capture === "review"
            ? this.runProposalsGate(args, ctx, recomputeProposals
                ? { proposalsId, recompute: true }
                : undefined)
            : null
        if (this.memoryBranches) {

          void (proposalsRun ?? Promise.resolve()).then(() => {
            if (this.cancelledDuringPreview.has(args.chatId)) return
            const checkupCtx = { projectId: ctx.project.id, sessionId: args.chatId }
            const request = this.memoryCheckup?.buildBranchPrompt?.(checkupCtx, args.memoryUserText ?? args.content)
              ?? this.memoryCheckup?.buildForkPrompt?.(checkupCtx)
            return this.continueMemoryBranch(args.chatId, "changes", "Candidate review", request?.dependencyKey ?? "")
          }).catch(() => {})
        }
        const transferRun =
          this.memoryTransferDetect && this.policy.capture === "review"
            ? this.runTransferGate(
                args,
                ctx,
                proposalsRun ?? Promise.resolve(),
                recomputeTransfer ? { transferId, recompute: true } : undefined,
              )
            : null
        if (proposalsRun || transferRun) {
          const [proposalsStage, transferStage] = await Promise.all([proposalsRun, transferRun])
          if (proposalsStage) {
            proposalsId = proposalsStage.proposalsId
            if (proposalsStage.decision !== "none" && proposalsStage.decision !== "cancelled") stepOneTouched = true
          }
          if (transferStage && transferStage.decision !== "none" && transferStage.decision !== "cancelled") {
            stepOneTouched = true
            transferId = transferStage.transferId
          }
          const prep = this.activePreparations.get(args.chatId)
          if (
            prep?.cancellation.signal.aborted
            || proposalsStage?.decision === "cancelled"
            || transferStage?.decision === "cancelled"
          ) return


          while (prep && prep.reparks.length) {
            const decision = await prep.reparks.shift()!
            if (decision === "cancelled") return
          }
          if (prep?.reopened) {
            stepOneTouched = true
            if (await this.refreshTransferAfterCandidateReview(args, ctx.turnNumber)) return
          }
        }
        const completedPreparation = this.activePreparations.get(args.chatId)
        this.activePreparations.delete(args.chatId)
        completedPreparation?.cancellation.settle()
        if (this.memoryCheckup) {
          let checkupRevision = 0
          let checkupOptions: {
            checkupId?: string
            proposalsId?: string
            transferId?: string
            reuseParent?: boolean
          } = {
            proposalsId,
            transferId,
            ...(recomputeCheckup && checkupId ? { checkupId, reuseParent: true } : {}),
          }

          while (true) {
            const stage = await this.runCheckupGate(args, ctx, checkupOptions)
            checkupId = stage.checkupId
            if (stage.decision === "cancelled") return
            if (stage.decision !== "reopen_proposals" && stage.decision !== "reopen_transfer") {
              if (stage.decision !== "none") stepOneTouched = true
              break
            }
            stepOneTouched = true
            if (stage.decision === "reopen_transfer") {
              if (!transferId) throw new Error("Memory transfer review is no longer available")
              const reopened = await this.reopenTransferBeforeCheckup({
                args,
                ctx,
                transferId,
                checkupId,
                revision: checkupRevision,
              })
              checkupRevision = reopened.revision
              if (reopened.cancelled) return
              checkupOptions = { checkupId, proposalsId, transferId, reuseParent: true }
              continue
            }
            if (!proposalsId) throw new Error("Memory candidate review is no longer available")

            const reopened = await this.reopenProposalsBeforeCheckup({
              args,
              ctx,
              proposalsId,
              checkupId,
              revision: checkupRevision,
            })
            checkupRevision = reopened.revision
            if (reopened.cancelled) return
            checkupOptions = { checkupId, proposalsId, transferId, reuseParent: true }
          }
        }


        if (stepOneTouched || this.memoryBranches) {
          ctx = {
            ...ctx,
            injected: planMemoryInjection({
              policy: this.policy,
              provider: args.provider,
              memory: this.memory!,
              projectId: ctx.project.id,
              chatId: args.chatId,
              workspaceDir: ctx.project.localPath,
            }).injectedMemories,
          }
        }
        }
        if (args.openingReview) {
          if (!this.openingBoardBacklog) {
            throw new Error("Opening Memory Board state is unavailable")
          }
          const openingState = {
            taskId: args.openingReview.taskId,
            chatId: args.chatId,
            reviewId: args.openingReview.reviewId,
            phase: "preparing" as const,
          }
          this.openingBoardBacklog.markOpeningPromptLongTermReady(openingState)
          this.emitStateChange(args.chatId, { immediate: true })
          const completion = await this.openingBoardBacklog.waitForOpeningPromptCompletion(openingState)
          if (completion === "invalidated") {


            this.openingBoardRecoveryRetryAttempts.delete(args.openingReview.taskId)
            this.scheduleOpeningBoardRecovery(args.openingReview.taskId)
            return
          }
          if (this.cancelledDuringPreview.delete(args.chatId)) return
        }
        const previewId = crypto.randomUUID()

        const memoryIds = ctx.injected.map((m) => m.id)
        const injectedIdSet = new Set(memoryIds)
        const transferredIds = (this.memory?.getTransferLandings(args.chatId) ?? []).filter((id) =>
          injectedIdSet.has(id)
        )


        const attentionKey = `pay_attention:${args.chatId}`
        const queuedAttention = this.memory!.store.getKv<Array<string | { id: string; quote?: string }>>(attentionKey)


        const queuedEntries = Array.isArray(queuedAttention)
          ? queuedAttention.map((e) => (typeof e === "string" ? { id: e } : e)).filter((e) => memoryIds.includes(e.id))
          : []
        const attentionIds = queuedEntries.map((e) => e.id)
        if (Array.isArray(queuedAttention) && queuedAttention.length) {
          this.memory!.store.setKv(attentionKey, [])
          this.turnPayAttention.set(args.chatId, queuedEntries)
        }
        const autoProceed = this.getMemoryPreviewSettings().autoProceedWhenEmpty && ctx.injected.length === 0


        if (!autoProceed) {
          const pending: PendingMemoryPreview = {
            chatId: args.chatId,
            previewId,
            revision: 0,
            published: false,
            memoryIds,
            task: args.memoryUserText ?? args.content,
            memories: ctx.injected,
            expectedUseById: new Map(),
            proposalsId,
            transferId,
            checkupId,
            respond: (decision, selectedIds, expectedUses, controlOperation) => {
              claimed = true
              this.deletePendingPreviewIfCurrent(args.chatId, pending)
              void this.finishMemoryPreview({
                args,
                chat: ctx.chat,
                project: ctx.project,
                turnNumber: ctx.turnNumber,
                previewId,
                memoryIds,
                decision,
                selectedIds,
                expectedUses,
                controlOperation,
              })
            },
            reopen: (from, stageId) => {
              claimed = true
              this.deletePendingPreviewIfCurrent(args.chatId, pending)
              this.startingChats.set(args.chatId, "previewing_memory")
              void this.runReopenedMemoryPreparation({
                args,
                ctx,
                previewId,
                revision: 1,
                proposalsId: proposalsId!,
                transferId,
                checkupId: checkupId!,
                from,
                stageId,
              })
            },
          }
          this.pendingPreviews.set(args.chatId, pending)
          gated = true
        }
        const willAssessRelevance = !autoProceed && (this.memoryBranches || Boolean(this.memoryRelevance)) && ctx.injected.length > 0
        await this.store.appendMessage(
          args.chatId,
          timestamped({
            kind: "memory_preview",
            previewId,
            ...(this.policy.studyMode && this.policy.condition === "memosync"
              ? { taskId: this.getActiveStudyTaskId() ?? undefined }
              : {}),
            turn: ctx.turnNumber,
            task: args.memoryUserText ?? args.content,
            memories: ctx.injected.map((m) => ({ id: m.id, content: m.content, scope: m.scope })),


            ...(transferredIds.length ? { transferredIds } : {}),
            ...(willAssessRelevance ? { relevancePending: true } : {}),
            ...(attentionIds.length ? { attentionIds } : {}),
          })
        )

        const parked = this.pendingPreviews.get(args.chatId)
        if (parked && parked.previewId === previewId) parked.published = true


        if (willAssessRelevance) {
          const userText = args.memoryUserText ?? args.content


          const settle = async (relevant: RelevantMemory[]) => {
            const current = this.pendingPreviews.get(args.chatId)


            if (current?.previewId !== previewId || current.revision !== 0) return
            const selectedIds = [...new Set([...attentionIds, ...relevant.map((item) => item.id)])]
            const expectedUses = await this.resolveExpectedUses(userText, ctx.injected, selectedIds, relevant)
            const stillCurrent = this.pendingPreviews.get(args.chatId)
            if (stillCurrent?.previewId !== previewId || stillCurrent.revision !== 0) return
            for (const use of expectedUses) stillCurrent.expectedUseById.set(use.id, use.expectedUse)
            if (relevant.length > 0) {
              this.memory!.logger.event({
                type: "memory.relevance",
                sessionId: args.chatId,
                turn: ctx.turnNumber,
                ids: relevant.map((r) => r.id),
              })
            }
            this.turnExpectedUses.set(args.chatId, expectedUses)
            await this.store.appendMessage(
              args.chatId,
              timestamped({ kind: "memory_preview_relevance", previewId, revision: 0, relevant: relevant.map(({ id, why }) => ({ id, why })), expectedUses })
            )
            this.emitStateChange(args.chatId)
          }
          void this.assessWorkingMemory(args, ctx.injected, attentionIds)
            .then(settle)
            .catch(() => this.memoryBranches
              ? this.reportWorkingMemoryFailure(args.chatId, previewId, 0)
              : settle([]).catch(() => {}))
        }
        if (autoProceed) {


          if (this.cancelledDuringPreview.delete(args.chatId)) {
            this.emitStateChange(args.chatId, { immediate: true })
            return
          }


          await this.store.appendMessage(
            args.chatId,
            timestamped({ kind: "memory_preview_decision", previewId, decision: "go_on", auto: true })
          )
          if (args.openingReview) automaticOpeningWorkingMemory = { previewId, decision: "go_on" }
          this.memory!.logger.event({
            type: "memory.preview",
            sessionId: args.chatId,
            engine: args.provider,
            turn: ctx.turnNumber,
            memoryIds,
            decision: "auto_go_on",
          })
        } else if (this.cancelledDuringPreview.delete(args.chatId)) {


          if (this.pendingPreviews.get(args.chatId)?.previewId === previewId) {
            this.pendingPreviews.delete(args.chatId)
            gated = false
          }
          this.emitStateChange(args.chatId, { immediate: true })
          return
        }
        this.emitStateChange(args.chatId, { immediate: true })
      } catch (error) {
        const cancelled = this.cancelledDuringPreview.delete(args.chatId)
        if (!cancelled) {
          this.reportBackgroundError?.(
            `[memory-preview] chat ${args.chatId} turn ${ctx.turnNumber}: ${error instanceof Error ? error.message : String(error)}`
          )
        }


        if (claimed) return
        if (cancelled) {
          this.pendingPreviews.delete(args.chatId)
          return
        }
        if (args.openingReview || this.memoryBranches) {


          this.pendingPreviews.delete(args.chatId)
          throw error
        }

        this.pendingPreviews.delete(args.chatId)
        gated = false
      }
      if (gated) return
      await this.bootEngineTurn(
        automaticOpeningWorkingMemory ? { ...args, openingWorkingMemory: automaticOpeningWorkingMemory } : args,
        {
        chat: ctx.chat,
        project: ctx.project,
        turnNumber: ctx.turnNumber,
        memoryDisabledForTurn: false,
        },
      )
    } catch (error) {


      this.restoreUndeliveredEnforcement(args.chatId)
      const message = error instanceof Error ? error.message : String(error)
      try {
        await this.store.appendMessage(
          args.chatId,
          timestamped({ kind: "result", subtype: "error", isError: true, durationMs: 0, result: message })
        )
        await this.store.recordTurnFailed(args.chatId, message)
      } finally {
        if (args.openingReview) this.scheduleOpeningBoardRecovery(args.openingReview.taskId)
        this.emitStateChange(args.chatId)
      }
    } finally {


      this.startingChats.delete(args.chatId)
      const activePreparation = this.activePreparations.get(args.chatId)
      this.activePreparations.delete(args.chatId)

      this.cancelledDuringPreview.delete(args.chatId)

      activePreparation?.cancellation.settle()
      if (!this.pendingPreviews.has(args.chatId) && !this.activeTurns.has(args.chatId)) this.disposeMemoryBranches(args.chatId)
    }
  }


  private async finishMemoryPreview(ctx: {
    args: StartTurnArgs
    chat: ReturnType<EventStore["requireChat"]>
    project: NonNullable<ReturnType<EventStore["getProject"]>>
    turnNumber: number
    previewId: string

    memoryIds: string[]
    decision: MemoryPreviewDecision

    selectedIds?: string[]

    expectedUses?: ExpectedMemoryUse[]
    controlOperation?: PreviewControlOperation
  }) {
    const { args, decision } = ctx
    try {
      const selected = new Set(ctx.selectedIds ?? ctx.memoryIds)
      const expectedUses = (ctx.expectedUses ?? this.turnExpectedUses.get(args.chatId) ?? [])
        .filter((use) => selected.has(use.id) && typeof use.expectedUse === "string" && use.expectedUse.trim())
        .map((use) => ({ id: use.id, expectedUse: use.expectedUse.trim().slice(0, 220) }))
      await this.store.appendMessage(
        args.chatId,
        timestamped({ kind: "memory_preview_decision", previewId: ctx.previewId, decision, selectedIds: ctx.selectedIds, expectedUses })
      )
      this.memory?.logger.event({
        type: "memory.preview",
        ...(ctx.controlOperation ? { operationId: ctx.controlOperation.operationId } : {}),
        sessionId: args.chatId,
        engine: args.provider,
        turn: ctx.turnNumber,
        memoryIds: ctx.memoryIds,
        decision,
        selectedIds: ctx.selectedIds,
      })


      if (decision === "go_on" && ctx.selectedIds) {
        this.turnMemoryRestriction.set(args.chatId, ctx.selectedIds)
      }
      if (decision === "go_on" && expectedUses.length) {
        this.turnExpectedUses.set(args.chatId, expectedUses)
      }
      if (decision !== "go_on") this.turnExpectedUses.delete(args.chatId)

      if (decision === "dismiss") {
        this.restoreUndeliveredEnforcement(args.chatId)
        this.disposeMemoryBranches(args.chatId)
        await this.store.recordTurnCancelled(args.chatId)
        if (ctx.controlOperation) {
          try {
            this.memory?.logger.event({
              type: "study.control_operation",
              ...ctx.controlOperation,
              phase: "completed",
            })
          } catch {

          }
        }


        this.releasePendingPreviewResponse(args.chatId, ctx.previewId)
        this.emitStateChange(args.chatId, { immediate: true })
        await this.maybeStartNextQueuedMessage(args.chatId)
        return
      }

      this.emitStateChange(args.chatId)
      const providerArgs = args.openingReview && (decision === "go_on" || decision === "without_memory")
        ? { ...args, openingWorkingMemory: { previewId: ctx.previewId, decision } }
        : args
      await this.bootEngineTurn(this.refreshOpeningProviderAttachments(providerArgs), {
        chat: ctx.chat,
        project: ctx.project,
        turnNumber: ctx.turnNumber,
        memoryDisabledForTurn: decision === "without_memory",
      })
      if (ctx.controlOperation) {
        try {
          this.memory?.logger.event({
            type: "study.control_operation",
            ...ctx.controlOperation,
            phase: "completed",
          })
        } catch {

        }
      }
    } catch (error) {
      this.restoreUndeliveredEnforcement(args.chatId)
      if (ctx.controlOperation) {
        try {
          this.memory?.logger.event({
            type: "study.control_operation",
            ...ctx.controlOperation,
            phase: "failed",
            errorClass: error instanceof Error ? error.constructor.name : typeof error,
          })
        } catch {

        }
      }


      const message = error instanceof Error ? error.message : String(error)
      await this.store.appendMessage(
        args.chatId,
        timestamped({ kind: "result", subtype: "error", isError: true, durationMs: 0, result: message })
      )
      await this.store.recordTurnFailed(args.chatId, message)
      this.emitStateChange(args.chatId)
    } finally {
      this.releasePendingPreviewResponse(args.chatId, ctx.previewId)
    }
  }


  private refreshOpeningProviderAttachments(args: StartTurnArgs): StartTurnArgs {
    if (!args.openingReview || !this.openingBoardBacklog) return args
    const recovered = this.openingBoardBacklog.recoverOpeningPrompt(args.openingReview.taskId)
    if (
      !recovered
      || recovered.chatId !== args.chatId
      || recovered.reviewId !== args.openingReview.reviewId
    ) {
      throw new Error("The immutable opening attachment receipt is no longer available")
    }
    if (recovered.attachmentFailure) throw new Error(recovered.attachmentFailure)
    return { ...args, providerAttachments: recovered.providerAttachments }
  }


  private async bootEngineTurn(
    args: StartTurnArgs,
    ctx: {
      chat: ReturnType<EventStore["requireChat"]>
      project: NonNullable<ReturnType<EventStore["getProject"]>>
      turnNumber: number
      memoryDisabledForTurn: boolean
    }
  ) {
    const { chat, project, turnNumber, memoryDisabledForTurn } = ctx
    this.disposeMemoryBranches(args.chatId)
    const turnRestriction = args.resume?.selectedIds ?? this.turnMemoryRestriction.get(args.chatId)
    const providerAttachments = args.providerAttachments ?? args.attachments


    await ensureProjectDirectory(project.localPath)


    const turnMemoryPlan =
      this.memory && !memoryDisabledForTurn
        ? planMemoryInjection({
            policy: this.policy,
            provider: args.provider,
            memory: this.memory,
            projectId: chat.projectId,
            chatId: args.chatId,
            workspaceDir: project.localPath,
            restrictToIds: turnRestriction,
          })
        : null
    const injectedIdsAtBoot = turnMemoryPlan?.injectedMemories.map((m) => m.id) ?? []

    const onToolRequest = async (request: HarnessToolRequest): Promise<unknown> => {
      const active = this.activeTurns.get(args.chatId)
      if (!active) {
        throw new Error("Chat turn ended unexpectedly")
      }

      active.status = "waiting_for_user"
      this.emitStateChange(args.chatId)

      return await new Promise<unknown>((resolve) => {
        active.pendingTool = {
          toolUseId: request.tool.toolId,
          tool: request.tool,
          resolve,
        }
      })
    }

    let turn: HarnessTurn
    if (args.provider === "claude") {
      logSendToStartingProfile(args.profile, "start_turn.provider_boot.begin", {
        chatId: args.chatId,
        provider: args.provider,
        model: args.model,
      })
      turn = await this.startClaudeTurn({
        chatId: args.chatId,
        localPath: project.localPath,
        model: args.model,
        effort: args.effort,
        planMode: args.planMode,
        sessionToken: chat.pendingForkSessionToken ?? chat.sessionToken,
        forkSession: Boolean(chat.pendingForkSessionToken),
        onToolRequest,
        projectId: chat.projectId,
        memoryEnabled: !memoryDisabledForTurn,
        memoryPlan: turnMemoryPlan,
        restrictMemoryIds: turnRestriction,
      })
      logSendToStartingProfile(args.profile, "start_turn.provider_boot.ready", {
        chatId: args.chatId,
        provider: args.provider,
        model: args.model,
      })
    } else {
      logSendToStartingProfile(args.profile, "start_turn.provider_boot.begin", {
        chatId: args.chatId,
        provider: args.provider,
        model: args.model,
      })


      const codexPlan: MemoryInjectionPlan | null =
        this.memory && !memoryDisabledForTurn
          ? planMemoryInjection({
              policy: this.policy,
              provider: "codex",
              memory: this.memory,
              projectId: chat.projectId,
              chatId: args.chatId,
              workspaceDir: project.localPath,
              restrictToIds: turnRestriction,
            })
          : null


      const codexMemorySpecs =
        this.memory && this.policy.memoryTools
          ? buildMemoryToolSpecs(this.memory, {
              capture: this.capture,
              onProposed: (created, info) => {


                const autoIds = info?.resurfaced ? new Set<string>() : this.autoApplyProposals(created, { chatId: args.chatId })
                const autoApplied = created.filter(({ id }) => autoIds.has(id))
                if (!autoApplied.length) return
                void this.store
                  .appendMessage(
                    args.chatId,
                    timestamped({
                      kind: "memory_candidates",
                      candidates: autoApplied.map(({ id }) => ({ id, auto: true })),
                    })
                  )
                  .then(() => this.emitStateChange(args.chatId))
                  .catch(() => {})
              },
            })
          : []
      const codexSelected = new Set(codexPlan?.injectedMemories.map(item => item.id) ?? [])
      const expectedUses = (this.turnExpectedUses.get(args.chatId) ?? []).filter(use => codexSelected.has(use.id))
      const enforced = (this.turnPayAttention.get(args.chatId) ?? []).filter(item => codexSelected.has(item.id))
      const codexMemoryBlock = [
        codexPlan?.block ?? "",
        expectedUses.length ? `How the selected memories are expected to guide this turn:\n${expectedUses.map(use => `[${use.id}] ${use.expectedUse}`).join("\n")}` : "",
        ...enforced.map(item => `ENFORCED THIS RUN: [${item.id}] MUST be followed.${item.quote ? ` Previous violation: ${item.quote}` : ""}`),
        args.resume ? `RESUMING AN INTERRUPTED TURN: continue the existing conversation and completed work. Correction: ${args.resume.correction}` : "",
        args.resume?.enforce ? `ENFORCED THIS RUN: [${args.resume.memoryId}] MUST be followed. ${args.resume.correction}` : "",
      ].filter(Boolean).join("\n\n")
      if (args.resume?.enforce && !codexSelected.has(args.resume.memoryId)) throw new Error("The enforced memory is no longer in Working Memory")
      if (this.memory && codexPlan && codexMemoryBlock) {
        this.memory.logger.event({
          type: "memory.inject",
          sessionId: args.chatId,
          engine: "codex",
          memories: codexPlan.injectedMemories.map((m) => ({ id: m.id, scope: m.scope })),
          tokenEstimate: Math.ceil(codexMemoryBlock.length / 4),
          mode: codexPlan.mode,
          staticFiles: codexPlan.staticFiles.length ? codexPlan.staticFiles : undefined,
        })
      }
      const onDynamicToolCall = codexMemorySpecs.length && !memoryDisabledForTurn
        ? async (name: string, toolArgs: Record<string, unknown>) => {
            const r = await dispatchMemoryTool(codexMemorySpecs, name, toolArgs, {
              projectId: chat.projectId,
              sessionId: args.chatId,
              turn: turnNumber,
              engine: "codex",
              allowedMemoryIds: codexPlan?.injectedMemories.map(item => item.id) ?? [],
            })
            return { text: r.text, isError: r.isError }
          }
        : undefined
      const sessionToken = await this.codexManager.startSession({
        chatId: args.chatId,
        cwd: project.localPath,
        model: args.model,
        serviceTier: args.serviceTier,
        sessionToken: chat.sessionToken,
        pendingForkSessionToken: chat.pendingForkSessionToken,
        dynamicTools: codexMemorySpecs.length ? toCodexDynamicTools(codexMemorySpecs) : undefined,
      })
      if (chat.pendingForkSessionToken && sessionToken) {
        await this.store.setPendingForkSessionToken(args.chatId, null)
      }
      logSendToStartingProfile(args.profile, "start_turn.session_ready", {
        chatId: args.chatId,
        provider: args.provider,
        model: args.model,
      })
      turn = await this.codexManager.startTurn({
        chatId: args.chatId,
        content: buildPromptText(args.content, providerAttachments),
        model: args.model,
        effort: args.effort as any,
        serviceTier: args.serviceTier,
        planMode: args.planMode,
        onToolRequest,
        developerInstructions: codexMemoryBlock || undefined,
        onDynamicToolCall,
      })
      this.turnPayAttention.delete(args.chatId)
      args.onMemoryDeliveryAccepted?.(codexPlan?.injectedMemories.map(item => item.id) ?? [])
      logSendToStartingProfile(args.profile, "start_turn.provider_boot.ready", {
        chatId: args.chatId,
        provider: args.provider,
        model: args.model,
      })
    }

    const active: ActiveTurn = {
      chatId: args.chatId,
      provider: args.provider,
      turn,
      model: args.model,
      effort: args.effort,
      serviceTier: args.serviceTier,
      planMode: args.planMode,
      status: args.provider === "claude" ? "running" : "starting",
      pendingTool: null,
      postToolFollowUp: null,
      hasFinalResult: false,
      cancelRequested: false,
      cancelRecorded: false,
      providerTurnStarted: false,
      clientTraceId: args.profile?.traceId,
      profilingStartedAt: args.profile?.startedAt,
      turnNumber,
      turnId: args.turnId!,
      taskId: this.getActiveStudyTaskId(),
      memoryPlan: turnMemoryPlan,

      userText: args.memoryUserText ?? args.content,
      assistantChunks: [],
      citedIds: new Set<string>(),
      memoryDisabled: memoryDisabledForTurn,
      memoryDeliveryAccepted: args.provider === "codex",
      injectedIds: injectedIdsAtBoot,
    }
    this.activeTurns.set(args.chatId, active)
    if (active.taskId) {
      const taskChats = this.studyTaskChats.get(active.taskId) ?? new Set<string>()
      taskChats.add(args.chatId)
      this.studyTaskChats.set(active.taskId, taskChats)
      const taskPaths = this.studyTaskProjectPaths.get(active.taskId) ?? new Set<string>()
      taskPaths.add(project.localPath)
      this.studyTaskProjectPaths.set(active.taskId, taskPaths)
    }
    logSendToStartingProfile(args.profile, "start_turn.active_turn_registered", {
      chatId: args.chatId,
      status: active.status,
    })
    this.emitStateChange(args.chatId, { immediate: active.status === "starting" })
    logSendToStartingProfile(args.profile, "start_turn.state_change_emitted", {
      chatId: args.chatId,
      status: active.status,
    })

    if (turn.getAccountInfo) {
      void turn.getAccountInfo()
        .then(async (accountInfo) => {
          if (!accountInfo) return
          if (args.provider === "claude") {
            const session = this.claudeSessions.get(args.chatId)
            if (session) {
              if (session.accountInfoLoaded) return
              session.accountInfoLoaded = true
            } else {
              return
            }
          }
          await this.store.appendMessage(args.chatId, timestamped({ kind: "account_info", accountInfo }))
          this.emitStateChange(args.chatId)
        })
        .catch(() => undefined)
    }

    if (args.provider === "claude") {
      const session = this.claudeSessions.get(args.chatId)
      if (!session) {
        throw new Error("Claude session was not initialized")
      }


      let promptText = buildPromptText(args.content, providerAttachments)
      let deliveredFocusIds = [...active.injectedIds]
      let deliveredVisiblePool = active.memoryPlan?.bakedMemories ?? []
      let deliveredFocusedMemories = active.memoryPlan?.injectedMemories ?? []
      let deliveredExpectedUses: ExpectedMemoryUse[] = []
      let deliveredResumeInterruptId: string | undefined
      let nextMemoryBaseline: Map<string, number> | null = null
      const repeatedFocusText = active.memoryPlan?.mode === "plain" || active.memoryPlan?.mode === "file"
        ? active.memoryPlan.block
        : ""
      if (repeatedFocusText) {
        promptText += `\n\n<system-reminder>\n${repeatedFocusText}\n</system-reminder>`
      }
      if (session.memoryBaseline && this.memory) {
        const delta = computeMemoryTurnDelta({
          memory: this.memory,
          projectId: chat.projectId,
          chatId: args.chatId,
          baseline: session.memoryBaseline,
          restrictToIds: turnRestriction,
        })


        nextMemoryBaseline = delta.nextBaseline
        deliveredFocusIds = delta.effectiveIds
        deliveredVisiblePool = delta.visibleMemories
        deliveredFocusedMemories = delta.effectiveMemories
        const reminderParts: string[] = []
        if (delta.block) reminderParts.push(delta.block)


        const turnRestrictionForEnforce = turnRestriction
        const payAttention = (this.turnPayAttention.get(args.chatId) ?? []).filter(
          (e) => turnRestrictionForEnforce === undefined || turnRestrictionForEnforce.includes(e.id),
        )
        if (payAttention.length) {
          reminderParts.push(
            payAttention
              .map(
                (e) =>
                  `ENFORCED THIS RUN: [${e.id}] MUST be followed — the user explicitly enforced it after it was violated on the previous turn.` +
                  (e.quote ? ` Evidence of that violation: "${e.quote}"` : ""),
              )
              .join("\n"),
          )
        }


        const resumeCtx = args.resume
        deliveredResumeInterruptId = resumeCtx?.interruptId
        if (resumeCtx) {
          if (resumeCtx.enforce) {
            if (!deliveredFocusIds.includes(resumeCtx.memoryId)) {


              if (this.activeTurns.get(args.chatId) === active) this.activeTurns.delete(args.chatId)
              this.startingChats.delete(args.chatId)
              active.turn.close()
              this.emitStateChange(args.chatId, { immediate: true })
              throw new Error("The enforced memory is no longer in the current chat's effective Working Memory")
            }
            reminderParts.push(
              `ENFORCED THIS RUN: [${resumeCtx.memoryId}] MUST be followed — the user explicitly enforced it while recovering an interrupted turn.` +
                (resumeCtx.quote ? ` Evidence of that violation: "${resumeCtx.quote}"` : "") +
                (resumeCtx.correction ? ` Required correction: "${resumeCtx.correction}"` : ""),
            )
          }
          const selectionNote = deliveredFocusIds.includes(resumeCtx.memoryId)
            ? ""
            : ` [${resumeCtx.memoryId}] was removed from this turn's working memory.`
          reminderParts.push(
            "RESUMING AN INTERRUPTED TURN: your previous reply above was stopped by the user midway " +
              `after they identified a problem involving [${resumeCtx.memoryId}]. Do not redo work that already completed; ` +
              `continue from where it stopped.${selectionNote} Participant correction: ${resumeCtx.correction}`,
          )
        }
        const expectedUses = (this.turnExpectedUses.get(args.chatId) ?? []).filter(use => deliveredFocusIds.includes(use.id))
        if (this.memoryBranches) this.turnExpectedUses.set(args.chatId, expectedUses)
        else this.turnExpectedUses.delete(args.chatId)
        if (expectedUses?.length) {
          deliveredExpectedUses = expectedUses
          const detailIds = this.policy.memoryTools
            ? expectedUses.filter((use) => Boolean(this.memory!.store.getById(use.id)?.detail)).map((use) => use.id)
            : []
          const withDetail = new Set(detailIds)
          reminderParts.push(
            "How the selected memories are expected to guide this turn:\n" +
              expectedUses
                .map((use) => `- [${use.id}]${withDetail.has(use.id) ? " [+detail]" : ""} ${use.expectedUse}`)
                .join("\n") +
              (detailIds.length
                ? ` Load the [+detail] ones (${detailIds.map((id) => `[${id}]`).join(", ")}) with load_memory_detail before relying on them.`
                : ""),
          )
        }


        const memoryBearingTurn =
          this.policy.memoryTools && (turnRestriction === undefined || turnRestriction.length > 0)
        if (memoryBearingTurn) {
          reminderParts.push(CITE_NUDGE)


          const injectedNow = this.memory!.injectedFor(chat.projectId, args.chatId)
          if (injectedNow.some((m) => m.detail && (turnRestriction === undefined || turnRestriction.includes(m.id)))) {
            reminderParts.push(DETAIL_NUDGE)
          }
        }
        if (this.capture && this.policy.memoryTools) reminderParts.push(CAPTURE_NUDGE)
        if (reminderParts.length > 0) {
          promptText += `\n\n<system-reminder>\n${reminderParts.join("\n\n")}\n</system-reminder>`
        }
      }
      const promptSeq = session.nextPromptSeq + 1
      session.nextPromptSeq = promptSeq
      session.pendingPromptSeqs.push(promptSeq)
      active.claudePromptSeq = promptSeq
      logClaudeSteer("claude_prompt_sent", {
        chatId: args.chatId,
        sessionId: session.id,
        promptSeq,
        activeStatus: active.status,
        contentPreview: args.content.slice(0, 160),
        pendingPromptSeqs: [...session.pendingPromptSeqs],
      })
      const openingFocusDelivery = args.openingReview && args.openingWorkingMemory && this.memory
        ? buildDeliveredStoreFocusEvent({
            condition: "memosync",
            taskId: active.taskId,
            chatId: args.chatId,
            turnId: active.turnId,
            turn: active.turnNumber ?? turnNumber,
            mode: "skills",
            promptText,
            visiblePool: deliveredVisiblePool,
            focusedMemories: deliveredFocusedMemories,
            expectedUses: deliveredExpectedUses,
            disabled: active.memoryDisabled,
            resumeOfInterruptId: deliveredResumeInterruptId,
          })
        : null
      const openingProviderDispatch = args.openingReview && args.openingWorkingMemory
        ? {
            taskId: args.openingReview.taskId,
            chatId: args.chatId,
            reviewId: args.openingReview.reviewId,
            phase: "completed" as const,
            previewId: args.openingWorkingMemory.previewId,
            decision: args.openingWorkingMemory.decision,
            ...(openingFocusDelivery ? { focusDelivery: openingFocusDelivery } : {}),
          }
        : null
      if (openingProviderDispatch) {
        const claim = this.openingBoardBacklog?.claimOpeningProviderDispatch(openingProviderDispatch)
        if (claim !== "claimed") {
          throw new Error(`Opening prompt provider dispatch is already ${claim ?? "unavailable"}`)
        }
      }
      try {
        await session.session.sendPrompt(promptText, {
          allowedMemoryIds: deliveredFocusIds,
          turn: active.turnNumber ?? turnNumber,
          engine: "claude",
          promptSeq,
        })
      } catch (error) {
        try {
          if (openingProviderDispatch) {
            this.openingBoardBacklog!.settleOpeningProviderDispatch(openingProviderDispatch, "failed")
          }
        } finally {


          if (this.activeTurns.get(args.chatId) === active) {
            this.activeTurns.delete(args.chatId)
          }
          if (this.claudeSessions.get(args.chatId) === session) {
            this.claudeSessions.delete(args.chatId)
          }
          this.clearStreamingAssistantText(args.chatId)
          session.session.close()
          active.turn.close()
          this.emitStateChange(args.chatId, { immediate: true })
        }
        throw error
      }
      if (openingProviderDispatch) {
        this.openingBoardBacklog!.settleOpeningProviderDispatch(openingProviderDispatch, "delivered")
      }
      if (nextMemoryBaseline) session.memoryBaseline = nextMemoryBaseline
      active.memoryDeliveryAccepted = true
      this.turnPayAttention.delete(args.chatId)
      active.injectedIds = deliveredFocusIds
      if (active.memoryPlan) active.memoryPlan = { ...active.memoryPlan, injectedMemories: deliveredFocusedMemories.map(item => ({ ...item })) }
      args.onMemoryDeliveryAccepted?.([...deliveredFocusIds])
      if (this.memory && (this.policy.condition === "memosync" || this.policy.condition === "auto")) {
        try {
          if (openingFocusDelivery) {
            persistDeliveredStoreFocusEvent({
              event: openingFocusDelivery,
              condition: "memosync",
              logger: this.memory.logger,
              studyStore: this.studyMemoryStore ?? undefined,
            })
          } else {
            recordDeliveredStoreFocus({
              logger: this.memory.logger,
              studyStore: this.studyMemoryStore ?? undefined,
              condition: this.policy.condition,
              taskId: active.taskId,
              chatId: args.chatId,
              turnId: active.turnId,
              turn: active.turnNumber ?? turnNumber,
              mode: this.policy.condition === "memosync" ? "skills" : "plain",
              promptText,
              visiblePool: deliveredVisiblePool,
              focusedMemories: deliveredFocusedMemories,
              getAutoProjectCloneRef: this.policy.condition === "auto"
                ? (memoryId) => this.memory!.getAutoProjectCloneRef(memoryId)
                : undefined,
              expectedUses: this.policy.condition === "memosync" ? deliveredExpectedUses : undefined,
              disabled: active.memoryDisabled,
              focusPayloadText: repeatedFocusText || undefined,
              resumeOfInterruptId: deliveredResumeInterruptId,
            })
          }
        } catch (error) {
          if (active.taskId) {
            this.noteStudyMemoryQualityFlag({
              code: "focus_persistence_failed",
              blocking: true,
              taskId: active.taskId,
              chatId: args.chatId,
              turnId: active.turnId,
              turn: active.turnNumber ?? turnNumber,
            })
          }
          this.reportBackgroundError?.(
            `[study-focus] chat ${args.chatId} turn ${active.turnNumber ?? turnNumber}: ${error instanceof Error ? error.message : String(error)}`
          )
        }
      } else if (this.policy.condition === "static") {
        this.launchStaticFocusMaterialization({
          taskId: active.taskId,
          projectId: chat.projectId,
          chatId: args.chatId,
          turnId: active.turnId,
          turn: active.turnNumber ?? turnNumber,
          promptText,
          plan: active.memoryPlan,
        })
      }
      logSendToStartingProfile(args.profile, "start_turn.claude_prompt_sent", {
        chatId: args.chatId,
      })
      return
    }

    void this.runTurn(active)
  }

  private async startClaudeTurn(args: {
    chatId: string
    localPath: string
    model: string
    effort?: string
    planMode: boolean
    sessionToken: string | null
    forkSession: boolean
    onToolRequest: (request: HarnessToolRequest) => Promise<unknown>
    projectId?: string

    memoryEnabled?: boolean

    memoryPlan?: MemoryInjectionPlan | null

    restrictMemoryIds?: string[]
  }): Promise<HarnessTurn> {


    await this.prepareStudyProjectRuntime(args.localPath)
    let session = this.claudeSessions.get(args.chatId)
    const memoryEnabled = args.memoryEnabled ?? true
    const subprocessEnv = buildClaudeSubprocessEnv({
      localPath: args.localPath,
      rawStudyProjects: this.policy.studyMode ? process.env.STUDY_PROJECTS : undefined,
    })
    const runtimeEnv: Record<string, string | undefined> = buildClaudeSdkRuntimeOptions({ requestedModel: args.model, env: subprocessEnv }).env


    const providerRuntimeKey = String(Bun.hash(JSON.stringify([
      runtimeEnv.ANTHROPIC_BASE_URL ?? "official",
      runtimeEnv.ANTHROPIC_API_KEY, runtimeEnv.ANTHROPIC_AUTH_TOKEN,
      runtimeEnv.CLAUDE_CONFIG_DIR,
    ])))


    const turnPlan = args.memoryPlan !== undefined
      ? args.memoryPlan
      : memoryEnabled && this.memory
        ? planMemoryInjection({
            policy: this.policy,
            provider: "claude",
            memory: this.memory,
            projectId: args.projectId,
            chatId: args.chatId,
            workspaceDir: args.localPath,
            restrictToIds: args.restrictMemoryIds,
          })
        : null
    const desiredMemoryHash = turnPlan?.sessionRebuildKey ?? "memory-off"
    if (
      !session ||
      session.retired ||
      session.localPath !== args.localPath ||
      session.effort !== args.effort ||
      session.memorySetHash !== desiredMemoryHash ||
      session.providerRuntimeKey !== providerRuntimeKey ||
      args.forkSession
    ) {
      let resumeToken = session?.sessionToken ?? args.sessionToken


      if (resumeToken && !this.claudeSessionFileExists(args.localPath, resumeToken)) {
        console.warn(
          `[claude] resume token for chat ${args.chatId} has no session file (recreated container?) — starting fresh`,
        )
        resumeToken = null
        await this.store.setSessionToken(args.chatId, null)
      }
      if (session) {
        await this.retireClaudeSession(session, "session_rebuild")
      }

      const started = await this.startClaudeSessionFn({
        localPath: args.localPath,
        model: args.model,
        effort: args.effort,
        planMode: args.planMode,
        sessionToken: resumeToken,
        forkSession: args.forkSession,
        onToolRequest: args.onToolRequest,
        memory: memoryEnabled ? this.memory : null,
        capture: memoryEnabled ? this.capture : null,
        projectId: args.projectId,
        chatId: args.chatId,
        policy: this.policy,
        studyPreviewRuntime: this.studyPreviewRuntime,
        subprocessEnv,
        memoryPlan: turnPlan,
        restrictMemoryIds: args.restrictMemoryIds,


        onMemoryProposal: (created) => {
          const autoIds = this.autoApplyProposals(created, { chatId: args.chatId })
          const autoApplied = created.filter(({ id }) => autoIds.has(id))
          if (!autoApplied.length) return
          void this.store
            .appendMessage(
              args.chatId,
              timestamped({
                kind: "memory_candidates",
                candidates: autoApplied.map(({ id }) => ({ id, auto: true })),
              })
            )
            .then(() => this.emitStateChange(args.chatId))
            .catch(() => {})
        },
      })
      this.refreshClaudeModelCatalog(started)


      const bootPlan = started.memoryPlan !== undefined ? started.memoryPlan : turnPlan
      session = {
        id: crypto.randomUUID(),
        chatId: args.chatId,
        session: started,
        localPath: args.localPath,
        model: args.model,
        effort: args.effort,
        planMode: args.planMode,
        sessionToken: resumeToken,
        accountInfoLoaded: false,
        nextPromptSeq: 0,
        pendingPromptSeqs: [],
        retired: false,
        retireReason: null,
        pump: null,
        memorySetHash: desiredMemoryHash,
        providerRuntimeKey,
        memoryBaseline:
          bootPlan?.mode === "skills"
            ? new Map(bootPlan.bakedMemories.map((m) => [m.id, m.version]))
            : null,
      }
      this.claudeSessions.set(args.chatId, session)
      session.pump = this.runClaudeSession(session)
    } else {
      if (session.model !== args.model) {
        await session.session.setModel(args.model)
        session.model = args.model
      }
      if (session.planMode !== args.planMode) {
        await session.session.setPermissionMode(args.planMode)
        session.planMode = args.planMode
      }
    }

    return {
      provider: "claude",
      stream: {
        async *[Symbol.asyncIterator]() {},
      },
      getAccountInfo: session.session.getAccountInfo,
      interrupt: session.session.interrupt,
      close: () => {},
    }
  }

  async send(command: Extract<ClientCommand, { type: "chat.send" }>) {
    const profile = command.clientTraceId
      ? { traceId: command.clientTraceId, startedAt: performance.now() }
      : null
    let chatId = command.chatId

    logSendToStartingProfile(profile, "chat_send.received", {
      existingChatId: command.chatId ?? null,
      projectId: command.projectId ?? null,
    })


    this.assertStudyPromptAllowed({
      chatId,
      projectId: command.projectId,
      channel: "chat.send",
      content: command.content,
      attachments: command.attachments,
      openingReviewId: command.openingReviewId,
    })

    if (!chatId) {
      if (!command.projectId) {
        throw new Error("Missing projectId for new chat")
      }
      const created = await this.store.createChat(command.projectId)
      chatId = created.id
      logSendToStartingProfile(profile, "chat_send.chat_created", {
        chatId,
        projectId: command.projectId,
      })
    }


    this.assertStudyPromptAllowed({
      chatId,
      content: command.content,
      channel: "chat.send",
      attachments: command.attachments,
      openingReviewId: command.openingReviewId,
    })

    const chat = this.store.requireChat(chatId)
    const provider = this.resolveProvider(command, chat.provider)
    let openingReview: StartTurnArgs["openingReview"]
    if (command.openingReviewId) {
      const taskId = this.getActiveStudyTaskId()
      if (
        !taskId
        || !this.openingBoardBacklog
        || !this.policy.studyMode
        || this.policy.condition !== "memosync"
        || provider !== "claude"
      ) {
        throw new Error("Opening Memory Board prompt preparation is unavailable")
      }
      const openingInput = {
        taskId,
        chatId,
        reviewId: command.openingReviewId,
        content: command.content,
        attachments: command.attachments ?? [],
      }
      if (this.openingBoardBacklog.claimOpeningPromptDispatch(openingInput) === "duplicate") {
        return { chatId, openingReviewDuplicate: true as const }
      }
      openingReview = { taskId, reviewId: command.openingReviewId }
    }
    if (
      this.activeTurns.has(chatId)
      || this.hasPendingPreviewActivity(chatId)
      || this.startingChats.has(chatId)
      || this.pendingAutoCaptureStarts.has(chatId)
    ) {
      if (openingReview) throw new Error("The opening first message cannot be queued behind another turn")
      const queuedMessage = await this.enqueueMessage(chatId, command.content, command.attachments ?? [], {
        provider: command.provider,
        model: command.model,
        modelOptions: command.modelOptions,
        effort: command.effort,
        planMode: command.planMode,
      })
      return { chatId, queuedMessageId: queuedMessage.id, queued: true as const }
    }

    const settings = this.getProviderSettings(provider, command)
    if (this.shouldQueueBehindAutoCapture(provider)) {
      const queuedMessage = await this.enqueueMessage(chatId, command.content, command.attachments ?? [], {
        provider: command.provider,
        model: command.model,
        modelOptions: command.modelOptions,
        effort: command.effort,
        planMode: command.planMode,
      })
      this.scheduleAutoCaptureQueueDrain(chatId, queuedMessage.id)
      logSendToStartingProfile(profile, "chat_send.ready_for_ack", {
        chatId,
        provider,
        model: settings.model,
        deferredForAutoCapture: true,
      })
      return { chatId, queuedMessageId: queuedMessage.id, queued: true as const }
    }

    await this.startTurnForChat({
      chatId,
      provider,
      content: command.content,
      attachments: command.attachments ?? [],
      model: settings.model,
      effort: settings.effort,
      serviceTier: settings.serviceTier,
      planMode: settings.planMode,
      appendUserPrompt: true,
      profile,
      openingReview,
      ...(openingReview ? { turnId: openingReview.reviewId } : {}),
    })

    logSendToStartingProfile(profile, "chat_send.ready_for_ack", {
      chatId,
      provider,
      model: settings.model,
    })

    return { chatId }
  }

  async enqueue(command: Extract<ClientCommand, { type: "message.enqueue" }>) {
    const queuedMessage = await this.enqueueMessage(command.chatId, command.content, command.attachments ?? [], {
      provider: command.provider,
      model: command.model,
      modelOptions: command.modelOptions,
      planMode: command.planMode,
    }, "message.enqueue")
    return { queuedMessageId: queuedMessage.id }
  }

  async steer(command: Extract<ClientCommand, { type: "message.steer" }>) {
    const queuedMessage = this.store.getQueuedMessage(command.chatId, command.queuedMessageId)
    if (!queuedMessage) {
      throw new Error("Queued message not found")
    }
    this.assertStudyPromptAllowed({
      chatId: command.chatId,
      content: queuedMessage.content,
      channel: "message.steer",
      attachments: queuedMessage.attachments,
    })

    logClaudeSteer("steer_requested", {
      chatId: command.chatId,
      queuedMessageId: command.queuedMessageId,
      activeTurn: this.activeTurns.has(command.chatId),
      queuedMessagePreview: queuedMessage.content.slice(0, 160),
    })


    const isBusy = () =>
      this.activeTurns.has(command.chatId)
      || this.hasPendingPreviewActivity(command.chatId)
      || this.startingChats.has(command.chatId)
      || this.pendingAutoCaptureStarts.has(command.chatId)

    if (isBusy()) {
      await this.cancel(command.chatId, { hideInterrupted: true })
    }

    logClaudeSteer("steer_after_cancel", {
      chatId: command.chatId,
      stillActive: this.activeTurns.has(command.chatId),
    })


    if (isBusy()) {
      throw new Error("Chat is still running")
    }

    await this.dequeueAndStartQueuedMessage(command.chatId, queuedMessage, { steered: true })
  }

  async dequeue(command: Extract<ClientCommand, { type: "message.dequeue" }>) {
    const queuedMessage = this.store.getQueuedMessage(command.chatId, command.queuedMessageId)
    if (!queuedMessage) {
      throw new Error("Queued message not found")
    }

    await this.store.removeQueuedMessage(command.chatId, command.queuedMessageId)
  }

  async forkChat(chatId: string) {
    const chat = this.store.requireChat(chatId)
    if (this.activeTurns.has(chatId) || this.drainingStreams.has(chatId)) {
      throw new Error("Chat must be idle before forking")
    }
    if (!chat.provider) {
      throw new Error("Chat must have a provider before forking")
    }
    if (!chat.sessionToken && !chat.pendingForkSessionToken) {
      throw new Error("Chat has no session to fork")
    }

    const forked = await this.store.forkChat(chatId)
    return { chatId: forked.id }
  }

  private async runClaudeSession(session: ClaudeSessionState) {
    try {
      for await (const event of session.session.stream) {
        if (session.retired) {
          this.reportBackgroundError?.(
            `[claude-retired-event] dropped ${event.entry?.kind ?? event.type} for chat ${session.chatId} after ${session.retireReason ?? "retirement"}`,
          )
          continue
        }
        const participantOrigin = event.origin === "human"
          || (!this.policy.studyMode && (event.origin === undefined || event.origin === "unknown"))
        if (!participantOrigin) {
          this.reportBackgroundError?.(
            `[claude-background-event] dropped ${event.entry?.kind ?? event.type} with origin ${event.origin} for chat ${session.chatId}`,
          )
          continue
        }
        if (event.type === "session_token" && event.sessionToken) {
          session.sessionToken = event.sessionToken
          await this.store.setSessionToken(session.chatId, event.sessionToken)
          this.emitStateChange(session.chatId)
          continue
        }

        if (event.type === "assistant_delta") {
          this.appendAssistantDelta(session.chatId, event)
          continue
        }

        if (!event.entry) continue
        if (event.entry.kind === "assistant_text" || event.entry.kind === "result" || event.entry.kind === "interrupted") {


          this.clearStreamingAssistantText(session.chatId)
        }
        await this.store.appendMessage(session.chatId, event.entry)
        const active = this.activeTurns.get(session.chatId)
        if (event.entry.kind === "compact_boundary") {


          this.memory?.logger.event({
            type: "turn.compacted",
            sessionId: session.chatId,
            engine: "claude",
            ...(active?.turnNumber !== undefined ? { turn: active.turnNumber } : {}),
          })
        }
        if (event.entry.kind === "assistant_text") {
          const counted = this.recordMemoryCitations(event.entry.text, session.chatId)
          if (active) {
            active.assistantChunks.push(event.entry.text)
            for (const id of counted) active.citedIds.add(id)
          }
        }
        if (event.entry.kind === "system_init" && active) {
          active.status = "running"
          active.providerTurnStarted = true


          if (active.claudePromptSeq !== undefined) {
            const activeSeq = active.claudePromptSeq
            const orphaned = session.pendingPromptSeqs.filter((seq) => seq < activeSeq)
            if (orphaned.length > 0) {
              const releasedOriginReservations = session.session
                .discardHumanTurnReservations?.(orphaned) ?? 0
              session.pendingPromptSeqs.splice(
                0,
                session.pendingPromptSeqs.length,
                ...session.pendingPromptSeqs.filter((seq) => seq >= activeSeq),
              )
              logClaudeSteer("claude_prompt_fifo_resync", {
                chatId: session.chatId,
                sessionId: session.id,
                activePromptSeq: activeSeq,
                droppedPromptSeqs: orphaned,
                releasedOriginReservations,
              })
            }
          }
          const chat = this.store.getChat(session.chatId)
          if (
            chat?.pendingForkSessionToken
            && session.sessionToken
            && session.sessionToken !== chat.pendingForkSessionToken
          ) {
            await this.store.setPendingForkSessionToken(session.chatId, null)
          }
          logClaudeSteer("claude_event_system_init", {
            chatId: session.chatId,
            sessionId: session.id,
            activePromptSeq: active.claudePromptSeq ?? null,
            pendingPromptSeqs: [...session.pendingPromptSeqs],
          })
        }

        const completedClaudePromptSeq = event.entry.kind === "result" || event.entry.kind === "interrupted"
          ? (session.pendingPromptSeqs.shift() ?? null)
          : null

        logClaudeSteer("claude_event", {
          chatId: session.chatId,
          sessionId: session.id,
          entryKind: event.entry.kind,
          eventOrigin: event.origin ?? "human",
          activePromptSeq: active?.claudePromptSeq ?? null,
          completedPromptSeq: completedClaudePromptSeq,
          activeStatus: active?.status ?? null,
          pendingPromptSeqs: [...session.pendingPromptSeqs],
        })

        if (event.entry.kind === "result" && active && completedClaudePromptSeq === (active.claudePromptSeq ?? null)) {
          active.hasFinalResult = true
          if (event.entry.isError) {
            await this.store.recordTurnFailed(session.chatId, event.entry.result || "Turn failed")
          } else if (!active.cancelRequested) {
            await this.store.recordTurnFinished(session.chatId)
            const chat = this.store.getChat(session.chatId)
            this.launchPostTurnMemoryPasses({
              chatId: session.chatId,
              projectId: chat?.projectId,
              engine: "claude",
              turnNumber: active.turnNumber,
              turnId: active.turnId,
              taskId: active.taskId,
              userText: active.userText ?? "",
              assistantText: active.assistantChunks.join("\n"),
              citedIds: [...active.citedIds],
              memoryDisabled: active.memoryDisabled,
              injectedIds: [...active.injectedIds],
              claudeSessionToken: chat?.sessionToken,
              localPath: chat?.projectId ? this.store.getProject(chat.projectId)?.localPath : undefined,
            })
          }
          this.activeTurns.delete(session.chatId)
          if (!active.cancelRequested) {


            try {
              await this.maybeStartNextQueuedMessage(session.chatId)
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error)
              await this.store.appendMessage(
                session.chatId,
                timestamped({ kind: "result", subtype: "error", isError: true, durationMs: 0, result: message }),
              )
              await this.store.recordTurnFailed(session.chatId, message)
            }
          }
        }

        this.emitStateChange(session.chatId)
      }
    } catch (error) {
      const active = this.activeTurns.get(session.chatId)
      if (active && !active.cancelRequested) {
        const message = error instanceof Error ? error.message : String(error)
        await this.store.appendMessage(
          session.chatId,
          timestamped({
            kind: "result",
            subtype: "error",
            isError: true,
            durationMs: 0,
            result: message,
          })
        )
        await this.store.recordTurnFailed(session.chatId, message)
      }
    } finally {


      const isCurrent = !session.retired && this.claudeSessions.get(session.chatId) === session


      if (isCurrent) this.clearStreamingAssistantText(session.chatId)
      if (isCurrent) this.claudeSessions.delete(session.chatId)
      const active = this.activeTurns.get(session.chatId)
      if (isCurrent && active?.provider === "claude") {
        if (active.cancelRequested && !active.cancelRecorded) {
          await this.store.recordTurnCancelled(session.chatId)
        }
        this.activeTurns.delete(session.chatId)
      }
      session.session.close()
      this.emitStateChange(session.chatId)
    }
  }

  private async generateTitleInBackground(chatId: string, messageContent: string, cwd: string, expectedCurrentTitle: string) {
    try {
      const result = await this.generateTitle(messageContent, cwd)
      if (result.failureMessage) {
        this.reportBackgroundError?.(
          `[title-generation] chat ${chatId} failed provider title generation: ${result.failureMessage}`
        )
      }
      if (!result.title || result.usedFallback) return

      const chat = this.store.requireChat(chatId)
      if (chat.title !== expectedCurrentTitle) return

      await this.store.renameChat(chatId, result.title)
      this.emitStateChange(chatId)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.reportBackgroundError?.(
        `[title-generation] chat ${chatId} failed background title generation: ${message}`
      )
    }
  }

  private async runTurn(active: ActiveTurn) {
    try {
      for await (const event of active.turn.stream) {


        if (active.cancelRequested) break

        if (event.type === "session_token" && event.sessionToken) {
          await this.store.setSessionToken(active.chatId, event.sessionToken)
          const chat = this.store.getChat(active.chatId)
          if (
            chat?.pendingForkSessionToken
            && event.sessionToken !== chat.pendingForkSessionToken
          ) {
            await this.store.setPendingForkSessionToken(active.chatId, null)
          }
          this.emitStateChange(active.chatId)
          continue
        }

        if (event.type === "assistant_delta") {
          this.appendAssistantDelta(active.chatId, event)
          continue
        }

        if (!event.entry) continue
        if (event.entry.kind === "assistant_text") {


          this.clearStreamingAssistantText(active.chatId)
        }
        await this.store.appendMessage(active.chatId, event.entry)
        if (event.entry.kind === "assistant_text") {
          const counted = this.recordMemoryCitations(event.entry.text, active.chatId)
          active.assistantChunks.push(event.entry.text)
          for (const id of counted) active.citedIds.add(id)
        }

        if (event.entry.kind === "system_init") {
          active.status = "running"
        }

        if (event.entry.kind === "result") {
          active.hasFinalResult = true
          if (event.entry.isError) {
            await this.store.recordTurnFailed(active.chatId, event.entry.result || "Turn failed")
          } else if (!active.cancelRequested) {
            await this.store.recordTurnFinished(active.chatId)
            const chat = this.store.getChat(active.chatId)
            this.launchPostTurnMemoryPasses({
              chatId: active.chatId,
              projectId: chat?.projectId,
              engine: "codex",
              turnNumber: active.turnNumber,
              turnId: active.turnId,
              taskId: active.taskId,
              userText: active.userText ?? "",
              assistantText: active.assistantChunks.join("\n"),
              citedIds: [...active.citedIds],
              memoryDisabled: active.memoryDisabled,
              injectedIds: [...active.injectedIds],
            })
          }


          this.activeTurns.delete(active.chatId)


          this.drainingStreams.set(active.chatId, { turn: active.turn })
        }

        this.emitStateChange(active.chatId)
      }
    } catch (error) {
      if (!active.cancelRequested) {
        const message = error instanceof Error ? error.message : String(error)
        await this.store.appendMessage(
          active.chatId,
          timestamped({
            kind: "result",
            subtype: "error",
            isError: true,
            durationMs: 0,
            result: message,
          })
        )
        await this.store.recordTurnFailed(active.chatId, message)
      }
    } finally {


      this.clearStreamingAssistantText(active.chatId)
      if (active.cancelRequested && !active.cancelRecorded) {
        await this.store.recordTurnCancelled(active.chatId)
      }
      active.turn.close()


      if (this.activeTurns.get(active.chatId) === active) {
        this.activeTurns.delete(active.chatId)
      }

      this.drainingStreams.delete(active.chatId)
      this.emitStateChange(active.chatId)

      if (active.postToolFollowUp && !active.cancelRequested) {
        try {
          await this.startTurnForChat({
            chatId: active.chatId,
            provider: active.provider,
            content: active.postToolFollowUp.content,
            attachments: [],
            model: active.model,
            effort: active.effort,
            serviceTier: active.serviceTier,
            planMode: active.postToolFollowUp.planMode,
            appendUserPrompt: false,
            turnId: active.turnId,
          })
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          await this.store.appendMessage(
            active.chatId,
            timestamped({
              kind: "result",
              subtype: "error",
              isError: true,
              durationMs: 0,
              result: message,
            })
          )
          await this.store.recordTurnFailed(active.chatId, message)
          this.emitStateChange(active.chatId)
        }
      } else if (!active.cancelRequested) {
        try {
          await this.maybeStartNextQueuedMessage(active.chatId)
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          await this.store.appendMessage(
            active.chatId,
            timestamped({
              kind: "result",
              subtype: "error",
              isError: true,
              durationMs: 0,
              result: message,
            })
          )
          await this.store.recordTurnFailed(active.chatId, message)
          this.emitStateChange(active.chatId)
        }
      }
    }
  }

  private assertMemoSyncControl(chatId: string): void {
    const chat = this.store.requireChat(chatId)


    if (this.policy.condition !== "memosync" || (chat.provider !== "claude" && (this.policy.studyMode || chat.provider !== "codex"))) {
      throw new Error("Per-memory interrupt is only available on a supported MemoSync engine")
    }
  }


  async interruptMemory(args: { chatId: string; memoryId: string; quote?: string }) {
    const { chatId, memoryId } = args
    this.assertMemoSyncControl(chatId)
    const active = this.activeTurns.get(chatId)
    if (!active) {
      throw new Error("A MemoSync turn must be running before a memory can interrupt it")
    }


    const turnNumber = active.turnNumber
    const workingIds = active.injectedIds


    if (!workingIds.includes(memoryId)) {
      throw new Error(`Memory ${memoryId} is not part of the current turn's working memory`)
    }
    const streamed = this.streamingAssistantTexts.get(chatId)?.text ?? ""
    const citedOrder: string[] = []
    for (const match of streamed.matchAll(/\[(M-\d+)\]/g)) {
      const id = match[1]
      if (id && !citedOrder.includes(id)) citedOrder.push(id)
    }
    const messages = this.store.getMessages(chatId)
    let prompt = ""
    for (let i = messages.length - 1; i >= 0; i--) {
      const entry = messages[i] as { kind: string; content?: string }
      if (entry.kind === "user_prompt") {
        prompt = entry.content ?? ""
        break
      }
    }


    const workingSet = [
      ...citedOrder.filter((id) => workingIds.includes(id)).map((id) => ({ id, cited: true })),
      ...workingIds.filter((id) => !citedOrder.includes(id)).map((id) => ({ id, cited: false })),
    ]

    const interruptId = crypto.randomUUID()
    const quote = args.quote?.trim() ? args.quote.trim().slice(0, 300) : undefined


    this.memory?.logger.event({
      type: "memory.interrupt",
      eventId: `control:interrupt:${interruptId}`,
      interruptId,
      ...(active.taskId ? { taskId: active.taskId, sessionId: active.taskId } : { sessionId: chatId }),
      chatId,
      id: memoryId,
      turn: turnNumber,
      quote,
    })
    await this.cancel(chatId, { skipPostTurnMemoryPasses: true })

    this.memory?.store.recordTraceLabel(memoryId, "violated", { actor: "user", sessionId: chatId, turn: turnNumber })
    await this.store.appendMessage(
      chatId,
      timestamped({ kind: "memory_interrupt", interruptId, memoryId, quote, prompt, workingSet, turn: turnNumber }),
    )
    this.emitStateChange(chatId, { immediate: true })
  }


  async resumeInterrupted(args: {
    chatId: string
    interruptId: string
    correction: string
    selectedIds: string[]
    enforce?: boolean
  }) {
    const { chatId } = args
    this.assertMemoSyncControl(chatId)
    if (this.activeTurns.has(chatId)) throw new Error("A turn is already running")
    const messages = this.store.getMessages(chatId)
    const entry = messages.find(
      (m): m is Extract<typeof m, { kind: "memory_interrupt" }> =>
        (m as { kind?: string }).kind === "memory_interrupt" &&
        (m as { interruptId?: string }).interruptId === args.interruptId,
    )
    if (!entry) throw new Error("No matching memory interrupt")
    const alreadyResolved = messages.some(
      (m) =>
        (m as { kind?: string }).kind === "memory_interrupt_resolution" &&
        (m as { interruptId?: string }).interruptId === args.interruptId,
    )
    if (alreadyResolved) throw new Error("Interrupt already resumed")

    const correction = args.correction?.trim()
    if (!correction) throw new Error("A correction is required to resume")
    const chat = this.store.requireChat(chatId)
    const memory = this.memory
    if (!memory) throw new Error("Memory service is unavailable")
    const enforce = args.enforce === true
    const selectedIds = normalizeMemorySelection({
      memory,
      projectId: chat.projectId,
      chatId,
      selectedIds: enforce ? [...args.selectedIds, entry.memoryId] : args.selectedIds,
    })
    if (enforce && !selectedIds.includes(entry.memoryId)) {
      throw new Error("The enforced memory is no longer in the current chat's effective Working Memory")
    }

    const resumedTaskId = this.getActiveStudyTaskId()
    if (resumedTaskId) {


      this.memory?.logger.event({
        type: "memory.resume",
        eventId: `control:resume:${args.interruptId}`,
        interruptId: args.interruptId,
        taskId: resumedTaskId,
        sessionId: resumedTaskId,
        chatId,
        id: entry.memoryId,
        enforced: enforce,
      })
      if (enforce) {
        this.memory?.logger.event({
          type: "memory.audit_action",
          eventId: `control:resume-enforce:${args.interruptId}`,
          taskId: resumedTaskId,
          sessionId: resumedTaskId,
          chatId,
          id: entry.memoryId,
          action: "enforce",
        })
      }
    }

    const provider = (chat.provider ?? "claude") as AgentProvider
    const lastModel = messages.filter(message => message.kind === "system_init").at(-1)?.model
    const settings = this.getProviderSettings(provider, { model: lastModel })
    let deliveryAccepted = false
    let deliveredSelectedIds: string[] = []
    await this.startTurnForChat({
      chatId,
      provider,
      content: entry.prompt,
      attachments: [],
      model: settings.model,
      effort: settings.effort,
      serviceTier: settings.serviceTier,
      planMode: false,
      appendUserPrompt: true,


      turnId: args.interruptId,
      onMemoryDeliveryAccepted: (focusedIds) => {
        deliveryAccepted = true
        deliveredSelectedIds = [...focusedIds]
      },
      resume: {
        interruptId: args.interruptId,
        memoryId: entry.memoryId,
        correction,
        selectedIds,
        ...(enforce ? { enforce: true, quote: entry.quote } : {}),
      },
    })
    if (!deliveryAccepted) {
      throw new Error("The coding agent did not accept the interrupt recovery delivery")
    }


    await this.store.appendMessage(
      chatId,
      timestamped({
        kind: "memory_interrupt_resolution",
        interruptId: args.interruptId,
        correction,
        selectedIds: deliveredSelectedIds,
        ...(enforce ? { enforced: true } : {}),
      }),
    )
    this.emitStateChange(chatId, { immediate: true })
  }

  async cancel(
    chatId: string,
    options?: {
      hideInterrupted?: boolean


      skipPostTurnMemoryPasses?: boolean
    },
  ) {
    this.restoreUndeliveredEnforcement(chatId)
    this.disposeMemoryBranches(chatId)


    this.clearStreamingAssistantText(chatId)

    const draining = this.drainingStreams.get(chatId)
    if (draining) {
      draining.turn.close()
      this.drainingStreams.delete(chatId)
    }


    const deferredAutoStart = this.pendingAutoCaptureStarts.get(chatId)
    if (
      deferredAutoStart
      && !this.activeTurns.has(chatId)
      && !this.hasPendingPreviewActivity(chatId)
      && this.startingChats.get(chatId) !== "previewing_memory"
    ) {
      await this.cancelAutoCaptureQueueDrain(chatId, deferredAutoStart, options?.hideInterrupted)
      return
    }


    const proposalsParked = this.pendingProposalGates.get(chatId)
    const transferParked = this.pendingTransferGates.get(chatId)
    const checkupParked = this.pendingCheckupGates.get(chatId)
    if (proposalsParked || transferParked || checkupParked) {
      const preparation = this.activePreparations.get(chatId)
      this.cancelledDuringPreview.add(chatId)
      proposalsParked?.respond("cancelled")
      transferParked?.respond("cancelled")
      checkupParked?.respond("cancelled")


      await preparation?.cancellation.cancelAndWait()
      await this.store.appendMessage(chatId, timestamped({ kind: "interrupted", hidden: options?.hideInterrupted }))
      await this.store.recordTurnCancelled(chatId)
      this.emitStateChange(chatId, { immediate: true })
      return
    }


    const parked = this.pendingPreviews.get(chatId)
    if (parked) {
      if (parked.published) {
        parked.respond("dismiss")
        return
      }
      this.pendingPreviews.delete(chatId)
      this.cancelledDuringPreview.add(chatId)
      await this.store.appendMessage(chatId, timestamped({ kind: "interrupted", hidden: options?.hideInterrupted }))
      await this.store.recordTurnCancelled(chatId)
      this.emitStateChange(chatId, { immediate: true })
      return
    }


    if (this.startingChats.get(chatId) === "previewing_memory") {
      const preparation = this.activePreparations.get(chatId)
      this.cancelledDuringPreview.add(chatId)
      await preparation?.cancellation.cancelAndWait()
      await this.store.appendMessage(chatId, timestamped({ kind: "interrupted", hidden: options?.hideInterrupted }))
      await this.store.recordTurnCancelled(chatId)
      this.emitStateChange(chatId, { immediate: true })
      return
    }

    const active = this.activeTurns.get(chatId)
    if (!active) return

    logClaudeSteer("cancel_requested", {
      chatId,
      provider: active.provider,
      activePromptSeq: active.claudePromptSeq ?? null,
    })


    if (active.cancelRequested) return
    active.cancelRequested = true

    const pendingTool = active.pendingTool
    active.pendingTool = null

    if (pendingTool) {
      const result = discardedToolResult(pendingTool.tool)
      await this.store.appendMessage(
        chatId,
        timestamped({
          kind: "tool_result",
          toolId: pendingTool.toolUseId,
          content: result,
        })
      )
      if (active.provider === "codex" && pendingTool.tool.toolKind === "exit_plan_mode") {
        pendingTool.resolve(result)
      }
    }

    await this.store.appendMessage(chatId, timestamped({ kind: "interrupted", hidden: options?.hideInterrupted }))
    await this.store.recordTurnCancelled(chatId)
    active.cancelRecorded = true
    active.hasFinalResult = true


    this.activeTurns.delete(chatId)
    this.emitStateChange(chatId)


    if (!this.policy.studyMode && !options?.skipPostTurnMemoryPasses) {
      const chat = this.store.getChat(chatId)
      this.launchPostTurnMemoryPasses({
        chatId,
        projectId: chat?.projectId,
        engine: active.provider,
        turnNumber: active.turnNumber,
        turnId: active.turnId,
        taskId: active.taskId,
        userText: active.userText ?? "",
        assistantText: active.assistantChunks.join("\n"),
        citedIds: [...active.citedIds],
        memoryDisabled: true,
        injectedIds: [],
      })
    }
    logClaudeSteer("cancel_active_turn_deleted", {
      chatId,
      provider: active.provider,
      activePromptSeq: active.claudePromptSeq ?? null,
    })


    if (this.policy.studyMode && active.provider === "claude" && !active.providerTurnStarted) {
      const session = this.claudeSessions.get(chatId)
      if (session) {
        try {
          await this.retireClaudeSession(session, "study_turn_cancel_before_start")
        } catch (error) {


          this.reportBackgroundError?.(
            `[claude-retire] chat ${chatId}: ${error instanceof Error ? error.message : String(error)}`,
          )
        }
      } else {

        active.turn.close()
      }
      return
    }


    try {
      await Promise.race([
        active.turn.interrupt(),
        new Promise((resolve) => setTimeout(resolve, 5_000)),
      ])
    } catch {

    }
    active.turn.close()
  }

  async respondTool(command: Extract<ClientCommand, { type: "chat.respondTool" }>) {
    const active = this.activeTurns.get(command.chatId)
    if (!active || !active.pendingTool) {
      throw new Error("No pending tool request")
    }

    const pending = active.pendingTool
    if (pending.toolUseId !== command.toolUseId) {
      throw new Error("Tool response does not match active request")
    }

    await this.store.appendMessage(
      command.chatId,
      timestamped({
        kind: "tool_result",
        toolId: command.toolUseId,
        content: command.result,
      })
    )

    active.pendingTool = null
    active.status = "running"

    if (pending.tool.toolKind === "exit_plan_mode") {
      const result = (command.result ?? {}) as {
        confirmed?: boolean
        clearContext?: boolean
        message?: string
      }
      if (result.confirmed && result.clearContext) {
        await this.store.setSessionToken(command.chatId, null)
        await this.store.appendMessage(command.chatId, timestamped({ kind: "context_cleared" }))
      }

      if (active.provider === "codex") {
        active.postToolFollowUp = result.confirmed
          ? {
              content: result.message
                ? `Proceed with the approved plan. Additional guidance: ${result.message}`
                : "Proceed with the approved plan.",
              planMode: false,
            }
          : {
              content: result.message
                ? `Revise the plan using this feedback: ${result.message}`
                : "Revise the plan using this feedback.",
              planMode: true,
            }
      }
    }

    pending.resolve(command.result)

    this.emitStateChange(command.chatId)
  }
}
type StudyAgentPreviewRuntime = Pick<StudyPreviewRuntimeController, "ensure" | "status" | "restart" | "stop">
