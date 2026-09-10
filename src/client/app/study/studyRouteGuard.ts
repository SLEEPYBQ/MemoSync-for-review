export interface StudyRouteProgress {
  activeTaskId: string | null
  postSessionPending: boolean
  freezeState: "open" | "freezing" | "frozen" | null
}

export type StudyRouteAccess =
  | { kind: "allow" }
  | { kind: "wait" }
  | { kind: "redirect"; to: string }

interface StudyRouteAccessInput {
  pathname: string
  checkedPathname: string | null
  progress: StudyRouteProgress | null
}

export function isStudyQuestionnairePath(pathname: string): boolean {
  return /^\/study\/[^/]+\/quiz\/?$/.test(pathname)
}


export function isStudyPreSessionPath(pathname: string): boolean {
  return pathname === "/guide"
}


export function resolveStudyRouteAccess(input: StudyRouteAccessInput): StudyRouteAccess {
  if (isStudyPreSessionPath(input.pathname)) return { kind: "allow" }
  if (input.checkedPathname !== input.pathname || input.progress === null) {


    return isStudyQuestionnairePath(input.pathname) ? { kind: "allow" } : { kind: "wait" }
  }

  const measurementOwnsRoute = input.progress.postSessionPending || input.progress.freezeState === "freezing"
  if (measurementOwnsRoute && input.progress.activeTaskId) {
    const questionnairePath = `/study/${encodeURIComponent(input.progress.activeTaskId)}/quiz`
    if (input.pathname !== questionnairePath) {
      return { kind: "redirect", to: questionnairePath }
    }
  }

  return { kind: "allow" }
}
