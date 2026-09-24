import { isProjectDocument, type ProjectDocument, projectKind } from '@image-playground/shared'
import { accountScope } from '../../../lib/authScope'
import { MediaRequestError } from '../../../lib/cloudMedia'
import type { CanvasEditor } from './editor'
import type { CloudSceneCheckpoint } from './persistence'
import { getCloudProject, ProjectRequestError, putCloudProject } from './projectClient'
import {
  isLocalAgentFailure,
  type LoadedBindings,
  prepareProjectMedia,
  projectDocument,
  projectScene,
} from './projectMedia'
import { type CanvasProject, projectRepository, UNTITLED_PROJECT } from './projectRepository'
import type { CloudSceneStrategy, SceneRecord } from './sceneRecord'

type Checkpoint = Omit<CloudSceneCheckpoint, 'version' | 'name'>
const RETRY_DELAYS = [1000, 2000, 5000, 15000, 30000]
/** 发送前为参考图等同步最多等这么久；超时就把认不出的那几张照旧内联。 */
const MEDIA_LOOKUP_MS = 20_000
let activeSyncs = 0
const waitingSyncs: (() => void)[] = []
async function withSyncSlot(work: () => Promise<void>) {
  if (activeSyncs < 2) activeSyncs++
  else await new Promise<void>((resolve) => waitingSyncs.push(resolve))
  try {
    await work()
  } finally {
    const next = waitingSyncs.shift()
    if (next) next()
    else activeSyncs--
  }
}
export type ProjectSyncStatus =
  | 'deleted'
  | 'loading'
  | 'pending'
  | 'local'
  | 'offline'
  | 'syncing'
  | 'saved'
  | 'error'
  | 'load-error'
  | 'conflict'
  | 'media-local'
  | 'local-error'
  | 'auth-error'
  | 'permission-error'
  | 'quota-error'
  | 'format-error'

type SyncMessage =
  | 'errors:projectSync.project_deleted'
  | 'errors:projectSync.recovery_changed'
  | 'errors:projectSync.recovery_copy_failed'
  | 'errors:projectSync.local_save_failed'
  | 'errors:projectSync.unauthorized'
  | 'errors:projectSync.project_not_found'
  | 'errors:projectSync.project_document_too_large'
  | 'errors:projectSync.invalid_project_document'
  | 'errors:projectSync.project_conflict'
  | 'errors:projectSync.media_local'
  | 'errors:projectSync.load_failed'
  | 'errors:projectSync.fallback'

function classifyFailure(error: unknown): { status: ProjectSyncStatus; message: SyncMessage } {
  const status =
    error instanceof ProjectRequestError || error instanceof MediaRequestError
      ? error.status
      : undefined
  if (error instanceof Error && error.message === 'local_save_failed')
    return { status: 'local-error', message: 'errors:projectSync.local_save_failed' }
  if (status === 410) return { status: 'deleted', message: 'errors:projectSync.project_deleted' }
  if (status === 401) return { status: 'auth-error', message: 'errors:projectSync.unauthorized' }
  if (status === 403 || status === 404)
    return { status: 'permission-error', message: 'errors:projectSync.project_not_found' }
  if (status === 413 || status === 507)
    return { status: 'quota-error', message: 'errors:projectSync.project_document_too_large' }
  if (error instanceof ProjectRequestError && status === 409)
    return { status: 'conflict', message: 'errors:projectSync.project_conflict' }
  if (
    (status && status >= 400 && status < 500 && status !== 408 && status !== 429) ||
    error instanceof SyntaxError ||
    (error instanceof Error &&
      [
        'unsupported_project',
        'invalid_project_receipt',
        'invalid_media_upload',
        'invalid_media_confirmation',
      ].includes(error.message))
  )
    return { status: 'format-error', message: 'errors:projectSync.invalid_project_document' }
  return { status: 'error', message: 'errors:projectSync.fallback' }
}
const STOPPED = new Set<ProjectSyncStatus>([
  'deleted',
  'conflict',
  'local-error',
  'auth-error',
  'permission-error',
  'quota-error',
  'format-error',
  'load-error',
])

function content(name: string, document: ProjectDocument): string {
  // PostgreSQL JSONB 的键序与浏览器可能不同；对象键排序，元素数组顺序保留。
  return JSON.stringify([name, document], (_key, value) =>
    value && typeof value === 'object' && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)))
      : value,
  )
}

