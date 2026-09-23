// @vitest-environment jsdom
import 'fake-indexeddb/auto'
import { encodeAgentFrame } from '@image-playground/shared'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { agentDraft } from '../../../features/agent/lib/drafts'
import { useAgentStore } from '../../../features/agent/store'
import {
  currentCanvasWorkspace,
  selectCanvasWorkspace,
} from '../../../features/canvas/lib/workspaces'
import { useCanvasProjectStore } from '../../../features/canvas/projectStore'
import { setClientStorageScope } from '../../../lib/authScope'
import { _setRuntimeConfigForTesting } from '../../../lib/runtimeConfig'

const state = () => useAgentStore.getState()
let turnResponse: () => Promise<Response>
const fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
  const url = String(input)
  if (url.endsWith('/abort')) return Response.json({ aborted: true })
  if (url.endsWith('/conversations') && init?.method === 'POST')
    return Response.json({
      conversation: { id: crypto.randomUUID(), title: '', createdAt: 1, updatedAt: 1 },
    })
  if (url.includes('/turns')) return turnResponse()
  if (url.endsWith('/conversations')) return Response.json({ conversations: [] })
  return Response.json({ messages: [], turns: [], activeTurn: null })
})
beforeEach(async () => {
  history.replaceState(null, '', '/')
  setClientStorageScope(crypto.randomUUID())
  _setRuntimeConfigForTesting({ bff: { enabled: true, baseUrl: 'http://bff.test' } })
  vi.stubGlobal('fetch', fetchMock)
  useCanvasProjectStore.setState({ projects: [], activeId: null, loaded: false, error: null })
  await useCanvasProjectStore.getState().load()
  selectCanvasWorkspace(null)
  await currentCanvasWorkspace().ready
  useAgentStore.setState({
    loaded: true,
    conversationId: null,
    messages: [],
    turns: {},
    turn: 'idle',
    stopping: false,
    activeTurn: null,
    error: null,
    historyFailed: false,
    historyLoading: false,
  })
})
afterEach(async () => {
  await currentCanvasWorkspace().flush()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  fetchMock.mockClear()
  setClientStorageScope(null)
})
it.each([false, true])('发送中点中止后切项目，重新订阅=%s 时仍会取消旧轮', async (reopen) => {
  let release!: (response: Response) => void
  turnResponse = () =>
    new Promise((resolve) => {
      release = resolve
    })
  const sending = state().send('旧项目生成')
  await vi.waitFor(() => expect(release).toBeTypeOf('function'))
  const oldConversation = state().conversationId
  await state().abort()
  expect(await state().createProject()).toBe(true)
  let resumed: ReadableStreamDefaultController<Uint8Array> | undefined
  if (reopen) {
    fetchMock.mockImplementationOnce(async () =>
      Response.json({ messages: [], turns: [], activeTurn: { turnId: 'old-turn' } }),
    )
    fetchMock.mockImplementationOnce(
      async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              resumed = controller
              controller.enqueue(
                new TextEncoder().encode(
                  encodeAgentFrame(1, {
                    type: 'turnStart',
                    turnId: 'old-turn',
                    userMessageId: 'old-user',
                  }),
                ),
              )
            },
          }),
        ),
    )
    await state().selectConversation(oldConversation!)
    await vi.waitFor(() => expect(state().activeTurn?.turnId).toBe('old-turn'))
  }
  release(
    new Response(
      encodeAgentFrame(1, { type: 'turnStart', turnId: 'old-turn', userMessageId: 'old-user' }),
    ),
  )
  await sending
  expect(
    fetchMock.mock.calls.some(([url]) =>
      String(url).endsWith(`${oldConversation}/turns/old-turn/abort`),
    ),
  ).toBe(true)
  expect(state().conversationId).toBe(reopen ? oldConversation : null)
  if (resumed) {
    resumed.enqueue(
      new TextEncoder().encode(
        encodeAgentFrame(2, {
          type: 'turnEnd',
          turnId: 'old-turn',
          stopReason: 'aborted',
          durationMs: 1,
          usage: null,
        }),
      ),
    )
    resumed.close()
    await vi.waitFor(() => expect(state().turn).toBe('idle'))
  } else expect(state().messages).toEqual([])
  expect(state().stopping).toBe(false)
})
it('两个空项目的输入和画布独立，往返切换可恢复', async () => {
  const first = useCanvasProjectStore.getState().activeId!
  const draft = agentDraft(null, first)
  await vi.waitFor(() => expect(draft.getSnapshot().loading).toBe(false))
  draft.update({ prompt: '产品海报草稿', references: [] })
  currentCanvasWorkspace().doc.setCamera({ x: 77 })
  expect(await state().createProject()).toBe(true)
  const second = useCanvasProjectStore.getState().activeId!
  const secondDraft = agentDraft(null, second)
  await vi.waitFor(() => expect(secondDraft.getSnapshot().loading).toBe(false))
  expect(secondDraft.getSnapshot().draft.prompt).toBe('')
  await currentCanvasWorkspace().ready
  expect(currentCanvasWorkspace().doc.camera.x).toBe(0)
  expect(await state().selectProject(first)).toBe(true)
  expect(currentCanvasWorkspace().doc.camera.x).toBe(77)
  expect(agentDraft(null, first).getSnapshot().draft.prompt).toBe('产品海报草稿')
})
it('切换后旧请求的冲突响应不能重新打开旧会话', async () => {
  let resolve!: (response: Response) => void
  turnResponse = () =>
    new Promise((done) => {
      resolve = done
    })
  const sending = state().send('旧项目生成')
  await vi.waitFor(() => expect(resolve).toBeTypeOf('function'))
  const oldConversation = state().conversationId
  expect(await state().createProject()).toBe(true)
  resolve(
    Response.json({ error: 'agent_turn_already_running', turnId: 'other-turn' }, { status: 409 }),
  )
  await sending
  expect(state().conversationId).toBeNull()
  expect(state().messages).toEqual([])
  expect(
    fetchMock.mock.calls.filter(([url]) => String(url).includes(`${oldConversation}/messages`)),
  ).toEqual([])
})
it('保存失败时拒绝切换，保留当前项目', async () => {
  const first = useCanvasProjectStore.getState().activeId
  vi.spyOn(currentCanvasWorkspace(), 'flush').mockResolvedValue(false)
  expect(await state().createProject()).toBe(false)
  expect(useCanvasProjectStore.getState().activeId).toBe(first)
})

