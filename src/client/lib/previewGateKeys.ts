import { isImeComposingKeyEvent, type ComposingKeyEventLike } from "./imeKeys"

export interface PreviewGateKeyEventLike extends ComposingKeyEventLike {
  key: string
  shiftKey?: boolean
  metaKey?: boolean
  ctrlKey?: boolean
  defaultPrevented?: boolean
}

export interface PreviewGateTargetLike {
  tagName: string
  isContentEditable?: boolean
  value?: string
}

export type PreviewGateKeyAction = "go_on" | "dismiss"


export function previewGateKeyAction(
  event: PreviewGateKeyEventLike,
  target: PreviewGateTargetLike | null,
): PreviewGateKeyAction | null {
  if (isImeComposingKeyEvent(event)) return null


  if (event.defaultPrevented) return null
  if (target && (target.tagName === "INPUT" || target.isContentEditable)) return null
  if (target && target.tagName === "TEXTAREA" && (target.value ?? "").trim() !== "") return null
  if (event.key === "Enter" && !event.shiftKey && !event.metaKey && !event.ctrlKey) {


    if (target && (target.tagName === "BUTTON" || target.tagName === "A" || target.tagName === "SELECT")) {
      return null
    }
    return "go_on"
  }
  if (event.key === "Escape") return "dismiss"
  return null
}
