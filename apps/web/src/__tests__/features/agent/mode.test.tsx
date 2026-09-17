// @vitest-environment jsdom
import 'fake-indexeddb/auto'
import type { AgentTurnEvent } from '@image-playground/shared'
import { encodeAgentFrame } from '@image-playground/shared'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import AgentClarification from '../../../features/agent/components/AgentClarification'
import { setAgentCanvasSink } from '../../../features/agent/lib/canvasSink'
import { useAgentStore } from '../../../features/agent/store'
import { _setRuntimeConfigForTesting } from '../../../lib/runtimeConfig'

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

const CONVERSATION = 'conversation-1'

const TURN_START: AgentTurnEvent = { type: 'turnStart', turnId: 'turn-2', userMessageId: 'user-2' }
const TURN_END: AgentTurnEvent = {
  type: 'turnEnd',
  turnId: 'turn-2',
  durationMs: 10,
  stopReason: 'completed',
  usage: null,
}

const turnBodies: Record<string, unknown>[] = []

const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input)
  if (url.includes('/turns')) {
    turnBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
    return new Response([TURN_START, TURN_END].map((e, i) => encodeAgentFrame(i + 1, e)).join(''), {
      headers: { 'content-type': 'text/event-stream' },
    })
  }
  return Response.json({ messages: [], activeTurn: null, turns: [] })
})

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  _setRuntimeConfigForTesting({ bff: { enabled: true, baseUrl: 'http://bff.test' } })
  vi.stubGlobal('fetch', fetchMock)
  localStorage.clear()
  turnBodies.length = 0
  setAgentCanvasSink({
    has: () => false,
    async reserve() {
      return []
    },
    discard() {},
    markFailed() {},
    async place() {
      return 'placed'
    },
    focus() {},
    async thumbnail() {
      return null
    },
  })
  useAgentStore.setState({
    conversationId: CONVERSATION,
    messages: [],
    turn: 'idle',
    activeTurn: null,
    turns: {},
    error: null,
    loaded: true,
    historyLoading: false,
    historyFailed: false,
    stopping: false,
    mode: 'image',
  })
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  setAgentCanvasSink(null)
  vi.unstubAllGlobals()
  fetchMock.mockClear()
})

function renderClarification(): void {
  act(() => {
    root.render(
      <AgentClarification
        message={{
          kind: 'clarification',
          id: 'clar-1',
          turnId: 'turn-1',
          question: '先出首帧还是直接出片？',
          options: ['先出首帧'],
        }}
        answered={false}
      />,
    )
  })
}

async function clickOption(label: string): Promise<void> {
  const button = [...host.querySelectorAll('button')].find((one) => one.textContent === label)!
  await act(async () => {
    button.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

describe('这一轮的创作类型', () => {
  it('作答澄清沿用会话的创作类型，不打回图片', async () => {
    // 澄清卡是「代用户发一轮」，它不知道输入框上的开关；mode 又不落库，
    // 所以这一轮只要退回图片，视频流程在模型问一句之后就断了。
    useAgentStore.setState({ mode: 'video' })
    renderClarification()

    await clickOption('先出首帧')

    expect(turnBodies).toHaveLength(1)
    expect(turnBodies[0]!.mode).toBe('video')
  })

  it('图片会话里作答澄清不带创作类型，服务端按缺省算图片', async () => {
    renderClarification()

    await clickOption('先出首帧')

    expect(turnBodies).toHaveLength(1)
    expect(turnBodies[0]!.mode).toBeUndefined()
  })

  it('显式传进来的创作类型压过会话的那个', async () => {
    useAgentStore.setState({ mode: 'image' })

    await useAgentStore.getState().send('做个开箱片', [], undefined, 'video')

    expect(turnBodies[0]!.mode).toBe('video')
  })
})
