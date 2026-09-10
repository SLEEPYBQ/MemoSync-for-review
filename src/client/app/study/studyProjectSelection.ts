interface ProjectRow {
  groupKey: string
}


export function findAssignedStudyProject<T extends ProjectRow>(projects: readonly T[], projectId: string): T | null {
  return projects.find((project) => project.groupKey === projectId) ?? null
}
