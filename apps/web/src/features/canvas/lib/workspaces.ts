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
import {
  type CloudSceneCheckpoint,
  PERSIST_DEBOUNCE_MS,
  readPersistedScene,
  saveScene,
} from './persistence'
import { cloudProjectsEnabled } from './projectClient'
import { type CanvasProject, projectRepository } from './projectRepository'
import { recoverCanvasTasks } from './recoverCanvasTasks'

import { canvasSceneKey } from './workspaceKeys'

export { canvasSceneKey } from './workspaceKeys'

/** 生命周期属于会话，切模式/切会话只换视图，异步任务仍写原文档并自动保存。 */
export class CanvasWorkspace {
  readonly id = crypto.randomUUID()
  private readonly scope = scopedStorageName('canvas')
  readonly doc = new CanvasDoc()
  readonly editor = new CanvasEditor(this.doc)
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
  private state = { loading: true, loadFailed: false, saveFailed: false }
  private listeners = new Set<() => void>()
  private timer: ReturnType<typeof setTimeout> | undefined
  private writes: Promise<unknown> = Promise.resolve()
  private disposed = false
  private refreshing = false
  private revision = 0
  private savedRevision = 0
  private structureRevision = 0
  private savedStructureRevision = 0
  private localCloudCheckpoint: CloudSceneCheckpoint | undefined
  private stopChanges: (() => void) | undefined

  constructor(
    private key: string,
    private migrateLegacy = false,
  ) {
    this.sink.background = true
    this.ready = this.load()
  }

  getSnapshot = () => this.state
  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }
  private update(patch: Partial<typeof this.state>) {
    if (patch.saveFailed && !this.state.saveFailed)
      useStore
        .getState()
        .showToast(i18next.t('saveError.messageDetailed', { ns: 'canvas' }), 'error')
    this.state = { ...this.state, ...patch }
    for (const listener of this.listeners) listener()
  }
  private async load() {
    this.update({ loading: true, loadFailed: false })
    try {
      let hasLocal = true
      // 已打开的云端会话持有完整快照；读取重试不能只恢复磁盘场景而留下旧内存基线。
      if (!this.cloud) {
        const stored = await readPersistedScene(this.key, this.migrateLegacy)
        hasLocal = Boolean(stored)
        this.localCloudCheckpoint = stored?.cloud
        if (stored) this.doc.restore([...stored.elements], stored.files ?? {}, stored.camera)
      }
      const project = useCanvasProjectStore
        .getState()
        .projects.find((one) => one.sceneKey === this.key)
      if (project?.cloud && cloudProjectsEnabled()) {
        this.cloud ??= new CloudProjectSession(project, this.editor, (updated) => {
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
        })
        await this.cloud.load(hasLocal)
        this.cloud.start()
        this.needsInitialFit = !hasLocal && this.doc.elements.length > 0
      }
      let { elements, files, camera } = this.doc
      this.stopChanges?.()
      this.stopChanges = this.editor.onChange(() => {
        if (this.state.loading) return
        if (
          elements === this.doc.elements &&
          files === this.doc.files &&
          camera === this.doc.camera
        )
          return
        if (elements !== this.doc.elements || files !== this.doc.files) {
          this.structureRevision += 1
          this.cloud?.markChanged()
        }
        ;({ elements, files, camera } = this.doc)
        this.revision += 1
        clearTimeout(this.timer)
        this.timer = setTimeout(() => void this.flush(), PERSIST_DEBOUNCE_MS)
      })
      recoverCanvasTasks(this.editor)
      this.update({ loading: false })
    } catch (error) {
      this.update({ loading: false, loadFailed: true })
      throw error
    }
  }
  retryLoad = () => {
    this.ready = this.load()
    void this.ready.catch(() => {})
  }
  refreshCloud() {
    if (
      this.disposed ||
      this.refreshing ||
      !this.cloud ||
      this.state.loading ||
      this.state.loadFailed
    )
      return
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
  flush = (): Promise<boolean> => {
    clearTimeout(this.timer)
    const save = this.writes
      .then(async () => {
        if (
          this.disposed ||
          this.scope !== scopedStorageName('canvas') ||
          this.state.loading ||
          this.state.loadFailed
        )
          return false
        if (this.savedRevision === this.revision && !this.state.saveFailed) return true
        const revision = this.revision
        const structureRevision = this.structureRevision
        const preserveStructure = structureRevision === this.savedStructureRevision
        const localProject = useCanvasProjectStore
          .getState()
          .projects.find((one) => one.sceneKey === this.key)
        const cloud = this.localCloudCheckpoint
          ? {
              ...this.localCloudCheckpoint,
              name: localProject?.name ?? this.localCloudCheckpoint.name,
            }
          : undefined
        let saved = this.cloud
          ? await this.cloud.saveLocal(preserveStructure)
          : await saveScene(this.editor, this.key, undefined, { preserveStructure, cloud })
        if (this.disposed || this.scope !== scopedStorageName('canvas')) return false
        if (saved) {
          try {
            await useCanvasProjectStore.getState().recordScene(this.key, this.doc)
          } catch {
            saved = false
          }
        }
        if (saved) {
          this.savedRevision = revision
          this.savedStructureRevision = structureRevision
        }
        this.update({ saveFailed: !saved })
        if (saved) this.cloud?.requestSync()
        return saved
      })
      .catch(() => {
        if (!this.disposed && this.scope === scopedStorageName('canvas'))
          this.update({ saveFailed: true })
        return false
      })
    this.writes = save
    return save
  }
  dispose() {
    this.disposed = true
    clearTimeout(this.timer)
    this.sink.background = false
    this.listeners.clear()
    this.stopChanges?.()
    this.cloud?.dispose()
  }
  /** 先原子提交新会话存档并移走草稿，再改内存键；失败时继续保留原草稿。 */
  bind(key: string): Promise<boolean> {
    const bind = this.writes.then(async () => {
      try {
        await this.ready
      } catch {
        return false
      }
      const revision = this.revision
      const saved = await saveScene(this.editor, key, this.key)
      if (saved) {
        this.key = key
        this.savedRevision = revision
      }
      this.update({ saveFailed: !saved })
      return saved
    })
    this.writes = bind
    return bind
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
