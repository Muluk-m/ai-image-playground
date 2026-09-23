import { i18next } from '../../../i18n'
import { AGENT_CONVERSATION_KEY, safeLocalStorage, scopedStorageName } from '../../../lib/authScope'
import { flushOnPageHide } from '../../../lib/flushOnPageHide'
import { useStore } from '../../../store'
import { setAgentCanvasSink } from '../../agent/lib/canvasSink'
import { currentCanvasProject, useCanvasProjectStore } from '../projectStore'
import { createAgentCanvasSink } from './agentCanvasSink'
import { CanvasDoc } from './canvasDoc'
import { CloudProjectSession } from './cloudProjects'
import { CanvasEditor } from './editor'
import { readPersistedScene } from './persistence'
import { cloudProjectsEnabled } from './projectClient'
import { type CanvasProject, projectRepository } from './projectRepository'
import { recoverCanvasTasks } from './recoverCanvasTasks'
import { SceneRecord, type SceneRecordStatus } from './sceneRecord'

import { canvasSceneKey } from './workspaceKeys'

export { canvasSceneKey } from './workspaceKeys'

/** 生命周期属于会话，切模式/切会话只换视图，异步任务仍写原文档并自动保存。 */
export class CanvasWorkspace {
  readonly id = crypto.randomUUID()
  readonly doc = new CanvasDoc()
  readonly editor = new CanvasEditor(this.doc)
  /** 盘上那条存档只有一个主人：读、恢复、检查点与落盘都归它。 */
  readonly record: SceneRecord
  readonly sink = createAgentCanvasSink(this.editor, () => this.ready, {
    enabled: () => Boolean(this.cloud),
    refresh: async () => {
      if (!(await this.flush())) throw new Error('local_save_failed')
      await this.cloud?.refresh(true)
    },
  })
  cloud: CloudProjectSession | undefined
  needsInitialFit = false
  ready: Promise<unknown>
  private disposed = false
  private refreshing = false

  constructor(key: string, migrateLegacy = false) {
    this.record = new SceneRecord(this.editor, key, migrateLegacy)
    this.sink.background = true
    this.ready = this.load()
  }

  getSnapshot = (): SceneRecordStatus => this.record.getSnapshot()
  subscribe = (listener: () => void): (() => void) => this.record.subscribe(listener)

  private load(): Promise<void> {
    return this.record.open(async (hasLocal) => {
      const project = useCanvasProjectStore
        .getState()
        .projects.find((one) => one.sceneKey === this.record.key)
      if (project?.cloud && cloudProjectsEnabled()) {
        this.cloud ??= new CloudProjectSession(
          project,
          this.record,
          (updated) => {
            useCanvasProjectStore.setState((state) => ({
              projects: state.projects.some((one) => one.id === updated.id)
                ? state.projects.map((one) => (one.id === updated.id ? updated : one))
                : [...state.projects, updated],
              cloudCatalog: state.cloudCatalog[updated.id]
                ? {
                    ...state.cloudCatalog,
                    [updated.id]: {
                      ...state.cloudCatalog[updated.id],
                      name: updated.name,
                      updatedAt: updated.updatedAt,
                    },
                  }
                : state.cloudCatalog,
            }))
          },
          // 副本只是备份，人留在正本：告诉他备份叫什么就够了，不切过去。
          (copy) => {
            useStore
              .getState()
              .showToast(
                i18next.t('sync.conflictForked', { ns: 'canvas', name: copy.name }),
                'info',
              )
          },
        )
        await this.cloud.load(hasLocal)
        this.cloud.start()
        this.needsInitialFit = !hasLocal && this.doc.elements.length > 0
      }
      recoverCanvasTasks(this.editor)
    })
  }
  retryLoad = () => {
    this.ready = this.load()
    void this.ready.catch(() => {})
  }
  refreshCloud() {
    const { loading, loadFailed } = this.record.getSnapshot()
    if (this.disposed || this.refreshing || !this.cloud || loading || loadFailed) return
    this.refreshing = true
    this.ready = this.ready.then(async () => {
      try {
        if (!(await this.flush())) return
        await this.cloud!.refresh()
      } catch {
        // 已打开的本机画布继续可用；具体同步失败由 cloud 状态展示。
      } finally {
        this.refreshing = false
      }
    })
    void this.ready.catch(() => {})
  }
  flush = async (): Promise<boolean> => {
    const saved = await this.record.flush()
    if (saved) this.cloud?.requestSync()
    return saved
  }
  dispose() {
    this.disposed = true
    this.record.dispose()
    this.sink.background = false
    this.cloud?.dispose()
  }
  /** 草稿转成会话存档：新键落成之前，原草稿一直留着。 */
  bind(key: string): Promise<boolean> {
    return this.record.rebind(key)
  }
}

