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

  it('页面被藏起来时把没落盘的画布冲掉', async () => {
    currentCanvasWorkspace()
    selectCanvasWorkspace('page-hide')
    const workspace = currentCanvasWorkspace()
    await workspace.ready
    workspace.doc.setCamera({ x: 64 })
    window.dispatchEvent(new Event('pagehide'))
    // 让冲盘排下的写事务先进队；此刻 500ms 的 debounce 还没到，落盘只可能来自它。
    await new Promise((resolve) => setTimeout(resolve, 0))
    const restored = editor()
    await loadScene(restored, canvasSceneKey('page-hide'))
    expect(restored.doc.camera.x).toBe(64)
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

it('真实工作区断网自动保存，联网无需手动点击即可续传', async () => {
  const { _setRuntimeConfigForTesting } = await import('../../../../lib/runtimeConfig')
  const { bootstrapClientCapabilities } = await import('../../../../lib/clientCapabilities')
  const { projectRepository } = await import('../../../../features/canvas/lib/projectRepository')
  const { useCanvasProjectStore } = await import('../../../../features/canvas/projectStore')
  setClientStorageScope(crypto.randomUUID())
  _setRuntimeConfigForTesting({ bff: { enabled: true, baseUrl: 'http://bff.test' } })
  const online = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false)
  const writes: unknown[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/api/capabilities')) return Response.json({ 'accounts:sync': true })
      const body = JSON.parse(init!.body as string)
      writes.push(body)
      return Response.json({
        id: project.id,
        name: body.name,
        revision: body.baseRevision + 1,
        createdAt: 1,
        updatedAt: 2,
        elementCount: body.document.elements.length,
      })
    }),
  )
  await bootstrapClientCapabilities(true, 'http://bff.test')
  const project = await projectRepository.create('离线工作区', undefined, true)
  useCanvasProjectStore.setState({ projects: [project] })
  const workspace = new CanvasWorkspace(project.sceneKey)
  try {
    await workspace.ready
    workspace.doc.addElements([
      {
        id: 'note',
        type: 'text',
        text: '自动恢复',
        x: 0,
        y: 0,
        width: 100,
        height: 30,
        fontSize: 24,
        fill: '#000',
      },
    ])
    await workspace.flush()
    await workspace.cloud!.sync()
    expect(writes).toHaveLength(0)
    online.mockReturnValue(true)
    window.dispatchEvent(new Event('online'))
    await vi.waitFor(() => expect(workspace.cloud?.getSnapshot().status).toBe('saved'), {
      timeout: 3000,
    })
    expect(writes).toHaveLength(1)
    expect(writes[0]).toMatchObject({ document: { elements: [{ text: '自动恢复' }] } })
  } finally {
    workspace.dispose()
    useCanvasProjectStore.setState({ projects: [] })
    _setRuntimeConfigForTesting({ bff: { enabled: false, baseUrl: '' } })
    await bootstrapClientCapabilities(false, '')
    vi.unstubAllGlobals()
  }
})

it('持续前台的当前项目定期发现远端变更，隐藏后停止检查', async () => {
  const { _setRuntimeConfigForTesting } = await import('../../../../lib/runtimeConfig')
  const { bootstrapClientCapabilities } = await import('../../../../lib/clientCapabilities')
  const { projectRepository } = await import('../../../../features/canvas/lib/projectRepository')
  const { useCanvasProjectStore } = await import('../../../../features/canvas/projectStore')
  const { forgetCanvasWorkspace } = await import('../../../../features/canvas/lib/workspaces')
  setClientStorageScope(crypto.randomUUID())
  _setRuntimeConfigForTesting({ bff: { enabled: true, baseUrl: 'http://bff.test' } })
  const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
  let reads = 0
  let finishRead: (() => void) | undefined
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/api/capabilities')) return Response.json({ 'accounts:sync': true })
      if (init?.method === 'PUT')
        return Response.json({
          id: project.id,
          name: project.name,
          revision: 1,
          createdAt: 1,
          updatedAt: 2,
          elementCount: 0,
        })
      reads++
      return new Promise<Response>((resolve) => {
        finishRead = () =>
          resolve(
            Response.json({
              id: project.id,
              name: project.name,
              revision: 2,
              createdAt: 1,
              updatedAt: 3,
              elementCount: 1,
              document: {
                version: 1,
                elements: [
                  {
                    id: 'remote',
                    type: 'text',
                    text: '另一台设备的新稿',
                    x: 0,
                    y: 0,
                    width: 100,
                    height: 30,
                    fontSize: 24,
                    fill: '#000',
                  },
                ],
              },
            }),
          )
      })
    }),
  )
  await bootstrapClientCapabilities(true, 'http://bff.test')
  let project = await projectRepository.create('持续前台', undefined, true)
  useCanvasProjectStore.setState({ projects: [project], activeId: project.id })
  currentCanvasWorkspace()
  selectCanvasWorkspace(null)
  const workspace = currentCanvasWorkspace()
  await workspace.ready
  showCanvasWorkspace(false)
  vi.useFakeTimers({
    toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'],
  })
  try {
    showCanvasWorkspace(true)
    await workspace.ready
    await vi.advanceTimersByTimeAsync(15000)
    await vi.waitFor(() => expect(reads).toBe(1))
    expect(workspace.getSnapshot().loading).toBe(false)
    finishRead!()
    await vi.waitFor(() =>
      expect(workspace.doc.elements[0]).toMatchObject({ text: '另一台设备的新稿' }),
    )
    expect(reads).toBe(1)
    await workspace.ready
    setClientStorageScope(crypto.randomUUID())
    project = await projectRepository.create('切账号后仍检查', undefined, true)
    useCanvasProjectStore.setState({ projects: [project], activeId: project.id })
    const next = currentCanvasWorkspace()
    await next.ready
    await vi.advanceTimersByTimeAsync(15000)
    await vi.waitFor(() => expect(reads).toBe(2))
    finishRead!()
    await next.ready
    expect(next.doc.elements[0]).toMatchObject({ text: '另一台设备的新稿' })
    visibility.mockReturnValue('hidden')
    document.dispatchEvent(new Event('visibilitychange'))
    await vi.advanceTimersByTimeAsync(60000)
    expect(reads).toBe(2)
  } finally {
    finishRead?.()
    await workspace.ready
    showCanvasWorkspace(false)
    forgetCanvasWorkspace(project.sceneKey)
    vi.useRealTimers()
    useCanvasProjectStore.setState({ projects: [], activeId: null })
    _setRuntimeConfigForTesting({ bff: { enabled: false, baseUrl: '' } })
    await bootstrapClientCapabilities(false, '')
    vi.unstubAllGlobals()
  }
})
