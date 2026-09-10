

import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"

const INSTALL_ID_FILE = "install-id"

export function resolveInstallId(dataDir: string): string {
  const filePath = join(dataDir, INSTALL_ID_FILE)
  try {
    const existing = readFileSync(filePath, "utf8").trim()
    if (/^[A-Za-z0-9-]{8,64}$/.test(existing)) return existing
  } catch {

  }
  const id = `local-${crypto.randomUUID()}`
  try {
    mkdirSync(dirname(filePath), { recursive: true })
    writeFileSync(filePath, `${id}\n`)
  } catch {

  }
  return id
}
