// @vitest-environment jsdom
import 'fake-indexeddb/auto'
import type { AgentTurnEvent } from '@image-playground/shared'
import { encodeAgentFrame } from '@image-playground/shared'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { forgetOutgoing, outgoingMessages } from '../../../features/agent/lib/outgoingJournal'
import { useAgentStore } from '../../../features/agent/store'
import type { CanvasProject } from '../../../features/canvas/lib/projectRepository'
import { useCanvasProjectStore } from '../../../features/canvas/projectStore'
import { AGENT_CONVERSATION_KEY, scopedStorageName } from '../../../lib/authScope'
import { _setRuntimeConfigForTesting } from '../../../lib/runtimeConfig'

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
