

import type { DragEvent, MouseEvent, ReactNode } from "react"
import { ShieldAlert } from "lucide-react"
import type { MemoryItem } from "../../lib/memoriesApi"
import { formatSidebarAgeLabel } from "../../lib/formatters"
import { cn } from "../../lib/utils"
import { Chip, scopeCardClasses, scopeRingClasses } from "./ScopeBadge"


import { FRESHNESS_CLASSES, TRACE_DOT_CLASSES } from "./memoryVocab"

interface MemoryCardProps {
  item: MemoryItem
  variant: "candidate" | "scoped"
  selected?: boolean
  draggable?: boolean
  onDragStart?: (e: DragEvent<HTMLDivElement>) => void
  onDragEnd?: (e: DragEvent<HTMLDivElement>) => void
  onClick?: () => void
  footer?: ReactNode

  originLabel?: string

  capturedIn?: string

  freshness?: "new" | "changed"
}

export function MemoryCard({ item, variant, selected, draggable, onDragStart, onDragEnd, onClick, footer, originLabel, capturedIn, freshness }: MemoryCardProps) {
  const age = formatSidebarAgeLabel(Date.parse(item.createdAt) || undefined, Date.now())
  function handleFooterClick(e: MouseEvent<HTMLDivElement>) {

    e.stopPropagation()
  }

  return (
    <div
      role={onClick ? "button" : undefined}
      tabIndex={onClick ? 0 : undefined}
      draggable={draggable}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onClick={onClick}
      onKeyDown={
        onClick
          ? (e) => {


              if (e.target !== e.currentTarget) return
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault()
                onClick()
              }
            }
          : undefined
      }
      className={cn(
        "rounded-2xl border p-3 shadow-sm transition-colors",
        variant === "candidate" ? "border-cand-border bg-cand-surface" : scopeCardClasses(item.scope),
        onClick && "cursor-pointer",
        draggable && "active:cursor-grabbing",
        selected && variant === "candidate" && "ring-2 ring-cand-dot",
        selected && variant === "scoped" && cn("ring-2", scopeRingClasses(item.scope)),
      )}
    >
      <p className="whitespace-pre-wrap text-sm text-foreground">{item.content}</p>
      {item.sensitive ? (
        <p className="mt-1.5 flex items-center gap-1 text-xs font-medium text-cand-fg">
          <ShieldAlert className="h-3.5 w-3.5 shrink-0" />
          sensitive — needs your confirmation
        </p>
      ) : null}
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        {freshness ? <Chip className={FRESHNESS_CLASSES[freshness]}>{freshness}</Chip> : null}
        <Chip className="font-mono">{item.id}</Chip>
        {originLabel ? <Chip className="max-w-[160px] truncate">{originLabel}</Chip> : null}
        {item.usageCount > 0 ? <span className="text-[11px] text-muted-foreground">used {item.usageCount}×</span> : null}
        {item.lastTraceLabel ? (
          <span
            title={`last trace: ${item.lastTraceLabel.replace(/_/g, " ")}`}
            className={cn("ml-auto h-2 w-2 shrink-0 rounded-full", TRACE_DOT_CLASSES[item.lastTraceLabel])}
          />
        ) : null}
      </div>
      {age || capturedIn ? (
        <p className="mt-1.5 truncate text-[11px] text-muted-foreground/80">
          {age ?? ""}
          {capturedIn ? `${age ? " · " : ""}from ${capturedIn}` : ""}
        </p>
      ) : null}
      {footer ? (
        <div className="mt-2 flex flex-wrap items-center gap-1.5" onClick={handleFooterClick}>
          {footer}
        </div>
      ) : null}
    </div>
  )
}
