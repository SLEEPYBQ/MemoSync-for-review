

import type { HydratedTranscriptMessage } from "../../shared/types"

export function buildViolatedCitationsByMessageId(
  messages: HydratedTranscriptMessage[],
): Map<string, Set<string>> | null {
  let segment: string[] = []
  let result: Map<string, Set<string>> | null = null
  for (const message of messages) {
    if (message.hidden) continue
    if (message.kind === "user_prompt") {
      segment = []
    } else if (message.kind === "assistant_text") {
      segment.push(message.id)
    } else if (message.kind === "memory_trace") {
      const violated = message.labels.filter((l) => l.label === "violated").map((l) => l.id)
      const judged = segment


      segment = []
      if (violated.length === 0 || judged.length === 0) continue
      result ??= new Map()
      for (const id of judged) {
        const set = result.get(id) ?? new Set<string>()
        for (const v of violated) set.add(v)
        result.set(id, set)
      }
    }
  }
  return result
}


export function violatedCitationsSignature(map: Map<string, Set<string>> | null): string {
  if (!map) return ""
  return [...map.entries()].map(([k, v]) => `${k}:${[...v].sort().join("+")}`).join("|")
}
