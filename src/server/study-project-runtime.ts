import { resolve } from "node:path"
import { parseStudyProjects } from "./study-projects"


export function studyProjectSubprocessEnv(
  baseEnv: Readonly<Record<string, string | undefined>>,
  projectPath: string,
  rawStudyProjects: string | undefined,
): Record<string, string | undefined> {
  const assigned = parseStudyProjects(rawStudyProjects)
    .some((project) => resolve(project.localPath) === resolve(projectPath))
  if (!assigned) return { ...baseEnv }

  const env: Record<string, string | undefined> = {
    ...baseEnv,


    NODE_ENV: "development",
    npm_config_include: "dev",


    NEXT_PRIVATE_OUTPUT_TRACE_ROOT: "/",
  }
  delete env.PORT
  return env
}
