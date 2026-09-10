

import { existsSync } from "node:fs"
import type { Dirent } from "node:fs"
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises"
import path from "node:path"
import { resolveExistingPathWithinRoot } from "./paths"
import { STATIC_MEMORY_FILENAME } from "./memory/static-files"
import { resolveConditionPolicy } from "./experiment/condition"
import type { ExperimentLogger } from "./experiment/logger"
import type { StudyProjectAccess } from "./study-project-access"

interface ProjectLike {
  id: string
  title: string
  localPath: string
}

interface ChatLike {
  id: string
  title: string
  projectId: string
}

export interface WorkspaceStoreLike {
  listProjects(): ProjectLike[]
  listChats(): ChatLike[]
  getProject(projectId: string): ProjectLike | undefined | null
}

export interface WorkspaceFileEntry {
  name: string
  kind: "file" | "dir"
  size: number
}

export interface WorkspaceRouteOptions {

  beginStudyMemoryMutation?: () => (() => void) | null

  experimentLogger?: Pick<ExperimentLogger, "event">

  getActiveStudyTaskId?: () => string | null

  studyProjectAccess?: StudyProjectAccess
}

class StaticEditOperationError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message)
  }
}

export async function runDurableStaticEditOperation<T>(input: {
  logger?: Pick<ExperimentLogger, "event">
  taskId: string | null
  operationId?: string
  chatId?: string
  projectId: string
  path: string
  durationMs?: number
  run: () => T | Promise<T>
}): Promise<T> {
  const operationId = input.operationId?.trim()
  if (!input.logger || !input.taskId || !operationId) {
    const result = await input.run()
    input.logger?.event({
      type: "memory.static_edit",
      ...(operationId ? { eventId: operationId } : {}),
      ...(input.chatId ? { sessionId: input.chatId } : {}),
      projectId: input.projectId,
      path: input.path,
      ...(input.durationMs === undefined ? {} : { durationMs: input.durationMs }),
    })
    return result
  }
  const base = {
    type: "study.control_operation" as const,
    operationId,
    taskId: input.taskId,
    sessionId: input.taskId,
    ...(input.chatId ? { chatId: input.chatId } : {}),
    surface: "static_memory" as const,
    action: "edit",
    controlType: "static_edit" as const,
    payload: {
      projectId: input.projectId,
      path: input.path,
      durationMs: input.durationMs ?? null,
    },
  }
  const attempted = input.logger.event({ ...base, phase: "attempted" })
  if (
    attempted !== null
    && typeof attempted === "object"
    && "durableCreated" in attempted
    && attempted.durableCreated === false
  ) {
    throw new StaticEditOperationError(
      409,
      "OPERATION_ALREADY_RECORDED",
      "This Static memory edit was already recorded. Refresh to recover its current outcome.",
    )
  }
  let result: T
  try {
    result = await input.run()
  } catch (error) {
    try {
      input.logger.event({
        ...base,
        phase: "failed",
        errorClass: error instanceof Error ? error.constructor.name : typeof error,
      })
    } catch {

    }
    throw error
  }
  try {
    input.logger.event({ ...base, phase: "completed" })
  } catch {


  }
  return result
}

const ok = <T>(data: T): Response => Response.json({ data })
const fail = (status: number, code: string, message: string): Response =>
  Response.json({ error: { code, message } }, { status })

const FILES_RE = /^\/api\/projects\/([^/]+)\/files$/
const FILE_INDEX_RE = /^\/api\/projects\/([^/]+)\/files\/index$/
const FILE_SEARCH_RE = /^\/api\/projects\/([^/]+)\/files\/search$/
const FILE_OP_RE = /^\/api\/projects\/([^/]+)\/files\/op$/
const MEMORY_FILE_RE = /^\/api\/projects\/([^/]+)\/memory-file$/

const MEMORY_FILE_MAX_BYTES = 256 * 1024


const INDEX_IGNORED_DIRS = new Set([
  "node_modules", ".git", "dist", "build", "out", ".next", ".nuxt", ".cache",
  ".turbo", "coverage", "__pycache__", ".venv", "venv", "target", ".DS_Store",
])
const INDEX_MAX_FILES = 8000
const INDEX_MAX_DEPTH = 16


