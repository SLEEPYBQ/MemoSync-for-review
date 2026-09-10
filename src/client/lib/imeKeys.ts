export interface ComposingKeyEventLike {
  isComposing?: boolean
  keyCode?: number
}


export function isImeComposingKeyEvent(event: ComposingKeyEventLike): boolean {
  return event.isComposing === true || event.keyCode === 229
}
