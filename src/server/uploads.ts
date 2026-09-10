import { randomUUID } from "node:crypto"
import { lstat, mkdir, open, realpath, rm, stat } from "node:fs/promises"
import path from "node:path"
import { fileTypeFromBuffer } from "file-type"
import type { ChatAttachment } from "../shared/types"
import {
  getProjectDataDir,
  getProjectUploadDir,
  PROJECT_DATA_DIR_NAME,
  resolveExistingPathWithinRoot,
  resolveLocalPath,
  type ContainedPathResult,
} from "./paths"

const DEFAULT_BINARY_MIME_TYPE = "application/octet-stream"
const IMAGE_MIME_PREFIX = "image/"
const TEXT_PLAIN_CONTENT_TYPE = "text/plain; charset=utf-8"

const TEXT_CONTENT_TYPE_BY_EXTENSION = new Map<string, string>([
  [".csv", "text/csv; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".jsonc", TEXT_PLAIN_CONTENT_TYPE],
  [".md", "text/markdown; charset=utf-8"],
  [".tsv", "text/tab-separated-values; charset=utf-8"],
])

const TEXT_LIKE_EXTENSIONS = new Set([
  ".c", ".cc", ".cfg", ".conf", ".cpp", ".cs", ".css", ".env", ".go", ".graphql", ".h", ".hpp", ".htm", ".html",
  ".ini", ".java", ".js", ".jsx", ".kt", ".lua", ".mjs", ".php", ".pl", ".properties", ".py", ".rb", ".rs",
  ".scss", ".sh", ".shtml", ".sql", ".svg", ".svgz", ".swift", ".toml", ".ts", ".tsx", ".txt", ".vue", ".xht", ".xhtml", ".xml", ".yaml", ".yml", ".zsh",
])

function isWithin(root: string, target: string) {
  return target === root || target.startsWith(`${root}${path.sep}`)
}

async function ensureContainedDirectory(
  directoryPath: string,
  projectRoot: string,
  create: boolean,
): Promise<ContainedPathResult> {
  try {
    let info
    try {
      info = await lstat(directoryPath)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" || !create) {
        return { ok: false, reason: "missing" }
      }
      try {
        await mkdir(directoryPath)
      } catch (mkdirError) {
        if ((mkdirError as NodeJS.ErrnoException).code !== "EEXIST") throw mkdirError
      }
      info = await lstat(directoryPath)
    }


    if (info.isSymbolicLink() || !info.isDirectory()) {
      return { ok: false, reason: "outside" }
    }
    const resolved = await realpath(directoryPath)
    if (!isWithin(projectRoot, resolved)) {
      return { ok: false, reason: "outside" }
    }
    return { ok: true, path: resolved, root: projectRoot }
  } catch {
    return { ok: false, reason: "missing" }
  }
}

async function resolveProjectUploadDirectory(localPath: string, create: boolean): Promise<ContainedPathResult> {
  try {
    const projectPath = resolveLocalPath(localPath)
    const projectRoot = await realpath(projectPath)
    if (!(await stat(projectRoot)).isDirectory()) return { ok: false, reason: "missing" }


    const dataDir = await ensureContainedDirectory(getProjectDataDir(projectPath), projectRoot, create)
    if (!dataDir.ok) return dataDir
    return ensureContainedDirectory(path.join(projectPath, PROJECT_DATA_DIR_NAME, "uploads"), projectRoot, create)
  } catch {
    return { ok: false, reason: "missing" }
  }
}

export async function resolveExistingProjectUpload(
  localPath: string,
  storedName: string,
): Promise<ContainedPathResult> {
  const uploadDir = await resolveProjectUploadDirectory(localPath, false)
  if (!uploadDir.ok) return uploadDir
  const lexicalTarget = path.resolve(uploadDir.path, storedName)
  if (!isWithin(uploadDir.path, lexicalTarget)) return { ok: false, reason: "outside" }
  try {
    if ((await lstat(lexicalTarget)).isSymbolicLink()) return { ok: false, reason: "outside" }
  } catch {
    return { ok: false, reason: "missing" }
  }
  return resolveExistingPathWithinRoot(uploadDir.path, storedName)
}

