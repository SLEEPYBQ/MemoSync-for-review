

export function baseName(relPath: string): string {
  const i = relPath.lastIndexOf("/")
  return i >= 0 ? relPath.slice(i + 1) : relPath
}

export function dirName(relPath: string): string {
  const i = relPath.lastIndexOf("/")
  return i >= 0 ? relPath.slice(0, i) : ""
}


export function filterIndexPaths(index: string[], query: string, limit = 200): string[] {
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (tokens.length === 0) return []
  const ranked: Array<{ path: string; rank: number }> = []
  for (const p of index) {
    const lower = p.toLowerCase()
    if (!tokens.every((t) => lower.includes(t))) continue
    const base = baseName(lower)
    const first = tokens[0]
    const rank = base.startsWith(first) ? 0 : base.includes(first) ? 1 : 2
    ranked.push({ path: p, rank })


    if (ranked.length >= limit * 5) break
  }
  return ranked
    .sort((a, b) => a.rank - b.rank)
    .slice(0, limit)
    .map((r) => r.path)
}


export function nextActiveTab(tabs: string[], closing: string, active: string | null): string | null {
  if (active !== closing) return active
  const i = tabs.indexOf(closing)
  if (i === -1) return active
  const remaining = tabs.filter((t) => t !== closing)
  if (remaining.length === 0) return null
  return remaining[Math.min(i, remaining.length - 1)]
}


export function ancestorDirs(relPath: string): string[] {
  const parts = relPath.split("/")
  const dirs: string[] = []
  for (let i = 1; i < parts.length; i++) dirs.push(parts.slice(0, i).join("/"))
  return dirs
}


export function remapPathAfterRename(p: string, from: string, to: string): string {
  if (p === from) return to
  if (p.startsWith(`${from}/`)) return to + p.slice(from.length)
  return p
}


export function isSameOrUnder(p: string, target: string): boolean {
  return p === target || p.startsWith(`${target}/`)
}
