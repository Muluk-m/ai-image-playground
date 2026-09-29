// @vitest-environment jsdom
import 'fake-indexeddb/auto'
import { webcrypto } from 'node:crypto'
import type { AgentTurnEvent } from '@image-playground/shared'
import { encodeAgentFrame } from '@image-playground/shared'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import AgentComposer from '../../../features/agent/components/AgentComposer'
import {
  forgetOutgoing,
  outgoingMessages,
  rememberOutgoing,
} from '../../../features/agent/lib/outgoingJournal'
import { currentProjectDraft } from '../../../features/agent/lib/projectLifecycle'
import type { UnsentTurnSubmission } from '../../../features/agent/lib/turnSubmission'
import { useAgentStore } from '../../../features/agent/store'
import {
  currentCanvasWorkspace,
  peekCanvasWorkspace,
} from '../../../features/canvas/lib/activeProject'
import { CanvasDoc } from '../../../features/canvas/lib/canvasDoc'
import {
  type CanvasProject,
  projectRepository,
} from '../../../features/canvas/lib/projectRepository'
import { useCanvasProjectStore } from '../../../features/canvas/projectStore'
import { useLibraryStore } from '../../../features/library/store'
import {
  AGENT_CONVERSATION_KEY,
  scopedStorageName,
  setClientStorageScope,
} from '../../../lib/authScope'
import { bootstrapClientCapabilities } from '../../../lib/clientCapabilities'
import { _setRuntimeConfigForTesting } from '../../../lib/runtimeConfig'
import { useStore } from '../../../store'

const CONVERSATION = 'conversation-1'
const PROJECT = 'project-1'

function turnStream(...events: AgentTurnEvent[]): Response {
  const payload = events.map((event, index) => encodeAgentFrame(index + 1, event)).join('')
  return new Response(payload, { headers: { 'content-type': 'text/event-stream' } })
}

const COMPLETED_TURN = () =>
  turnStream(
    { type: 'turnStart', turnId: 'turn-1', userMessageId: 'user-1' },
    { type: 'turnEnd', turnId: 'turn-1', durationMs: 5, stopReason: 'completed', usage: null },
  )

/** 起轮请求此刻怎么应答：测试逐条换掉它。 */
let turnResponse: () => Response | Promise<Response>
let messagesResponse: () => Response

const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input)
  if (url.endsWith('/api/agent/conversations') && init?.method === 'POST')
    return Response.json({
      conversation: { id: CONVERSATION, title: '', createdAt: 1, updatedAt: 1 },
    })
  if (url.endsWith('/api/agent/conversations')) return Response.json({ conversations: [] })
  if (url.includes('/turns')) return turnResponse()
  return messagesResponse()
})

function openProject(conversationId: string | null): void {
  const project: CanvasProject = {
    id: PROJECT,
    name: '项目',
    customName: false,
    conversationId,
    sceneKey: `scene:${PROJECT}`,
    createdAt: 0,
    updatedAt: 0,
    hasContent: false,
    kind: 'image',
  }
  useCanvasProjectStore.setState({ projects: [project], activeId: PROJECT, loaded: true })
}

/** 刷新页面：内存里的面板状态没了，本机存下来的东西还在。 */
function reload(conversationId: string | null): void {
  useAgentStore.setState({
    conversationId,
    messages: [],
    turns: {},
    queue: [],
    turn: 'idle',
    stopping: false,
    reconnecting: false,
    activeTurn: null,
    error: null,
    loaded: false,
    historyLoading: false,
    historyFailed: false,
  })
}