async function collectFileIndex(root: string): Promise<{ files: string[]; truncated: boolean }> {
  const files: string[] = []
  let truncated = false
  const walk = async (dirAbs: string, dirRel: string, depth: number): Promise<void> => {
    if (truncated || depth > INDEX_MAX_DEPTH) return
    let entries: Dirent[]
    try {
      entries = await readdir(dirAbs, { withFileTypes: true })
    } catch {
      return
    }
    entries.sort((a, b) => a.name.localeCompare(b.name))
    for (const entry of entries) {
      if (truncated) return
      const rel = dirRel ? `${dirRel}/${entry.name}` : entry.name
      if (entry.isDirectory()) {
        if (!INDEX_IGNORED_DIRS.has(entry.name)) await walk(path.join(dirAbs, entry.name), rel, depth + 1)
        continue
      }
      if (!entry.isFile()) continue
      if (files.length >= INDEX_MAX_FILES) {
        truncated = true
        return
      }
      files.push(rel)
    }
  }
  await walk(root, "", 0)
  return { files, truncated }
}

const SEARCH_MAX_RESULTS = 300
const SEARCH_MAX_PER_FILE = 20
const SEARCH_MAX_FILE_BYTES = 512 * 1024

export interface ContentSearchMatch {
  path: string
  line: number

  text: string

  col: number
}


async function searchFileContents(root: string, query: string): Promise<{ results: ContentSearchMatch[]; truncated: boolean }> {
  const needle = query.toLowerCase()
  const { files, truncated: indexTruncated } = await collectFileIndex(root)
  const results: ContentSearchMatch[] = []
  let truncated = indexTruncated
  for (const rel of files) {
    if (results.length >= SEARCH_MAX_RESULTS) {
      truncated = true
      break
    }
    const abs = path.join(root, rel)
    try {
      if ((await stat(abs)).size > SEARCH_MAX_FILE_BYTES) continue
      const content = await Bun.file(abs).text()

      if (content.includes("\0")) continue
      let perFile = 0
      const lines = content.split("\n")
      for (let i = 0; i < lines.length; i++) {
        const idx = lines[i].toLowerCase().indexOf(needle)
        if (idx === -1) continue
        const trimmed = lines[i].trim()
        results.push({
          path: rel,
          line: i + 1,
          text: trimmed.slice(0, 200),
          col: Math.max(0, trimmed.toLowerCase().indexOf(needle)),
        })
        if (++perFile >= SEARCH_MAX_PER_FILE) break
        if (results.length >= SEARCH_MAX_RESULTS) {
          truncated = true
          break
        }
      }
    } catch {

    }
  }
  return { results, truncated }
}

type TargetPathResult =
  | { ok: true; path: string; exists: boolean }
  | { ok: false; reason: "outside" | "invalid" }


async function resolveTargetPathWithinRoot(rootPath: string, rel: string): Promise<TargetPathResult> {
  const normalized = path.posix.normalize(rel.replaceAll("\\", "/"))
  if (!normalized || normalized === "." || normalized.startsWith("../") || normalized.includes("/../") || path.posix.isAbsolute(normalized)) {
    return { ok: false, reason: "invalid" }
  }
  const rootResolved = await resolveExistingPathWithinRoot(rootPath, "")
  if (!rootResolved.ok) return { ok: false, reason: "invalid" }
  const root = rootResolved.path
  const target = path.resolve(root, normalized)
  if (target === root || !target.startsWith(`${root}${path.sep}`)) return { ok: false, reason: "outside" }

  let ancestor = path.dirname(target)
  while (ancestor !== root && !existsSync(ancestor)) ancestor = path.dirname(ancestor)
  const ancestorRel = path.relative(root, ancestor).split(path.sep).join("/")
  const ancestorResolved = await resolveExistingPathWithinRoot(root, ancestorRel)
  if (!ancestorResolved.ok) return { ok: false, reason: "outside" }

  const suffix = path.relative(ancestor, target)
  const realTarget = suffix ? path.join(ancestorResolved.path, suffix) : ancestorResolved.path
  return { ok: true, path: realTarget, exists: existsSync(realTarget) }
}

const FILE_OPS = new Set(["create", "mkdir", "rename", "delete"])

