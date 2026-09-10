

export function normalizeQuoteText(s: string): string {
  return s.replace(/[*_`~#>[\]()]/g, "").replace(/\s+/g, " ").trim().toLowerCase()
}


export function findQuoteBlock(quote: string, origin: HTMLElement | null): HTMLElement | null {
  const target = normalizeQuoteText(quote)
  if (target.length < 6) return null
  const root =
    origin?.closest<HTMLElement>("[data-transcript-list]") ??
    document.querySelector<HTMLElement>("[data-transcript-list]")
  if (!root) return null
  const anchored = Boolean(origin && root.contains(origin))
  const blocks = Array.from(root.querySelectorAll<HTMLElement>("p, li, blockquote, pre, h1, h2, h3, h4"))

  const searchFor = (needle: string): HTMLElement | null => {
    let best: HTMLElement | null = null
    for (const el of blocks) {
      if (!normalizeQuoteText(el.textContent || "").includes(needle)) continue
      if (!anchored) return el
      if (origin!.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_PRECEDING) best = el
      else break
    }
    return best
  }

  const exact = searchFor(target)
  if (exact) return exact


  if (target.length > 60) {
    const prefix = target.slice(0, 60)
    return searchFor(prefix)
  }
  return null
}


export function findCitationBlock(memoryId: string, origin: HTMLElement | null): HTMLElement | null {
  const root =
    origin?.closest<HTMLElement>("[data-transcript-list]") ??
    document.querySelector<HTMLElement>("[data-transcript-list]")
  if (!root) return null
  const anchored = Boolean(origin && root.contains(origin))
  const label = `[${memoryId}]`
  let best: HTMLElement | null = null
  for (const el of Array.from(root.querySelectorAll<HTMLElement>("span"))) {
    if ((el.textContent || "").trim() !== label) continue

    if (origin && origin.contains(el)) continue
    const block = el.closest<HTMLElement>("p, li, blockquote, pre, h1, h2, h3, h4") ?? el
    if (!anchored) return block
    if (origin!.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_PRECEDING) best = block
    else break
  }
  return best
}


export function flashQuoteBlock(el: HTMLElement, className = "citation-flash-block", ms = 1900): void {
  el.scrollIntoView({ behavior: "smooth", block: "center" })
  el.classList.remove(className)
  void el.offsetWidth
  el.classList.add(className)
  window.setTimeout(() => el.classList.remove(className), ms)
}
