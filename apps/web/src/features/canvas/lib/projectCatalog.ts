import type { CloudProjectSummary } from '@image-playground/shared'
import { type CanvasProject, projectExperience } from './projectRepository'

/** 旧会话场景保留作本机存档；已有云端对话项目时，目录只显示云端入口。 */
export function catalogProjectId(
  project: CanvasProject | undefined,
  projects: readonly CanvasProject[],
): string | undefined {
  if (
    !project?.id.startsWith('legacy:') ||
    !project.conversationId ||
    projectExperience(project) !== 'chat'
  )
    return project?.id
  return (
    projects.find(
      (candidate) =>
        !candidate.id.startsWith('legacy:') &&
        candidate.cloud &&
        !candidate.cloud.deleted &&
        candidate.conversationId === project.conversationId &&
        projectExperience(candidate) === 'chat',
    )?.id ?? project.id
  )
}

/** 云端目录负责显示新名称，本机未同步的改名优先。列表与快捷切换用同一份视图。 */
export function projectCatalog(
  projects: readonly CanvasProject[],
  cloud: Record<string, CloudProjectSummary>,
): CanvasProject[] {
  const available = projects
    .filter((project) => !project.cloud?.deleted)
    .map((project) => {
      const remote = cloud[project.id]
      return remote && !project.cloud?.nameDirty
        ? {
            ...project,
            name: remote.name,
            // 本机较新时仍以本机为准；本机没有封面（对话项目画布常是空的）就用云端那张。
            cover:
              remote.updatedAt >= project.updatedAt && remote.coverMediaId !== undefined
                ? remote.coverMediaId
                  ? `aip-media:${remote.coverMediaId}`
                  : undefined
                : (project.cover ??
                  (remote.coverMediaId ? `aip-media:${remote.coverMediaId}` : undefined)),
            updatedAt: Math.max(project.updatedAt, remote.updatedAt),
            hasContent: project.hasContent || remote.elementCount > 0,
            experience: remote.experience ?? project.experience,
            sourceProjectId: remote.sourceProjectId ?? project.sourceProjectId,
          }
        : project
    })
  return available
    .filter((project) => catalogProjectId(project, available) === project.id)
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
