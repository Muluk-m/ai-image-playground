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