beforeEach(async () => {
  _setRuntimeConfigForTesting({ bff: { enabled: true, baseUrl: 'http://bff.test' } })
  vi.stubGlobal('fetch', fetchMock)
  localStorage.clear()
  turnResponse = COMPLETED_TURN
  messagesResponse = () => Response.json({ messages: [], activeTurn: null, turns: [] })
  // 本机那份跨用例留着：上一条没清掉会被下一条当成「刷新前丢的」重发。
  for (const one of await outgoingMessages(PROJECT)) await forgetOutgoing(PROJECT, one.id)
  openProject(CONVERSATION)
  reload(CONVERSATION)
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

it('发送途中刷新页面，这句话还在，并且原样重发出去', async () => {
  // 起轮请求一直悬着：用户就是在这个当口刷新的。
  let neverSettles: (value: Response) => void = () => {}
  turnResponse = () => new Promise<Response>((resolve) => (neverSettles = resolve))

  void useAgentStore.getState().send('把这两张图的黑人面向背面')
  await vi.waitFor(async () =>
    expect(await outgoingMessages(PROJECT)).toMatchObject([
      { text: '把这两张图的黑人面向背面', conversationId: CONVERSATION },
    ]),
  )
  const [journaled] = await outgoingMessages(PROJECT)

  // 刷新：面板回到空白，本机那条还在。
  reload(CONVERSATION)
  turnResponse = COMPLETED_TURN
  localStorage.setItem(scopedStorageName(AGENT_CONVERSATION_KEY), CONVERSATION)
  await useAgentStore.getState().load()

  await vi.waitFor(() =>
    expect(
      useAgentStore
        .getState()
        .messages.some((one) => one.kind === 'text' && one.text === '把这两张图的黑人面向背面'),
    ).toBe(true),
  )
  // 重发带的是原来那个 id：服务端据此认出是同一条，不会排第二次。
  const turns = fetchMock.mock.calls.filter(([url]) => String(url).includes('/turns'))
  const resent = turns[turns.length - 1]
  expect(JSON.parse(String(resent?.[1]?.body)).clientMessageId).toBe(journaled?.id)
  // 收下之后本机不再留着。
  await vi.waitFor(async () => expect(await outgoingMessages(PROJECT)).toEqual([]))
  neverSettles(COMPLETED_TURN())
})

it('服务端已经收下的那条不再重发，本机那份丢掉', async () => {
  let neverSettles: (value: Response) => void = () => {}
  turnResponse = () => new Promise<Response>((resolve) => (neverSettles = resolve))
  void useAgentStore.getState().send('把背景换成浅木色')
  await vi.waitFor(async () => expect(await outgoingMessages(PROJECT)).toHaveLength(1))

  // 刷新后历史里已经有这一句：服务端其实收下了。
  reload(CONVERSATION)
  messagesResponse = () =>
    Response.json({
      messages: [
        {
          id: 'user-1',
          turnId: 'turn-1',
          role: 'user',
          content: [{ type: 'text', text: '把背景换成浅木色' }],
          createdAt: 1,
        },
      ],
      activeTurn: null,
      turns: [],
    })
  localStorage.setItem(scopedStorageName(AGENT_CONVERSATION_KEY), CONVERSATION)
  fetchMock.mockClear()
  await useAgentStore.getState().load()

  await vi.waitFor(async () => expect(await outgoingMessages(PROJECT)).toEqual([]))
  expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/turns'))).toBe(false)
  neverSettles(COMPLETED_TURN())
})

it('重发仍使用发话时保存的画布目录', async () => {
  const canvas = {
    elements: [{ id: 'at-send', type: 'image' as const, x: 1, y: 2, width: 10, height: 10 }],
  }
  await rememberOutgoing({
    id: 'retry-1',
    projectId: PROJECT,
    conversationId: CONVERSATION,
    text: '看画布',
    references: [],
    canvas,
    mode: 'image',
    modelOverride: 'gpt-image-2.5-flare',
    clarificationAnswer: false,
    createdAt: Date.now(),
  })
  localStorage.setItem(scopedStorageName(AGENT_CONVERSATION_KEY), CONVERSATION)

  await useAgentStore.getState().load()

  await vi.waitFor(() =>
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/turns'))).toBe(true),
  )
  const sent = fetchMock.mock.calls.find(([url]) => String(url).includes('/turns'))
  const body = JSON.parse(String(sent?.[1]?.body))
  expect(body.canvas).toEqual(canvas)
  expect(body.params.model).toBe('gpt-image-2.5-flare')
  await vi.waitFor(async () => expect(await outgoingMessages(PROJECT)).toEqual([]))
})

it('发送失败后换了设置，刷新重发仍沿用原轮的完整参数', async () => {
  const original = useStore.getState().params
  useStore.setState({ params: { ...original, size: '1536x1024', quality: 'high' } })
  useAgentStore.setState({ thinkingDepth: 'deep', autoSubmit: true })
  turnResponse = () => Response.json({ error: 'unavailable' }, { status: 503 })
  await useAgentStore
    .getState()
    .send('保留这次设置', [], undefined, 'image', undefined, undefined, 'gpt-image-2')
  const first = fetchMock.mock.calls.find(([url]) => String(url).includes('/turns'))
  const initial = JSON.parse(String(first?.[1]?.body))
  expect(initial.params).toMatchObject({
    model: 'gpt-image-2',
    size: '1536x1024',
    quality: 'high',
    thinkingDepth: 'deep',
    autoSubmit: true,
  })
  useStore.setState({ params: { ...original, size: '1024x1536', quality: 'low' } })
  useAgentStore.setState({ thinkingDepth: 'fast', autoSubmit: false })
  reload(CONVERSATION)
  fetchMock.mockClear()
  turnResponse = COMPLETED_TURN
  localStorage.setItem(scopedStorageName(AGENT_CONVERSATION_KEY), CONVERSATION)
  await useAgentStore.getState().load()
  await vi.waitFor(() =>
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/turns'))).toBe(true),
  )
  const resent = fetchMock.mock.calls.find(([url]) => String(url).includes('/turns'))
  expect(JSON.parse(String(resent?.[1]?.body)).params).toEqual(initial.params)
  await vi.waitFor(async () => expect(await outgoingMessages(PROJECT)).toEqual([]))
  useStore.setState({ params: original })
})

it.each([
  false,
  true,
])('等待原图同步后，引用与发话时画布一致且不带入后续编辑（排队=%s）', async (queued) => {
  vi.stubGlobal('crypto', webcrypto)
  setClientStorageScope(crypto.randomUUID())
  const source = 'data:image/png;base64,AQID'
  const marked = 'data:image/png;base64,BAUG'
  const mask = 'data:image/png;base64,BwgJ'
  const mediaId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  let releaseUpload: (response: Response) => void = () => {}
  let uploading = false
  const project = await projectRepository.create('发送时画布', undefined, true)
  await projectRepository.update(project.id, { conversationId: CONVERSATION })
  useCanvasProjectStore.setState({
    projects: [{ ...project, conversationId: CONVERSATION }],
    activeId: project.id,
    loaded: true,
  })
  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    if (url.endsWith('/api/capabilities')) return Response.json({ 'accounts:sync': true })
    if (url === source)
      return new Response(
        Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]),
        { headers: { 'content-type': 'image/png' } },
      )
    if (url.endsWith('/uploads')) {
      uploading = true
      return new Promise<Response>((resolve) => {
        releaseUpload = resolve
      })
    }
    if (url.includes('/api/projects/') && init?.method === 'PUT') {
      const body = JSON.parse(String(init.body))
      return Response.json({
        id: project.id,
        name: body.name,
        revision: body.baseRevision + 1,
        createdAt: 1,
        updatedAt: 2,
        elementCount: body.document.elements.length,
      })
    }
    return fetchMock(input, init)
  })
  await bootstrapClientCapabilities(true, 'http://bff.test')
  const workspace = currentCanvasWorkspace()
  try {
    await workspace.ready
    await vi.waitFor(() => expect(workspace.cloud?.getSnapshot().status).toBe('saved'))
    workspace.doc.addElements(
      ['photo', 'marked', 'masked'].map((id) => ({
        id,
        type: 'image' as const,
        fileId: 'original',
        x: 10,
        y: 20,
        width: 30,
        height: 40,
        rotation: 0,
      })),
      { files: { original: source } },
    )
    if (queued) useAgentStore.setState({ turn: 'running' })
    const sending = useAgentStore.getState().send('改这张图', [
      { imageId: 'photo', dataUrl: source },
      { imageId: 'marked', dataUrl: marked },
      { imageId: 'masked', dataUrl: source, maskDataUrl: mask },
    ])
    await vi.waitFor(() => expect(uploading).toBe(true))
    workspace.doc.updateElements([{ id: 'photo', patch: { x: 900 } }])
    releaseUpload(Response.json({ id: mediaId, status: 'ready' }))
    await sending
    const sent = fetchMock.mock.calls.find(([url]) => String(url).includes('/turns'))
    const body = JSON.parse(String(sent?.[1]?.body))
    expect(body.references).toEqual([
      { imageId: 'photo', mediaId },
      { imageId: 'marked', dataUrl: marked },
      { imageId: 'masked', dataUrl: source, maskDataUrl: mask },
    ])
    expect(body.canvas.elements).toEqual([
      { id: 'photo', type: 'image', x: 10, y: 20, width: 30, height: 40, mediaId },
      { id: 'marked', type: 'image', x: 10, y: 20, width: 30, height: 40 },
      { id: 'masked', type: 'image', x: 10, y: 20, width: 30, height: 40 },
    ])
  } finally {
    workspace.dispose()
    setClientStorageScope(null)
    peekCanvasWorkspace()
    await bootstrapClientCapabilities(false, '')
  }
})

