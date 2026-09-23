import type { AgentConversationView } from '@image-playground/shared'
import {
  AGENT_CONVERSATION_KEY,
  accountScope,
  safeLocalStorage,
  scopedStorageName,
} from '../../../lib/authScope'
import { flushOnPageHide } from '../../../lib/flushOnPageHide'
import { setAgentCanvasSink } from '../../agent/lib/canvasSink'
import { currentCanvasProject, restoreCloudProject, useCanvasProjectStore } from '../projectStore'
import type { CloudProjectSession } from './cloudProjects'
import { readPersistedScene } from './persistence'
import {
  cloudProjectsEnabled,
  getCloudProject,
  PROJECT_REQUEST_TIMEOUT_MS,
  restoreDeletedCloudProject,
} from './projectClient'
import { type CanvasProject, projectRepository, UNTITLED_PROJECT } from './projectRepository'
import { writeProjectRoute } from './projectRoute'
import { canvasSceneKey } from './workspaceKeys'
import { CanvasWorkspace } from './workspaces'

/**
 * 当前项目：谁被打开着、它的画布是哪一份、智能体的产物落到哪里。
 * 工作区注册表住在这里——「项目」与「它的画布」本来就是一回事，分开放就要靠调用方对齐。
 */
const workspaces = new Map<string, CanvasWorkspace>()
const listeners = new Set<() => void>()
let current: CanvasWorkspace | undefined
let visible = false
let lifecycleInstalled = false
let refreshTimer: ReturnType<typeof setInterval> | undefined
let sameAccount = accountScope()

/** 换过账号就把上一个账号开着的画布全扔掉：它们的存档与云端会话都不属于现在这个人。 */
function ensureCurrentAccount() {
  if (sameAccount()) return
  for (const item of workspaces.values()) item.dispose()
  workspaces.clear()
  current = undefined
  sameAccount = accountScope()
  clearInterval(refreshTimer)
  refreshTimer = undefined
  setAgentCanvasSink(null)
}

function refreshVisibleWorkspace() {
  clearInterval(refreshTimer)
  refreshTimer = undefined
  if (!visible || document.visibilityState !== 'visible') return
  current?.refreshCloud()
  refreshTimer = setInterval(() => {
    if (document.visibilityState === 'hidden') return
    current?.refreshCloud()
    void useCanvasProjectStore.getState().refreshCloud()
  }, 15000)
}

function workspace(key: string, migrateLegacy = false): CanvasWorkspace {
  ensureCurrentAccount()
  let value = workspaces.get(key)
  if (!value) {
    value = new CanvasWorkspace(key, migrateLegacy)
    void value.ready.catch(() => {})
    workspaces.set(key, value)
  }
  return value
}

/**
 * 已经打开的那个工作区的云同步会话；还没打开任何工作区时是 undefined。
 * 只读：不像 `currentCanvasWorkspace()` 那样顺手建一个——在发送路径上建工作区会抢在
 * 首条消息绑定画布之前占住 `current`，绑定随之失败。
 */
export function openCanvasCloudSession(): CloudProjectSession | undefined {
  return current?.cloud
}

export function currentCanvasWorkspace(): CanvasWorkspace {
  ensureCurrentAccount()
  if (!current) {
    const remembered = safeLocalStorage.getItem(scopedStorageName(AGENT_CONVERSATION_KEY))
    current = workspace(currentCanvasProject()?.sceneKey ?? canvasSceneKey(remembered), true)
    const opened = current
    void opened.ready
      .then(() => {
        if (current === opened && visible) {
          setAgentCanvasSink(opened.sink)
          refreshVisibleWorkspace()
        }
      })
      .catch(() => {})
  }
  if (!lifecycleInstalled) {
    lifecycleInstalled = true
    // 冲的是此刻还活着的那些：`forgetCanvasWorkspace` 摘掉的不在其中。
    flushOnPageHide(() => {
      for (const item of workspaces.values()) void item.flush()
    })
    document.addEventListener('visibilitychange', refreshVisibleWorkspace)
  }
  return current
}

