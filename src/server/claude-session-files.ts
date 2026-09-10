

import { existsSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { resolveClaudeConfigDir } from "./provider-runtime"


export function claudeProjectFolderName(localPath: string): string {
  return localPath.replace(/[^a-zA-Z0-9]/g, "-")
}


export function claudeSessionFileExists(
  localPath: string,
  sessionToken: string,
  homeDir = homedir(),
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {

  if (!/^[A-Za-z0-9-]+$/.test(sessionToken)) return false
  return existsSync(join(resolveClaudeConfigDir(env, homeDir), "projects", claudeProjectFolderName(localPath), `${sessionToken}.jsonl`))
}
