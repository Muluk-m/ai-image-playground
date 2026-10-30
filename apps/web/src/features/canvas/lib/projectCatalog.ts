import type { CloudProjectSummary, ProjectTotals } from '@image-playground/shared'
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
    .filter((project) => !project.cloud?.deleted && !project.quotaRejected)
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

/** 服务端已经数进总数的项目：上过云、没删、没被上限拒。没上过云的另算。 */
function countedByServer(project: CanvasProject | undefined): boolean {
  return Boolean(
    project?.cloud &&
      project.cloud.revision > 0 &&
      !project.cloud.deleted &&
      !project.quotaRejected,
  )
}

/** 本机删掉、恢复或首次上云的那一项，让服务端总数跟着变，不必再拉一遍第一页。 */
export function adjustProjectTotals(
  totals: ProjectTotals,
  before: CanvasProject | undefined,
  after: CanvasProject,
): ProjectTotals {
  const delta = (project: CanvasProject | undefined, sign: number) =>
    countedByServer(project) && project
      ? { all: sign, chat: projectExperience(project) === 'chat' ? sign : 0 }
      : { all: 0, chat: 0 }
  const removed = delta(before, -1)
  const added = delta(after, 1)
  return {
    all: Math.max(0, totals.all + removed.all + added.all),
    chat: Math.max(0, totals.chat + removed.chat + added.chat),
  }
}

/**
 * 页签上的数字。云端只拉了前几页，按服务端总数显示，再加上本机还没上云的；
 * 搜索时只能数已经拉下来的。
 */
export function projectCounts(
  scoped: readonly CanvasProject[],
  totals: ProjectTotals | null,
): Record<'all' | 'chat' | 'canvas', number> {
  const counted = totals ? scoped.filter((project) => !countedByServer(project)) : scoped
  const all = (totals?.all ?? 0) + counted.length
  const chat =
    (totals?.chat ?? 0) + counted.filter((project) => projectExperience(project) === 'chat').length
  return { all, chat, canvas: Math.max(0, all - chat) }
}
