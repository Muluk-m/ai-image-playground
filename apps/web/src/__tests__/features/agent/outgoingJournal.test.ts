// @vitest-environment jsdom

vi.mock('../../../lib/imagePreprocessing', async () => ({
  IMAGE_PREPROCESSING: { maxPixels: 4194304 },
  preprocessImageFile: (await import('../../helpers/preparedImageFile')).preparedImageFile,
}))

import 'fake-indexeddb/auto'
import { webcrypto } from 'node:crypto'
import type { AgentTurnEvent } from '@image-playground/shared'
import { encodeAgentFrame } from '@image-playground/shared'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import AgentComposer from '../../../features/agent/components/AgentComposer'
import { DraftSession } from '../../../features/agent/lib/drafts'
import { returnQueuedToDraft } from '../../../features/agent/lib/messageQueue'
import {
  forgetOutgoing,
  outgoingMessages,
  rememberOutgoing,
} from '../../../features/agent/lib/outgoingJournal'
import { currentProjectDraft } from '../../../features/agent/lib/projectLifecycle'
import { draftForSubmit } from '../../../features/agent/lib/references'
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
  if (url.includes('/submissions/'))
    return Response.json({
      receipt:
        url.endsWith('/withdraw') || url.endsWith('/reconcile')
          ? { state: 'cancelled', queued: { id: 'not-accepted', text: '', createdAt: 1 } }
          : null,
    })
  if (url.endsWith('/api/agent/conversations') && init?.method === 'POST')
    return Response.json({
      conversation: { id: CONVERSATION, title: '', createdAt: 1, updatedAt: 1 },
    })
  if (url.endsWith('/api/agent/conversations')) return Response.json({ conversations: [] })
  if (url.includes('/turns')) return turnResponse()
  return messagesResponse()
})

function openProject(conversationId: string | null, experience: 'chat' | 'canvas' = 'chat'): void {
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
    experience,
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
  openProject(CONVERSATION, 'canvas')
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
  // 已明确拒绝的提交可保留消息 id；未决 5xx 会先做服务端终态确认。
  turnResponse = () => Response.json({ error: 'invalid_selection' }, { status: 400 })
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
  openProject(CONVERSATION, 'canvas')
  vi.stubGlobal('crypto', webcrypto)
  setClientStorageScope(crypto.randomUUID())
  const source = 'data:image/png;base64,AQID'
  const marked = 'data:image/png;base64,BAUG'
  const mask = 'data:image/png;base64,BwgJ'
  const mediaId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  let releaseUpload: (response: Response) => void = () => {}
  let uploading = false
  const project = await projectRepository.create(
    '发送时画布',
    undefined,
    true,
    true,
    'image',
    'canvas',
  )
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
  turnResponse = () => Response.json({ error: 'queue_full', limit: 10 }, { status: 409 })
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

it('uploads a complete immutable edit snapshot and restores the same mask, action and regions after rejection', async () => {
  vi.stubGlobal('crypto', webcrypto)
  setClientStorageScope(crypto.randomUUID())
  const source = 'data:image/png;base64,iVBORw0KGgo='
  const mask = 'data:image/png;base64,iVBORw0KGgoA'
  const originalId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  const maskId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
  let unsent: UnsentTurnSubmission | undefined
  const references = [
    {
      imageId: 'photo',
      dataUrl: source,
      maskDataUrl: mask,
      editAction: 'inpaint' as const,
      regions: [{ x: 0.1, y: 0.2, width: 0.3, height: 0.4 }],
    },
  ]
  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    if (url.endsWith('/api/capabilities')) return Response.json({ 'agent:attachments': true })
    if (url === source || url === mask)
      return new Response(
        Uint8Array.from(
          url === source ? [137, 80, 78, 71, 13, 10, 26, 10] : [137, 80, 78, 71, 13, 10, 26, 10, 0],
        ),
      )
    if (url.endsWith('/uploads'))
      return Response.json({
        id: JSON.parse(String(init?.body)).bytes === 8 ? originalId : maskId,
        status: 'ready',
        leaseExpiresAt: Date.now() + 1200_000,
      })
    return fetchMock(input, init)
  })
  await bootstrapClientCapabilities(true, 'http://bff.test')
  turnResponse = () => Response.json({ error: 'invalid_reference' }, { status: 400 })
  try {
    const sending = useAgentStore
      .getState()
      .send(
        '只修改选区',
        references,
        undefined,
        'image',
        undefined,
        undefined,
        undefined,
        async (snapshot) => {
          unsent = snapshot
          return true
        },
      )
    references[0]!.regions[0]!.x = 0.6
    await sending
    const sent = fetchMock.mock.calls.find(([url]) => String(url).includes('/turns'))
    const body = JSON.parse(String(sent?.[1]?.body))
    const expected = {
      imageId: 'photo',
      mediaId: originalId,
      maskMediaId: maskId,
      editAction: 'inpaint',
      regions: [{ x: 0.1, y: 0.2, width: 0.3, height: 0.4 }],
    }
    expect(body.references).toEqual([expected])
    expect(unsent?.references).toEqual([
      {
        imageId: 'photo',
        dataUrl: source,
        maskDataUrl: mask,
        editAction: 'inpaint',
        regions: expected.regions,
      },
    ])
    const restored = returnQueuedToDraft({ prompt: '', references: [] }, [unsent!])
    expect(draftForSubmit(restored).references).toEqual([
      {
        imageId: 'photo',
        dataUrl: source,
        maskDataUrl: mask,
        editAction: 'inpaint',
        regions: expected.regions,
      },
    ])
  } finally {
    setClientStorageScope(null)
    await bootstrapClientCapabilities(false, '')
  }
})

