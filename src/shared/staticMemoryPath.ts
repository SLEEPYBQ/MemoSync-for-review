

export function isStaticMemoryMarkdownPath(value: string): boolean {
  if (!value || value.startsWith("/") || value.includes("\\")) return false
  const segments = value.split("/")
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) return false
  if (value === "MEMORY.md") return true
  return segments[0] === "memory"
    && segments.length >= 2
    && segments[segments.length - 1]!.endsWith(".md")
}