it('第一句话上屏就是项目名，图片哨兵不进标题', async () => {
  const id = useCanvasProjectStore.getState().activeId!
  const name = () => useCanvasProjectStore.getState().projects.find((one) => one.id === id)?.name
  // `Promise.withResolvers` 不在 apps/web 的 lib 目标里，这里沿用同文件其它用例的写法。
  let release!: (response: Response) => void
  turnResponse = () =>
    new Promise((resolve) => {
      release = resolve
    })

  const sending = state().send('把[image 1]和[image 2] 换成浅木色背景')

  // 起轮还在路上，标题已经跟上了：这正是它存在的理由。
  await vi.waitFor(() => expect(name()).toBe('把和 换成浅木色背景'))
  release(Response.json({ error: 'agent_turn_failed' }, { status: 500 }))
  await sending

  // 用户自己改过名字之后，下一次首轮不再抢它。
  await useCanvasProjectStore.getState().update(id, { name: '我的项目', customName: true })
  useAgentStore.setState({ messages: [], turn: 'idle', conversationId: null })
  turnResponse = async () => Response.json({ error: 'agent_turn_failed' }, { status: 500 })
  await state().send('另起一句')
  expect(name()).toBe('我的项目')
})

it('失效会话保留原项目和画布，只移除失效绑定', async () => {
  const id = useCanvasProjectStore.getState().activeId!
  await useCanvasProjectStore.getState().update(id, { conversationId: 'gone' })
  currentCanvasWorkspace().doc.setCamera({ x: 99 })
  fetchMock.mockImplementationOnce(async () => new Response('{}', { status: 404 }))
  await state().selectProject(id)
  await vi.waitFor(() => expect(state().historyLoading).toBe(false))
  expect(useCanvasProjectStore.getState().activeId).toBe(id)
  expect(useCanvasProjectStore.getState().projects).toHaveLength(1)
  expect(state().conversationId).toBeNull()
  expect(currentCanvasWorkspace().doc.camera.x).toBe(99)
})

