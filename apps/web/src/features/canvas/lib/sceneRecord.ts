import { i18next } from '../../../i18n'
import { accountScope } from '../../../lib/authScope'
import { useStore } from '../../../store'
import { useCanvasProjectStore } from '../projectStore'
import type { CanvasEditor } from './editor'
import {
  type CloudSceneCheckpoint,
  PERSIST_DEBOUNCE_MS,
  type PersistedScene,
  persistedScene,
  readPersistedScene,
  writePersistedScene,
} from './persistence'

/** 读不到存档必须拦住编辑与保存（ADR-0005）；写不进去只提示重试。 */
export interface SceneRecordStatus {
  readonly loading: boolean
  readonly loadFailed: boolean
  readonly saveFailed: boolean
}

/**
 * 云端策略：这份存档跟着一个云端会话时，检查点归它，落盘结果也回给它。
 * 存档自己不认识同步状态，只认识「写下去的字节里带哪个检查点」。
 */
export interface CloudSceneStrategy {
  /** 此刻要跟文档一起落盘的检查点。 */
  checkpoint(): CloudSceneCheckpoint
  /** 这一次落盘交给云端会话：它给出检查点，也接住结果。 */
  save(write: (checkpoint: CloudSceneCheckpoint) => Promise<boolean>): Promise<boolean>
  /** 文档结构变了。 */
  markChanged(): void
  /** 本机这一份已经安全落盘，去把它推上去。 */
  requestSync(): void
}

/**
 * 一个项目的画布存档：IndexedDB 里那一条记录只由它读、恢复、保存与改键。
 * 「只在本机」还是「跟着云端那份」是它内部的策略选择，调用方只说文档变了或检查点变了。
 */
export class SceneRecord {
  private stored: PersistedScene | undefined
  /** 盘上那条记录读到过一次没有；没读到不许写——读不到不能当成空存档覆盖（ADR-0005）。 */
  private read = false
  /** 盘上此刻有没有这条记录：读到过，或者写成功过。 */
  private exists = false
  private status: SceneRecordStatus = { loading: true, loadFailed: false, saveFailed: false }
  private cloud: CloudSceneStrategy | undefined
  private readonly listeners = new Set<() => void>()
  private opening: Promise<void> = Promise.resolve()
  private writes: Promise<boolean> = Promise.resolve(true)
  private timer: ReturnType<typeof setTimeout> | undefined
  private stopChanges: (() => void) | undefined
  private disposed = false
  private revision = 0
  private savedRevision = 0
  private structureRevision = 0
  private savedStructureRevision = 0
  private readonly sameAccount = accountScope()

  constructor(
    readonly editor: CanvasEditor,
    private currentKey: string,
    private readonly migrateLegacy = false,
  ) {}

  get key(): string {
    return this.currentKey
  }

  getSnapshot = (): SceneRecordStatus => this.status
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /**
   * 打开这份存档：盘上那条记录只读一次、只恢复一次，`attach` 是同一次打开里接上的云端会话。
   * 任何一步失败都算没打开——编辑与保存一律拦住，直到重开成功。
   */
  open(attach?: (hasLocal: boolean) => Promise<void>): Promise<void> {
    this.opening = this.reopen(attach)
    return this.opening
  }

  private async reopen(attach?: (hasLocal: boolean) => Promise<void>): Promise<void> {
    this.update({ loading: true, loadFailed: false })
    try {
      // 读过的不再读第二遍：重开只为补上失败的那一步，不能拿磁盘那份盖掉内存里更新的文档。
      if (!this.read) {
        this.stored = await readPersistedScene(this.currentKey, this.migrateLegacy)
        this.read = true
        this.exists = this.stored !== undefined
        const stored = this.stored
        if (stored) this.editor.doc.restore([...stored.elements], stored.files ?? {}, stored.camera)
      }
      await attach?.(this.exists)
      this.track()
      this.update({ loading: false })
    } catch (error) {
      this.update({ loading: false, loadFailed: true })
      throw error
    }
  }

  /** 盘上那份自带的云端检查点。必须先 `open()`：没读过就问，等于把读不到当成空存档。 */
  get checkpoint(): CloudSceneCheckpoint | undefined {
    if (!this.read) throw new Error('scene_record_unread')
    return this.stored?.cloud
  }

  /** 云端会话接管这份存档的检查点，直到它被丢弃。 */
  useCloud(strategy: CloudSceneStrategy | undefined): void {
    this.cloud = strategy
  }

  /** 此刻这份存档的内容：冲突另存照着它复制一份。 */
  contents(): PersistedScene {
    return persistedScene(this.editor.doc, this.cloud?.checkpoint() ?? this.localCheckpoint())
  }

