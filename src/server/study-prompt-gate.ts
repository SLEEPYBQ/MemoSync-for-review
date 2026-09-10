import { extname } from "node:path"
import type { ChatAttachment } from "../shared/types"
import type { StudyRegistry } from "./study-registry"
import { getStudyTask, type StudyTask } from "../shared/studyTasks"
import { STUDY_BRIEFS } from "./study-briefs"
import { assessStudyInstructionOverlap } from "./study-instruction-guard"
import { briefReceiptKey, guideReceiptKey, type StudyUiReceiptReader } from "./study-ui-receipts"
import type { RegisteredStudyProject } from "./study-projects"
import {
  readContainedAttachmentBytes,
  type CapturedOpeningAttachment,
  type StudyOpeningAttachmentSnapshot,
  type StudyOpeningAttachmentSnapshotStore,
} from "./study-opening-attachments"

export type StudyPromptChannel = "chat.send" | "message.enqueue" | "message.steer" | "queue.dispatch"

export interface StudyPromptGateInput {
  chatId?: string
  projectId?: string
  channel?: StudyPromptChannel
  content: string
  attachments?: Array<{ absolutePath: string; mimeType?: string; size?: number }>
  openingReviewId?: string

  openingBoardPreparation?: boolean

  verifiedOpeningSnapshot?: boolean
}

export interface StudyOpeningPromptAdmission {
  refusal: string | null
  attachmentSnapshots?: StudyOpeningAttachmentSnapshot[]
}

export type StudyPromptGate = ((input: StudyPromptGateInput) => string | null) & {

  admitOpening?: (input: StudyPromptGateInput & {
    openingReviewId: string
    attachments: ChatAttachment[]
  }) => StudyOpeningPromptAdmission
}

export interface StudyInstructionGuardViolation {
  taskId: string
  chatId?: string
  projectId?: string
  channel: StudyPromptChannel
  reason: "near_verbatim"
  ruleVersion: string
  longestContiguousRun: number
  lcsRatio: number
  reference: string | null
}

interface StudyChatLike {
  projectId: string
  createdAt: number
  pendingForkSessionToken?: string | null
}

interface StudyProjectLike {
  localPath: string
}

const MAX_GUARD_TEXT_ATTACHMENT_BYTES = 2 * 1024 * 1024
const MAX_GUARD_ATTACHMENT_COUNT = 50
const MAX_GUARD_ATTACHMENT_TOTAL_BYTES = 200 * 1024 * 1024
const MAX_GUARD_COMBINED_TEXT_CHARACTERS = 1_000_000
const MAX_GUARD_PROMPT_CHARACTERS = 1_000_000
const TEXT_ATTACHMENT_EXTENSIONS = new Set([
  ".txt", ".md", ".markdown", ".json", ".jsonl", ".csv", ".tsv", ".yaml", ".yml",
  ".js", ".jsx", ".ts", ".tsx", ".html", ".css", ".xml", ".toml", ".ini", ".env",
])

function isTextAttachment(attachment: { absolutePath: string; mimeType?: string }): boolean {
  const extension = extname(attachment.absolutePath).toLocaleLowerCase("en-US")
  const mimeType = attachment.mimeType?.trim().toLocaleLowerCase("en-US") ?? ""
  const extensionAllowsText = extension ? TEXT_ATTACHMENT_EXTENSIONS.has(extension) : null
  const mimeAllowsText = mimeType
    ? mimeType.startsWith("text/") || ["application/json", "application/xml", "application/yaml"].includes(mimeType)
    : null


  if (extensionAllowsText === false || mimeAllowsText === false) return false
  return extensionAllowsText === true || mimeAllowsText === true
}

function readStudyTextAttachments(
  attachments: StudyPromptGateInput["attachments"],
  projectRoot: string,
): { text: string; error: boolean; captured: CapturedOpeningAttachment[] } {
  if ((attachments?.length ?? 0) > MAX_GUARD_ATTACHMENT_COUNT) return { text: "", error: true, captured: [] }
  const texts: string[] = []
  const captured: CapturedOpeningAttachment[] = []
  let totalBytes = 0
  let combinedTextCharacters = 0
  for (const attachment of attachments ?? []) {
    try {
      const opened = readContainedAttachmentBytes(projectRoot, attachment.absolutePath)
      if (!opened) return { text: "", error: true, captured: [] }
      const size = opened.byteSize
      totalBytes += size
      if (totalBytes > MAX_GUARD_ATTACHMENT_TOTAL_BYTES) return { text: "", error: true, captured: [] }
      if (isChatAttachment(attachment)) {
        captured.push({
          attachment: structuredClone(attachment),
          bytes: opened.bytes,
          contentSha256: opened.contentSha256,
          byteSize: opened.byteSize,
        })
      }
      if (!isTextAttachment(attachment)) continue
      if (size > MAX_GUARD_TEXT_ATTACHMENT_BYTES) return { text: "", error: true, captured: [] }
      const bytes = opened.bytes
      if (bytes.subarray(0, Math.min(bytes.length, 4096)).includes(0)) {
        return { text: "", error: true, captured: [] }
      }
      const text = bytes.toString("utf8")
      combinedTextCharacters += text.length
      if (combinedTextCharacters > MAX_GUARD_COMBINED_TEXT_CHARACTERS) return { text: "", error: true, captured: [] }
      texts.push(text)
    } catch {
      return { text: "", error: true, captured: [] }
    }
  }
  return { text: texts.join("\n"), error: false, captured }
}

