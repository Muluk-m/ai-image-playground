// @vitest-environment jsdom
import type { AgentMessageView } from '@image-playground/shared'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import AgentPendingDrafts from '../../../../features/agent/components/AgentPendingDrafts'
import { setAgentJobPollIntervalForTesting, useAgentStore } from '../../../../features/agent/store'
import type { AgentToolMessage } from '../../../../features/agent/types'
import { _setRuntimeConfigForTesting } from '../../../../lib/runtimeConfig'

const CONVERSATION = 'conversation-1'

function draft(id: string, prompt: string): AgentToolMessage {
  return {
    kind: 'tool',
    id,
    turnId: 'turn-1',
    toolCallId: id,
    toolName: 'generateImage',
    title: prompt,
    prompt,
    status: 'awaiting_confirmation',
    snapshot: { mode: 'image', args: { n: 1 }, target: { provider: 'openai', model: 'm' } },
  }
}

function submittedView(id: string, prompt: string): AgentMessageView {
  return {
    id,
    turnId: 'turn-1',
    role: 'assistant',
    createdAt: 1,
    content: [
      {
        type: 'toolResult',
        toolCallId: id,
        toolName: 'generateImage',
        status: 'submitted',
        title: prompt,
        prompt,
        job: { taskId: `task-${id}`, media: 'image' },
      },
    ],
  }
}

const posted: { id: string; prompt: string }[] = []
/** 第几次确认要被拒；`null` 表示都放行。 */
let refuseAt: number | null = null

const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input)
  if (url.endsWith('/confirmations')) {
    const body = JSON.parse(String(init?.body ?? '{}')) as { messageId: string; prompt: string }
    if (posted.length === refuseAt) {
      return Response.json(
        { error: 'confirmation_refused', code: 'insufficient_credits' },
        { status: 409 },
      )
    }
    posted.push({ id: body.messageId, prompt: body.prompt })
    return Response.json({ message: submittedView(body.messageId, body.prompt) })
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
  refuseAt = null
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

function confirmAll(): HTMLButtonElement {
  return [...host.querySelectorAll('button')].find((one) =>
    one.textContent?.includes('全部确认'),
  ) as HTMLButtonElement
}

async function clickAndSettle(button: HTMLButtonElement): Promise<void> {
  await act(async () => {
    button.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
  await act(async () => {
    // web 的 tsconfig lib 还没到 es2024，`Promise.withResolvers` 在这里不存在。
    await new Promise((resolve) => setTimeout(resolve, 20))
  })
}

it('只有一张待确认时不出现：那时它和卡上的键说同一件事', () => {
  useAgentStore.setState({ conversationId: CONVERSATION, messages: [draft('a', '一只猫')] })
  act(() => root.render(<AgentPendingDrafts />))

  expect(host.textContent).toBe('')
})

it('逐张确认，带上用户在卡里改过的那一份', async () => {
  useAgentStore.setState({
    conversationId: CONVERSATION,
    messages: [draft('a', '一只猫'), draft('b', '一只公鸡')],
    promptDrafts: { b: '一只大公鸡' },
  })
  act(() => root.render(<AgentPendingDrafts />))
  expect(host.textContent).toContain('2 张稿等你确认')

  await clickAndSettle(confirmAll())

  // 清单在点下去那一刻就定死：边确认边读 messages 会漏掉后面那些（确认会就地换掉卡片）。
  expect(posted).toEqual([
    { id: 'a', prompt: '一只猫' },
    { id: 'b', prompt: '一只大公鸡' },
  ])
  // 两张都换成已提交，横幅自己收起来。
  expect(host.textContent).toBe('')
})

it('一张被拒就停下，剩下的原样留着', async () => {
  refuseAt = 1
  useAgentStore.setState({
    conversationId: CONVERSATION,
    messages: [draft('a', '一只猫'), draft('b', '一只公鸡'), draft('c', '一只鹅')],
    promptDrafts: {},
  })
  act(() => root.render(<AgentPendingDrafts />))

  await clickAndSettle(confirmAll())

  // 第二张被拒：第三张压根没发出去，不刷出一串同样的错。
  expect(posted).toEqual([{ id: 'a', prompt: '一只猫' }])
  expect(host.querySelector('[role="alert"]')?.textContent).toContain('积分')
  const left = useAgentStore
    .getState()
    .messages.filter((one) => one.kind === 'tool' && one.status === 'awaiting_confirmation')
  expect(left.map((one) => one.id)).toEqual(['b', 'c'])
})
