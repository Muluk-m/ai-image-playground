// @vitest-environment jsdom
import 'fake-indexeddb/auto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { agentCanvasSink } from '../../../../features/agent/lib/canvasSink'
import { CanvasDoc } from '../../../../features/canvas/lib/canvasDoc'
import { CanvasEditor } from '../../../../features/canvas/lib/editor'
import { loadScene, saveScene } from '../../../../features/canvas/lib/persistence'
import {
  bindNewCanvasWorkspace,
  CanvasWorkspace,
  canvasSceneKey,
  currentCanvasWorkspace,
  selectCanvasWorkspace,
  showCanvasWorkspace,
} from '../../../../features/canvas/lib/workspaces'
import { setClientStorageScope } from '../../../../lib/authScope'

vi.mock('../../../../features/canvas/lib/recoverCanvasTasks', () => ({
  recoverCanvasTasks: vi.fn(),
}))
vi.mock('../../../../store', () => ({ useStore: { getState: () => ({ showToast: vi.fn() }) } }))

afterEach(() => {
  vi.restoreAllMocks()
  setClientStorageScope(null)
})
const freshKey = () => `test:${crypto.randomUUID()}`
const editor = () => new CanvasEditor(new CanvasDoc())

function abortNextPut() {
  const put = IDBObjectStore.prototype.put
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  return vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementationOnce(function (
    this: IDBObjectStore,
    ...args: Parameters<IDBObjectStore['put']>
  ) {
    const result = put.apply(this, args)
    this.transaction.abort()
    return result
  })
}

describe('会话画布', () => {
  it('新会话与历史会话独立，首次发送保留同一个文档，后台完成仍写原存档', async () => {
    const draft = currentCanvasWorkspace()
    await draft.ready
    showCanvasWorkspace(true)
    draft.doc.setCamera({ x: 17 })
    const sink = agentCanvasSink()
    expect(await bindNewCanvasWorkspace('first')).toBe(true)
    expect(currentCanvasWorkspace()).toBe(draft)
    expect(agentCanvasSink()).toBe(sink)
    selectCanvasWorkspace(null)
    const next = currentCanvasWorkspace()
    await next.ready
    expect(next.doc.camera.x).toBe(0)
    expect(next.editor).not.toBe(draft.editor)
    draft.doc.setCamera({ x: 28 })
    await draft.flush()
    selectCanvasWorkspace('first')
    expect(currentCanvasWorkspace()).toBe(draft)
    const restored = editor()
    await loadScene(restored, canvasSceneKey('first'))
    expect(restored.doc.camera.x).toBe(28)
    showCanvasWorkspace(false)
  })

  it('未编辑的旧标签页不覆盖其它标签页的新存档', async () => {
    const key = freshKey()
    const stale = new CanvasWorkspace(key)
    await stale.ready
    const newer = editor()
    newer.doc.setCamera({ x: 99 })
    await saveScene(newer, key)
    stale.doc.setViewport(900, 600)
    stale.doc.setSelection([])
    stale.doc.setTool('pen')
    stale.doc.notifyAssetLoaded()
    await stale.flush()
    const restored = editor()
    await loadScene(restored, key)
    expect(restored.doc.camera.x).toBe(99)
  })

  it('绑定事务失败保留草稿，重试原子转存后后续编辑只写新会话', async () => {
    const source = freshKey(),
      target = freshKey()
    const draft = new CanvasWorkspace(source)
    await draft.ready
    draft.doc.setCamera({ x: 42 })
    await draft.flush()
    const spy = abortNextPut()
    expect(await draft.bind(target)).toBe(false)
    const backup = editor()
    expect(await loadScene(backup, source)).toBe(true)
    expect(backup.doc.camera.x).toBe(42)
    spy.mockRestore()
    expect(await draft.bind(target)).toBe(true)
    expect(await loadScene(editor(), source)).toBe(false)
    draft.doc.setCamera({ x: 43 })
    await draft.flush()
    const restored = editor()
    await loadScene(restored, target)
    expect(restored.doc.camera.x).toBe(43)
  })

  it('读失败不写空场景，重试读取恢复原内容', async () => {
    const key = freshKey()
    const source = editor()
    source.doc.setCamera({ x: 81 })
    await saveScene(source, key)
    vi.spyOn(IDBObjectStore.prototype, 'get').mockImplementationOnce(() => {
      throw new Error('offline storage')
    })
    const workspace = new CanvasWorkspace(key)
    await expect(workspace.ready).rejects.toThrow()
    expect(await workspace.flush()).toBe(false)
    expect(workspace.getSnapshot().loadFailed).toBe(true)
    workspace.retryLoad()
    await workspace.ready
    expect(workspace.doc.camera.x).toBe(81)
  })

  it('账号与匿名画布键互不相同', () => {
    const anonymous = canvasSceneKey('same')
    setClientStorageScope('a/b')
    const first = canvasSceneKey('same')
    setClientStorageScope('a_b')
    expect(canvasSceneKey('same')).not.toBe(first)
    expect(canvasSceneKey('same')).not.toBe(anonymous)
    expect(canvasSceneKey(null)).not.toBe(canvasSceneKey('draft'))
  })
})