function isChatAttachment(value: unknown): value is ChatAttachment {
  if (!value || typeof value !== "object") return false
  const attachment = value as Partial<ChatAttachment>
  return typeof attachment.id === "string"
    && (attachment.kind === "file" || attachment.kind === "image")
    && typeof attachment.displayName === "string"
    && typeof attachment.absolutePath === "string"
    && typeof attachment.relativePath === "string"
    && typeof attachment.contentUrl === "string"
    && typeof attachment.mimeType === "string"
    && typeof attachment.size === "number"
}

interface StudyPromptGateStore {
  getChat(chatId: string): StudyChatLike | null
  getProject(projectId: string): StudyProjectLike | null
}


export function createStudyPromptGate(deps: {
  registry: StudyRegistry
  store: StudyPromptGateStore
  assignedProjects: ReadonlyMap<StudyTask["projectSlug"], Pick<RegisteredStudyProject, "projectId" | "localPath" | "starterReady">>
  uiReceipts: StudyUiReceiptReader

  onboarding: { isBriefingComplete(): boolean } | null

  boardPromptRefusal?: (taskId: string, input: StudyPromptGateInput) => string | null

  allowVerbatimInstruction?: boolean
  recordInstructionGuardViolation?: (event: StudyInstructionGuardViolation) => void

  openingAttachmentSnapshots?: StudyOpeningAttachmentSnapshotStore
}): StudyPromptGate {
  const openingEvidence = new WeakMap<object, CapturedOpeningAttachment[]>()
  const gate = ((input: StudyPromptGateInput) => {
    const chat = input.chatId ? deps.store.getChat(input.chatId) : null
    const projectId = chat?.projectId ?? input.projectId
    const project = projectId ? deps.store.getProject(projectId) : null
    if (!project) {
      return "The assigned project could not be verified. Open the active task brief and use its Start button."
    }
    const taskId = deps.registry.activeTaskId()
    const task = taskId ? getStudyTask(taskId) : undefined
    if (task) {
      const assigned = deps.assignedProjects.get(task.projectSlug)
      if (!assigned?.starterReady || assigned.projectId !== projectId || assigned.localPath !== project.localPath) {
        return `This session must be completed in the ${task.projectTitle} project. Open the task brief and use its Start button.`
      }
    }
    if (chat?.pendingForkSessionToken) {
      return "This chat was forked from an earlier Claude session and cannot be used in the study. Start a new chat from the current task brief."
    }
    const lifecycleRefusal = deps.registry.promptRefusal(chat?.createdAt)
    if (lifecycleRefusal) return lifecycleRefusal

    const brief = taskId ? STUDY_BRIEFS[taskId] : undefined
    if (!taskId || !brief) return null
    if (!deps.onboarding) {
      return "Study onboarding is unavailable for this participant instance."
    }
    if (!deps.onboarding.isBriefingComplete()) {
      return "Complete the study briefing before sending a prompt."
    }
    if (!deps.uiReceipts.has(guideReceiptKey())) {
      return "Complete the current study guide before sending a prompt."
    }
    if (!deps.uiReceipts.has(briefReceiptKey(taskId))) {
      return "Review the current task brief and use its Start button before sending a prompt."
    }


    if (!input.openingBoardPreparation) {
      const boardRefusal = deps.boardPromptRefusal?.(taskId, input)
      if (boardRefusal) return boardRefusal
    }
    if (input.content.length > MAX_GUARD_PROMPT_CHARACTERS) {
      return "This prompt is too long to verify against the study instructions. Shorten it and describe the task in your own words."
    }
    if (input.attachments?.some((attachment) => !isTextAttachment(attachment))) {
      return "Study prompts can only include plain-text files that the instruction guard can inspect. Remove the image, PDF, archive, or other non-text attachment and try again."
    }
    if (input.openingBoardPreparation && !(input.attachments ?? []).every(isChatAttachment)) {
      return "An attachment could not be checked against the study instructions. Remove or shorten it, then try again."
    }
    const attachmentText = input.verifiedOpeningSnapshot
      ? { text: "", error: false, captured: [] }
      : readStudyTextAttachments(input.attachments, project.localPath)
    if (attachmentText.error) {
      return "An attachment could not be checked against the study instructions. Remove or shorten it, then try again."
    }
    if (input.openingBoardPreparation) openingEvidence.set(input, attachmentText.captured)


    if (deps.allowVerbatimInstruction) return null
    const assessment = assessStudyInstructionOverlap(
      [input.content, attachmentText.text].filter(Boolean).join("\n"),
      brief,
    )
    if (!assessment.rejected) return null

    deps.recordInstructionGuardViolation?.({
      taskId,
      ...(input.chatId ? { chatId: input.chatId } : {}),
      ...(projectId ? { projectId } : {}),
      channel: input.channel ?? "chat.send",
      reason: "near_verbatim",
      ruleVersion: assessment.ruleVersion,
      longestContiguousRun: assessment.longestContiguousRun,
      lcsRatio: assessment.lcsRatio,
      reference: assessment.reference,
    })
    return "Please describe the task to the agent in your own words. Copying or closely reproducing the study instructions is not allowed, so this prompt was not sent."
  }) as StudyPromptGate
  gate.admitOpening = (input) => {
    const refusal = gate(input)
    if (refusal) return { refusal }
    const captured = openingEvidence.get(input)
    openingEvidence.delete(input)
    if (input.attachments.length === 0) return { refusal: null, attachmentSnapshots: [] }
    if (!deps.openingAttachmentSnapshots || !captured || captured.length !== input.attachments.length) {
      return { refusal: "Opening attachment preparation is unavailable. Remove the attachment and try again." }
    }
    try {
      return {
        refusal: null,
        attachmentSnapshots: deps.openingAttachmentSnapshots.persist(input.openingReviewId, captured),
      }
    } catch {
      return { refusal: "An attachment could not be preserved for the opening review. Remove it and try again." }
    }
  }
  return gate
}
