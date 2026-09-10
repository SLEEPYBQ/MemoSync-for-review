

import type { ReactNode } from "react"
import { FolderGit2, MessagesSquare, User } from "lucide-react"
import type { LucideIcon } from "lucide-react"
import type { MemoryScope, MemoryType } from "../../lib/memoriesApi"
import { MEMORY_SCOPE_CHIP_CLASSES, memoryScopeLabel } from "../../lib/memoryCitations"
import { cn } from "../../lib/utils"

export const SCOPES: MemoryScope[] = ["personal", "project", "session"]

export const SCOPE_ICONS: Record<MemoryScope, LucideIcon> = {
  personal: User,
  project: FolderGit2,
  session: MessagesSquare,
}


const SCOPE_CARD_CLASSES: Record<MemoryScope, string> = {
  personal: "border-personal-border bg-personal-surface",
  project: "border-project-border bg-project-surface",
  session: "border-session-border bg-session-surface",
}

const SCOPE_RING_CLASSES: Record<MemoryScope, string> = {
  personal: "ring-personal",
  project: "ring-project",
  session: "ring-session",
}


const TYPE_CHIP_CLASSES: Record<MemoryType, string> = {
  constraint: "border-rose-500/30 bg-rose-500/10 text-rose-700 dark:text-rose-300",
  preference: "border-violet-500/30 bg-violet-500/10 text-violet-700 dark:text-violet-300",
  lesson: "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300",
  fact: "border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-300",
}


export function typeChipClasses(type: MemoryType): string {
  return TYPE_CHIP_CLASSES[type] ?? ""
}


export function isMemoryType(value: string): value is MemoryType {
  return value === "constraint" || value === "preference" || value === "lesson" || value === "fact"
}


export function scopeCardClasses(scope: MemoryScope): string {
  return SCOPE_CARD_CLASSES[scope]
}


export function scopeRingClasses(scope: MemoryScope): string {
  return SCOPE_RING_CLASSES[scope]
}


export function ScopeBadge({ scope, className }: { scope: MemoryScope; className?: string }) {
  const Icon = SCOPE_ICONS[scope]
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium",
        MEMORY_SCOPE_CHIP_CLASSES[scope],
        className,
      )}
    >
      <Icon className="h-3 w-3" />
      {memoryScopeLabel(scope)}
    </span>
  )
}


export function Chip({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full border border-border bg-muted px-2 py-0.5 text-xs text-muted-foreground",
        className,
      )}
    >
      {children}
    </span>
  )
}
