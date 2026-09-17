import {
  isProjectDocument,
  PROJECT_NAME_MAX_LENGTH,
  type ProjectDocument,
} from '@image-playground/shared'
import { i18next } from '../../../i18n'
import { scopedStorageName } from '../../../lib/authScope'
import { MediaRequestError } from '../../../lib/cloudMedia'
import type { CanvasEditor } from './editor'
import { type CloudSceneCheckpoint, readPersistedScene, saveScene } from './persistence'
import { getCloudProject, ProjectRequestError, putCloudProject } from './projectClient'
import {
  type LoadedBindings,
  prepareProjectMedia,
  projectDocument,
  projectScene,
} from './projectMedia'
import { type CanvasProject, projectRepository } from './projectRepository'

type Checkpoint = Omit<CloudSceneCheckpoint, 'version' | 'name'>
export type ProjectSyncStatus =
  | 'loading'
  | 'pending'
  | 'syncing'
  | 'saved'
  | 'error'
  | 'load-error'
  | 'conflict'
  | 'media-local'

function content(name: string, document: ProjectDocument): string {
  // PostgreSQL JSONB 的键序与浏览器可能不同；对象键排序，元素数组顺序保留。
  return JSON.stringify([name, document], (_key, value) =>
    value && typeof value === 'object' && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)))
      : value,
  )
}

/** 一个已打开项目的同步会话持有自己的基线，不能借用另一标签页的新修订覆盖旧文档。 */
export class CloudProjectSession {
  private baseline: Checkpoint = { revision: 0, savedContent: null, pending: null, conflict: false }
  private readonly mediaBindings: LoadedBindings = new Map()
  private initialized = false
  private writable = false
  private queue: Promise<unknown> = Promise.resolve()
  private readonly scope = scopedStorageName('canvas-cloud')
  private readonly controller = new AbortController()
  private state: { status: ProjectSyncStatus; message: string | null } = {
    status: 'loading',
    message: null,
  }
  private listeners = new Set<() => void>()

