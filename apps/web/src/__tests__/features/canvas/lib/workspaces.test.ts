// @vitest-environment jsdom
import 'fake-indexeddb/auto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { readPersistedScene } from '../../../../features/canvas/lib/persistence'
import { canvasSceneKey } from '../../../../features/canvas/lib/workspaceKeys'
import { CanvasWorkspace } from '../../../../features/canvas/lib/workspaces'
import { setClientStorageScope } from '../../../../lib/authScope'
import { saveSceneRecord } from '../../../helpers/sceneRecord'

vi.mock('../../../../features/canvas/lib/recoverCanvasTasks', () => ({
  recoverCanvasTasks: vi.fn(),
}))
vi.mock('../../../../store', () => ({ useStore: { getState: () => ({ showToast: vi.fn() }) } }))

afterEach(() => {
  vi.restoreAllMocks()
  setClientStorageScope(null)
})
const freshKey = () => `test:${crypto.randomUUID()}`

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

describe('画布工作区', () => {
  it('未编辑的旧标签页不覆盖其它标签页的新存档', async () => {
    const key = freshKey()
    const stale = new CanvasWorkspace(key)
    await stale.ready
    await saveSceneRecord(key, 99)
    stale.doc.setViewport(900, 600)
    stale.doc.setSelection([])
    stale.doc.setTool('pen')
    stale.doc.notifyAssetLoaded()
    await stale.flush()
    expect((await readPersistedScene(key))?.camera.x).toBe(99)
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
    expect((await readPersistedScene(source))?.camera.x).toBe(42)
    spy.mockRestore()
    expect(await draft.bind(target)).toBe(true)
    expect(await readPersistedScene(source)).toBeUndefined()
    draft.doc.setCamera({ x: 43 })
    await draft.flush()
    expect((await readPersistedScene(target))?.camera.x).toBe(43)
  })

  it('读失败不写空场景，重试读取恢复原内容', async () => {
    const key = freshKey()
    await saveSceneRecord(key, 81)
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
