

import { basename } from "node:path"
import { STUDY_TASKS, type StudyTask } from "../shared/studyTasks"
import { resolveLocalPath } from "./paths"

export interface StudyProjectSpec {
  localPath: string
  title: string
}


export interface StudyProjectStore {
  openProject(localPath: string, title?: string): Promise<{ id: string; localPath: string; title: string }>
}

export interface RegisteredStudyProject {
  projectId: string
  localPath: string
  title: string
  starterReady: boolean
}


export function parseStudyProjects(raw: string | undefined): StudyProjectSpec[] {
  if (!raw || !raw.trim()) return []
  const parsed = JSON.parse(raw)
  if (!Array.isArray(parsed)) {
    throw new Error("STUDY_PROJECTS must be a JSON array of {localPath, title?}")
  }
  const specs: StudyProjectSpec[] = []
  const seenPaths = new Set<string>()
  for (const entry of parsed) {
    const localPath = typeof entry?.localPath === "string" ? entry.localPath.trim() : ""
    if (!localPath) continue
    if (seenPaths.has(localPath)) {


      throw new Error(`Duplicate study-project localPath: ${JSON.stringify(localPath)}`)
    }
    seenPaths.add(localPath)
    const title = typeof entry?.title === "string" && entry.title.trim() ? entry.title.trim() : basename(localPath)
    specs.push({ localPath, title })
  }
  return specs
}


export async function registerStudyProjects(store: StudyProjectStore, specs: StudyProjectSpec[]) {
  const projects = []
  for (const spec of specs) {
    projects.push(await store.openProject(spec.localPath, spec.title))
  }
  return projects
}


export function resolveRegisteredStudyProjects(
  specs: readonly StudyProjectSpec[],
  registered: ReadonlyArray<{ id: string; localPath: string; title: string }>,
  isStarterReady: (slug: StudyTask["projectSlug"], localPath: string) => boolean,
): ReadonlyMap<StudyTask["projectSlug"], RegisteredStudyProject> {
  if (specs.length !== registered.length) {
    throw new Error(`Expected ${specs.length} registered study projects; received ${registered.length}`)
  }
  const slugs = [...new Set(STUDY_TASKS.map((task) => task.projectSlug))]
  const result = new Map<StudyTask["projectSlug"], RegisteredStudyProject>()

  for (const slug of slugs) {
    const indexes = specs
      .map((spec, index) => ({ spec, index }))
      .filter(({ spec }) => basename(resolveLocalPath(spec.localPath)) === slug)
    if (indexes.length !== 1) {
      throw new Error(`Expected exactly one registered study project for ${slug}; found ${indexes.length}`)
    }
    const { spec, index } = indexes[0]!
    const project = registered[index]!
    const expectedPath = resolveLocalPath(spec.localPath)
    if (project.localPath !== expectedPath) {
      throw new Error(`Study project ${slug} registered path mismatch: expected ${expectedPath}, received ${project.localPath}`)
    }
    result.set(slug, {
      projectId: project.id,
      localPath: expectedPath,
      title: project.title,
      starterReady: isStarterReady(slug, expectedPath),
    })
  }
  return result
}