it('reuploads expired unaccepted originals and masks after refresh with the same message identity', async () => {
  vi.stubGlobal('crypto', webcrypto)
  setClientStorageScope(crypto.randomUUID())
  const source = 'data:image/png;base64,iVBORw0KGgo='
  const mask = 'data:image/png;base64,iVBORw0KGgoA'
  const references = [
    {
      imageId: 'photo',
      dataUrl: source,
      maskDataUrl: mask,
      editAction: 'erase' as const,
      regions: [{ x: 0, y: 0, width: 0.5, height: 0.5 }],
    },
  ]
  let now = Date.now()
  const clock = vi.spyOn(Date, 'now').mockImplementation(() => now)
  let generation = 1
  const uploads: { generation: number; bytes: number }[] = []
  const identity = (bytes: number) =>
    `${bytes === 8 ? 'aaaaaaaa' : 'bbbbbbbb'}-aaaa-4aaa-8aaa-aaaaaaaaaaa${generation}`
  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    if (url.endsWith('/api/capabilities')) return Response.json({ 'agent:attachments': true })
    if (url === source || url === mask)
      return new Response(
        Uint8Array.from(
          url === source ? [137, 80, 78, 71, 13, 10, 26, 10] : [137, 80, 78, 71, 13, 10, 26, 10, 0],
        ),
      )
    if (url.endsWith('/uploads')) {
      const { bytes } = JSON.parse(String(init?.body))
      uploads.push({ generation, bytes })
      return Response.json({ id: identity(bytes), status: 'ready', leaseExpiresAt: now + 120_000 })
    }
    return fetchMock(input, init)
  })
  await bootstrapClientCapabilities(true, 'http://bff.test')
  turnResponse = () => Response.json({ error: 'invalid_reference' }, { status: 400 })
  try {
    await useAgentStore.getState().send('擦除选区内容', references)
    const initial = JSON.parse(
      String(fetchMock.mock.calls.find(([url]) => String(url).includes('/turns'))?.[1]?.body),
    )
    expect(initial.references[0]).toMatchObject({ mediaId: identity(8), maskMediaId: identity(9) })
    // The server collected both unclaimed objects while this browser was offline.
    generation = 2
    now += 600_000
    reload(CONVERSATION)
    fetchMock.mockClear()
    turnResponse = COMPLETED_TURN
    localStorage.setItem(scopedStorageName(AGENT_CONVERSATION_KEY), CONVERSATION)
    await useAgentStore.getState().load()
    await vi.waitFor(() =>
      expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/turns'))).toBe(true),
    )
    const retry = JSON.parse(
      String(fetchMock.mock.calls.find(([url]) => String(url).includes('/turns'))?.[1]?.body),
    )
    expect(retry.references).toEqual([
      {
        imageId: 'photo',
        mediaId: identity(8),
        maskMediaId: identity(9),
        editAction: 'erase',
        regions: references[0]!.regions,
      },
    ])
    expect(retry.clientMessageId).toBe(initial.clientMessageId)
    expect(
      [...uploads].sort(
        (left, right) => left.generation - right.generation || left.bytes - right.bytes,
      ),
    ).toEqual([
      { generation: 1, bytes: 8 },
      { generation: 1, bytes: 9 },
      { generation: 2, bytes: 8 },
      { generation: 2, bytes: 9 },
    ])
    await vi.waitFor(async () => expect(await outgoingMessages(PROJECT)).toEqual([]))
  } finally {
    clock.mockRestore()
    setClientStorageScope(null)
    await bootstrapClientCapabilities(false, '')
  }
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
      // 空回执需要复查并由服务端确认终态后才归还草稿。
      await vi.waitFor(() => expect(session.getSnapshot().draft.submission).toBeDefined(), {
        timeout: 3000,
      })
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
      // 原 id 已被服务端确认取消；保留参数快照，但手动重发必须换 id。
      expect(resent.clientMessageId).not.toBe(initial.clientMessageId)
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
  const outcome = await useAgentStore
    .getState()
    .send('已撤回', [], undefined, 'image', 'withdrawn-client-id', undefined, undefined, returned)
  expect(outcome).toBe('cancelled')
  expect(returned).toHaveBeenCalledOnce()
  const snapshot = returned.mock.calls[0]?.[0]
  const posted = fetchMock.mock.calls.find(([url]) => String(url).includes('/turns'))
  const body = JSON.parse(String(posted?.[1]?.body))
  expect(snapshot).toMatchObject({ text: '已撤回', params: body.params })
  expect(snapshot?.id).not.toBe('withdrawn-client-id')
  expect(await outgoingMessages(PROJECT)).toEqual([])
  reload(CONVERSATION)
})

it('刷新补发遇到已撤回时，先持久化到所属项目草稿再删除日志', async () => {
  setClientStorageScope(crypto.randomUUID())
  const draft = currentProjectDraft(CONVERSATION)
  await draft.ready
  turnResponse = () =>
    Response.json(
      {
        state: 'cancelled',
        queued: { id: 'withdrawn', text: '刷新补发', createdAt: 1, references: [] },
      },
      { status: 202 },
    )
  const outcome = await useAgentStore
    .getState()
    .send('刷新补发', [], undefined, 'image', 'withdrawn-original-id')
  expect(outcome).toBe('cancelled')
  expect(await outgoingMessages(PROJECT)).toEqual([])
  const restored = new DraftSession(draft.key)
  await restored.ready
  expect(restored.getSnapshot().unsent).toMatchObject({
    prompt: '刷新补发',
    submission: { text: '刷新补发' },
  })
  expect(restored.getSnapshot().unsent?.submission?.id).not.toBe('withdrawn-original-id')
})

it('keeps all 100 selected attachments and sends only after retrying the failed upload', async () => {
  vi.stubGlobal('crypto', webcrypto)
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  setClientStorageScope(crypto.randomUUID())
  const registrations: string[] = []
  const putAttempts = new Map<string, number>()
  let failedMediaId: string | undefined
  let finishTurn!: (response: Response) => void
  const turnGate = new Promise<Response>((resolve) => {
    finishTurn = resolve
  })
  turnResponse = () => turnGate
  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    if (url.endsWith('/api/capabilities'))
      return Response.json({
        'agent:attachments': true,
        'agent:bulk-attachments': true,
        attachmentLimits: {
          logicalReferences: 100,
          imageBytes: 20 * 1024 * 1024,
          imagePixels: 40_000_000,
          uploadConcurrency: 4,
        },
      })
    if (url.startsWith('data:image/'))
      return new Response(Uint8Array.from(atob(url.split(',')[1]!), (char) => char.charCodeAt(0)))
    if (url.endsWith('/uploads')) {
      const { sha256 } = JSON.parse(String(init?.body)) as { sha256: string }
      registrations.push(sha256)
      const id = `${sha256.slice(0, 8)}-aaaa-4aaa-8aaa-${sha256.slice(8, 20)}`
      failedMediaId ??= id
      return Response.json({
        id,
        status: 'pending',
        uploadUrl: `https://storage.test/${id}`,
        leaseExpiresAt: Date.now() + 1200_000,
      })
    }
    if (url.startsWith('https://storage.test/')) {
      const id = url.split('/').slice(-1)[0]!
      const count = (putAttempts.get(id) ?? 0) + 1
      putAttempts.set(id, count)
      return new Response(null, { status: id === failedMediaId && count === 1 ? 400 : 200 })
    }
    if (url.endsWith('/complete'))
      return Response.json({ id: url.split('/').slice(-2)[0], status: 'ready' })
    return fetchMock(input, init)
  })
  await bootstrapClientCapabilities(true, 'http://bff.test')
  useLibraryStore.setState({ assets: [], loadAssets: async () => {} })
  const session = currentProjectDraft(CONVERSATION)
  await session.ready
  session.update({ prompt: '检查这 100 张图片', references: [] })
  const files = Array.from(
    { length: 100 },
    (_, index) =>
      new File(
        [Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, index])],
        `photo-${index + 1}.png`,
        { type: 'image/png' },
      ),
  )
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  try {
    await act(async () => root.render(createElement(AgentComposer, { doc: new CanvasDoc() })))
    await act(async () => {
      const input = host.querySelector<HTMLInputElement>('input[type="file"]')!
      Object.defineProperty(input, 'files', { configurable: true, value: files })
      input.dispatchEvent(new Event('change', { bubbles: true }))
      useStore.getState().confirmDialog?.action()
      useStore.getState().setConfirmDialog(null)
    })
    await act(async () => {
      await vi.waitFor(() => expect(session.getSnapshot().draft.references).toHaveLength(100))
      // This checks complete intake through 100 durable writes, not CI machine throughput.
      await vi.waitFor(() => expect(putAttempts.size).toBe(100), { timeout: 25_000 })
    })
    expect(session.getSnapshot().draft.references.map((reference) => reference.name)).toEqual(
      Array.from({ length: 100 }, (_, index) => `photo-${index + 1}`),
    )
    expect(JSON.stringify(session.getSnapshot().draft)).not.toContain('base64,')
    const send = host.querySelector<HTMLButtonElement>('[data-slot="composer-send"]')!
    expect(send.disabled).toBe(true)
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/turns'))).toBe(false)
    const retry = [...host.querySelectorAll<HTMLButtonElement>('button')].filter(
      (button) => button.textContent === '重试',
    )
    expect(retry).toHaveLength(1)
    await act(async () => {
      retry[0]!.click()
      await vi.waitFor(() => expect(send.disabled).toBe(false))
    })
    expect([...putAttempts.values()].filter((count) => count > 1)).toEqual([2])
    expect(new Set(registrations).size).toBe(100)
    await act(async () => {
      send.click()
      await vi.waitFor(() =>
        expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/turns'))).toBe(true),
      )
    })
    const request = fetchMock.mock.calls.find(([url]) => String(url).includes('/turns'))!
    const body = JSON.parse(String(request[1]?.body))
    expect(body.references).toHaveLength(100)
    expect(
      body.references.every(
        (reference: { mediaId?: string; dataUrl?: string }) =>
          reference.mediaId && !reference.dataUrl,
      ),
    ).toBe(true)
    expect(JSON.stringify(await outgoingMessages(PROJECT))).not.toContain('base64,')
    await act(async () => {
      finishTurn(COMPLETED_TURN())
      await vi.waitFor(async () => expect(await outgoingMessages(PROJECT)).toEqual([]))
    })
  } finally {
    finishTurn(COMPLETED_TURN())
    act(() => root.unmount())
    host.remove()
    setClientStorageScope(null)
    await bootstrapClientCapabilities(false, '')
  }
}, 30_000)

