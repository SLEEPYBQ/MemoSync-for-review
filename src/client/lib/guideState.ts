

const GUIDE_SEEN_STORAGE_KEY = "memosync:guide-seen"

export interface StudyGuideStatus {
  version: string
  completed: boolean
}

type GuideFetch = (url: string, init?: RequestInit) => Promise<Response>

async function readGuideStatus(response: Response): Promise<StudyGuideStatus> {
  if (!response.ok) throw new Error(`study guide state request failed (${response.status})`)
  const body = await response.json() as { data?: StudyGuideStatus }
  if (!body.data || typeof body.data.version !== "string" || typeof body.data.completed !== "boolean") {
    throw new Error("study guide state response is invalid")
  }
  return body.data
}

export function fetchStudyGuideStatus(fetcher: GuideFetch = fetch): Promise<StudyGuideStatus> {
  return fetcher("/api/study/guide-status", { cache: "no-store" }).then(readGuideStatus)
}

export function completeStudyGuide(fetcher: GuideFetch = fetch): Promise<StudyGuideStatus> {
  return fetcher("/api/study/guide-complete", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  }).then(readGuideStatus)
}

export function hasSeenGuide(storage: Pick<Storage, "getItem"> = window.localStorage): boolean {
  try {
    return storage.getItem(GUIDE_SEEN_STORAGE_KEY) === "1"
  } catch {
    return true
  }
}

export function markGuideSeen(storage: Pick<Storage, "setItem"> = window.localStorage): void {
  try {
    storage.setItem(GUIDE_SEEN_STORAGE_KEY, "1")
  } catch {

  }
}


export function shouldAutoShowGuide(policy: { studyMode: boolean } | null, seen: boolean): boolean {
  if (!policy) return false
  return policy.studyMode && !seen
}


export function canSkipGuide(policy: { studyMode: boolean }): boolean {
  return !policy.studyMode
}
