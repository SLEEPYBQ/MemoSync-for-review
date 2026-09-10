

import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"
import { getDataDir } from "../src/shared/branding"

const args = process.argv.slice(2)
const full = args.includes("--full")
const outFlagIndex = args.indexOf("--out")
const outDir = outFlagIndex >= 0 ? args[outFlagIndex + 1] : undefined
if (outFlagIndex >= 0 && !outDir) {
  console.error("--out requires a directory argument")
  process.exit(1)
}

const dataDir = process.env.DATA_DIR || getDataDir(homedir())
if (!existsSync(dataDir)) {
  console.error(`No MemoSync data directory at ${dataDir} — has the app run on this machine?`)
  process.exit(1)
}

const DEFAULT_ENTRIES = [
  "experiments",
  "install-id",
  "memory.sqlite",
  "memories",
  "settings.json",
]
const FULL_ENTRIES = [
  ...DEFAULT_ENTRIES,
  "projects.jsonl",
  "chats.jsonl",
  "messages.jsonl",
  "queued-messages.jsonl",
  "turns.jsonl",
  "snapshot.json",
  "transcripts",
]

const wanted = full ? FULL_ENTRIES : DEFAULT_ENTRIES
const present = wanted.filter((entry) => existsSync(path.join(dataDir, entry)))
if (present.length === 0) {
  console.error(`Nothing to export yet — ${dataDir} holds none of: ${wanted.join(", ")}`)
  process.exit(1)
}

const installId = (() => {
  try {
    return readFileSync(path.join(dataDir, "install-id"), "utf8").trim() || "unknown"
  } catch {
    return "unknown"
  }
})()

const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/T/, "-").slice(0, 13)
const archiveName = `memosync-export-${installId}-${stamp}${full ? "-full" : ""}.tar.gz`
const targetDir = outDir ? path.resolve(outDir) : process.cwd()
mkdirSync(targetDir, { recursive: true })
const archivePath = path.join(targetDir, archiveName)

const tar = spawnSync("tar", ["-czf", archivePath, "-C", dataDir, ...present], { stdio: "inherit" })
if (tar.status !== 0) {
  console.error("tar failed — archive not created")
  process.exit(tar.status ?? 1)
}

const sizeMb = (statSync(archivePath).size / (1024 * 1024)).toFixed(1)
console.log(`\nExported ${present.length} entries from ${dataDir}:`)
for (const entry of present) console.log(`  - ${entry}`)
if (!full) console.log("  (chat transcripts and session logs excluded — rerun with --full to include them)")
console.log(`\n→ ${archivePath} (${sizeMb} MB)`)
console.log("Send this file to the researcher.")