it('删除后迟到的会话列表不能重新导入项目', async () => {
  const id = useCanvasProjectStore.getState().activeId!
  await useCanvasProjectStore.getState().update(id, { conversationId: 'deleted' })
  let resolve!: (response: Response) => void
  fetchMock.mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done
      }),
  )
  const refresh = state().refreshConversations()
  expect(await state().deleteProject(id)).toBe(true)
  resolve(
    Response.json({
      conversations: [{ id: 'deleted', title: '已删除', createdAt: 1, updatedAt: 1 }],
    }),
  )
  await refresh
  expect(
    useCanvasProjectStore.getState().projects.some((one) => one.conversationId === 'deleted'),
  ).toBe(false)
})

it('草稿保存失败时拒绝切项目，错误与内容保留', async () => {
  const id = useCanvasProjectStore.getState().activeId!
  const draft = agentDraft(null, id)
  await draft.ready
  const snapshot = draft.getSnapshot()
  vi.spyOn(draft, 'getSnapshot').mockReturnValue({
    ...snapshot,
    draft: { prompt: '重要草稿', references: [] },
    error: '草稿保存失败',
  })
  expect(await state().createProject()).toBe(false)
  expect(useCanvasProjectStore.getState().activeId).toBe(id)
})

it('主动新建的空项目保持画布视图，重复新建不堆积空项目', async () => {
  const first = useCanvasProjectStore.getState().activeId!
  expect(await state().createProject()).toBe(true)
  expect(useCanvasProjectStore.getState().activeId).toBe(first)
  expect(
    useCanvasProjectStore.getState().projects.find((one) => one.id === first)?.workspaceOpened,
  ).toBe(true)
  expect(await state().createProject()).toBe(true)
  expect(useCanvasProjectStore.getState().projects).toHaveLength(1)
  const { projectRepository } = await import('../../../features/canvas/lib/projectRepository')
  expect((await projectRepository.list()).find((one) => one.id === first)?.workspaceOpened).toBe(
    true,
  )
})

it('尚未对话但画布已有内容时，新建必须保留原画布并创建独立项目', async () => {
  const first = useCanvasProjectStore.getState().activeId!
  currentCanvasWorkspace().doc.addElements([
    {
      id: 'original',
      type: 'image',
      x: 20,
      y: 30,
      width: 100,
      height: 100,
      rotation: 0,
      fileId: 'original-file',
    },
  ])
  expect(await state().createProject()).toBe(true)
  const second = useCanvasProjectStore.getState().activeId!
  expect(second).not.toBe(first)
  await currentCanvasWorkspace().ready
  expect(currentCanvasWorkspace().doc.elements).toHaveLength(0)
  expect(await state().selectProject(first)).toBe(true)
  expect(currentCanvasWorkspace().doc.elements).toHaveLength(1)
})

it('删除当前空项目时必须切换到另一个项目，不能复用即将删除的项目', async () => {
  const first = useCanvasProjectStore.getState().activeId!
  expect(await state().deleteProject(first)).toBe(true)
  const next = useCanvasProjectStore.getState().activeId
  expect(next).toBeTruthy()
  expect(next).not.toBe(first)
  expect(useCanvasProjectStore.getState().projects.some((one) => one.id === next)).toBe(true)
})
