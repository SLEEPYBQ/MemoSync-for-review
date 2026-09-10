

export interface SlashCommandMatch {
  query: string
  matches: string[]
}

export function matchSlashCommands(value: string, commands: string[]): SlashCommandMatch | null {
  if (commands.length === 0) return null
  if (!value.startsWith("/")) return null
  if (/[\s\n]/.test(value)) return null
  const query = value.slice(1).toLowerCase()
  const prefix: string[] = []
  const substring: string[] = []
  for (const command of commands) {
    const lower = command.toLowerCase()
    if (lower.startsWith(query)) prefix.push(command)
    else if (query && lower.includes(query)) substring.push(command)
  }

  const matches = [...prefix, ...substring]
  return matches.length ? { query, matches } : null
}


export const SLASH_POPUP_MAX_HEIGHT_PX = 288

export const SLASH_POPUP_ANCHOR_GAP_PX = 8

export const SLASH_POPUP_VIEWPORT_MARGIN_PX = 12

export const SLASH_POPUP_MIN_HEIGHT_PX = 96


export function slashPopupMaxHeightPx(anchorTopPx: number): number {
  const available = Math.floor(anchorTopPx - SLASH_POPUP_ANCHOR_GAP_PX - SLASH_POPUP_VIEWPORT_MARGIN_PX)
  return Math.max(SLASH_POPUP_MIN_HEIGHT_PX, Math.min(SLASH_POPUP_MAX_HEIGHT_PX, available))
}