  /** 文档变过才落盘；没变过说明盘上那份已经是它。 */
  flush = (): Promise<boolean> => {
    clearTimeout(this.timer)
    return this.enqueue(async () => {
      if (this.status.loading) return false
      if (this.savedRevision === this.revision && !this.status.saveFailed) return true
      const revision = this.revision
      const structureRevision = this.structureRevision
      let saved = await this.write(structureRevision === this.savedStructureRevision)
      if (this.gone()) return false
      if (saved) {
        try {
          await useCanvasProjectStore.getState().recordScene(this.currentKey, this.editor.doc)
        } catch {
          saved = false
        }
      }
      if (saved) {
        this.savedRevision = revision
        this.savedStructureRevision = structureRevision
      }
      this.update({ saveFailed: !saved })
      // 「本机写成功了就去推云端」只在这一处成文：防抖那次落盘与手动 flush 走的是同一条路。
      // `persist()` 不走这里——它是同步会话自己要求的那次写，再回头请求同步会绕回自己。
      if (saved) this.cloud?.requestSync()
      return saved
    })
  }

  /** 检查点变了：文档与检查点整份写一次，不看文档变没变。 */
  persist = (): Promise<boolean> => this.enqueue(() => this.write(false))

  /** 草稿转成会话存档：先原子提交新键并移走草稿，再改内存里的键；失败就继续留在原键上。 */
  rebind(key: string): Promise<boolean> {
    return this.enqueue(async () => {
      try {
        await this.opening
      } catch {
        return false
      }
      const revision = this.revision
      const saved = await this.put(this.localCheckpoint(), false, key, this.currentKey)
      if (saved) {
        this.currentKey = key
        this.savedRevision = revision
      }
      this.update({ saveFailed: !saved })
      return saved
    })
  }

  dispose(): void {
    this.disposed = true
    clearTimeout(this.timer)
    this.listeners.clear()
    this.stopChanges?.()
  }

  /** 每次落盘都排在上一次后面：两条写路径共用一条队列，先后顺序就是盘上的顺序。 */
  private enqueue(work: () => Promise<boolean>): Promise<boolean> {
    const save = this.writes
      .then(() => (this.gone() || !this.read || this.status.loadFailed ? false : work()))
      .catch(() => {
        if (!this.gone()) this.update({ saveFailed: true })
        return false
      })
    this.writes = save
    return save
  }

  private gone(): boolean {
    return this.disposed || !this.sameAccount()
  }

  private write(preserveStructure: boolean): Promise<boolean> {
    const put = (checkpoint: CloudSceneCheckpoint | undefined) =>
      this.put(checkpoint, preserveStructure)
    return this.cloud ? this.cloud.save(put) : put(this.localCheckpoint())
  }

  private async put(
    checkpoint: CloudSceneCheckpoint | undefined,
    preserveStructure: boolean,
    key = this.currentKey,
    removeKey?: string,
  ): Promise<boolean> {
    try {
      await writePersistedScene(
        persistedScene(this.editor.doc, checkpoint),
        key,
        removeKey,
        preserveStructure,
      )
      this.exists = true
      return true
    } catch (error) {
      console.warn('[canvas] 场景持久化失败', error)
      return false
    }
  }

  /** 只在本机的策略：盘上那份自带的检查点，名字跟着目录里这个项目走。 */
  private localCheckpoint(): CloudSceneCheckpoint | undefined {
    const checkpoint = this.stored?.cloud
    if (!checkpoint) return
    const name = useCanvasProjectStore
      .getState()
      .projects.find((one) => one.sceneKey === this.currentKey)?.name
    return name ? { ...checkpoint, name } : checkpoint
  }

  /** 文档与盘上那份从这一刻起开始分叉：结构变了要整份写，只挪相机不动别人的结构。 */
  private track(): void {
    const doc = this.editor.doc
    let { elements, files, camera } = doc
    this.stopChanges?.()
    this.stopChanges = this.editor.onChange(() => {
      if (this.status.loading) return
      if (elements === doc.elements && files === doc.files && camera === doc.camera) return
      if (elements !== doc.elements || files !== doc.files) {
        this.structureRevision += 1
        this.cloud?.markChanged()
      }
      ;({ elements, files, camera } = doc)
      this.revision += 1
      clearTimeout(this.timer)
      this.timer = setTimeout(() => void this.flush(), PERSIST_DEBOUNCE_MS)
    })
  }

  private update(patch: Partial<SceneRecordStatus>): void {
    if (patch.saveFailed && !this.status.saveFailed)
      useStore
        .getState()
        .showToast(i18next.t('saveError.messageDetailed', { ns: 'canvas' }), 'error')
    this.status = { ...this.status, ...patch }
    for (const listener of this.listeners) listener()
  }
}
