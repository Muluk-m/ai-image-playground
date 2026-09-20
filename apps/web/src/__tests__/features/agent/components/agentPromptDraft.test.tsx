// @vitest-environment jsdom
import type { AgentMessageView } from '@image-playground/shared'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import AgentToolCard from '../../../../features/agent/components/AgentToolCard'
import { setAgentJobPollIntervalForTesting, useAgentStore } from '../../../../features/agent/store'
import type { AgentToolMessage } from '../../../../features/agent/types'
import { _setRuntimeConfigForTesting } from '../../../../lib/runtimeConfig'

const CONVERSATION = 'conversation-1'
/** 模型自己补上的颜色（用户没说过）就藏在这段里：确认卡要把它原样摆出来。 */
const DRAFTED = '把白色浴缸换成浅灰绿色浴缸，保留原有瓷砖与光线。\n镜头与原图一致。'
const CORRECTED = '把浴缸换成白色浴缸，不要改变颜色，保留原有瓷砖与光线。'

const draft: AgentToolMessage = {
  kind: 'tool',
  id: 'tool-1',
  turnId: 'turn-1',
  toolCallId: 'call-1',
  toolName: 'generateImage',
  title: '换一只浴缸',
  prompt: DRAFTED,
  status: 'awaiting_confirmation',
  snapshot: {
    mode: 'image',
    args: { n: 2 },
    target: { provider: 'openai', model: 'gpt-image-1' },
  },
}

const submitted: AgentMessageView = {
  id: 'tool-1',
  turnId: 'turn-1',
  role: 'assistant',
  createdAt: 1,
  content: [
    {
      type: 'toolResult',
      toolCallId: 'call-1',
      toolName: 'generateImage',
      status: 'submitted',
      title: '换一只浴缸',
      prompt: CORRECTED,
      snapshot: draft.snapshot,
      job: { taskId: 'task-1', media: 'image' },
    },
  ],
}

const posted: { url: string; body: unknown }[] = []
let confirmResponse: () => Response | Promise<Response>

const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input)
  if (url.endsWith('/confirmations')) {
    posted.push({ url, body: JSON.parse(String(init?.body ?? 'null')) })
    return confirmResponse()
  }
  if (url.endsWith('/jobs')) return Response.json({ jobs: [] })
  return Response.json({ messages: [], activeTurn: null, turns: [] })
})

let host: HTMLDivElement
let root: Root

globalThis.IS_REACT_ACT_ENVIRONMENT = true

beforeEach(() => {
  _setRuntimeConfigForTesting({ bff: { enabled: true, baseUrl: 'http://bff.test' } })
  vi.stubGlobal('fetch', fetchMock)
  setAgentJobPollIntervalForTesting(5)
  posted.length = 0
  confirmResponse = () => Response.json({ message: submitted })
  useAgentStore.setState({
    conversationId: CONVERSATION,
    messages: [draft],
    promptDrafts: {},
    turn: 'idle',
    error: null,
  })
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  // 守候循环按会话退出：别让它跨用例继续问服务端。
  useAgentStore.setState({ conversationId: null, messages: [], promptDrafts: {} })
  setAgentJobPollIntervalForTesting()
  vi.unstubAllGlobals()
  fetchMock.mockClear()
})

function render(message: AgentToolMessage = draft): void {
  act(() => root.render(<AgentToolCard message={message} />))
}

function field(): HTMLTextAreaElement {
  return host.querySelector('textarea')!
}

function type(text: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
  act(() => {
    setter.call(field(), text)
    field().dispatchEvent(new Event('input', { bubbles: true }))
  })
}

/** 提交键在两个状态下的两种文字，都是同一个键。 */
function confirmButton(): HTMLButtonElement {
  return [...host.querySelectorAll('button')].find(
    (one) => one.textContent === '确认生成' || one.textContent === '提交中…',
  )!
}

function card(): AgentToolMessage {
  const message = useAgentStore.getState().messages[0]
  if (message?.kind !== 'tool') throw new Error('expected a tool card')
  return message
}

it('把整段草稿摊在卡上直接可改，而不是藏在「查看提示词」后面', () => {
  render()

  expect(field().value).toBe(DRAFTED)
  expect(field().disabled).toBe(false)
  expect(host.textContent).not.toContain('查看提示词')
  expect(host.textContent).toContain('确认后生成 2 张')
  expect(host.textContent).toContain('gpt-image-1')
})

it('确认提交的是用户改过的那份字，卡就地换成已提交', async () => {
  render()
  type(CORRECTED)

  await act(async () => confirmButton().click())

  expect(posted).toEqual([
    {
      url: `http://bff.test/api/agent/conversations/${CONVERSATION}/confirmations`,
      body: { deviceId: expect.any(String), messageId: 'tool-1', prompt: CORRECTED },
    },
  ])
  expect(card()).toMatchObject({ id: 'tool-1', status: 'submitted', prompt: CORRECTED })
  // 就地改写：不会在草稿卡旁边多出一张。
  expect(useAgentStore.getState().messages).toHaveLength(1)
  expect(useAgentStore.getState().promptDrafts['tool-1']).toBeUndefined()
})

it('提交被拒时改过的字还在，原因与出路只落在这张卡上', async () => {
  confirmResponse = () =>
    Response.json({ error: 'confirmation_refused', code: 'insufficient_credits' }, { status: 409 })
  render()
  type(CORRECTED)

  await act(async () => confirmButton().click())

  expect(field().value).toBe(CORRECTED)
  expect(card().status).toBe('awaiting_confirmation')
  expect(host.querySelector('[role="alert"]')?.textContent).toBe('积分不够，这次没有提交')
  expect(confirmButton().disabled).toBe(false)
  expect(useAgentStore.getState().error).toBeNull()
})

it('提示词被清空时确认按钮按不下去', () => {
  render()
  type('   \n  ')

  expect(confirmButton().disabled).toBe(true)
  expect(host.textContent).toContain('提示词不能为空')
})

it('连点两下只提交一次', async () => {
  let release = () => {}
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  confirmResponse = async () => {
    await held
    return Response.json({ message: submitted })
  }
  render()

  act(() => confirmButton().click())
  act(() => confirmButton().click())
  expect(confirmButton().disabled).toBe(true)

  await act(async () => {
    release()
    await held
  })
  expect(posted).toHaveLength(1)
})
