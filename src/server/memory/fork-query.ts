

import { query } from "@anthropic-ai/claude-agent-sdk"

export interface ForkQueryInput {

  sessionToken: string

  localPath: string

  prompt: string
  timeoutMs?: number
}

const DEFAULT_TIMEOUT_MS = 90_000


function unfence(text: string): string {
  const m = /^```(?:json)?\s*\n([\s\S]*?)\n```\s*$/.exec(text.trim())
  return m ? m[1] : text
}

export async function runForkQuery(input: ForkQueryInput): Promise<Record<string, unknown> | null> {
  if (!input.sessionToken || !input.prompt.trim()) return null
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), input.timeoutMs ?? DEFAULT_TIMEOUT_MS)
  try {
    let text = ""
    const q = query({
      prompt: input.prompt,
      options: {
        cwd: input.localPath,
        resume: input.sessionToken,
        forkSession: true,
        maxTurns: 1,
        allowedTools: [],
        abortController: controller,
        env: (() => {
          const { CLAUDECODE: _c, ...env } = process.env
          return env
        })(),
      },
    })
    for await (const m of q) {
      const mm = m as { type?: string; subtype?: string; result?: string }
      if (mm.type === "result") {
        if (mm.subtype === "success" && typeof mm.result === "string") text = mm.result
        break
      }
    }
    if (!text.trim()) return null
    const parsed = JSON.parse(unfence(text)) as unknown
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}
