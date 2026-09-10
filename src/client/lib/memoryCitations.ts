

import type { MemoryScope } from "./memoriesApi"

export const MEMORY_CITATION_SCHEME = "memosync-memory:"

const CITATION_RE = /\[(M-\d+)\]/g


export function linkifyMemoryCitations(text: string): string {
  if (!text) return text


  const CODE_SEGMENT = /(```[\s\S]*?```|`[^`\n]*`)/g
  return text
    .split(CODE_SEGMENT)
    .map((segment, index) =>
      index % 2 === 1
        ? segment
        : segment.replace(CITATION_RE, (full, id) => `[${full}](${MEMORY_CITATION_SCHEME}${id})`),
    )
    .join("")
}


export function parseMemoryCitationHref(href?: string): string | null {
  if (!href || !href.startsWith(MEMORY_CITATION_SCHEME)) return null
  const id = href.slice(MEMORY_CITATION_SCHEME.length)
  return /^M-\d+$/.test(id) ? id : null
}


export function isMemoryScope(value: string): value is MemoryScope {
  return value === "personal" || value === "project" || value === "session"
}


export function memoryScopeLabel(scope: string): string {
  switch (scope) {
    case "personal":
      return "Personal"
    case "project":
      return "Project"
    case "session":
      return "Session"
    default:
      return scope
  }
}


export const MEMORY_SCOPE_CHIP_CLASSES: Record<MemoryScope, string> = {
  personal: "border-personal-border bg-personal-surface text-personal-fg",
  project: "border-project-border bg-project-surface text-project-fg",
  session: "border-session-border bg-session-surface text-session-fg",
}

export const MEMORY_SCOPE_TEXT_CLASSES: Record<MemoryScope, string> = {
  personal: "text-personal-fg",
  project: "text-project-fg",
  session: "text-session-fg",
}

export const MEMORY_SCOPE_SELECTED_CLASSES: Record<MemoryScope, string> = {
  personal: "bg-personal-surface text-personal-fg",
  project: "bg-project-surface text-project-fg",
  session: "bg-session-surface text-session-fg",
}