it('keeps an oversized attachment in the selected scope until the user explicitly removes it', async () => {
  vi.stubGlobal('crypto', webcrypto)
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  setClientStorageScope(crypto.randomUUID())
  const registered: number[] = []
  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    if (url.endsWith('/api/capabilities'))
      return Response.json({
        'agent:attachments': true,
        'agent:bulk-attachments': true,
        attachmentLimits: {
          logicalReferences: 100,
          imageBytes: 10 * 1024 * 1024,
          imagePixels: 40_000_000,
          uploadConcurrency: 4,
        },
      })
    if (url.endsWith('/uploads')) {
      const { sha256, bytes } = JSON.parse(String(init?.body))
      registered.push(bytes)
      return Response.json({
        id: `${sha256.slice(0, 8)}-aaaa-4aaa-8aaa-${sha256.slice(8, 20)}`,
        status: 'ready',
        leaseExpiresAt: Date.now() + 1200_000,
      })
    }
    return fetchMock(input, init)
  })
  await bootstrapClientCapabilities(true, 'http://bff.test')
  useLibraryStore.setState({ assets: [], loadAssets: async () => {} })
  const session = currentProjectDraft(CONVERSATION)
  await session.ready
  session.update({ prompt: '检查完整这组图片', references: [] })
  const files = Array.from(
    { length: 3 },
    (_, index) =>
      new File(
        [Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, index])],
        `photo-${index + 1}.png`,
        { type: 'image/png' },
      ),
  )
  Object.defineProperty(files[2], 'size', { value: 100 * 1024 * 1024 + 1 })
  const reads: Blob[] = []
  const originalRead = FileReader.prototype.readAsArrayBuffer
  const reader = vi.spyOn(FileReader.prototype, 'readAsArrayBuffer').mockImplementation(function (
    this: FileReader,
    file,
  ) {
    reads.push(file)
    return originalRead.call(this, file)
  })
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  try {
    await act(async () => root.render(createElement(AgentComposer, { doc: new CanvasDoc() })))
    await act(async () => {
      const input = host.querySelector<HTMLInputElement>('input[type="file"]')!
      Object.defineProperty(input, 'files', { value: files })
      input.dispatchEvent(new Event('change', { bubbles: true }))
      await vi.waitFor(() => expect(session.getSnapshot().draft.references).toHaveLength(3))
      await vi.waitFor(() => expect(registered).toHaveLength(2))
    })
    expect(session.getSnapshot().draft.references.map((reference) => reference.name)).toEqual([
      'photo-1',
      'photo-2',
      'photo-3',
    ])
    expect(reads).not.toContain(files[2])
    const send = host.querySelector<HTMLButtonElement>('[data-slot="composer-send"]')!
    expect(send.disabled).toBe(true)
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/turns'))).toBe(false)
    await act(async () => {
      host.querySelector<HTMLButtonElement>('button[aria-label="移除参考图 photo-3"]')!.click()
      await vi.waitFor(() => expect(send.disabled).toBe(false))
      send.click()
      await vi.waitFor(() =>
        expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/turns'))).toBe(true),
      )
    })
    const request = fetchMock.mock.calls.find(([url]) => String(url).includes('/turns'))!
    expect(JSON.parse(String(request[1]?.body)).references).toHaveLength(2)
  } finally {
    reader.mockRestore()
    act(() => root.unmount())
    host.remove()
    setClientStorageScope(null)
    await bootstrapClientCapabilities(false, '')
  }
})

it('retains local originals during draft to journal handoff and releases only their last durable owner', async () => {
  vi.stubGlobal('crypto', webcrypto)
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  setClientStorageScope(crypto.randomUUID())
  const { readLocalAttachment } = await import('../../../lib/localAttachmentSources')
  let finishTurn!: (response: Response) => void
  turnResponse = () =>
    new Promise<Response>((resolve) => {
      finishTurn = resolve
    })
  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    if (url.endsWith('/api/capabilities'))
      return Response.json({
        'agent:attachments': true,
        'agent:bulk-attachments': true,
        attachmentLimits: {
          logicalReferences: 100,
          imageBytes: 10 * 1024 * 1024,
          imagePixels: 40_000_000,
          uploadConcurrency: 4,
        },
      })
    if (url.endsWith('/uploads')) {
      const { sha256 } = JSON.parse(String(init?.body))
      return Response.json({
        id: `${sha256.slice(0, 8)}-aaaa-4aaa-8aaa-${sha256.slice(8, 20)}`,
        status: 'ready',
        leaseExpiresAt: Date.now() + 1200_000,
      })
    }
    return fetchMock(input, init)
  })
  await bootstrapClientCapabilities(true, 'http://bff.test')
  useLibraryStore.setState({ assets: [], loadAssets: async () => {} })
  const session = currentProjectDraft(CONVERSATION)
  await session.ready
  session.update({ prompt: '检查这两张图', references: [] })
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  try {
    await act(async () => root.render(createElement(AgentComposer, { doc: new CanvasDoc() })))
    await act(async () => {
      const input = host.querySelector<HTMLInputElement>('input[type="file"]')!
      Object.defineProperty(input, 'files', {
        value: Array.from(
          { length: 2 },
          (_, index) =>
            new File(
              [Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, index])],
              `ownership-${index}.png`,
              { type: 'image/png' },
            ),
        ),
      })
      input.dispatchEvent(new Event('change', { bubbles: true }))
      await vi.waitFor(() => expect(session.getSnapshot().draft.references).toHaveLength(2))
      await vi.waitFor(() =>
        expect(host.querySelector<HTMLButtonElement>('[data-slot="composer-send"]')!.disabled).toBe(
          false,
        ),
      )
    })
    const [shared, exclusive] = session.getSnapshot().draft.references
    await session.flush()
    const other = new DraftSession(scopedStorageName('agent-project-draft:other-owner'))
    await other.ready
    other.update({ prompt: '另一个尚未发送的草稿', references: [shared!] })
    await other.flush()
    await act(async () => {
      host.querySelector<HTMLButtonElement>('[data-slot="composer-send"]')!.click()
      await vi.waitFor(async () => expect(await outgoingMessages(PROJECT)).toHaveLength(1))
      await vi.waitFor(() => expect(finishTurn).toBeTypeOf('function'))
    })
    expect(session.getSnapshot().draft.references).toEqual([])
    await session.flush()
    expect(new Uint8Array((await readLocalAttachment(exclusive!.dataUrl)).data)).toEqual(
      Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 1]),
    )
    await act(async () => {
      finishTurn(COMPLETED_TURN())
      await vi.waitFor(async () => expect(await outgoingMessages(PROJECT)).toEqual([]))
    })
    await vi.waitFor(async () => {
      await expect(readLocalAttachment(exclusive!.dataUrl)).rejects.toThrow(
        'attachment_source_missing',
      )
    })
    expect((await readLocalAttachment(shared!.dataUrl)).data.byteLength).toBe(9)
    other.update({ prompt: '', references: [] })
    await other.flush()
    await expect(readLocalAttachment(shared!.dataUrl)).rejects.toThrow('attachment_source_missing')
  } finally {
    finishTurn?.(COMPLETED_TURN())
    act(() => root.unmount())
    host.remove()
    setClientStorageScope(null)
    await bootstrapClientCapabilities(false, '')
  }
})

