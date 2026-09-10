

import { existsSync, readFileSync } from "node:fs"
import { basename } from "node:path"
import { getStudyTask, STUDY_TASKS, type StudyTaskStatus } from "../shared/studyTasks"

export interface StudyProgressEntry {
  id: string
  title: string
  status: StudyTaskStatus
}

export type StudyFreezeState = "open" | "freezing" | "frozen"


export interface StudyLifecycleReader {
  getTaskFreezeSnapshot(taskId: string): { snapshotId: string; frozenAt: string } | null
  getQuestionnaireSubmission(snapshotId: string): { submittedAt: string } | null
  getSessionCompletion(taskId: string): { completedAt: string } | null
  getSusSubmission(): { submittedAt: string } | null
}


export function resolveStudyOrder(env: string | undefined = process.env.STUDY_TASK_ORDER): string[] {
  const known = STUDY_TASKS.map((task) => task.id)
  const requested = (env ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter((id) => known.includes(id))
  return [...requested, ...known.filter((id) => !requested.includes(id))]
}

export class StudyRegistry {
  private readonly order: string[]

  private readonly frozenAtByTask = new Map<string, string>()

  private readonly completedAtByTask = new Map<string, string>()
  private susSubmittedAt: string | null = null

  private readonly freezingTasks = new Set<string>()

  private readonly memoryMutationsByTask = new Map<string, number>()

  constructor(
    eventsPath?: string,
    order: string[] = resolveStudyOrder(),
    lifecycle?: StudyLifecycleReader,
  ) {
    this.order = order
    if (eventsPath && existsSync(eventsPath)) {
      for (const line of readFileSync(eventsPath, "utf8").split("\n")) {
        if (!line.trim()) continue
        try {
          const event = JSON.parse(line) as { type?: string; ts?: string; taskId?: string }
          if (typeof event.taskId !== "string") continue
          const ts = typeof event.ts === "string" ? event.ts : new Date(0).toISOString()
          if (event.type === "study.freeze") this.noteFreeze(event.taskId, ts)
          else if (event.type === "study.unfreeze") this.noteUnfreeze(event.taskId)
          else if (event.type === "study.session.complete") this.noteSessionComplete(event.taskId, ts)


          else if (event.type === "quiz.submit") this.noteSessionComplete(event.taskId, ts)
          else if (event.type === "study.sus.submit") this.noteSusSubmit(ts)
        } catch {

        }
      }
    }
    if (lifecycle) this.recoverCanonicalLifecycle(lifecycle)
  }

  private recoverCanonicalLifecycle(lifecycle: StudyLifecycleReader): void {
    for (const taskId of this.order) {
      const snapshot = lifecycle.getTaskFreezeSnapshot(taskId)
      if (!snapshot) continue
      this.freezingTasks.delete(taskId)
      this.frozenAtByTask.set(taskId, snapshot.frozenAt)


      this.completedAtByTask.delete(taskId)
      const completion = lifecycle.getSessionCompletion(taskId)
      if (completion) this.completedAtByTask.set(taskId, completion.completedAt)
    }
    this.susSubmittedAt = lifecycle.getSusSubmission()?.submittedAt ?? null
  }

  noteFreeze(taskId: string, ts: string = new Date().toISOString()): void {
    this.freezingTasks.delete(taskId)
    if (!this.frozenAtByTask.has(taskId)) this.frozenAtByTask.set(taskId, ts)
  }

  freezeState(taskId: string): StudyFreezeState | null {
    if (!this.order.includes(taskId)) return null
    if (this.frozenAtByTask.has(taskId)) return "frozen"
    return this.freezingTasks.has(taskId) ? "freezing" : "open"
  }


  beginFreeze(taskId: string): boolean {
    if (this.taskStatus(taskId) !== "active" || this.freezeState(taskId) !== "open") return false
    if ((this.memoryMutationsByTask.get(taskId) ?? 0) > 0) return false
    this.freezingTasks.add(taskId)
    return true
  }


  beginTreatmentMemoryMutation(): (() => void) | null {
    const taskId = this.activeTaskId()
    if (!taskId || this.freezeState(taskId) !== "open") return null
    this.memoryMutationsByTask.set(taskId, (this.memoryMutationsByTask.get(taskId) ?? 0) + 1)
    let released = false
    return () => {
      if (released) return
      released = true
      const remaining = (this.memoryMutationsByTask.get(taskId) ?? 1) - 1
      if (remaining > 0) this.memoryMutationsByTask.set(taskId, remaining)
      else this.memoryMutationsByTask.delete(taskId)
    }
  }

  hasTreatmentMemoryMutation(taskId: string): boolean {
    return (this.memoryMutationsByTask.get(taskId) ?? 0) > 0
  }


  cancelFreeze(taskId: string): boolean {
    return this.freezingTasks.delete(taskId)
  }


  noteUnfreeze(taskId: string): void {
    this.freezingTasks.delete(taskId)
    this.frozenAtByTask.delete(taskId)
  }

  noteSessionComplete(taskId: string, ts: string = new Date().toISOString()): void {
    this.freezingTasks.delete(taskId)
    this.completedAtByTask.set(taskId, ts)
  }

  noteSusSubmit(ts: string = new Date().toISOString()): void {
    this.susSubmittedAt = ts
  }


  activeTaskId(): string | null {
    return this.order.find((id) => !this.completedAtByTask.has(id)) ?? null
  }


  nextTaskIdAfter(taskId: string): string | null {
    const index = this.order.indexOf(taskId)
    return index >= 0 ? this.order[index + 1] ?? null : null
  }

  taskStatus(taskId: string): StudyTaskStatus | null {
    if (!this.order.includes(taskId)) return null
    if (this.completedAtByTask.has(taskId)) return "completed"
    return this.activeTaskId() === taskId ? "active" : "locked"
  }


  windowStart(): string | null {
    let latest: string | null = null
    for (const ts of this.completedAtByTask.values()) {
      if (latest === null || ts > latest) latest = ts
    }
    return latest
  }


  taskWindowAt(timestampMs: number): { taskId: string; startAt: number; endAt: number | null } | null {
    if (!Number.isFinite(timestampMs)) return null
    let startAt = Number.NEGATIVE_INFINITY
    for (const taskId of this.order) {
      const frozenAt = this.frozenAtByTask.get(taskId)
      const endAt = frozenAt ? Date.parse(frozenAt) : null
      if (endAt !== null && Number.isFinite(endAt)) {
        if (timestampMs >= startAt && timestampMs <= endAt) return { taskId, startAt, endAt }
      } else if (this.taskStatus(taskId) === "active" && timestampMs >= startAt) {
        return { taskId, startAt, endAt: null }
      }

      const completedAt = this.completedAtByTask.get(taskId)
      if (!completedAt) break
      const nextStart = Date.parse(completedAt)
      if (!Number.isFinite(nextStart)) break
      startAt = nextStart
    }
    return null
  }

  frozenAt(taskId: string): string | undefined {
    return this.frozenAtByTask.get(taskId)
  }


  questionnairePending(): boolean {
    const active = this.activeTaskId()
    return active !== null && this.frozenAtByTask.has(active)
  }

  postSessionPending(): boolean {
    return this.questionnairePending()
  }

  susPending(): boolean {
    return this.activeTaskId() === null && this.susSubmittedAt === null
  }

  studyComplete(): boolean {
    return this.activeTaskId() === null && this.susSubmittedAt !== null
  }

  progress(): StudyProgressEntry[] {
    const titles = new Map(STUDY_TASKS.map((task) => [task.id, task.title]))
    return this.order.map((id) => ({
      id,
      title: titles.get(id) ?? id,
      status: this.taskStatus(id) ?? "locked",
    }))
  }


  promptRefusal(chatCreatedAtMs?: number, projectLocalPath?: string): string | null {
    const active = this.activeTaskId()
    if (active === null) {
      return this.studyComplete()
        ? "The study is complete. Please let the experimenter know."
        : "All sessions are complete. Please finish the final usability questions."
    }
    if (this.freezingTasks.has(active)) {
      return "The current session is ending. Please wait for the end-of-session questions."
    }
    if (this.frozenAtByTask.has(active)) {
      return "The current session has ended. Please finish the end-of-session questions first."
    }
    const start = this.windowStart()
    if (chatCreatedAtMs !== undefined && start !== null && chatCreatedAtMs < Date.parse(start)) {
      return "This chat belongs to a completed session and is read-only. Please start a new chat for the current task."
    }
    if (projectLocalPath !== undefined) {
      const task = getStudyTask(active)
      const projectSlug = basename(projectLocalPath.replace(/[\\/]+$/, ""))
      if (task && projectSlug !== task.projectSlug) {
        return `This session must be completed in the ${task.projectTitle} project. Open the task brief and use its Start button.`
      }
    }
    return null
  }
}
