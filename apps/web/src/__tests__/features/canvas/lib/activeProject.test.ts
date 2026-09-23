// @vitest-environment jsdom
import 'fake-indexeddb/auto'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { agentCanvasSink } from '../../../../features/agent/lib/canvasSink'
import {
  bindNewCanvasWorkspace,
  conversationSceneKey,
  currentCanvasWorkspace,
  forgetCanvasWorkspace,
  openProject,
  selectCanvasWorkspace,
  showCanvasWorkspace,
} from '../../../../features/canvas/lib/activeProject'
import { readPersistedScene } from '../../../../features/canvas/lib/persistence'
import { projectRepository } from '../../../../features/canvas/lib/projectRepository'
import { canvasSceneKey } from '../../../../features/canvas/lib/workspaceKeys'
import { useCanvasProjectStore } from '../../../../features/canvas/projectStore'
import { setClientStorageScope } from '../../../../lib/authScope'
import { bootstrapClientCapabilities } from '../../../../lib/clientCapabilities'
import { _setRuntimeConfigForTesting } from '../../../../lib/runtimeConfig'
import { saveSceneRecord } from '../../../helpers/sceneRecord'

vi.mock('../../../../features/canvas/lib/recoverCanvasTasks', () => ({
  recoverCanvasTasks: vi.fn(),
}))
vi.mock('../../../../store', () => ({ useStore: { getState: () => ({ showToast: vi.fn() }) } }))

/** 两个各自有画布的项目：一个开着，一个在目录里等着被打开。 */
async function twoProjects() {
  setClientStorageScope(crypto.randomUUID())
  const first = await projectRepository.update((await projectRepository.create('先打开的')).id, {
    conversationId: 'conversation-first',
  })
  const second = await projectRepository.update((await projectRepository.create('后打开的')).id, {
    conversationId: 'conversation-second',
  })
  await saveSceneRecord(first.sceneKey, 11)
  await saveSceneRecord(second.sceneKey, 22)
  useCanvasProjectStore.setState({
    projects: [first, second],
    activeId: first.id,
    loaded: true,
  })
  return { first, second }
}

let keys: string[] = []

beforeEach(() => {
  keys = []
})

afterEach(() => {
  for (const key of keys) forgetCanvasWorkspace(key)
  useCanvasProjectStore.setState({ projects: [], activeId: null, loaded: false })
  setClientStorageScope(null)
  vi.restoreAllMocks()
})

it('打开项目选中的是这个项目那份画布，不是上一个项目的', async () => {
  const { first, second } = await twoProjects()
  keys = [first.sceneKey, second.sceneKey]
  const opened = currentCanvasWorkspace()
  await opened.ready
  expect(opened.doc.camera.x).toBe(11)

  openProject(second.id)

  const next = currentCanvasWorkspace()
  await next.ready
  expect(next).not.toBe(opened)
  expect(next.doc.camera.x).toBe(22)
  expect(useCanvasProjectStore.getState().activeId).toBe(second.id)
})

it('按会话选画布认的是那条会话的项目，不看当前项目是谁', async () => {
  const { first, second } = await twoProjects()
  keys = [first.sceneKey, second.sceneKey]
  const opened = currentCanvasWorkspace()
  await opened.ready
  openProject(second.id)
  await currentCanvasWorkspace().ready

  // 当前项目已经是第二个：第一条会话的画布仍要落回第一个项目那份存档，
  // 而不是按会话 id 另起一份空画布。
  selectCanvasWorkspace(conversationSceneKey('conversation-first'))

  const back = currentCanvasWorkspace()
  await back.ready
  expect(back.doc.camera.x).toBe(11)
})

it('没有项目的会话落到这条会话自己的草稿画布', async () => {
  const { first, second } = await twoProjects()
  keys = [first.sceneKey, second.sceneKey, conversationSceneKey('conversation-none')]
  await currentCanvasWorkspace().ready

  selectCanvasWorkspace(conversationSceneKey('conversation-none'))

  const drafted = currentCanvasWorkspace()
  await drafted.ready
  expect(drafted.doc.camera.x).toBe(0)
})

it('新会话与历史会话独立，首次发送保留同一个文档，后台完成仍写原存档', async () => {
  const draft = currentCanvasWorkspace()
  await draft.ready
  showCanvasWorkspace(true)
  draft.doc.setCamera({ x: 17 })
  const sink = agentCanvasSink()
  expect(await bindNewCanvasWorkspace('first')).toBe(true)
  expect(currentCanvasWorkspace()).toBe(draft)
  expect(agentCanvasSink()).toBe(sink)
  selectCanvasWorkspace(canvasSceneKey(null))
  const next = currentCanvasWorkspace()
  await next.ready
  expect(next.doc.camera.x).toBe(0)
  expect(next.editor).not.toBe(draft.editor)
  draft.doc.setCamera({ x: 28 })
  await draft.flush()
  selectCanvasWorkspace(conversationSceneKey('first'))
  expect(currentCanvasWorkspace()).toBe(draft)
  expect((await readPersistedScene(canvasSceneKey('first')))?.camera.x).toBe(28)
  showCanvasWorkspace(false)
})

it('页面被藏起来时把没落盘的画布冲掉', async () => {
  currentCanvasWorkspace()
  selectCanvasWorkspace(conversationSceneKey('page-hide'))
  const workspace = currentCanvasWorkspace()
  await workspace.ready
  workspace.doc.setCamera({ x: 64 })
  window.dispatchEvent(new Event('pagehide'))
  // 让冲盘排下的写事务先进队；此刻 500ms 的 debounce 还没到，落盘只可能来自它。
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect((await readPersistedScene(canvasSceneKey('page-hide')))?.camera.x).toBe(64)
})

it('持续前台的当前项目定期发现远端变更，隐藏后停止检查', async () => {
  setClientStorageScope(crypto.randomUUID())
  _setRuntimeConfigForTesting({ bff: { enabled: true, baseUrl: 'http://bff.test' } })
  const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
  let reads = 0
  let finishRead: (() => void) | undefined
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/api/capabilities')) return Response.json({ 'accounts:sync': true })
      if (url.endsWith('/api/projects'))
        return Response.json({ projects: [], deletedIds: [], nextCursor: null })
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
      // `Promise.withResolvers` 还不在本工程的 TS lib 目标里，这里保留 executor 形式。
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
  openProject(project.id)
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