it('restores the original draft without dispatch when its durable outgoing journal cannot be written', async () => {
  vi.stubGlobal('crypto', webcrypto)
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  setClientStorageScope(crypto.randomUUID())
  const { readLocalAttachment } = await import('../../../lib/localAttachmentSources')
  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    if (url.endsWith('/api/capabilities'))
      return Response.json({
        'agent:attachments': true,
        'agent:bulk-attachments': true,
        attachmentLimits: {
          logicalReferences: 100,
          imageBytes: 10 * 1024 * 1024,
          imagePixels: 40_000_000,
          uploadConcurrency: 4,
        },
      })
    if (url.endsWith('/uploads')) {
      const { sha256 } = JSON.parse(String(init?.body))
      return Response.json({
        id: `${sha256.slice(0, 8)}-aaaa-4aaa-8aaa-${sha256.slice(8, 20)}`,
        status: 'ready',
        leaseExpiresAt: Date.now() + 1200_000,
      })
    }
    return fetchMock(input, init)
  })
  await bootstrapClientCapabilities(true, 'http://bff.test')
  useLibraryStore.setState({ assets: [], loadAssets: async () => {} })
  const session = currentProjectDraft(CONVERSATION)
  await session.ready
  session.update({ prompt: '这张图不要丢', references: [] })
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  let failure: ReturnType<typeof vi.spyOn> | undefined
  try {
    await act(async () => root.render(createElement(AgentComposer, { doc: new CanvasDoc() })))
    await act(async () => {
      const input = host.querySelector<HTMLInputElement>('input[type="file"]')!
      Object.defineProperty(input, 'files', {
        value: [
          new File([Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 7])], 'keep.png', {
            type: 'image/png',
          }),
        ],
      })
      input.dispatchEvent(new Event('change', { bubbles: true }))
      await vi.waitFor(() => expect(session.getSnapshot().draft.references).toHaveLength(1))
      await vi.waitFor(() =>
        expect(host.querySelector<HTMLButtonElement>('[data-slot="composer-send"]')!.disabled).toBe(
          false,
        ),
      )
    })
    const original = session.getSnapshot().draft.references[0]!
    await session.flush()
    const transaction = IDBDatabase.prototype.transaction
    let failures = 0
    failure = vi.spyOn(IDBDatabase.prototype, 'transaction').mockImplementation(function (
      this: IDBDatabase,
      stores,
      mode,
      options,
    ) {
      if (
        mode === 'readwrite' &&
        (typeof stores === 'string' ? stores === 'outgoing' : stores.includes('outgoing'))
      ) {
        failures++
        throw new DOMException('No disk space for the outgoing command', 'QuotaExceededError')
      }
      return transaction.call(this, stores, mode, options)
    })
    await act(async () => {
      host.querySelector<HTMLButtonElement>('[data-slot="composer-send"]')!.click()
      await vi.waitFor(() => expect(failures).toBeGreaterThan(0))
      await vi.waitFor(() =>
        expect(
          session.getSnapshot().draft.references.length === 1 ||
            fetchMock.mock.calls.some(([url]) => String(url).includes('/turns')),
        ).toBe(true),
      )
    })
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/turns'))).toBe(false)
    expect(session.getSnapshot().draft).toMatchObject({
      prompt: '这张图不要丢',
      references: [original],
    })
    await session.flush()
    const recovered = new DraftSession(session.key)
    await recovered.ready
    expect(recovered.getSnapshot().unsent?.references).toEqual([original])
    expect(new Uint8Array((await readLocalAttachment(original.dataUrl)).data)[8]).toBe(7)
    expect(await outgoingMessages(PROJECT)).toEqual([])
  } finally {
    failure?.mockRestore()
    act(() => root.unmount())
    host.remove()
    setClientStorageScope(null)
    await bootstrapClientCapabilities(false, '')
  }
})

it('keeps every selected position when one original cannot be stored and restores its failed placeholder', async () => {
  vi.stubGlobal('crypto', webcrypto)
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  setClientStorageScope(crypto.randomUUID())
  let registrations = 0
  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    if (url.endsWith('/api/capabilities'))
      return Response.json({
        'agent:attachments': true,
        'agent:bulk-attachments': true,
        attachmentLimits: {
          logicalReferences: 100,
          imageBytes: 10 * 1024 * 1024,
          imagePixels: 40_000_000,
          uploadConcurrency: 4,
        },
      })
    if (url.endsWith('/uploads')) {
      registrations++
      const { sha256 } = JSON.parse(String(init?.body))
      return Response.json({
        id: `${sha256.slice(0, 8)}-aaaa-4aaa-8aaa-${sha256.slice(8, 20)}`,
        status: 'ready',
        leaseExpiresAt: Date.now() + 1200_000,
      })
    }
    return fetchMock(input, init)
  })
  await bootstrapClientCapabilities(true, 'http://bff.test')
  useLibraryStore.setState({ assets: [], loadAssets: async () => {} })
  const session = currentProjectDraft(CONVERSATION)
  await session.ready
  session.update({ prompt: '这三张必须完整保留', references: [] })
  const put = IDBObjectStore.prototype.put
  let sourceWrites = 0
  const failure = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (
    this: IDBObjectStore,
    value,
    key,
  ) {
    if (this.name === 'attachment_sources' && ++sourceWrites === 2) {
      this.transaction.abort()
      throw new DOMException('Original storage is full', 'QuotaExceededError')
    }
    return key === undefined ? put.call(this, value) : put.call(this, value, key)
  })
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  try {
    await act(async () => root.render(createElement(AgentComposer, { doc: new CanvasDoc() })))
    await act(async () => {
      const input = host.querySelector<HTMLInputElement>('input[type="file"]')!
      Object.defineProperty(input, 'files', {
        value: Array.from(
          { length: 3 },
          (_, index) =>
            new File(
              [Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, index])],
              `stored-${index + 1}.png`,
              { type: 'image/png' },
            ),
        ),
      })
      input.dispatchEvent(new Event('change', { bubbles: true }))
      await vi.waitFor(() => expect(session.getSnapshot().draft.references).toHaveLength(3))
      await vi.waitFor(() => expect(registrations).toBe(2))
    })
    const selected = session.getSnapshot().draft.references
    expect(selected.map((reference) => reference.name)).toEqual([
      'stored-1',
      'stored-2',
      'stored-3',
    ])
    expect(JSON.stringify(selected)).not.toContain('base64,')
    expect(host.querySelector<HTMLButtonElement>('[data-slot="composer-send"]')!.disabled).toBe(
      true,
    )
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/turns'))).toBe(false)
    await session.flush()
    const restored = new DraftSession(session.key)
    await restored.ready
    expect(restored.getSnapshot().draft.references).toEqual(selected)
    await act(async () => {
      host.querySelector<HTMLButtonElement>('button[aria-label="移除参考图 stored-2"]')!.click()
      await vi.waitFor(() =>
        expect(host.querySelector<HTMLButtonElement>('[data-slot="composer-send"]')!.disabled).toBe(
          false,
        ),
      )
    })
  } finally {
    failure.mockRestore()
    act(() => root.unmount())
    host.remove()
    setClientStorageScope(null)
    await bootstrapClientCapabilities(false, '')
  }
})

