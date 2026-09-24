// @vitest-environment jsdom
import 'fake-indexeddb/auto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { readPersistedScene } from '../../../../features/canvas/lib/persistence'
import { projectRepository } from '../../../../features/canvas/lib/projectRepository'
import { canvasSceneKey } from '../../../../features/canvas/lib/workspaceKeys'
import { CanvasWorkspace } from '../../../../features/canvas/lib/workspaces'
import { useCanvasProjectStore } from '../../../../features/canvas/projectStore'
import { setClientStorageScope } from '../../../../lib/authScope'
import { bootstrapClientCapabilities } from '../../../../lib/clientCapabilities'
import { _setRuntimeConfigForTesting } from '../../../../lib/runtimeConfig'
import { abortNextPut, freshSceneKey, saveSceneRecord } from '../../../helpers/sceneRecord'

vi.mock('../../../../features/canvas/lib/recoverCanvasTasks', () => ({
  recoverCanvasTasks: vi.fn(),
}))
vi.mock('../../../../store', () => ({ useStore: { getState: () => ({ showToast: vi.fn() }) } }))

afterEach(() => {
  vi.restoreAllMocks()
  setClientStorageScope(null)
})

describe('画布工作区', () => {
  it('未编辑的旧标签页不覆盖其它标签页的新存档', async () => {
    const key = freshSceneKey()
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
    const source = freshSceneKey(),
      target = freshSceneKey()
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
    const key = freshSceneKey()
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

it('编辑之后不用手动推：防抖落盘顺手把这份文档送上去', async () => {
  setClientStorageScope(crypto.randomUUID())
  _setRuntimeConfigForTesting({ bff: { enabled: true, baseUrl: 'http://bff.test' } })
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
  const project = await projectRepository.create('自动上传', undefined, true)
  useCanvasProjectStore.setState({ projects: [project] })

  const workspace = new CanvasWorkspace(project.sceneKey)
  try {
    await workspace.ready
    // 新项目起步那次推送先落定，后面的写入只可能来自这次编辑。
    await vi.waitFor(() => expect(workspace.cloud?.getSnapshot().status).toBe('saved'), {
      timeout: 3000,
    })
    const before = writes.length
    workspace.doc.addElements([
      {
        id: 'note',
        type: 'text',
        text: '防抖之后自己上去',
        x: 0,
        y: 0,
        width: 100,
        height: 30,
        fontSize: 24,
        fill: '#000',
      },
    ])
    // 谁都不碰 flush / requestSync / sync：推上去必须是防抖那次落盘自己带出来的。
    // 500ms 防抖落盘 + 1000ms 排下的推送，给一倍余量。
    await vi.waitFor(() => expect(writes).toHaveLength(before + 1), { timeout: 3000 })
    expect(writes[before]).toMatchObject({ document: { elements: [{ text: '防抖之后自己上去' }] } })
  } finally {
    workspace.dispose()
    useCanvasProjectStore.setState({ projects: [] })
    _setRuntimeConfigForTesting({ bff: { enabled: false, baseUrl: '' } })
    await bootstrapClientCapabilities(false, '')
    vi.unstubAllGlobals()
  }
})

it('本机已有画布：先交给用户，补传原图在后台进行，不挡加载', async () => {
  setClientStorageScope(crypto.randomUUID())
  _setRuntimeConfigForTesting({ bff: { enabled: true, baseUrl: 'http://bff.test' } })
  const source = 'data:image/png;base64,iVBORw0KGgoAAAAA'
  const uploads: unknown[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/api/capabilities')) return Response.json({ 'accounts:sync': true })
      if (url === source)
        return new Response(Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
      if (url.endsWith('/api/media/uploads')) {
        uploads.push(url)
        // 大画布逐张上传要很久：这里干脆不回，加载也必须照样结束。
        return new Promise<Response>(() => {})
      }
      const body = JSON.parse(init!.body as string)
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
  const project = await projectRepository.create('大画布', undefined, true)
  useCanvasProjectStore.setState({ projects: [project] })
  const first = new CanvasWorkspace(project.sceneKey)
  let second: CanvasWorkspace | undefined
  try {
    await first.ready
    first.doc.addElements(
      [{ id: 'img', type: 'image', fileId: 'f', x: 0, y: 0, width: 10, height: 10, rotation: 0 }],
      { files: { f: source } },
    )
    await first.flush()
    first.dispose()

    second = new CanvasWorkspace(project.sceneKey)
    await second.ready
    expect(second.getSnapshot().loading).toBe(false)
    expect(second.doc.elements.map((one) => one.id)).toEqual(['img'])
    await vi.waitFor(() => expect(uploads.length).toBeGreaterThan(0), { timeout: 3000 })
  } finally {
    first.dispose()
    second?.dispose()
    useCanvasProjectStore.setState({ projects: [] })
    _setRuntimeConfigForTesting({ bff: { enabled: false, baseUrl: '' } })
    await bootstrapClientCapabilities(false, '')
    vi.unstubAllGlobals()
  }
})
