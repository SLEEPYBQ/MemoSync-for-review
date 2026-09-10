

export const KNOWN_CATALOG_PREFIXES = ["deepseek-", "glm-"] as const


export function isKnownCatalogModel(modelId: string): boolean {
  return KNOWN_CATALOG_PREFIXES.some((prefix) => modelId.startsWith(prefix))
}

export interface ChatProviderRoute {

  baseUrl: string

  apiKey: string | undefined

  autoCompactWindow: string

  subagentModel: string

  appendOneMillionSuffix: boolean
}


export function resolveChatProviderRoute(
  modelId: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): ChatProviderRoute | null {
  if (modelId.startsWith("glm-")) {
    return {


      baseUrl: env.GLM_BASE_URL?.trim() || "https://open.bigmodel.cn/api/anthropic",
      apiKey: env.GLM_API_KEY?.trim() || undefined,


      autoCompactWindow: env.GLM_AUTO_COMPACT_WINDOW?.trim() || "1000000",
      subagentModel: env.GLM_SUBAGENT_MODEL?.trim() || "glm-5.3-flash",
      appendOneMillionSuffix: true,
    }
  }
  return null
}
