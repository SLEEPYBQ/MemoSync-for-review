export type GuideCandidateDecisionStep = "memosync.long-term-card" | "memosync.candidate-reopened"


export function resolveGuideCandidateJourneyDecision(
  stepId: GuideCandidateDecisionStep,
): { targetStepId: "memosync.candidate-summary" | "memosync.board-library"; blocker: null } {
  return {
    targetStepId: stepId === "memosync.candidate-reopened"
      ? "memosync.board-library"
      : "memosync.candidate-summary",
    blocker: null,
  }
}
