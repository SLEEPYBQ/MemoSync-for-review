

import { useEffect } from "react"
import { Bot } from "lucide-react"
import { DISPLAY_NAME } from "../../shared/branding"
import { useConditionPolicyResolved } from "../lib/conditionApi"
import { MemoSyncIcon } from "./MemoSyncIcon"

export const NEUTRAL_BRAND_NAME = "Agent"


export function useBrandName(): string {
  const policy = useConditionPolicyResolved()
  if (policy === null) return ""
  return policy.condition === "memosync" ? DISPLAY_NAME : NEUTRAL_BRAND_NAME
}

interface BrandIconProps {
  className?: string
  animated?: "hover" | "loop" | "none"
}

export function BrandIcon({ className, animated }: BrandIconProps) {
  const policy = useConditionPolicyResolved()
  if (policy === null) return null
  if (policy.condition === "memosync") return <MemoSyncIcon className={className} animated={animated} />
  return <Bot aria-hidden="true" className={className} />
}


export function useBrandFavicon(): void {
  const policy = useConditionPolicyResolved()
  const identity = policy === null ? null : policy.condition === "memosync" ? "memosync" : "neutral"
  useEffect(() => {
    if (identity === null) return
    for (const el of document.querySelectorAll('link[rel="icon"], link[rel="apple-touch-icon"]')) el.remove()
    const add = (rel: string, href: string, attrs: Record<string, string> = {}) => {
      const link = document.createElement("link")
      link.rel = rel
      link.href = href
      for (const [key, value] of Object.entries(attrs)) link.setAttribute(key, value)
      document.head.appendChild(link)
    }
    if (identity === "memosync") {
      add("icon", "/icon.svg", { type: "image/svg+xml" })
      add("icon", "/favicon.png", { type: "image/png", sizes: "96x96" })
      add("icon", "/icon-192.png", { type: "image/png", sizes: "192x192" })
      add("apple-touch-icon", "/apple-touch-icon.png", { sizes: "180x180" })
    } else {
      add("icon", "/agent-icon.svg", { type: "image/svg+xml" })
    }
  }, [identity])
}