/** 一个已打开项目的同步会话持有自己的基线，不能借用另一标签页的新修订覆盖旧文档。 */
export class CloudProjectSession implements CloudSceneStrategy {
  private readonly editor: CanvasEditor
  private baseline: Checkpoint = { revision: 0, savedContent: null, pending: null, conflict: false }
  private readonly mediaBindings: LoadedBindings = new Map()
  private loadedWithLocal = false
  private initialized = false
  private writable = false
  private readRequired = false
  private readVersion = 0
  private queue: Promise<unknown> = Promise.resolve()
  private readonly sameAccount = accountScope()
  private readonly controller = new AbortController()
  private state: { status: ProjectSyncStatus; message: SyncMessage | null } = {
    status: 'loading',
    message: null,
  }
  private listeners = new Set<() => void>()
  private started = false
  private timer: ReturnType<typeof setTimeout> | undefined
  private scheduled: Promise<void> | undefined
  private retries = 0
  private forking = false
  private editVersion = 0
  private lastCheck = 0
  private recoveryMetadata: Parameters<typeof projectRepository.update>[1] | undefined

  start() {
    if (this.started) return
    this.started = true
    window.addEventListener('online', this.resume)
    if (this.state.status === 'error') this.retryLater()
    else this.requestSync()
  }
  requestSync() {
    if (
      this.state.status === 'pending' ||
      this.state.status === 'local' ||
      this.state.status === 'offline'
    )
      this.schedule(1000)
  }
  private resume = () => {
    if (STOPPED.has(this.state.status)) return
    this.retries = 0
    this.schedule(1000)
  }
  private retryLater() {
    const delay = RETRY_DELAYS[this.retries]
    if (delay !== undefined && this.started && navigator.onLine !== false) {
      this.retries++
      this.schedule(delay)
    }
  }
  private schedule(delay: number) {
    if (!this.started || this.timer || navigator.onLine === false) return
    this.timer = setTimeout(() => {
      this.timer = undefined
      void this.runSync().catch(() => {})
    }, delay)
  }

