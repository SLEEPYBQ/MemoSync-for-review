

import { DEFAULT_DEEPSEEK_MODEL_ID } from "../shared/types"

export const DEEPSEEK_ANTHROPIC_PATH = "/anthropic"


export const DEEPSEEK_AUTO_COMPACT_WINDOW = "786432"

export function deriveDeepSeekEngineEnv(env: Readonly<Record<string, string | undefined>>): Record<string, string> | null {
  const apiKey = env.DEEPSEEK_API_KEY?.trim()
  if (!apiKey) return null
  if (env.MEMOSYNC_USE_OWN_ANTHROPIC === "1") return null

  const base = (env.DEEPSEEK_BASE_URL?.trim() || "https://api.deepseek.com").replace(/\/+$/, "")
  const model = env.DEEPSEEK_MODEL?.trim() || DEFAULT_DEEPSEEK_MODEL_ID
  return {
    ANTHROPIC_BASE_URL: `${base}${DEEPSEEK_ANTHROPIC_PATH}`,


    ANTHROPIC_AUTH_TOKEN: apiKey,
    ANTHROPIC_API_KEY: apiKey,
    ANTHROPIC_MODEL: model,
    ANTHROPIC_DEFAULT_OPUS_MODEL: model,
    ANTHROPIC_DEFAULT_SONNET_MODEL: model,


    ANTHROPIC_DEFAULT_HAIKU_MODEL: DEFAULT_DEEPSEEK_MODEL_ID,
    ANTHROPIC_SMALL_FAST_MODEL: DEFAULT_DEEPSEEK_MODEL_ID,
    CLAUDE_CODE_SUBAGENT_MODEL: DEFAULT_DEEPSEEK_MODEL_ID,
    CLAUDE_CODE_AUTO_COMPACT_WINDOW: env.CLAUDE_CODE_AUTO_COMPACT_WINDOW?.trim() || DEEPSEEK_AUTO_COMPACT_WINDOW,
  }
}


export function applyDeepSeekEngineEnvDefaults(): Record<string, string> | null {
  const derived = deriveDeepSeekEngineEnv(process.env)
  if (!derived) return null
  const displaced = process.env.ANTHROPIC_BASE_URL?.trim()
  if (displaced && displaced !== derived.ANTHROPIC_BASE_URL) {
    console.log(`[engine] ignoring inherited ANTHROPIC_BASE_URL=${displaced} — DEEPSEEK_API_KEY takes precedence (set MEMOSYNC_USE_OWN_ANTHROPIC=1 to keep your own ANTHROPIC_* setup)`)
  }
  Object.assign(process.env, derived)
  console.log(`[engine] Claude Code engine → DeepSeek (${derived.ANTHROPIC_BASE_URL}, default model ${derived.ANTHROPIC_MODEL})`)
  return derived
}
