import { scopedStorageName } from '../../../lib/authScope'
import {
  cloudProjectsEnabled,
  ensureCloudProjectConversation,
} from '../../canvas/lib/projectClient'
import {
  canvasSceneKey,
  currentCanvasWorkspace,
  forgetCanvasWorkspace,
  prepareCanvasRemoval,
  selectCanvasWorkspace,
} from '../../canvas/lib/workspaces'
import { currentCanvasProject, useCanvasProjectStore } from '../../canvas/projectStore'
import {
  AgentRequestError,
  createConversation,
  fetchMessages,
  removeConversation,
} from './agentClient'
import { agentDraft, type DraftSession, removeProjectDraft } from './drafts'

/**
 * 当前项目此刻用的那份草稿。项目身份决定草稿归属，会话 id 只用来接住项目化之前
 * 留下的旧草稿，所以推导只有这一处，输入框与项目切换读的必须是同一个会话。
 */
export function currentProjectDraft(conversationId: string | null): DraftSession {
  const project = currentCanvasProject()
  return agentDraft(conversationId, project?.id, project?.sceneKey === canvasSceneKey(null))
}

export type SaveCurrentProjectResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: 'draft_save_failed' | 'save_failed' }

/**
 * 把当前项目未保存的输入与画布都落盘；任一半没落下就不算保存成功，调用方只看这一个结果。
 * 只停在 `CanvasWorkspace.flush()` 这一层：云同步由它代为触发，再往下探会出现两个主人。
 */
export async function saveCurrentProject(
  conversationId: string | null,
): Promise<SaveCurrentProjectResult> {
  // 先草稿后画布：草稿只写本机，画布的 flush() 会捎带触发云同步。
  const draft = currentProjectDraft(conversationId)
  await draft.ready
  // 草稿的 flush 不返回成败，写失败记在 snapshot 上。
  await draft.flush()
  if (draft.getSnapshot().error) return { ok: false, reason: 'draft_save_failed' }
  const workspace = currentCanvasWorkspace()
  // 读失败的画布 flush() 一定是 false，等 ready 只是为了不抢在首次读取前写。
  await workspace.ready.catch(() => {})
  // 画布的 flush 反过来：不抛，直接返回成败。
  if (!(await workspace.flush())) return { ok: false, reason: 'save_failed' }
  return { ok: true }
}

/** 一个项目在界面上的最小身份：展示它要知道的就这两样。 */
export interface ShownProject {
  readonly id: string
  readonly conversationId: string | null
}

/** 展示项目时只有 store 走得了的那几步（zustand 状态与交付闭包）；顺序归本模块。 */
export interface ShowProjectPanel {
  /** 交付的当前代次是 store 里的闭包，作废它只有 store 做得到。 */
  resetDelivery(): void
  /** 必须是一次 `set`：任何一次渲染都不能看见「消息已清、会话还是旧的」这种中间态。 */
  reset(project: ShownProject): void
  open(conversationId: string): void
}

/**
 * 把这个项目摆到界面上：作废旧交付、认它当前项目、清面板、发布它的画布，最后读回会话。
 * 顺序不能动——清掉旧消息后再发布新画布，画布挂载的通知才不会把旧产物投到新项目里。
 */
export function showProject(project: ShownProject, panel: ShowProjectPanel): void {
  panel.resetDelivery()
  useCanvasProjectStore.getState().activate(project.id)
  panel.reset(project)
  selectCanvasWorkspace(project.conversationId)
  if (project.conversationId) panel.open(project.conversationId)
}

export type DeleteProjectResult =
  | { readonly ok: true }
  | {
      readonly ok: false
      readonly reason: 'not_found' | 'cloud_project' | 'busy' | 'save_failed' | 'failed'
    }

/** 删除时面板那一侧。前两样是面板此刻的事实，读它们与后面的判断之间没有 await。 */
export interface DeleteProjectPanel {
  /** 面板此刻跟着的会话：要保住的是它那份草稿。 */
  readonly conversationId: string | null
  /** 面板上有没有一轮在跑。 */
  readonly running: boolean
  /** 删掉当前项目之前先让新项目顶上：要清面板、发布新画布，只有 store 走得了这条。 */
  replaceCurrent(): Promise<void>
  /** 会话列表是面板状态，会话没了要由它摘掉。 */
  forgetConversation(conversationId: string | null): void
}