it('排队发送失败后仍保留原输入，刷新后用同一消息身份重发', async () => {
  useAgentStore.setState({ turn: 'running' })
  turnResponse = () => Response.json({ error: 'unavailable' }, { status: 503 })
  await useAgentStore.getState().send('接着处理下一张')
  const [saved] = await outgoingMessages(PROJECT)
  expect(saved).toMatchObject({ text: '接着处理下一张', conversationId: CONVERSATION })
  reload(CONVERSATION)
  turnResponse = COMPLETED_TURN
  fetchMock.mockClear()
  localStorage.setItem(scopedStorageName(AGENT_CONVERSATION_KEY), CONVERSATION)
  await useAgentStore.getState().load()
  await vi.waitFor(() =>
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/turns'))).toBe(true),
  )
  const resent = fetchMock.mock.calls.find(([url]) => String(url).includes('/turns'))
  expect(JSON.parse(String(resent?.[1]?.body)).clientMessageId).toBe(saved!.id)
  await vi.waitFor(async () => expect(await outgoingMessages(PROJECT)).toEqual([]))
})

it.each([
  false,
  true,
])('失败退回输入框后再次发送：原样沿用快照，改写则新发（改写=%s）', async (edited) => {
  const original = useStore.getState().params
  useStore.setState({ params: { ...original, size: '1536x1024', quality: 'high' } })
  useLibraryStore.setState({ assets: [], loadAssets: async () => {} })
  const session = currentProjectDraft(CONVERSATION)
  await session.ready
  session.update({ prompt: '原消息', references: [] })
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  try {
    await act(async () => root.render(createElement(AgentComposer, { doc: new CanvasDoc() })))
    const clickSend = async () => {
      await act(async () => {
        const button = host.querySelector<HTMLButtonElement>('button[aria-label="发送并拟提示词"]')!
        button.click()
      })
    }
    turnResponse = () => Response.json({ error: 'unavailable' }, { status: 503 })
    await clickSend()
    await act(async () => {
      await vi.waitFor(() => expect(session.getSnapshot().draft.submission).toBeDefined())
    })
    const first = fetchMock.mock.calls.find(([url]) => String(url).includes('/turns'))
    const initial = JSON.parse(String(first?.[1]?.body))
    await vi.waitFor(async () => expect(await outgoingMessages(PROJECT)).toEqual([]))
    useStore.setState({ params: { ...original, size: '1024x1536', quality: 'low' } })
    if (edited) act(() => session.update((draft) => ({ ...draft, prompt: '改写后的消息' })))
    turnResponse = COMPLETED_TURN
    fetchMock.mockClear()
    await clickSend()
    await act(async () => {
      await vi.waitFor(() => expect(useAgentStore.getState().turn).toBe('idle'))
    })
    const second = fetchMock.mock.calls.find(([url]) => String(url).includes('/turns'))
    const resent = JSON.parse(String(second?.[1]?.body))
    if (edited) {
      expect(resent.clientMessageId).not.toBe(initial.clientMessageId)
      expect(resent.params).toMatchObject({ size: '1024x1536', quality: 'low' })
    } else {
      expect(resent.clientMessageId).toBe(initial.clientMessageId)
      expect(resent.params).toEqual(initial.params)
    }
    await vi.waitFor(async () => expect(await outgoingMessages(PROJECT)).toEqual([]))
  } finally {
    act(() => root.unmount())
    host.remove()
    useStore.setState({ params: original })
  }
})

it.each([
  false,
  true,
])('已撤回的服务端消息退回原参数，但下次手动发送换新 id（排队=%s）', async (queued) => {
  if (queued) useAgentStore.setState({ turn: 'running', activeTurn: { turnId: 'existing-turn' } })
  turnResponse = () =>
    Response.json(
      {
        turnId: 'existing-turn',
        state: 'cancelled',
        queued: { id: 'withdrawn', text: '已撤回', createdAt: 1, references: [] },
      },
      { status: 202 },
    )
  const returned = vi.fn(async (_snapshot: UnsentTurnSubmission) => true)
  await useAgentStore
    .getState()
    .send('已撤回', [], undefined, 'image', 'withdrawn-client-id', undefined, undefined, returned)
  expect(returned).toHaveBeenCalledOnce()
  const snapshot = returned.mock.calls[0]?.[0]
  const posted = fetchMock.mock.calls.find(([url]) => String(url).includes('/turns'))
  const body = JSON.parse(String(posted?.[1]?.body))
  expect(snapshot).toMatchObject({ text: '已撤回', params: body.params })
  expect(snapshot?.id).not.toBe('withdrawn-client-id')
  expect(await outgoingMessages(PROJECT)).toEqual([])
  reload(CONVERSATION)
})