it('rejects a 101 image selection before reading or uploading any original', async () => {
  vi.stubGlobal('crypto', webcrypto)
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  setClientStorageScope(crypto.randomUUID())
  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    if (String(input).endsWith('/api/capabilities'))
      return Response.json({
        'agent:attachments': true,
        'agent:bulk-attachments': true,
        attachmentLimits: {
          logicalReferences: 100,
          imageBytes: 10 * 1024 * 1024,
          imagePixels: 40_000_000,
          uploadConcurrency: 4,
        },
      })
    return fetchMock(input, init)
  })
  await bootstrapClientCapabilities(true, 'http://bff.test')
  useLibraryStore.setState({ assets: [], loadAssets: async () => {} })
  const session = currentProjectDraft(CONVERSATION)
  await session.ready
  session.update({ prompt: '保留这段输入', references: [] })
  const reads = vi.spyOn(FileReader.prototype, 'readAsArrayBuffer').mockImplementation(() => {})
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  try {
    await act(async () => root.render(createElement(AgentComposer, { doc: new CanvasDoc() })))
    await act(async () => {
      const input = host.querySelector<HTMLInputElement>('input[type="file"]')!
      Object.defineProperty(input, 'files', {
        value: Array.from(
          { length: 101 },
          (_, index) =>
            new File(
              [Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, index])],
              `excess-${index + 1}.png`,
              { type: 'image/png' },
            ),
        ),
      })
      input.dispatchEvent(new Event('change', { bubbles: true }))
      useStore.getState().confirmDialog?.action()
      useStore.getState().setConfirmDialog(null)
    })
    expect(reads).not.toHaveBeenCalled()
    expect(session.getSnapshot().draft).toMatchObject({ prompt: '保留这段输入', references: [] })
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith('/uploads'))).toBe(false)
  } finally {
    reads.mockRestore()
    act(() => root.unmount())
    host.remove()
    setClientStorageScope(null)
    await bootstrapClientCapabilities(false, '')
  }
})

it('stores mixed canvas library and mask inputs as local handles before drafts or journals are persisted', async () => {
  vi.stubGlobal('crypto', webcrypto)
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  setClientStorageScope(crypto.randomUUID())
  const sources = Array.from(
    { length: 4 },
    (_, index) =>
      `data:image/png;base64,${btoa(String.fromCharCode(137, 80, 78, 71, 13, 10, 26, 10, index))}`,
  )
  let registrations = 0
  let finishTurn!: (response: Response) => void
  const gate = new Promise<Response>((resolve) => {
    finishTurn = resolve
  })
  turnResponse = () => gate
  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    if (url.endsWith('/api/capabilities'))
      return Response.json({
        'agent:attachments': true,
        'agent:bulk-attachments': true,
        attachmentLimits: {
          logicalReferences: 100,
          imageBytes: 10 * 1024 * 1024,
          imagePixels: 40_000_000,
          uploadConcurrency: 4,
        },
      })
    if (url.startsWith('data:image/'))
      return new Response(Uint8Array.from(atob(url.split(',')[1]!), (char) => char.charCodeAt(0)))
    if (url.endsWith('/uploads')) {
      registrations++
      const { sha256 } = JSON.parse(String(init?.body))
      return Response.json({
        id: `${sha256.slice(0, 8)}-aaaa-4aaa-8aaa-${sha256.slice(8, 20)}`,
        status: 'ready',
        leaseExpiresAt: Date.now() + 1200_000,
      })
    }
    return fetchMock(input, init)
  })
  await bootstrapClientCapabilities(true, 'http://bff.test')
  useLibraryStore.setState({ assets: [], loadAssets: async () => {} })
  const session = currentProjectDraft(CONVERSATION)
  await session.ready
  session.update({
    prompt: '按序检查图片并编辑最后一张',
    references: [
      { id: 'canvas-original', name: '画布原图', dataUrl: sources[0]! },
      { id: 'library-original', name: '素材原图', dataUrl: sources[1]! },
      {
        id: 'mask-target',
        name: '带遮罩原图',
        dataUrl: sources[2]!,
        maskDataUrl: sources[3]!,
        editAction: 'inpaint',
      },
    ],
  })
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  try {
    expect(JSON.stringify(session.getSnapshot().draft)).not.toContain('base64,')
    await session.flush()
    const recovered = new DraftSession(session.key)
    await recovered.ready
    expect(JSON.stringify(recovered.getSnapshot().draft)).not.toContain('base64,')
    expect(recovered.getSnapshot().draft.references.map((reference) => reference.id)).toEqual([
      'canvas-original',
      'library-original',
      'mask-target',
    ])
    await act(async () => root.render(createElement(AgentComposer, { doc: new CanvasDoc() })))
    await act(async () => {
      await vi.waitFor(() => expect(registrations).toBe(4))
      await vi.waitFor(() =>
        expect(host.querySelector<HTMLButtonElement>('[data-slot="composer-send"]')!.disabled).toBe(
          false,
        ),
      )
      host.querySelector<HTMLButtonElement>('[data-slot="composer-send"]')!.click()
      await vi.waitFor(() =>
        expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/turns'))).toBe(true),
      )
    })
    const request = fetchMock.mock.calls.find(([url]) => String(url).includes('/turns'))!
    const body = JSON.parse(String(request[1]?.body))
    expect(body.references.map((reference: { imageId: string }) => reference.imageId)).toEqual([
      'canvas-original',
      'library-original',
      'mask-target',
    ])
    expect(body.references[2]).toMatchObject({
      mediaId: expect.any(String),
      maskMediaId: expect.any(String),
      editAction: 'inpaint',
    })
    expect(JSON.stringify(await outgoingMessages(PROJECT))).not.toContain('base64,')
  } finally {
    await act(async () => {
      finishTurn(COMPLETED_TURN())
      await vi.waitFor(async () => expect(await outgoingMessages(PROJECT)).toEqual([]))
    })
    act(() => root.unmount())
    host.remove()
    setClientStorageScope(null)
    await bootstrapClientCapabilities(false, '')
  }
})

