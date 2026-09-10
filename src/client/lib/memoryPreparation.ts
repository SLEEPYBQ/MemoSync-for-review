import type { HydratedTranscriptMessage } from "../../shared/types"


export function hasOpenMemoryPreparationStep(messages: HydratedTranscriptMessage[]): boolean {
  let latestUserPromptIndex = -1
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.kind === "user_prompt") {
      latestUserPromptIndex = index
      break
    }
  }
  return messages.slice(Math.max(0, latestUserPromptIndex)).some((message) => (
    (message.kind === "memory_proposals" || message.kind === "memory_transfer" || message.kind === "memory_checkup" || message.kind === "memory_preview")
    && message.decision === undefined
  ))
}
