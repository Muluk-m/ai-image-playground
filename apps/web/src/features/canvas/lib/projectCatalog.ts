import type { CloudProjectSummary } from '@image-playground/shared'
import { type CanvasProject, projectExperience } from './projectRepository'

/** 云端目录负责显示新名称，本机未同步的改名优先。列表与快捷切换用同一份视图。 */
export function projectCatalog(
  projects: readonly CanvasProject[],
  cloud: Record<string, CloudProjectSummary>,
): CanvasProject[] {
  return projects
    .filter((project) => !project.cloud?.deleted)
    .map((project) => {
      const remote = cloud[project.id]
      return remote && !project.cloud?.nameDirty
        ? {
            ...project,
            name: remote.name,
            cover:
              remote.updatedAt >= project.updatedAt && remote.coverMediaId !== undefined
                ? remote.coverMediaId
                  ? `aip-media:${remote.coverMediaId}`
                  : undefined
                : project.cover,
            updatedAt: Math.max(project.updatedAt, remote.updatedAt),
            hasContent: project.hasContent || remote.elementCount > 0,
            experience: remote.experience ?? project.experience,
            sourceProjectId: remote.sourceProjectId ?? project.sourceProjectId,
          }
        : project
    })
    .sort((a, b) => b.updatedAt - a.updatedAt)
}

/** 侧栏与项目切换器每一类先列几条，展开也按这个步长；更多的去「资产 → 项目」。 */
export const RECENT_PROJECT_COUNT = 5

/** 按对话 / 画布拆开，保持原有顺序。 */
export function projectsByExperience(
  projects: readonly CanvasProject[],
): Record<'chat' | 'canvas', CanvasProject[]> {
  const groups: Record<'chat' | 'canvas', CanvasProject[]> = { chat: [], canvas: [] }
  for (const project of projects) groups[projectExperience(project)].push(project)
  return groups
}