  constructor(
    private project: CanvasProject,
    private readonly editor: CanvasEditor,
    private readonly publish: (project: CanvasProject) => void = () => {},
  ) {}
  getSnapshot = () => this.state
  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }
  private current() {
    if (this.controller.signal.aborted || scopedStorageName('canvas-cloud') !== this.scope)
      throw new Error('project_scope_changed')
  }
  private update(status: ProjectSyncStatus, message: string | null = null) {
    this.current()
    this.state = { status, message }
    for (const listener of this.listeners) listener()
  }
  private document(): ProjectDocument | null {
    return projectDocument(this.editor.doc, this.mediaBindings)
  }
  private async persist() {
    if (!(await this.saveLocal())) throw new Error('local_save_failed')
  }
  async saveLocal(preserveStructure = false): Promise<boolean> {
    this.current()
    const saved = await saveScene(this.editor, this.project.sceneKey, undefined, {
      cloud: { version: 1, ...this.baseline, name: this.project.name },
      preserveStructure,
    })
    this.current()
    return saved
  }
  private async metadata(patch: Parameters<typeof projectRepository.update>[1]) {
    this.current()
    this.project = await projectRepository.update(this.project.id, patch)
    this.current()
    this.publish(this.project)
  }
  load(hasLocalScene = false): Promise<void> {
    return this.serialize(() => this.loadCurrent(hasLocalScene))
  }
  private async loadCurrent(hasLocalScene: boolean): Promise<void> {
    this.current()
    const retryingRead = this.state.status === 'load-error'
    if (!this.initialized) {
      const cached = await readPersistedScene(this.project.sceneKey)
      this.current()
      if (cached?.cloud) {
        if (cached.cloud.version !== 1 || !Number.isSafeInteger(cached.cloud.revision))
          throw new Error('unsupported_cloud_cache')
        const { version: _version, name, ...baseline } = cached.cloud
        this.baseline = baseline
        this.project = {
          ...this.project,
          name: this.project.cloud?.nameDirty ? this.project.name : name,
        }
        this.editor.doc.restore([...cached.elements], cached.files, cached.camera)
        hasLocalScene = true
      }
      this.initialized = true
    }
    if (this.baseline.media)
      await prepareProjectMedia(
        this.editor.doc,
        this.baseline.media,
        this.mediaBindings,
        this.controller.signal,
        false,
      )
    this.current()
    const local = this.document()
    // Preserve local media while it is being confirmed; never replace it with a remote structure.
    if (hasLocalScene && !local) {
      this.writable = true
      await this.persist()
      await this.push()
      return
    }
    const dirty =
      !retryingRead &&
      hasLocalScene &&
      this.baseline.savedContent !== null &&
      (!local || content(this.project.name, local) !== this.baseline.savedContent)
    if (
      this.baseline.pending ||
      this.baseline.conflict ||
      dirty ||
      (this.project.cloud?.revision === 0 && this.baseline.revision === 0)
    ) {
      this.writable = true
      await this.push()
      return
    }
    this.update('loading')
    this.writable = false
    try {
      const remote = await getCloudProject(this.project.id, this.controller.signal)
      this.current()
      if (
        !isProjectDocument(remote.document) ||
        remote.id !== this.project.id ||
        !Number.isSafeInteger(remote.revision) ||
        remote.revision < 1
      )
        throw new Error('unsupported_project')
      if (retryingRead || !hasLocalScene || remote.revision !== this.baseline.revision) {
        const scene = projectScene(remote.document)
        this.editor.doc.restore(scene.elements, scene.files, this.editor.doc.camera)
      }
      await this.metadata({
        name: remote.name,
        customName: true,
        cloud: { revision: remote.revision },
        updatedAt: remote.updatedAt,
        hasContent: remote.elementCount > 0 || this.project.hasContent,
      })
      this.baseline = {
        revision: remote.revision,
        savedContent: content(remote.name, remote.document),
        pending: null,
        conflict: false,
      }
      await this.persist()
      this.writable = true
      this.update('saved')
    } catch (error) {
      this.update('load-error', i18next.t('cloud.loadFailed', { ns: 'canvas' }))
      throw error
    }
  }
  markChanged() {
    if (this.state.status !== 'conflict') this.update('pending')
  }
  rename(name: string): Promise<void> {
    return this.serialize(async () => {
      if (!name.trim() || name.length > PROJECT_NAME_MAX_LENGTH)
        throw new Error('invalid_project_name')
      await this.metadata({
        name,
        customName: true,
        cloud: { revision: this.baseline.revision, nameDirty: true },
      })
      this.markChanged()
      await this.push()
    })
  }
  private serialize(work: () => Promise<void>): Promise<void> {
    const operation = this.queue.then(work)
    this.queue = operation.catch(() => {})
    return operation
  }
  sync = (): Promise<void> => this.serialize(() => this.push())
  private async commitPending(): Promise<void> {
    const pending = this.baseline.pending!
    const result = await putCloudProject(this.project.id, pending, this.controller.signal)
    this.current()
    if (result.id !== this.project.id || result.revision !== pending.baseRevision + 1)
      throw new Error('invalid_project_receipt')
    this.baseline = {
      revision: result.revision,
      savedContent: content(pending.name, pending.document),
      media: this.baseline.media,
      pending: null,
      conflict: false,
    }
    await this.persist()
    await this.metadata({
      cloud: { revision: result.revision, nameDirty: this.project.name !== pending.name },
      updatedAt: result.updatedAt,
    })
  }
  private async push(): Promise<void> {
    this.current()
    if (!this.writable) throw new Error('project_not_loaded')
    if (this.baseline.conflict) {
      this.update('conflict', i18next.t('cloud.conflict', { ns: 'canvas' }))
      return
    }
    try {
      this.update('syncing')
      if (this.baseline.pending) await this.commitPending()
      await this.persist()
      this.baseline.media ??= {}
      await prepareProjectMedia(
        this.editor.doc,
        this.baseline.media,
        this.mediaBindings,
        this.controller.signal,
      )
      this.current()
      const document = this.document()
      if (!document) {
        this.update('media-local', i18next.t('cloud.mediaLocal', { ns: 'canvas' }))
        return
      }
      if (content(this.project.name, document) !== this.baseline.savedContent) {
        this.baseline.pending = {
          requestId: crypto.randomUUID(),
          baseRevision: this.baseline.revision,
          name: this.project.name,
          document: structuredClone(document),
        }
        await this.persist()
        await this.commitPending()
      }
      const current = this.document()
      this.update(
        current && content(this.project.name, current) === this.baseline.savedContent
          ? 'saved'
          : 'pending',
      )
    } catch (error) {
      this.current()
      if (error instanceof ProjectRequestError && error.status === 409) {
        this.baseline.conflict = true
        await this.persist()
        this.update('conflict', i18next.t('cloud.conflict', { ns: 'canvas' }))
      } else {
        this.update(
          'error',
          (error instanceof ProjectRequestError || error instanceof MediaRequestError) &&
            error.status === 413
            ? i18next.t('cloud.quotaExceeded', { ns: 'canvas' })
            : i18next.t('cloud.syncFailed', { ns: 'canvas' }),
        )
      }
    }
  }
  dispose() {
    this.controller.abort()
    this.listeners.clear()
  }
}
