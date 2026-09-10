

import { existsSync, renameSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"
import { getDataRootDir, getLegacyDataRootDir, LOG_PREFIX } from "../shared/branding"


function looksLikeThisAppsDataRoot(rootDir: string): boolean {
  return existsSync(path.join(rootDir, "data"))
}

function moveAsideAsBackup(dir: string): string | null {
  const stamp = new Date().toISOString().slice(0, 10)
  let backup = `${dir}-v1-backup-${stamp}`
  let suffix = 2
  while (existsSync(backup)) {
    backup = `${dir}-v1-backup-${stamp}-${suffix}`
    suffix += 1
  }
  try {
    renameSync(dir, backup)
    return backup
  } catch {
    return null
  }
}


export function migrateLegacyDataRoot(homeDir: string = homedir()): boolean {

  if (process.env.NODE_ENV === "test") return false

  const current = getDataRootDir(homeDir)
  const legacy = getLegacyDataRootDir(homeDir)
  if (!existsSync(legacy)) return false

  if (existsSync(current)) {
    if (looksLikeThisAppsDataRoot(current)) return false
    const backup = moveAsideAsBackup(current)
    if (!backup) {
      console.warn(`${LOG_PREFIX} data root ${current} is occupied by an unrecognized directory and could not be moved aside; leaving ${legacy} unmigrated`)
      return false
    }
    console.log(`${LOG_PREFIX} moved pre-existing ${current} (old MemoSync v1 layout) to ${backup}`)
  }

  try {
    renameSync(legacy, current)
    console.log(`${LOG_PREFIX} migrated data root ${legacy} -> ${current}`)
    return true
  } catch (error) {
    console.warn(`${LOG_PREFIX} failed to migrate data root ${legacy} -> ${current}:`, error)
    return false
  }
}