/**
 * 名字已经写进本机目录并标了 `nameDirty`，这里把它推给已经打开的那个云端会话。
 * 项目没打开就什么都不做：不为改个名字把整份文档拉下来，下次打开时会连同文档一起推上去。
 */
export async function pushCloudProjectName(project: CanvasProject): Promise<void> {
  const session = workspaces.get(project.sceneKey)?.cloud
  if (!session) return
  try {
    await session.rename(project.name)
  } catch {
    // 推不上去就留着 `nameDirty`，下次同步再补；改名不该因为网络失手而回滚。
  }
}

/**
 * 会话标题定下来时给还没起名的云端项目改名。只对已经开着的工作区就地改：为了给一堆旧项目
 * 补名字而把它们的文档逐个拉起来推一遍，代价太大。没开着的返回 false，由调用方落本地并标
 * `nameDirty`，等它下次打开时那次 push 顺手带上去。
 */
export async function autoNameCloudProject(project: CanvasProject, name: string): Promise<boolean> {
  const target = workspaces.get(project.sceneKey)
  if (!target?.cloud) return false
  await target.cloud.rename(name, false)
  return true
}

const workspaces = new Map<string, CanvasWorkspace>()
const listeners = new Set<() => void>()
let current: CanvasWorkspace | undefined
let visible = false
let lifecycleInstalled = false
let refreshTimer: ReturnType<typeof setInterval> | undefined
let workspaceScope = scopedStorageName('canvas')

function ensureWorkspaceScope() {
  const scope = scopedStorageName('canvas')
  if (scope === workspaceScope) return
  for (const item of workspaces.values()) item.dispose()
  workspaces.clear()
  current = undefined
  workspaceScope = scope
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
  ensureWorkspaceScope()
  let value = workspaces.get(key)
  if (!value) {
    value = new CanvasWorkspace(key, migrateLegacy)
    void value.ready.catch(() => {})
    workspaces.set(key, value)
  }
  return value
}

export function currentCanvasWorkspace(): CanvasWorkspace {
  ensureWorkspaceScope()
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

export function selectCanvasWorkspace(conversationId: string | null): void {
  ensureWorkspaceScope()
  // 不在画布里时无需加载图片；下次打开画布从记住的会话初始化。
  if (!current) return
  void current.flush()
  const project = currentCanvasProject()
  current = workspace(
    project?.conversationId === conversationId ? project.sceneKey : canvasSceneKey(conversationId),
  )
  current.refreshCloud()
  if (visible) setAgentCanvasSink(current.sink)
  for (const listener of listeners) listener()
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

export async function reloadCloudProject(id: string): Promise<void> {
  const project = useCanvasProjectStore.getState().projects.find((one) => one.id === id)
  if (project) await workspaces.get(project.sceneKey)?.cloud?.load(true)
}

export async function copyDeletedProjectLocally(id: string): Promise<CanvasProject> {
  const scope = scopedStorageName('canvas')
  const project = useCanvasProjectStore.getState().projects.find((one) => one.id === id)
  if (!project?.cloud?.deleted) throw new Error('project_not_deleted')
  const cached = workspaces.get(project.sceneKey)
  if (cached && !(await cached.flush())) throw new Error('local_save_failed')
  if (scopedStorageName('canvas') !== scope) throw new Error('account_changed')
  const scene = await readPersistedScene(project.sceneKey)
  if (scopedStorageName('canvas') !== scope) throw new Error('account_changed')
  if (!scene) throw new Error('local_scene_missing')
  const copy = await projectRepository.createRecoveryCopy(project, scene)
  if (scopedStorageName('canvas') !== scope) throw new Error('account_changed')
  useCanvasProjectStore.setState((state) => ({
    projects: [...state.projects.filter((one) => one.id !== copy.id), copy],
  }))
  return copy
}
