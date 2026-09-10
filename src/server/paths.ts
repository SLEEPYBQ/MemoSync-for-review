import { existsSync, renameSync } from "node:fs"
import { mkdir, realpath, stat } from "node:fs/promises"
import { homedir } from "node:os"
import path from "node:path"


export const PROJECT_DATA_DIR_NAME = ".memosync"

export const LEGACY_PROJECT_DATA_DIR_NAME = ".kanna"


export function getProjectDataDir(localPath: string) {
  const root = resolveLocalPath(localPath)
  const current = path.join(root, PROJECT_DATA_DIR_NAME)
  const legacy = path.join(root, LEGACY_PROJECT_DATA_DIR_NAME)
  if (!existsSync(current) && existsSync(legacy)) {
    try {
      renameSync(legacy, current)
    } catch {


    }
  }
  return current
}

export function resolveLocalPath(localPath: string) {
  const trimmed = localPath.trim()
  if (!trimmed) {
    throw new Error("Project path is required")
  }
  if (trimmed === "~") {
    return homedir()
  }
  if (trimmed.startsWith("~/")) {
    return path.join(homedir(), trimmed.slice(2))
  }
  return path.resolve(trimmed)
}

export async function ensureProjectDirectory(localPath: string) {
  const resolvedPath = resolveLocalPath(localPath)

  await mkdir(resolvedPath, { recursive: true })
  const info = await stat(resolvedPath)
  if (!info.isDirectory()) {
    throw new Error("Project path must be a directory")
  }
}

export function getProjectUploadDir(localPath: string) {
  return path.join(getProjectDataDir(localPath), "uploads")
}

export function getProjectExportDir(localPath: string) {
  return path.join(getProjectDataDir(localPath), "exports")
}

export type ContainedPathResult =
  | { ok: true; path: string; root: string }
  | { ok: false; reason: "outside" | "missing" }


export async function resolveExistingPathWithinRoot(rootPath: string, relativePath: string): Promise<ContainedPathResult> {
  const lexicalRoot = path.resolve(rootPath)
  const lexicalTarget = path.resolve(lexicalRoot, relativePath)
  if (lexicalTarget !== lexicalRoot && !lexicalTarget.startsWith(`${lexicalRoot}${path.sep}`)) {
    return { ok: false, reason: "outside" }
  }

  try {
    const [resolvedRoot, resolvedTarget] = await Promise.all([
      realpath(lexicalRoot),
      realpath(lexicalTarget),
    ])
    if (resolvedTarget !== resolvedRoot && !resolvedTarget.startsWith(`${resolvedRoot}${path.sep}`)) {
      return { ok: false, reason: "outside" }
    }
    return { ok: true, path: resolvedTarget, root: resolvedRoot }
  } catch {
    return { ok: false, reason: "missing" }
  }
}
