import type { CloudProjectSummary } from '@image-playground/shared'
import type { CanvasProject } from './projectRepository'

/** 云端目录负责显示新名称，本机未同步的改名优先。列表与快捷切换用同一份视图。 */
export function projectCatalog(
  projects: readonly CanvasProject[],
  cloud: Record<string, CloudProjectSummary>,
): CanvasProject[] {
  return projects
    .map((project) => {
      const remote = cloud[project.id]
      return remote && !project.cloud?.nameDirty
        ? {
            ...project,
            name: remote.name,
            updatedAt: Math.max(project.updatedAt, remote.updatedAt),
            hasContent: project.hasContent || remote.elementCount > 0,
          }
        : project
    })
    .sort((a, b) => b.updatedAt - a.updatedAt)
}