it('binds a persisted local original to the captured canvas but never binds different pixels with the same image id', async () => {
  vi.stubGlobal('crypto', webcrypto)
  setClientStorageScope(crypto.randomUUID())
  const original = `data:image/png;base64,${btoa(String.fromCharCode(137, 80, 78, 71, 13, 10, 26, 10, 1))}`
  const burned = `data:image/png;base64,${btoa(String.fromCharCode(137, 80, 78, 71, 13, 10, 26, 10, 2))}`
  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    if (url.endsWith('/api/capabilities'))
      return Response.json({
        'agent:attachments': true,
        'agent:bulk-attachments': true,
        attachmentLimits: {
          logicalReferences: 100,
          imageBytes: 10 * 1024 * 1024,
          imagePixels: 40_000_000,
          uploadConcurrency: 4,
        },
      })
    if (url.startsWith('data:image/'))
      return new Response(Uint8Array.from(atob(url.split(',')[1]!), (char) => char.charCodeAt(0)))
    if (url.endsWith('/uploads')) {
      const { sha256 } = JSON.parse(String(init?.body))
      return Response.json({
        id: `${sha256.slice(0, 8)}-aaaa-4aaa-8aaa-${sha256.slice(8, 20)}`,
        status: 'ready',
        leaseExpiresAt: Date.now() + 1200_000,
      })
    }
    return fetchMock(input, init)
  })
  await bootstrapClientCapabilities(true, 'http://bff.test')
  const project = await projectRepository.create(
    '句柄原图匹配',
    undefined,
    false,
    true,
    'image',
    'canvas',
  )
  await projectRepository.update(project.id, { conversationId: CONVERSATION })
  useCanvasProjectStore.setState({
    projects: [{ ...project, conversationId: CONVERSATION }],
    activeId: project.id,
    loaded: true,
  })
  const workspace = currentCanvasWorkspace()
  const session = currentProjectDraft(CONVERSATION)
  try {
    await workspace.ready
    await session.ready
    workspace.doc.addElements(
      ['photo', 'burned'].map((id) => ({
        id,
        type: 'image' as const,
        fileId: 'original',
        x: 10,
        y: 20,
        width: 30,
        height: 40,
        rotation: 0,
      })),
      { files: { original } },
    )
    session.update({
      prompt: '检查两张图',
      references: [
        { id: 'photo', dataUrl: original },
        { id: 'burned', dataUrl: burned },
      ],
    })
    await session.flush()
    const sending = useAgentStore
      .getState()
      .send('检查两张图', draftForSubmit(session.getSnapshot().draft).references)
    workspace.doc.updateElements([{ id: 'photo', patch: { x: 999 } }])
    await sending
    const request = fetchMock.mock.calls.find(([url]) => String(url).includes('/turns'))!
    const body = JSON.parse(String(request[1]?.body))
    expect(body.canvas.elements[0]).toMatchObject({
      id: 'photo',
      x: 10,
      mediaId: body.references[0].mediaId,
    })
    expect(body.canvas.elements[1]).not.toHaveProperty('mediaId')
    expect(body.references[0].mediaId).not.toBe(body.references[1].mediaId)
  } finally {
    session.update({ prompt: '', references: [] })
    await session.flush()
    workspace.dispose()
    setClientStorageScope(null)
    peekCanvasWorkspace()
    await bootstrapClientCapabilities(false, '')
  }
})

it('reserves a selected group before reads so an overlapping selection cannot exceed its scope', async () => {
  vi.stubGlobal('crypto', webcrypto)
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  setClientStorageScope(crypto.randomUUID())
  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    if (String(input).endsWith('/api/capabilities'))
      return Response.json({
        'agent:attachments': true,
        'agent:bulk-attachments': true,
        attachmentLimits: {
          logicalReferences: 100,
          imageBytes: 10 * 1024 * 1024,
          imagePixels: 40_000_000,
          uploadConcurrency: 4,
        },
      })
    return fetchMock(input, init)
  })
  await bootstrapClientCapabilities(true, 'http://bff.test')
  useLibraryStore.setState({ assets: [], loadAssets: async () => {} })
  const session = currentProjectDraft(CONVERSATION)
  await session.ready
  session.update({ prompt: '完整这组', references: [] })
  const pending: { reader: FileReader; file: Blob }[] = []
  const read = FileReader.prototype.readAsArrayBuffer
  const blocked = vi.spyOn(FileReader.prototype, 'readAsArrayBuffer').mockImplementation(function (
    this: FileReader,
    file,
  ) {
    pending.push({ reader: this, file })
  })
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  try {
    await act(async () => root.render(createElement(AgentComposer, { doc: new CanvasDoc() })))
    await act(async () => {
      const input = host.querySelector<HTMLInputElement>('input[type="file"]')!
      const files = Array.from(
        { length: 100 },
        (_, index) =>
          new File(
            [Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, index])],
            `reserved-${index + 1}.png`,
            { type: 'image/png' },
          ),
      )
      Object.defineProperty(input, 'files', { configurable: true, value: files })
      input.dispatchEvent(new Event('change', { bubbles: true }))
      useStore.getState().confirmDialog?.action()
      useStore.getState().setConfirmDialog(null)
      Object.defineProperty(input, 'files', {
        configurable: true,
        value: [new File([new Uint8Array([1])], 'extra.png', { type: 'image/png' })],
      })
      input.dispatchEvent(new Event('change', { bubbles: true }))
    })
    expect(session.getSnapshot().draft.references).toHaveLength(100)
    await session.flush()
    const restored = new DraftSession(session.key)
    await restored.ready
    expect(restored.getSnapshot().draft.references).toHaveLength(100)
    expect(
      restored.getSnapshot().draft.references.some((reference) => reference.name === 'extra'),
    ).toBe(false)
    expect(blocked).toHaveBeenCalledTimes(1)
    expect(host.querySelector<HTMLButtonElement>('[data-slot="composer-send"]')!.disabled).toBe(
      true,
    )
  } finally {
    blocked.mockRestore()
    act(() => root.unmount())
    host.remove()
    setClientStorageScope(null)
    for (const item of pending) read.call(item.reader, item.file)
    await bootstrapClientCapabilities(false, '')
  }
})

function pauseOutgoingRetention() {
  let entered!: () => void
  const waiting = new Promise<void>((resolve) => {
    entered = resolve
  })
  let release = () => {}
  let paused = false
  const get = IDBObjectStore.prototype.get
  const spy = vi.spyOn(IDBObjectStore.prototype, 'get').mockImplementation(function (
    this: IDBObjectStore,
    query,
  ) {
    if (
      !paused &&
      this.name === 'attachment_owners' &&
      typeof query === 'string' &&
      query.startsWith('outgoing:')
    ) {
      paused = true
      const tx = this.transaction
      let complete: IDBTransaction['oncomplete'] = null
      Object.defineProperty(tx, 'oncomplete', {
        configurable: true,
        set: (handler: IDBTransaction['oncomplete']) => {
          complete = handler
        },
        get: () => (event: Event) => {
          release = () => {
            complete?.call(tx, event)
          }
          entered()
        },
      })
    }
    return get.call(this, query)
  })
  return { waiting, release: () => release(), restore: () => spy.mockRestore() }
}

async function mountDurableAttachmentDraft() {
  vi.stubGlobal('crypto', webcrypto)
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const account = crypto.randomUUID()
  setClientStorageScope(account)
  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    if (url.endsWith('/api/capabilities'))
      return Response.json({
        'agent:attachments': true,
        'agent:bulk-attachments': true,
        attachmentLimits: {
          logicalReferences: 100,
          imageBytes: 10 * 1024 * 1024,
          imagePixels: 40_000_000,
          uploadConcurrency: 4,
        },
      })
    if (url.startsWith('data:image/'))
      return new Response(Uint8Array.from(atob(url.split(',')[1]!), (char) => char.charCodeAt(0)))
    if (url.endsWith('/uploads')) {
      const { sha256 } = JSON.parse(String(init?.body))
      return Response.json({
        id: `${sha256.slice(0, 8)}-aaaa-4aaa-8aaa-${sha256.slice(8, 20)}`,
        status: 'ready',
        leaseExpiresAt: Date.now() + 1200_000,
      })
    }
    return fetchMock(input, init)
  })
  await bootstrapClientCapabilities(true, 'http://bff.test')
  useLibraryStore.setState({ assets: [], loadAssets: async () => {} })
  const session = currentProjectDraft(CONVERSATION)
  await session.ready
  session.update({
    prompt: '保留完整的原输入',
    references: [{ id: 'retained', dataUrl: 'data:image/png;base64,iVBORw0KGgo=' }],
  })
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  await act(async () => root.render(createElement(AgentComposer, { doc: new CanvasDoc() })))
  await act(async () => {
    await vi.waitFor(() =>
      expect(host.querySelector<HTMLButtonElement>('[data-slot="composer-send"]')!.disabled).toBe(
        false,
      ),
    )
  })
  await session.flush()
  return { account, session, host, root }
}