async function handleFileOp(req: Request, localPath: string): Promise<Response> {
  let body: { op?: string; path?: string; toPath?: string }
  try {
    body = (await req.json()) as typeof body
  } catch {
    return fail(400, "BAD_REQUEST", "invalid JSON body")
  }
  const { op, path: rel, toPath } = body
  if (!op || !FILE_OPS.has(op)) return fail(400, "BAD_REQUEST", "unknown op")
  if (typeof rel !== "string" || !rel) return fail(400, "BAD_REQUEST", "path is required")

  const target = await resolveTargetPathWithinRoot(localPath, rel)
  if (!target.ok) return fail(400, "BAD_REQUEST", "path escapes the project root")

  try {
    switch (op) {
      case "create": {
        if (target.exists) return fail(409, "CONFLICT", "file already exists")
        await mkdir(path.dirname(target.path), { recursive: true })
        await writeFile(target.path, "", { flag: "wx" })
        return ok({ done: true })
      }
      case "mkdir": {
        if (target.exists) return fail(409, "CONFLICT", "directory already exists")
        await mkdir(target.path, { recursive: true })
        return ok({ done: true })
      }
      case "rename": {
        if (!target.exists) return fail(404, "NOT_FOUND", "source not found")
        if (typeof toPath !== "string" || !toPath) return fail(400, "BAD_REQUEST", "toPath is required")
        const dest = await resolveTargetPathWithinRoot(localPath, toPath)
        if (!dest.ok) return fail(400, "BAD_REQUEST", "toPath escapes the project root")
        if (dest.exists) return fail(409, "CONFLICT", "target already exists")
        await mkdir(path.dirname(dest.path), { recursive: true })
        await rename(target.path, dest.path)
        return ok({ done: true })
      }
      case "delete": {
        if (!target.exists) return fail(404, "NOT_FOUND", "path not found")
        await rm(target.path, { recursive: true })
        return ok({ done: true })
      }
    }
  } catch {
    return fail(500, "INTERNAL", `${op} failed`)
  }
  return fail(400, "BAD_REQUEST", "unknown op")
}


