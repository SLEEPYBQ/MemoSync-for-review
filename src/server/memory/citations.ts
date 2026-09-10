

const CITATION_RE = /\[(M-\d+)\]/g;


export function extractCitations(text: string): string[] {
  if (!text) return [];
  const seen = new Set<string>();
  for (const m of text.matchAll(CITATION_RE)) seen.add(m[1]);
  return [...seen];
}


export function recordCitations(
  text: string,
  availableIds: Set<string>,
  bumpUsage: (id: string) => void,
): string[] {
  const counted: string[] = [];
  for (const id of extractCitations(text)) {
    if (availableIds.has(id)) {
      bumpUsage(id);
      counted.push(id);
    }
  }
  return counted;
}