it('keeps the original durable draft until its outgoing command has committed', async () => {
  const ui = await mountDurableAttachmentDraft()
  const original = ui.session.getSnapshot().draft
  const barrier = pauseOutgoingRetention()
  try {
    await act(async () => {
      ui.host.querySelector<HTMLButtonElement>('[data-slot="composer-send"]')!.click()
      await barrier.waiting
      await ui.session.flush()
    })
    expect(await outgoingMessages(PROJECT)).toEqual([])
    const recovered = new DraftSession(ui.session.key)
    await recovered.ready
    expect(recovered.getSnapshot().unsent).toMatchObject(original)
    expect(recovered.getSnapshot().unsent?.submission?.id).toEqual(expect.any(String))
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/turns'))).toBe(false)
  } finally {
    await act(async () => {
      barrier.release()
      await vi.waitFor(() => expect(ui.session.getSnapshot().submitting).toBe(false))
      await vi.waitFor(async () => expect(await outgoingMessages(PROJECT)).toEqual([]))
    })
    barrier.restore()
    act(() => ui.root.unmount())
    ui.host.remove()
    setClientStorageScope(null)
    await bootstrapClientCapabilities(false, '')
  }
})

it('does not journal or dispatch an old account draft after switching accounts during retention', async () => {
  const ui = await mountDurableAttachmentDraft()
  const original = ui.session.getSnapshot().draft
  const barrier = pauseOutgoingRetention()
  const writes: string[] = []
  const put = IDBObjectStore.prototype.put
  const journalWrites = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (
    this: IDBObjectStore,
    value,
    key,
  ) {
    if (this.name === 'outgoing' && typeof key === 'string') writes.push(key)
    return key === undefined ? put.call(this, value) : put.call(this, value, key)
  })
  try {
    await act(async () => {
      ui.host.querySelector<HTMLButtonElement>('[data-slot="composer-send"]')!.click()
      await barrier.waiting
    })
    setClientStorageScope(crypto.randomUUID())
    await act(async () => {
      barrier.release()
      await vi.waitFor(() => expect(ui.session.getSnapshot().submitting).toBe(false))
    })
    expect(writes).not.toContain(scopedStorageName(`agent-outgoing:${PROJECT}`))
    expect(await outgoingMessages(PROJECT)).toEqual([])
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/turns'))).toBe(false)
    setClientStorageScope(ui.account)
    const recovered = new DraftSession(ui.session.key)
    await recovered.ready
    expect(recovered.getSnapshot().unsent).toMatchObject(original)
  } finally {
    barrier.release()
    barrier.restore()
    journalWrites.mockRestore()
    act(() => ui.root.unmount())
    ui.host.remove()
    setClientStorageScope(null)
    await bootstrapClientCapabilities(false, '')
  }
})

it.each([
  false,
  true,
])('cleans the matching staged draft durably before forgetting a recovered command (delivered=%s)', async (delivered) => {
  const account = `crash-handoff-${delivered}`
  setClientStorageScope(account)
  const session = currentProjectDraft(CONVERSATION)
  await session.ready
  const original = { prompt: '崩溃前已提交的消息', references: [] }
  const submission: UnsentTurnSubmission = {
    id: `crash-handoff-command-${delivered}`,
    text: original.prompt,
    references: [],
    mode: 'image',
    clarificationAnswer: false,
  }
  // The browser closed after both writes committed, before draft cleanup committed.
  session.update(original)
  await session.stageSubmission(original, submission)
  await rememberOutgoing({
    ...submission,
    projectId: PROJECT,
    conversationId: CONVERSATION,
    createdAt: Date.now(),
  })
  const before = new DraftSession(session.key)
  await before.ready
  expect(before.getSnapshot().unsent?.submission?.id).toBe(submission.id)
  if (delivered) {
    messagesResponse = () =>
      Response.json({
        messages: [
          {
            id: 'accepted-user',
            turnId: 'accepted-turn',
            role: 'user',
            content: [{ type: 'text', text: original.prompt }],
            createdAt: 1,
          },
        ],
        activeTurn: null,
        turns: [],
      })
  }
  try {
    reload(CONVERSATION)
    localStorage.setItem(scopedStorageName(AGENT_CONVERSATION_KEY), CONVERSATION)
    fetchMock.mockClear()
    await useAgentStore.getState().load()
    await vi.waitFor(async () => expect(await outgoingMessages(PROJECT)).toEqual([]))
    // A second refresh cannot offer the already submitted content for editing/resending.
    const after = new DraftSession(session.key)
    await after.ready
    expect(after.getSnapshot().unsent).toBeNull()
    expect(after.getSnapshot().draft.prompt).toBe('')
    const turns = fetchMock.mock.calls.filter(([url]) => String(url).includes('/turns'))
    expect(turns).toHaveLength(delivered ? 0 : 1)
    if (!delivered)
      expect(JSON.parse(String(turns[0]?.[1]?.body)).clientMessageId).toBe(submission.id)
  } finally {
    for (const one of await outgoingMessages(PROJECT)) await forgetOutgoing(PROJECT, one.id)
    setClientStorageScope(null)
  }
})

it('keeps the journal when recovered draft cleanup cannot commit and preserves another draft on retry', async () => {
  setClientStorageScope('cleanup-write-failure')
  const session = currentProjectDraft(CONVERSATION)
  await session.ready
  const original = { prompt: '已经交给日志的消息', references: [] }
  const submission: UnsentTurnSubmission = {
    id: 'cleanup-write-failure-command',
    text: original.prompt,
    references: [],
    mode: 'image',
    clarificationAnswer: false,
  }
  session.update({ prompt: '用户后来输入的另一句', references: [] })
  await session.stageSubmission(original, submission)
  await rememberOutgoing({
    ...submission,
    projectId: PROJECT,
    conversationId: CONVERSATION,
    createdAt: Date.now(),
  })
  const put = IDBObjectStore.prototype.put
  const failure = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (
    this: IDBObjectStore,
    value,
    key,
  ) {
    if (this.name === 'drafts') throw new DOMException('Disk full', 'QuotaExceededError')
    return key === undefined ? put.call(this, value) : put.call(this, value, key)
  })
  try {
    localStorage.setItem(scopedStorageName(AGENT_CONVERSATION_KEY), CONVERSATION)
    fetchMock.mockClear()
    await useAgentStore.getState().load()
    await vi.waitFor(() => expect(session.getSnapshot().error).toBeTruthy())
    expect(await outgoingMessages(PROJECT)).toHaveLength(1)
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/turns'))).toBe(false)
    failure.mockRestore()
    reload(CONVERSATION)
    await useAgentStore.getState().load()
    await vi.waitFor(async () => expect(await outgoingMessages(PROJECT)).toEqual([]))
    const restored = new DraftSession(session.key)
    await restored.ready
    expect(restored.getSnapshot().draft.prompt).toBe('用户后来输入的另一句')
    expect(restored.getSnapshot().draft.submission).toBeUndefined()
    const turns = fetchMock.mock.calls.filter(([url]) => String(url).includes('/turns'))
    expect(turns).toHaveLength(1)
    expect(JSON.parse(String(turns[0]?.[1]?.body)).clientMessageId).toBe(submission.id)
  } finally {
    failure.mockRestore()
    for (const one of await outgoingMessages(PROJECT)) await forgetOutgoing(PROJECT, one.id)
    setClientStorageScope(null)
  }
})