function sanitizeFileName(fileName: string) {
  const baseName = path.basename(fileName).trim()


  const cleaned = baseName
    .replace(/[^\p{L}\p{M}\p{N}._-]+/gu, "-")
    .replace(/^-+|-+$/g, "")


  if (!cleaned || cleaned.startsWith(".")) return `upload${cleaned}`
  return cleaned
}

function getUploadCandidateNames(originalName: string) {
  const sanitizedName = sanitizeFileName(originalName)
  const parsed = path.parse(sanitizedName)
  const extension = parsed.ext
  const name = parsed.name || "upload"

  return {
    first: sanitizedName,
    withCounter(counter: number) {
      return `${name}-${counter}${extension}`
    },
  }
}

export async function persistProjectUpload(args: {
  projectId: string
  localPath: string
  fileName: string
  bytes: Uint8Array
  fallbackMimeType?: string
}): Promise<ChatAttachment> {
  const resolvedUploadDir = await resolveProjectUploadDirectory(args.localPath, true)
  if (!resolvedUploadDir.ok) {
    throw new Error("Project upload directory is missing or escapes the project root")
  }


  const uploadDir = getProjectUploadDir(args.localPath)

  const detectedType = await fileTypeFromBuffer(args.bytes)
  const mimeType = inferAttachmentContentType(
    args.fileName,
    detectedType?.mime ?? args.fallbackMimeType ?? DEFAULT_BINARY_MIME_TYPE,
  )
  const candidates = getUploadCandidateNames(args.fileName)

  let storedName = candidates.first
  let absolutePath = path.join(uploadDir, storedName)
  let counter = 1

  while (true) {
    try {
      const handle = await open(absolutePath, "wx")
      try {
        await handle.writeFile(args.bytes)
      } finally {
        await handle.close()
      }
      break
    } catch (error) {
      const code = error instanceof Error && "code" in error ? (error as NodeJS.ErrnoException).code : undefined
      if (code !== "EEXIST") {
        throw error
      }

      storedName = candidates.withCounter(counter)
      absolutePath = path.join(uploadDir, storedName)
      counter += 1
    }
  }

  return {
    id: randomUUID(),
    kind: mimeType.startsWith(IMAGE_MIME_PREFIX) ? "image" : "file",
    displayName: args.fileName,
    absolutePath,
    relativePath: `./${PROJECT_DATA_DIR_NAME}/uploads/${storedName}`,
    contentUrl: `/api/projects/${args.projectId}/uploads/${encodeURIComponent(storedName)}/content`,
    mimeType,
    size: args.bytes.byteLength,
  }
}

export function inferAttachmentContentType(fileName: string, fallbackType?: string): string {
  const extension = path.extname(fileName).toLowerCase()
  const mappedType = TEXT_CONTENT_TYPE_BY_EXTENSION.get(extension)
  if (mappedType) {
    return mappedType
  }

  if (TEXT_LIKE_EXTENSIONS.has(extension)) {
    return TEXT_PLAIN_CONTENT_TYPE
  }

  return fallbackType || DEFAULT_BINARY_MIME_TYPE
}

export function inferProjectFileContentType(fileName: string, fallbackType?: string): string {
  return inferAttachmentContentType(fileName, fallbackType)
}

export async function deleteProjectUpload(args: {
  localPath: string
  storedName: string
}): Promise<boolean> {
  const storedName = args.storedName
  if (!storedName || storedName.includes("/") || storedName.includes("\\") || storedName === "." || storedName === "..") {
    return false
  }

  const resolved = await resolveExistingProjectUpload(args.localPath, storedName)
  if (!resolved.ok) return false
  try {
    await rm(resolved.path, { force: true })
    return true
  } catch {
    return false
  }
}