export function subscribeCanvasWorkspace(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function showCanvasWorkspace(show: boolean): void {
  const changed = show !== visible
  visible = show
  setAgentCanvasSink(show ? currentCanvasWorkspace().sink : null)
  if (changed) refreshVisibleWorkspace()
  if (!show) void current?.flush()
}

/** 这条会话此刻对应的那份画布：有项目就是项目的存档，没有才落到会话草稿那一把键。 */
export function conversationSceneKey(conversationId: string | null): string {
  const project = useCanvasProjectStore
    .getState()
    .projects.find((one) => one.conversationId === conversationId)
  return conversationId && project ? project.sceneKey : canvasSceneKey(conversationId)
}

/** 把这份画布摆到台前：旧的先冲盘，新的接上智能体产物。不在画布里时不动。 */
export function selectCanvasWorkspace(key: string): void {
  ensureCurrentAccount()
  // 不在画布里时无需加载图片；下次打开画布从当前项目初始化。
  if (!current) return
  void current.flush()
  current = workspace(key)
  current.refreshCloud()
  if (visible) setAgentCanvasSink(current.sink)
  for (const listener of listeners) listener()
}

/**
 * 把这个项目摆成当前项目：认它当前、按项目（不是按会话）选它的画布、发布它的产物出口、写地址。
 *
 * `reset` 是给「从别的项目切过来」那一路的：它在旧画布撤下与新画布发布之间跑，面板必须在这一刻
 * 清空，否则旧轮的产物会投进新项目——`showProject` 传的就是这一步。重新摆开已经是当前项目的
 * 那个（进画布、失效会话解绑后）没有别人的面板要清，不传。
 */
export function openProject(projectId: string, reset: () => void = () => {}): void {
  const state = useCanvasProjectStore.getState()
  const project = state.projects.find((one) => one.id === projectId)
  if (!project) return
  // 已经是当前项目（进画布、后台对完云端那份）就不再往历史里压一条。
  state.activate(project.id, state.activeId === project.id)
  reset()
  selectCanvasWorkspace(project.sceneKey)
}

/** 进画布：目录读完就把该打开的那个项目摆上来。读不出目录由界面报错并重试。 */
export async function openCurrentProject(): Promise<void> {
  try {
    await useCanvasProjectStore.getState().load()
  } catch {
    return
  }
  const active = useCanvasProjectStore.getState().activeId
  if (active) openProject(active)
}

/** 地址里那个项目打不开时的退路：回到当前项目的地址，没有当前项目就回首页。 */
export function backToCurrentProject(): void {
  const active = useCanvasProjectStore.getState().activeId
  if (!active) {
    location.assign('/')
    return
  }
  writeProjectRoute(active, true)
  useCanvasProjectStore.setState({ routeError: null })
}

export async function bindNewCanvasWorkspace(conversationId: string): Promise<boolean> {
  const project = currentCanvasProject()
  if (project) {
    if (project.conversationId && project.conversationId !== conversationId) return false
    const original = current
    if (original) {
      try {
        await original.ready
      } catch {
        return false
      }
      if (!(await original.flush())) return false
    }
    try {
      await useCanvasProjectStore.getState().update(project.id, { conversationId })
      return true
    } catch {
      return false
    }
  }
  if (!current) return true
  const draftKey = canvasSceneKey(null)
  const draft = workspaces.get(draftKey)
  if (draft !== current) return false
  const key = canvasSceneKey(conversationId)
  if (!(await draft.bind(key))) return false
  workspaces.delete(draftKey)
  workspaces.set(key, draft)
  return true
}

export async function prepareCanvasRemoval(key: string): Promise<void> {
  const target = workspace(key)
  await target.ready
  if (target.doc.elements.some((one) => one.type === 'placeholder' && one.status === 'loading'))
    throw new Error('busy')
  if (!(await target.flush())) throw new Error('save_failed')
}

export function forgetCanvasWorkspace(key: string): void {
  if (workspaces.get(key) === current) {
    clearInterval(refreshTimer)
    refreshTimer = undefined
  }
  workspaces.get(key)?.dispose()
  workspaces.delete(key)
}

/**
 * 名字已经写进本机目录并标了 `nameDirty`，这里把它推给已经打开的那个云端会话。
 * 项目没打开就什么都不做：不为改个名字把整份文档拉下来，下次打开时会连同文档一起推上去。
 */
async function pushCloudProjectName(project: CanvasProject): Promise<void> {
  const session = workspaces.get(project.sceneKey)?.cloud
  if (!session) return
  try {
    await session.rename(project.name)
  } catch {
    // 推不上去就留着 `nameDirty`，下次同步再补；改名不该因为网络失手而回滚。
  }
}

/** 用户自己改的名字：先落本机目录（`nameDirty` 保证远端不回盖），开着的项目顺手推上去。 */
export async function renameProject(id: string, name: string): Promise<void> {
  await useCanvasProjectStore.getState().update(id, { name, customName: true })
  const project = useCanvasProjectStore.getState().projects.find((one) => one.id === id)
  if (project?.cloud && cloudProjectsEnabled()) await pushCloudProjectName(project)
}

/**
 * 会话标题给还没起名的项目补的自动名：不算用户起的名字，标题再变还能跟着改。
 * 开着的云端项目就地改并推上去；没开着的落本机并标 `nameDirty`——为了补个名字
 * 把一堆旧项目的文档逐个拉起来推一遍，代价太大，等它下次打开顺手带上去。
 */
export async function autoNameProject(id: string, name: string): Promise<void> {
  const project = useCanvasProjectStore.getState().projects.find((one) => one.id === id)
  const session =
    project?.cloud && cloudProjectsEnabled() && workspaces.get(project.sceneKey)?.cloud
  if (session) {
    await session.rename(name, false)
    return
  }
  useCanvasProjectStore.getState().updateListed(
    await projectRepository.update(id, {
      name,
      hasContent: true,
      ...(project?.cloud ? { cloud: { ...project.cloud, nameDirty: true } } : {}),
    }),
  )
}

/** 从回收站恢复一个云端项目：身份先在云端复活，再把目录与已经开着的那份画布对上。 */
export async function restoreProject(id: string): Promise<void> {
  const isCurrent = accountScope()
  await restoreDeletedCloudProject(id)
  if (!isCurrent()) return
  const summary = await getCloudProject(id, AbortSignal.timeout(PROJECT_REQUEST_TIMEOUT_MS))
  if (!isCurrent()) return
  const project = await restoreCloudProject(summary)
  if (!isCurrent()) return
  useCanvasProjectStore.getState().updateListed(project)
  useCanvasProjectStore.setState((state) => ({
    cloudCatalog: { ...state.cloudCatalog, [id]: summary },
  }))
  if (isCurrent()) await workspaces.get(project.sceneKey)?.cloud?.load(true)
}

/** 会话列表回来了：没有项目的会话补一条项目记录，没起过名的跟着会话标题走。 */
export async function importConversationProjects(
  conversations: readonly AgentConversationView[],
  isCurrent: () => boolean = () => true,
): Promise<void> {
  await useCanvasProjectStore.getState().load()
  for (const conversation of conversations) {
    if (!isCurrent()) return
    const existing = useCanvasProjectStore
      .getState()
      .projects.find((one) => one.conversationId === conversation.id)
    if (existing) {
      if (existing.cloud?.deleted) continue
      // 自动命名是顺带做的：一个项目改不动（本机没这条记录），后面的项目不该跟着没名字。
      if (!existing.customName && conversation.title && existing.name !== conversation.title)
        await autoNameProject(existing.id, conversation.title).catch(() => {})
      continue
    }
    const project = await projectRepository.create(conversation.title || UNTITLED_PROJECT, {
      sceneKey: canvasSceneKey(conversation.id),
      conversationId: conversation.id,
    })
    useCanvasProjectStore.getState().updateListed(project)
  }
}

export async function copyDeletedProjectLocally(id: string): Promise<CanvasProject> {
  const isCurrent = accountScope()
  const project = useCanvasProjectStore.getState().projects.find((one) => one.id === id)
  if (!project?.cloud?.deleted) throw new Error('project_not_deleted')
  const cached = workspaces.get(project.sceneKey)
  if (cached && !(await cached.flush())) throw new Error('local_save_failed')
  if (!isCurrent()) throw new Error('account_changed')
  const scene = await readPersistedScene(project.sceneKey)
  if (!isCurrent()) throw new Error('account_changed')
  if (!scene) throw new Error('local_scene_missing')
  const copy = await projectRepository.createRecoveryCopy(project, scene)
  if (!isCurrent()) throw new Error('account_changed')
  useCanvasProjectStore.getState().updateListed(copy)
  return copy
}