it('does not offer a journal-owned draft for editing before conversation history starts loading', async () => {
  vi.stubGlobal('crypto', webcrypto)
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  setClientStorageScope('restore-before-history')
  await bootstrapClientCapabilities(false, '')
  useLibraryStore.setState({ assets: [], loadAssets: async () => {} })
  // Seed storage without registering a live draft session, as after a browser crash.
  const seeded = new DraftSession(scopedStorageName(`agent-project-draft:${PROJECT}`))
  await seeded.ready
  const original = { prompt: '不可另起命令重发的旧消息', references: [] }
  const submission: UnsentTurnSubmission = {
    id: 'restore-before-history-command',
    text: original.prompt,
    references: [],
    mode: 'image',
    clarificationAnswer: false,
  }
  seeded.update(original)
  await seeded.stageSubmission(original, submission)
  await rememberOutgoing({
    ...submission,
    projectId: PROJECT,
    conversationId: CONVERSATION,
    createdAt: Date.now(),
  })
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  try {
    await act(async () => {
      root.render(createElement(AgentComposer, { doc: new CanvasDoc() }))
      await currentProjectDraft(CONVERSATION).ready
    })
    expect(useAgentStore.getState().historyLoading).toBe(false)
    expect(useAgentStore.getState().loaded).toBe(false)
    const restore = host.querySelector<HTMLButtonElement>('button[aria-label="恢复"]') ?? undefined
    act(() => restore?.click())
    expect(currentProjectDraft(CONVERSATION).getSnapshot().draft.prompt).toBe('')
    expect(restore === undefined || restore.disabled).toBe(true)
    expect(await outgoingMessages(PROJECT)).toHaveLength(1)
  } finally {
    act(() => root.unmount())
    host.remove()
    for (const one of await outgoingMessages(PROJECT)) await forgetOutgoing(PROJECT, one.id)
    setClientStorageScope(null)
  }
})

it('preserves the read draft and its original while journal recovery is unreadable, until explicit retry', async () => {
  vi.stubGlobal('crypto', webcrypto)
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  setClientStorageScope('journal-read-unavailable')
  await bootstrapClientCapabilities(false, '')
  useLibraryStore.setState({ assets: [], loadAssets: async () => {} })
  const { registerLocalAttachmentSource, readLocalAttachment } = await import(
    '../../../lib/localAttachmentSources'
  )
  const handle = registerLocalAttachmentSource(
    new File([new Uint8Array([104, 105])], 'retained.png', { type: 'image/png' }),
    1024,
  )
  const original = {
    prompt: '尚未发送且不能丢失的内容',
    references: [{ id: 'retained-original', dataUrl: handle }],
  }
  const seeded = new DraftSession(scopedStorageName(`agent-project-draft:${PROJECT}`))
  await seeded.ready
  seeded.update(original)
  await seeded.flush()
  const get = IDBObjectStore.prototype.get
  const failure = vi.spyOn(IDBObjectStore.prototype, 'get').mockImplementation(function (
    this: IDBObjectStore,
    query,
  ) {
    if (this.name === 'outgoing')
      throw new DOMException('Journal temporarily unavailable', 'UnknownError')
    return get.call(this, query)
  })
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  try {
    await act(async () => {
      root.render(createElement(AgentComposer, { doc: new CanvasDoc() }))
      await currentProjectDraft(CONVERSATION).ready
    })
    const session = currentProjectDraft(CONVERSATION)
    expect(session.getSnapshot().draft).toMatchObject(original)
    expect(host.querySelector('[role="textbox"]')?.getAttribute('contenteditable')).toBe('false')
    expect(host.querySelector<HTMLButtonElement>('[data-slot="composer-send"]')!.disabled).toBe(
      true,
    )
    // Background selection updates and pagehide flush must not overwrite the unread recovery state.
    act(() => session.update({ prompt: '不能写入的新文本', references: [] }))
    await session.flush()
    const disk = new DraftSession(session.key)
    await disk.ready
    expect(disk.getSnapshot().draft).toMatchObject(original)
    expect(new Uint8Array((await readLocalAttachment(handle)).data)).toEqual(
      new Uint8Array([104, 105]),
    )
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/turns'))).toBe(false)
    failure.mockRestore()
    const retry =
      host.querySelector<HTMLButtonElement>('button[aria-label="重试恢复"]') ?? undefined
    expect(retry).toBeDefined()
    await act(async () => retry!.click())
    await vi.waitFor(() => expect(session.getSnapshot().error).toBeNull())
    expect(session.getSnapshot().draft).toMatchObject(original)
    expect(host.querySelector('[role="textbox"]')?.getAttribute('contenteditable')).toBe('true')
  } finally {
    failure.mockRestore()
    act(() => root.unmount())
    host.remove()
    setClientStorageScope(null)
  }
})

it.each([
  'current',
  'unsent',
] as const)('removes journal-owned in-memory %s content after recovery while preserving unrelated edits', async (position) => {
  setClientStorageScope(`memory-journal-owner-${position}`)
  await bootstrapClientCapabilities(false, '')
  const key = scopedStorageName(`agent-project-draft:${PROJECT}`)
  const seed = new DraftSession(key)
  await seed.ready
  seed.update({ prompt: '磁盘上尚未发送的另一句', references: [] })
  await seed.flush()
  const submission: UnsentTurnSubmission = {
    id: `memory-owned-${position}`,
    text: '日志已拥有的唯一命令',
    references: [],
    mode: 'image',
    clarificationAnswer: false,
  }
  await rememberOutgoing({
    ...submission,
    projectId: PROJECT,
    conversationId: CONVERSATION,
    createdAt: Date.now(),
  })
  const get = IDBObjectStore.prototype.get
  const failure = vi.spyOn(IDBObjectStore.prototype, 'get').mockImplementation(function (
    this: IDBObjectStore,
    query,
  ) {
    if (this.name === 'outgoing') throw new DOMException('Journal unreadable', 'UnknownError')
    return get.call(this, query)
  })
  const session = new DraftSession(key, undefined, PROJECT)
  try {
    if (position === 'unsent') session.update({ prompt: '恢复期间的新输入', references: [] })
    const returned = session.returnUnsent({ prompt: submission.text, references: [], submission })
    await session.ready
    await returned
    expect(session.getSnapshot().recoveryBlocked).toBe(true)
    failure.mockRestore()
    await session.retryRecovery()
    expect(session.getSnapshot().recoveryBlocked).toBe(false)
    expect(JSON.stringify(session.getSnapshot())).not.toContain(submission.text)
    expect(JSON.stringify(session.getSnapshot())).toContain('磁盘上尚未发送的另一句')
    if (position === 'unsent') expect(session.getSnapshot().draft.prompt).toBe('恢复期间的新输入')
    expect(await outgoingMessages(PROJECT)).toMatchObject([
      { id: submission.id, text: submission.text },
    ])
    const restored = new DraftSession(key, undefined, PROJECT)
    await restored.ready
    expect(JSON.stringify(restored.getSnapshot())).not.toContain(submission.text)
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/turns'))).toBe(false)
  } finally {
    failure.mockRestore()
    for (const one of await outgoingMessages(PROJECT)) await forgetOutgoing(PROJECT, one.id)
    setClientStorageScope(null)
  }
})