  constructor(
    private project: CanvasProject,
    /** 这个项目的画布存档；同步会话在自己活着的这段时间里给它出检查点。 */
    private readonly record: SceneRecord,
    private readonly publish: (project: CanvasProject) => void = () => {},
    /** 冲突自动分叉出的副本；调用方负责把用户带到副本上。空实现表示只走手动按钮。 */
    private readonly onFork: (copy: CanvasProject) => void = () => {},
  ) {
    this.editor = record.editor
    record.useCloud(this)
  }
  getSnapshot = () => this.state
  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }
  private current() {
    if (this.controller.signal.aborted || !this.sameAccount())
      throw new Error('project_scope_changed')
  }
  private update(status: ProjectSyncStatus, message: SyncMessage | null = null) {
    this.current()
    this.state = { status, message }
    for (const listener of this.listeners) listener()
    if (status === 'saved') {
      this.retries = 0
      clearTimeout(this.timer)
      this.timer = undefined
      this.forking = false
    }
    if (status === 'error') this.retryLater()
    // 冲突不等用户抉择，也不把用户切走：本机修改先落成一份备份副本，然后这个项目换上云端版本。
    // 用户始终停在正本上——对话记录挂在正本的会话里，切到副本等于让用户以为对话没了。
    if (status === 'conflict' && !this.forking) {
      this.forking = true
      void this.resolveConflict('cloud')
        .then((copy) => {
          if (copy) this.onFork(copy)
        })
        .catch(() => {})
    }
  }
  /** 换上云端版本；只在这台设备上的失败占位不在云端文档里，原样留下。 */
  private restoreRemote(scene: ReturnType<typeof projectScene>) {
    const local = this.editor.doc.elements.filter(isLocalAgentFailure)
    this.editor.doc.restore([...scene.elements, ...local], scene.files, this.editor.doc.camera)
  }
  private document(): ProjectDocument | null {
    return projectDocument(this.editor.doc, this.mediaBindings, this.project.kind)
  }
  /**
   * 云端文档是本机第一次得知「这张画布是什么」的地方——从另一台设备同步过来的项目，
   * 目录摘要里没有这一项。认领一次就定死，往后再读也不改。
   */
  private async adoptKind(document: ProjectDocument) {
    const kind = projectKind(document)
    if (this.project.kind === kind) return
    this.current()
    this.project = await projectRepository.adoptKind(this.project.id, kind)
    this.current()
    this.publish(this.project)
  }
  private async persist() {
    if (!(await this.record.persist())) throw new Error('local_save_failed')
  }
  /** 落盘时跟文档一起写下去的检查点：基线加此刻的名字。 */
  checkpoint = (): CloudSceneCheckpoint => ({
    version: 1,
    ...this.baseline,
    name: this.project.name,
  })
  /** 存档把这一次落盘交给同步会话：写进去的是它的检查点，同步状态也跟着这次结果走。 */
  save = async (
    write: (checkpoint: CloudSceneCheckpoint) => Promise<boolean>,
  ): Promise<boolean> => {
    this.current()
    const version = this.editVersion
    const saved = await write(this.checkpoint())
    this.current()
    if (!saved) this.update('local-error', 'errors:projectSync.local_save_failed')
    else if (
      version === this.editVersion &&
      (this.state.status === 'pending' || this.state.status === 'local-error')
    )
      this.update(navigator.onLine === false ? 'offline' : 'local')
    return saved
  }
  private async metadata(patch: Parameters<typeof projectRepository.update>[1]) {
    this.current()
    this.project = await projectRepository.update(this.project.id, patch)
    this.current()
    this.publish(this.project)
  }
  load(hasLocalScene = false): Promise<void> {
    this.lastCheck = Date.now()
    this.loadedWithLocal = hasLocalScene
    return this.serialize(() => this.loadCurrent(hasLocalScene))
  }
  /** 读取失败（`load-error`）后的手动重试：本机画布已经在用了，只能在这里再读一遍。 */
  reload(): Promise<void> {
    return this.load(this.loadedWithLocal).then(() => this.requestSync())
  }
  refresh(force = false): Promise<void> {
    if (
      (!force && Date.now() - this.lastCheck < 5000) ||
      (STOPPED.has(this.state.status) && this.state.status !== 'deleted') ||
      this.state.status === 'error'
    )
      return Promise.resolve()
    return this.load(true).then(() => this.requestSync())
  }
  private async loadCurrent(hasLocalScene: boolean): Promise<void> {
    this.current()
    const retryingRead = this.readRequired && !this.writable
    if (!this.initialized) {
      // 盘上那份已经由存档读过一次并恢复进文档，这里只接手它带着的检查点。
      const cached = this.record.checkpoint
      if (cached) {
        if (cached.version !== 1 || !Number.isSafeInteger(cached.revision))
          throw new Error('unsupported_cloud_cache')
        const { version: _version, name, ...baseline } = cached
        this.baseline = baseline
        this.project = {
          ...this.project,
          name: this.project.cloud?.nameDirty ? this.project.name : name,
        }
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
    if (navigator.onLine === false && this.baseline.deleted) {
      await this.markDeleted()
      return
    }
    if (navigator.onLine === false && hasLocalScene && this.baseline.savedContent !== null) {
      this.writable = true
      this.readRequired = true
      await this.persist()
      this.update('offline')
      return
    }
    if (this.baseline.deleted) {
      try {
        await getCloudProject(this.project.id, this.controller.signal)
        this.current()
        this.baseline.deleted = false
        const local = this.document()
        this.baseline.conflict = Boolean(
          this.baseline.pending ||
            (hasLocalScene &&
              (this.baseline.savedContent === null
                ? this.editor.doc.elements.length > 0
                : !local || content(this.project.name, local) !== this.baseline.savedContent)),
        )
      } catch (error) {
        if (error instanceof ProjectRequestError && error.status === 410) {
          await this.markDeleted()
          return
        }
        throw error
      }
    }
    const local = this.document()
    // Preserve local media while it is being confirmed; never replace it with a remote structure.
    if (hasLocalScene && !local) {
      this.writable = true
      await this.persist()
      await this.push()
      return
    }
    const dirty =
      (!retryingRead || this.editVersion !== this.readVersion) &&
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
    this.readRequired = true
    const version = this.editVersion
    this.readVersion = version
    const { elements, files } = this.editor.doc
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
      await this.adoptKind(remote.document)
      if (
        (version !== this.editVersion ||
          elements !== this.editor.doc.elements ||
          files !== this.editor.doc.files) &&
        hasLocalScene
      ) {
        this.writable = true
        await this.push()
        return
      }
      if (retryingRead || !hasLocalScene || remote.revision !== this.baseline.revision) {
        const scene = projectScene(remote.document, this.mediaBindings, this.project.conversationId)
        this.restoreRemote(scene)
      }
      await this.metadata({
        name: remote.name,
        // 云端那份还叫「未命名项目」就说明没人起过名字：留着自动命名的余地，
        // 会话标题出来后还能改过来。钉成自定义名，项目就永远停在未命名。
        customName: remote.name !== UNTITLED_PROJECT,
        cloud: { revision: remote.revision },
        updatedAt: remote.updatedAt,
        hasContent: remote.elementCount > 0 || this.project.hasContent,
      })
      this.baseline = {
        revision: remote.revision,
        media: this.baseline.media,
        savedContent: content(remote.name, remote.document),
        pending: null,
        conflict: false,
      }
      await this.persist()
      this.writable = true
      this.readRequired = false
      const current = this.document()
      this.update(
        current && content(this.project.name, current) === this.baseline.savedContent
          ? 'saved'
          : 'pending',
      )
    } catch (error) {
      this.current()
      if (error instanceof ProjectRequestError && error.status === 410) {
        await this.markDeleted()
        return
      }
      const failure = classifyFailure(error)
      if (hasLocalScene && this.baseline.savedContent !== null && failure.status === 'error') {
        this.writable = true
        this.update(failure.status, failure.message)
        return
      }
      this.update(failure.status === 'error' ? 'load-error' : failure.status, failure.message)
      throw error
    }
  }
  private async markDeleted() {
    this.baseline.deleted = true
    clearTimeout(this.timer)
    this.timer = undefined
    await this.persist()
    await this.metadata({
      cloud: { ...this.project.cloud, revision: this.baseline.revision, deleted: true },
    })
    this.update('deleted', 'errors:projectSync.project_deleted')
  }
  markChanged() {
    this.editVersion++
    if (!STOPPED.has(this.state.status) && this.state.status !== 'error') this.update('pending')
  }
  /**
   * 改名并推上去。`custom` 为假是会话标题给的自动名：不算用户起的名字，标题再变还能跟着改。
   */
  rename(name: string, custom = true): Promise<void> {
    return this.serialize(async () => {
      // 先把欠着的那次恢复元数据补写掉，否则它会把新名字盖回去。
      await this.saveRecoveryMetadata()
      await this.metadata({
        name,
        customName: custom,
        cloud: { revision: this.baseline.revision, nameDirty: true },
      })
      this.markChanged()
      await this.push()
    })
  }
  private serialize(work: () => Promise<void>): Promise<void> {
    const operation = this.queue.then(() => withSyncSlot(work))
    this.queue = operation.catch(() => {})
    return operation
  }
  sync = (): Promise<void> => {
    clearTimeout(this.timer)
    this.timer = undefined
    this.retries = 0
    return this.runSync()
  }
  /**
   * 这几张本机原图在云端各是哪个媒体 id；有还没上传的先同步一次（最多等 `MEDIA_LOOKUP_MS`）再认。
   *
   * 本机画布上的图一直是原图 data URL：上传之后 id 只记在绑定表里，不回写画布。发给智能体的
   * 参考图靠这里换成按 id 发——整张 base64 进请求体，十张原图就是几十 MB，一轮多图发送又慢
   * 又容易失败。生成产物服务端本来就有同一份，同步时按 sha256 秒回，不用真传字节。
   * 认不出的（同步失败、离线、不是画布上的图）不在结果里，调用方照旧内联。
   */
  async mediaIdsFor(sources: readonly string[]): Promise<ReadonlyMap<string, string>> {
    const lookup = () => {
      const found = new Map<string, string>()
      for (const binding of this.mediaBindings.values())
        if (sources.includes(binding.source)) found.set(binding.source, binding.id)
      return found
    }
    const found = lookup()
    if (found.size === new Set(sources).size) return found
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        this.sync(),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('media_lookup_timeout')), MEDIA_LOOKUP_MS)
        }),
      ])
    } catch {
      // 同步没成就按已认出的发，其余内联：宁可慢一点，也不能因为同步卡住发不出去。
    } finally {
      clearTimeout(timer)
    }
    return lookup()
  }
  private runSync(): Promise<void> {
    if (this.scheduled) return this.scheduled
    const operation = this.serialize(async () => {
      await this.saveRecoveryMetadata()
      if (this.readRequired) await this.loadCurrent(true)
      else await this.push()
    })
    this.scheduled = operation
    void operation
      .finally(() => {
        if (this.scheduled === operation) this.scheduled = undefined
        this.requestSync()
      })
      .catch(() => {})
    return operation
  }
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
    this.readRequired = false
    await this.persist()
    await this.metadata({
      cloud: { revision: result.revision, nameDirty: this.project.name !== pending.name },
      updatedAt: result.updatedAt,
    })
  }
  private async push(): Promise<void> {
    this.current()
    if (this.baseline.deleted) {
      this.update('deleted', 'errors:projectSync.project_deleted')
      return
    }
    if (!this.writable) throw new Error('project_not_loaded')
    if (this.baseline.conflict) {
      this.update('conflict', 'errors:projectSync.project_conflict')
      return
    }
    try {
      await this.persist()
      if (navigator.onLine === false) {
        this.update('offline')
        return
      }
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
        this.update('media-local', 'errors:projectSync.media_local')
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
      if (error instanceof ProjectRequestError && error.status === 410) {
        await this.markDeleted()
      } else if (error instanceof ProjectRequestError && error.status === 409) {
        this.baseline.conflict = true
        await this.persist()
        this.update('conflict', 'errors:projectSync.project_conflict')
      } else {
        const failure = classifyFailure(error)
        this.update(failure.status, failure.message)
      }
    }
  }
  private async saveRecoveryMetadata() {
    if (!this.recoveryMetadata) return
    try {
      await this.metadata(this.recoveryMetadata)
      this.recoveryMetadata = undefined
    } catch (error) {
      this.update('local-error', 'errors:projectSync.local_save_failed')
      throw error
    }
  }
  async resolveConflict(choice: 'cloud' | 'copy'): Promise<CanvasProject | undefined> {
    let copy: CanvasProject | undefined
    await this.serialize(async () => {
      this.current()
      if (!this.baseline.conflict && !this.baseline.deleted) return
      if (this.baseline.deleted && choice === 'cloud') return
      const remote =
        choice === 'cloud'
          ? await getCloudProject(this.project.id, this.controller.signal).catch(
              (error: unknown) => {
                this.update('conflict', classifyFailure(error).message)
                throw error
              },
            )
          : undefined
      this.current()
      if (
        remote &&
        (!isProjectDocument(remote.document) ||
          remote.id !== this.project.id ||
          !Number.isSafeInteger(remote.revision) ||
          remote.revision < 1)
      )
        throw new Error('unsupported_project')
      if (remote) await this.adoptKind(remote.document)
      const version = this.editVersion
      copy = await projectRepository
        .createRecoveryCopy(this.project, structuredClone(this.record.contents()))
        .catch((error: unknown) => {
          this.update('conflict', 'errors:projectSync.recovery_copy_failed')
          throw error
        })
      this.current()
      this.publish(copy)
      if (version !== this.editVersion) {
        this.update('conflict', 'errors:projectSync.recovery_changed')
        copy = undefined
        return
      }
      if (!remote) return
      const scene = projectScene(remote.document, this.mediaBindings, this.project.conversationId)
      this.restoreRemote(scene)
      this.project = { ...this.project, name: remote.name }
      this.baseline = {
        revision: remote.revision,
        savedContent: content(remote.name, remote.document),
        pending: null,
        conflict: false,
      }
      this.recoveryMetadata = {
        name: remote.name,
        customName: remote.name !== UNTITLED_PROJECT,
        cloud: { revision: remote.revision },
        updatedAt: remote.updatedAt,
        hasContent: remote.elementCount > 0,
      }
      await this.persist()
      await this.saveRecoveryMetadata()
      this.writable = true
      this.readRequired = false
      const current = this.document()
      this.update(
        current && content(this.project.name, current) === this.baseline.savedContent
          ? 'saved'
          : 'pending',
      )
      this.requestSync()
    })
    return copy
  }
  dispose() {
    this.started = false
    clearTimeout(this.timer)
    window.removeEventListener('online', this.resume)
    this.controller.abort()
    this.listeners.clear()
  }
}
