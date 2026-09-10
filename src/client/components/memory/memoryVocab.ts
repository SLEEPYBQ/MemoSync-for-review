

import type { MemoryScope, MemoryType } from "../../lib/memoriesApi"


export type TraceVerdict = "operational" | "injected_without_effect" | "violated" | "not_applicable"
export type Freshness = "new" | "changed"


export const TRACE_DOT_CLASSES: Record<TraceVerdict, string> = {
  operational: "bg-foreground/60",
  violated: "bg-destructive",
  injected_without_effect: "bg-muted-foreground/40",

  not_applicable: "bg-slate-400/50",
}


export const FRESHNESS_CLASSES: Record<Freshness, string> = {
  new: "border-cand-border bg-cand-surface text-cand-fg",
  changed: "border-project-border bg-project-surface text-project-fg",
}

export const SCOPE_LEGEND: { scope: MemoryScope; meaning: string }[] = [
  { scope: "personal", meaning: "Applies across all your projects." },
  { scope: "project", meaning: "Applies only inside this project." },
  { scope: "session", meaning: "Applies only inside this one chat." },
]

export const TYPE_LEGEND: { type: MemoryType; meaning: string }[] = [
  { type: "constraint", meaning: "A rule the agent should not break." },
  { type: "preference", meaning: "How you like things done." },
  { type: "lesson", meaning: "Something learned the hard way." },
  { type: "fact", meaning: "Plain ground truth about your setup." },
]

export const TRACE_DOT_LEGEND: { verdict: TraceVerdict; label: string; meaning: string }[] = [
  { verdict: "operational", label: "shaped the reply", meaning: "The agent followed it in its last reply." },
  { verdict: "violated", label: "violated", meaning: "The agent acted against it last time." },
  { verdict: "injected_without_effect", label: "no visible effect", meaning: "Included, but no detectable influence on the reply." },
  { verdict: "not_applicable", label: "not applicable", meaning: "Nothing in that turn it could apply to." },
]

export const FRESHNESS_LEGEND: { freshness: Freshness; label: string; meaning: string }[] = [
  { freshness: "new", label: "new", meaning: "Added since your last visit here." },
  { freshness: "changed", label: "changed", meaning: "Edited since your last visit here." },
]
