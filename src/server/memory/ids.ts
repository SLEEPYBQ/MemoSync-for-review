

export function memoryIdNum(id: string): number {
  const m = /^M-(\d+)$/.exec(id);
  return m ? parseInt(m[1], 10) : Number.MAX_SAFE_INTEGER;
}


export function compareMemoryId(a: string, b: string): number {
  const na = memoryIdNum(a);
  const nb = memoryIdNum(b);
  return na !== nb ? na - nb : a.localeCompare(b);
}
