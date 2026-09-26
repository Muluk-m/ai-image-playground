import { i18next } from '../../../i18n'
import { useStore } from '../../../store'
import { useCanvasProjectStore } from '../projectStore'
import { createAgentCanvasSink } from './agentCanvasSink'
import { CanvasDoc } from './canvasDoc'
import { CloudProjectSession } from './cloudProjects'
import { CanvasEditor } from './editor'
import { placeImagesIntoTargets } from './placeholderShapeOps'
import { computePlaceholderTargets } from './placement'
import { cloudProjectsEnabled } from './projectClient'
import { recoverCanvasTasks } from './recoverCanvasTasks'
import { SceneRecord, type SceneRecordStatus } from './sceneRecord'

/** 一个项目在这台设备上打开着的那份画布：文档、编辑器、产物出口，以及它的存档与云端会话。 */
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
  /** 云端那份第一次落到这台机器上：等画布量出尺寸，把内容一次性框进视野。 */
  private needsInitialFit = false
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

  private async load(): Promise<void> {
    let background: CloudProjectSession | undefined
    await this.record.open(async (hasLocal) => {
      const project = useCanvasProjectStore
        .getState()
        .projects.find((one) => one.sceneKey === this.record.key)
      if (project?.cloud && cloudProjectsEnabled()) {
        this.cloud ??= new CloudProjectSession(
          project,
          this.record,
          (updated) => useCanvasProjectStore.getState().updateListed(updated),
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
        if (hasLocal) {
          background = this.cloud
          return
        }
        await this.cloud.load(false)
        this.cloud.start()
        this.needsInitialFit = this.doc.elements.length > 0
      }
      recoverCanvasTasks(this.editor)
    })
    // 本机已有这份画布就先交给用户：云端核对与补传原图（大画布要逐张上传）放到后台。
    // 放在 open 之后：存档此刻才开始记录编辑，续跑任务改动的占位框与加载期间的编辑都落得了盘，
    // loadCurrent 也认得出它们、改走推送而不是拿云端版本盖掉。
    if (!background || this.disposed) return
    const cloud = background
    const settle = () => {
      if (!this.disposed) cloud.start()
    }
    const loading = cloud.load(true)
    // 云端文档里没有可续跑的画布任务（服务端预留的占位由它自己收尾），续跑只看本机这份，不必等；
    // 它改动的占位框算加载期间的本机修改，由 load 推上去。
    recoverCanvasTasks(this.editor)
    void loading.then(settle, settle)
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
  /** 落盘归存档；写成功之后推不推云端也归它（`SceneRecord.flush`）。 */
  flush = (): Promise<boolean> => this.record.flush()
  /**
   * 从别处送进来的图（工作台、灯箱的「生成视频」）：画布开着就把队列里的放下去。
   * 读盘没完或读失败时不动——那时候画布还不是可写的那一份。
   */
  placePendingImages(): void {
    const { loading, loadFailed } = this.record.getSnapshot()
    if (loading || loadFailed) return
    const pending = useStore.getState().consumeCanvasImages()
    if (!pending.length) return
    void placeImagesIntoTargets(
      this.editor,
      pending.map((dataUrl) => ({ dataUrl })),
      computePlaceholderTargets(this.editor, null, pending.length),
    ).then(
      () => this.flush(),
      (error) => console.warn('[canvas] 工作台图片放置失败', error),
    )
  }
  /** 第一次把云端那份铺开时框进视野；画布还没量出尺寸就等它量出来。返回取消等待的函数。 */
  fitInitialView(): () => void {
    if (!this.needsInitialFit) return () => {}
    const fit = () => {
      if (this.doc.viewport.width <= 1 || this.doc.viewport.height <= 1) return
      this.needsInitialFit = false
      unsubscribe()
      this.editor.scrollToElements(this.doc.elements.map((one) => one.id))
    }
    const unsubscribe = this.doc.subscribe(fit)
    fit()
    return unsubscribe
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