export async function handleWorkspaceRequest(
  req: Request,
  url: URL,
  store: WorkspaceStoreLike,
  options: WorkspaceRouteOptions = {},
): Promise<Response | null> {
  const { pathname } = url
  const filesMatch = pathname.match(FILES_RE)
  const indexMatch = pathname.match(FILE_INDEX_RE)
  const searchMatch = pathname.match(FILE_SEARCH_RE)
  const opMatch = pathname.match(FILE_OP_RE)
  const memoryFileMatch = pathname.match(MEMORY_FILE_RE)
  if (pathname !== "/api/projects" && pathname !== "/api/chats" && !filesMatch && !indexMatch && !searchMatch && !opMatch && !memoryFileMatch) {
    return null
  }


  if (memoryFileMatch) {
    if (resolveConditionPolicy().condition !== "static") {
      return fail(404, "NOT_AVAILABLE", "the memory file surface only exists in the 'static' condition")
    }
    const project = store.getProject(decodeURIComponent(memoryFileMatch[1]))
    if (!project) return fail(404, "NOT_FOUND", "unknown project")
    const abs = path.join(project.localPath, STATIC_MEMORY_FILENAME)

    if (req.method === "GET") {
      try {
        const [content, s] = await Promise.all([readFile(abs, "utf8"), stat(abs)])
        return ok({ path: STATIC_MEMORY_FILENAME, content, mtimeMs: s.mtimeMs, exists: true })
      } catch {
        return ok({ path: STATIC_MEMORY_FILENAME, content: "", mtimeMs: 0, exists: false })
      }
    }
    if (req.method === "PUT") {
      const projectId = decodeURIComponent(memoryFileMatch[1])
      const projectRefusal = options.studyProjectAccess?.projectRefusal(projectId)
      if (projectRefusal) return fail(409, "STUDY_PROJECT_LOCKED", projectRefusal)
      const release = options.beginStudyMemoryMutation?.()
      if (options.beginStudyMemoryMutation && !release) {
        return fail(409, "STUDY_FROZEN", "The current session is ending. Memory can no longer be changed.")
      }
      try {
        let body: { content?: string; baseMtimeMs?: number; sessionId?: string; editDurationMs?: number; eventId?: string }
        try {
          body = (await req.json()) as typeof body
        } catch {
          return fail(400, "BAD_REQUEST", "invalid JSON body")
        }
        if (typeof body.content !== "string") return fail(400, "BAD_REQUEST", "content must be a string")
        if (Buffer.byteLength(body.content, "utf8") > MEMORY_FILE_MAX_BYTES) {
          return fail(413, "TOO_LARGE", "memory file exceeds 256 KB")
        }
        if (typeof body.baseMtimeMs === "number") {
          try {
            const s = await stat(abs)
            if (Math.abs(s.mtimeMs - body.baseMtimeMs) > 1) {
              return fail(409, "CONFLICT", "the file changed since you loaded it — reload before saving")
            }
          } catch {


          }
        }
        let previousContent = ""
        try {
          previousContent = await readFile(abs, "utf8")
        } catch {

        }
        const changed = body.content !== previousContent
          || (typeof body.eventId === "string" && Boolean(body.eventId.trim()))
        const activeTaskId = options.getActiveStudyTaskId?.() ?? null
        const operationId = typeof body.eventId === "string" && body.eventId.trim() ? body.eventId.trim() : undefined
        if (changed && activeTaskId && !operationId) {
          return fail(400, "EVENT_ID_REQUIRED", "A durable Static edit operationId is required during the study")
        }
        const durationMs = typeof body.editDurationMs === "number"
          && Number.isFinite(body.editDurationMs)
          && body.editDurationMs >= 0
          ? Math.round(body.editDurationMs)
          : undefined
        const writeAndStat = async () => {
          await mkdir(path.dirname(abs), { recursive: true })
          await writeFile(abs, body.content!, "utf8")
          return stat(abs)
        }
        try {
          const s = changed
            ? await runDurableStaticEditOperation({
                logger: options.experimentLogger,
                taskId: activeTaskId,
                operationId,
                chatId: typeof body.sessionId === "string" ? body.sessionId : undefined,
                projectId: project.id,
                path: STATIC_MEMORY_FILENAME,
                durationMs,
                run: writeAndStat,
              })
            : await writeAndStat()
          return ok({ path: STATIC_MEMORY_FILENAME, mtimeMs: s.mtimeMs })
        } catch (error) {
          if (error instanceof StaticEditOperationError) return fail(error.status, error.code, error.message)
          return fail(500, "STATIC_EDIT_FAILED", "Failed to save Static memory")
        }
      } finally {
        release?.()
      }
    }
    return fail(405, "METHOD_NOT_ALLOWED", "use GET or PUT")
  }

  if (opMatch) {
    if (req.method !== "POST") return fail(405, "METHOD_NOT_ALLOWED", "use POST")
    const projectId = decodeURIComponent(opMatch[1])
    const projectRefusal = options.studyProjectAccess?.projectRefusal(projectId)
    if (projectRefusal) return fail(409, "STUDY_PROJECT_LOCKED", projectRefusal)
    const release = options.beginStudyMemoryMutation?.()
    if (options.beginStudyMemoryMutation && !release) {
      return fail(409, "STUDY_FROZEN", "The current session is ending. Workspace files can no longer be changed.")
    }
    const project = store.getProject(projectId)
    try {
      if (!project) return fail(404, "NOT_FOUND", "unknown project")
      return await handleFileOp(req, project.localPath)
    } finally {
      release?.()
    }
  }

  if (req.method !== "GET") return fail(405, "METHOD_NOT_ALLOWED", "use GET")

  if (searchMatch) {
    const project = store.getProject(decodeURIComponent(searchMatch[1]))
    if (!project) return fail(404, "NOT_FOUND", "unknown project")
    const q = url.searchParams.get("q") ?? ""
    if (q.trim().length < 2) return fail(400, "BAD_REQUEST", "query must be at least 2 characters")
    const resolved = await resolveExistingPathWithinRoot(project.localPath, "")
    if (!resolved.ok) return fail(404, "NOT_FOUND", "project directory not found")
    return ok(await searchFileContents(resolved.path, q.trim()))
  }

  if (pathname === "/api/projects") {
    return ok(store.listProjects().map((p) => ({ id: p.id, title: p.title })))
  }

  if (pathname === "/api/chats") {
    return ok(store.listChats().map((c) => ({ id: c.id, title: c.title, projectId: c.projectId })))
  }

  if (indexMatch) {
    const project = store.getProject(decodeURIComponent(indexMatch[1]))
    if (!project) return fail(404, "NOT_FOUND", "unknown project")
    const resolved = await resolveExistingPathWithinRoot(project.localPath, "")
    if (!resolved.ok) return fail(404, "NOT_FOUND", "project directory not found")
    return ok(await collectFileIndex(resolved.path))
  }

  const project = store.getProject(decodeURIComponent(filesMatch![1]))
  if (!project) return fail(404, "NOT_FOUND", "unknown project")

  const rel = url.searchParams.get("dir") ?? ""
  const resolved = await resolveExistingPathWithinRoot(project.localPath, rel)
  if (!resolved.ok) {
    return resolved.reason === "outside"
      ? fail(400, "BAD_REQUEST", "directory escapes the project root")
      : fail(404, "NOT_FOUND", "directory not found")
  }
  const { path: target, root } = resolved

  let names: Dirent[]
  try {
    names = await readdir(target, { withFileTypes: true })
  } catch {
    return fail(404, "NOT_FOUND", "directory not found")
  }

  const entries: WorkspaceFileEntry[] = []
  for (const entry of names) {
    if (entry.isDirectory()) {
      entries.push({ name: entry.name, kind: "dir", size: 0 })
      continue
    }
    if (!entry.isFile()) continue
    let size = 0
    try {
      size = (await stat(path.join(target, entry.name))).size
    } catch {
      continue
    }
    entries.push({ name: entry.name, kind: "file", size })
  }
  entries.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === "dir" ? -1 : 1))

  return ok({ dir: path.relative(root, target).split(path.sep).join("/"), entries })
}
