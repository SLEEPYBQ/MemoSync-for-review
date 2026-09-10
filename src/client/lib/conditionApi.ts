

import { useEffect, useState } from "react"
import type { ConditionPolicy } from "../../server/experiment/condition"
import { PROVIDERS, type ProviderCatalogEntry } from "../../shared/types"

export type { ConditionPolicy }

const DEFAULT_POLICY: ConditionPolicy = {
  condition: "memosync",
  capture: "review",
  preview: true,
  trace: true,
  boardVisible: true,
  boardWritable: true,
  bringIn: true,
  injection: "skills",
  memoryTools: true,
  studyMode: false,
}

let cached: ConditionPolicy | null = null
let inflight: Promise<ConditionPolicy> | null = null
let resolvedFromServer = false
let conditionLoadFailed = false


const CONDITION_LOAD_RETRY_DELAYS_MS = [0, 250, 750] as const


let cachedProviders: ProviderCatalogEntry[] | null = null

function wait(ms: number) {
  return new Promise<void>((resolve) => globalThis.setTimeout(resolve, ms))
}

export async function requestConditionPolicyWithRetry({
  fetchPolicy = () => fetch("/api/condition", { cache: "no-store" }),
  retryDelaysMs = CONDITION_LOAD_RETRY_DELAYS_MS,
  sleep = wait,
}: {
  fetchPolicy?: () => Promise<Response>
  retryDelaysMs?: readonly number[]
  sleep?: (ms: number) => Promise<void>
} = {}) {
  let lastError: unknown = new Error("condition request failed")

  for (const delayMs of retryDelaysMs) {
    if (delayMs > 0) await sleep(delayMs)
    try {
      const response = await fetchPolicy()
      if (!response.ok) throw new Error(`condition request failed (${response.status})`)
      const body = await response.json()
      if (!body?.data) throw new Error("condition response is missing data")
      return body
    } catch (error) {
      lastError = error
    }
  }

  throw lastError
}

export function fetchConditionPolicy(): Promise<ConditionPolicy> {
  if (cached) return Promise.resolve(cached)
  if (!inflight) {
    inflight = requestConditionPolicyWithRetry()
      .then((body) => {
        cached = body.data as ConditionPolicy
        resolvedFromServer = true
        conditionLoadFailed = false
        if (Array.isArray(body?.providers) && body.providers.length > 0) {
          cachedProviders = body.providers as ProviderCatalogEntry[]
        }
        return cached
      })
      .catch(() => {


        cached = DEFAULT_POLICY
        resolvedFromServer = false
        conditionLoadFailed = true
        return cached
      })
  }
  return inflight
}


const FALLBACK_PROVIDERS = PROVIDERS.filter((provider) => provider.id === "claude")


export function useServerProviders(): ProviderCatalogEntry[] {
  const [providers, setProviders] = useState<ProviderCatalogEntry[]>(cachedProviders ?? FALLBACK_PROVIDERS)
  useEffect(() => {
    let alive = true
    void fetchConditionPolicy().then(() => {
      if (alive && cachedProviders) setProviders(cachedProviders)
    })
    return () => {
      alive = false
    }
  }, [])
  return providers
}

export function useConditionPolicy(): ConditionPolicy {
  const [policy, setPolicy] = useState<ConditionPolicy>(cached ?? DEFAULT_POLICY)
  useEffect(() => {
    let alive = true
    void fetchConditionPolicy().then((p) => {
      if (alive) setPolicy(p)
    })
    return () => {
      alive = false
    }
  }, [])
  return policy
}


export function useConditionPolicyResolved(): ConditionPolicy | null {
  const [policy, setPolicy] = useState<ConditionPolicy | null>(resolvedFromServer ? cached : null)
  useEffect(() => {
    let alive = true
    void fetchConditionPolicy().then((p) => {
      if (alive && resolvedFromServer) setPolicy(p)
    })
    return () => {
      alive = false
    }
  }, [])
  return policy
}


export function useConditionPolicyLoadFailed(): boolean {
  const [failed, setFailed] = useState(conditionLoadFailed)
  useEffect(() => {
    let alive = true
    void fetchConditionPolicy().then(() => {
      if (alive) setFailed(conditionLoadFailed)
    })
    return () => {
      alive = false
    }
  }, [])
  return failed
}
