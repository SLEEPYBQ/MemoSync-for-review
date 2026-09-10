

export type ExperimentConditionName = "memosync" | "static" | "auto"

export interface ConditionPolicy {
  condition: ExperimentConditionName

  capture: "review" | "silent" | "off"
  preview: boolean
  trace: boolean
  boardVisible: boolean
  boardWritable: boolean
  bringIn: boolean


  injection: "skills" | "plain" | "file"

  memoryTools: boolean


  studyMode: boolean
}

const POLICIES: Record<ExperimentConditionName, Omit<ConditionPolicy, "studyMode">> = {
  memosync: {
    condition: "memosync",
    capture: "review",
    preview: true,
    trace: true,
    boardVisible: true,
    boardWritable: true,
    bringIn: true,
    injection: "skills",
    memoryTools: true,
  },
  auto: {
    condition: "auto",
    capture: "silent",
    preview: false,
    trace: false,
    boardVisible: false,
    boardWritable: false,
    bringIn: false,
    injection: "plain",
    memoryTools: false,
  },
  static: {
    condition: "static",
    capture: "off",
    preview: false,
    trace: false,
    boardVisible: false,
    boardWritable: false,
    bringIn: false,
    injection: "file",
    memoryTools: false,
  },
}

export function resolveConditionPolicy(condition = process.env.EXPERIMENT_CONDITION): ConditionPolicy {
  if (condition === "auto" || condition === "static" || condition === "memosync") {
    return { ...POLICIES[condition], studyMode: true }
  }
  if (condition && condition !== "memosync") {
    console.warn(`[experiment] unknown EXPERIMENT_CONDITION "${condition}" — falling back to memosync`)
  }
  return { ...POLICIES.memosync, studyMode: false }
}