/** 删掉这个项目的草稿、项目记录与画布存档。 */
export async function deleteProject(
  projectId: string,
  panel: DeleteProjectPanel,
): Promise<DeleteProjectResult> {
  const projects = useCanvasProjectStore.getState()
  const project = projects.projects.find((one) => one.id === projectId)
  if (!project) return { ok: false, reason: 'not_found' }
  // 云端项目只能在云端删：本机这一套只销毁本机存档，删完服务端那份还在，
  // 「已删除」就成了一句假话（ADR-0002「回收恢复尚未交付前不开放云端项目删除」、
  // ADR-0005 决策「本阶段不允许走本地删除流程销毁云端项目」）。
  if (project.cloud) return { ok: false, reason: 'cloud_project' }
  // 正在跑的那一轮还在往这张画布上落东西，连它一起删等于半路抽走目标
  //（ADR-0005 决策「运行中禁止切换、新建或删除当前会话」）。
  if (project.id === projects.activeId && panel.running) return { ok: false, reason: 'busy' }
  // 手头这份先保住：删除会把当前项目换掉，没落盘的输入与画布之后就找不回来了。
  if (!(await saveCurrentProject(panel.conversationId)).ok)
    return { ok: false, reason: 'save_failed' }
  try {
    // 画布那边只会抛，这里是把它翻成判别值的唯一一处；同样只停在 `prepareCanvasRemoval` 这一层。
    await prepareCanvasRemoval(project.sceneKey)
    if (project.conversationId && !(await removeIdleConversation(project.conversationId)))
      return { ok: false, reason: 'busy' }
    // 删的是当前项目就先让新项目顶上：界面一刻也不能没有当前项目。
    if (project.id === projects.activeId) await panel.replaceCurrent()
    await removeProjectDraft(projectId, project.conversationId)
    await projects.remove(projectId)
    forgetCanvasWorkspace(project.sceneKey)
    panel.forgetConversation(project.conversationId)
    return { ok: true }
  } catch (error) {
    return { ok: false, reason: failureReason(error) }
  }
}

/**
 * 删掉服务端那份会话；别的标签页还在这个会话上跑一轮时不删，返回 `false`。
 * 会话已经不在了正是我们要的结果，其余失败照旧抛出。
 */
async function removeIdleConversation(conversationId: string): Promise<boolean> {
  try {
    if ((await fetchMessages(conversationId)).activeTurn) return false
    await removeConversation(conversationId)
  } catch (error) {
    if (!(error instanceof AgentRequestError && error.status === 404)) throw error
  }
  return true
}

/** `prepareCanvasRemoval` 只用抛出报告失败，翻译它的字符串协议在这一处收口。 */
function failureReason(error: unknown): 'busy' | 'save_failed' | 'failed' {
  const thrown = error instanceof Error ? error.message : ''
  if (thrown === 'busy') return 'busy'
  return thrown === 'save_failed' ? 'save_failed' : 'failed'
}

export async function createProjectConversation(): Promise<string> {
  const project = currentCanvasProject()
  if (!project?.cloud || !cloudProjectsEnabled()) return (await createConversation()).id
  const scope = scopedStorageName('canvas')
  const workspace = currentCanvasWorkspace()
  await workspace.ready
  if (!(await workspace.flush())) throw new Error('local_save_failed')
  await workspace.cloud?.sync()
  if (currentCanvasProject()?.id !== project.id || scopedStorageName('canvas') !== scope)
    throw new Error('project_changed')
  if (!currentCanvasProject()?.cloud?.revision) throw new Error('project_not_synced')
  const result = await ensureCloudProjectConversation(project.id)
  if (currentCanvasProject()?.id !== project.id || scopedStorageName('canvas') !== scope)
    throw new Error('project_changed')
  return result.conversation.id
}
