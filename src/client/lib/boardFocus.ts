

export type BoardFocus = "candidates"

export function parseBoardFocus(search: string): BoardFocus | null {
  const focus = new URLSearchParams(search).get("focus")
  return focus === "candidates" ? "candidates" : null
}
