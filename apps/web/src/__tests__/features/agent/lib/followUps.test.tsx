// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import AgentFollowUps from '../../../../features/agent/components/AgentFollowUps'
import { fetchFollowUps } from '../../../../features/agent/lib/agentClient'
import { setAgentComposerFill } from '../../../../features/agent/lib/composerFill'
import {
  pollFollowUps,
  shouldPollFollowUps,
  visibleFollowUps,
} from '../../../../features/agent/lib/followUps'
import type { AgentPanelMessage, AgentTurnFooter } from '../../../../features/agent/types'
import { _setRuntimeConfigForTesting } from '../../../../lib/runtimeConfig'

vi.mock('../../../../lib/deviceId', () => ({ getDeviceId: () => 'device-abcdefgh' }))

afterEach(() => {
  document.body.replaceChildren()
})

function text(
  id: string,
  turnId: string,
  role: 'user' | 'assistant' = 'assistant',
): AgentPanelMessage {
  return { kind: 'text', id, turnId, role, text: '一句', streaming: false }
}

function footer(turnId: string, followUps?: readonly string[]): AgentTurnFooter {
  return {
    turnId,
    stopReason: 'completed',
    ...(followUps ? { followUps } : {}),
  }
}

const LINES = ['再出一版，背景改成夜晚橱窗。', '标题换成英文 Autumn Blend。'] as const

describe('下一句什么时候出现', () => {
  const messages = [text('user', 'turn-1', 'user'), text('assistant', 'turn-1')]
  const turns = { 'turn-1': footer('turn-1', LINES) }
  const shown = {
    idle: true,
    historyBlocked: false,
    welcome: false,
    draft: '',
    messages,
    turns,
  }

  it('只在刚说完、输入框还空着时显示这一轮的句子', () => {
    expect(visibleFollowUps(shown)).toEqual(LINES)
    expect(visibleFollowUps({ ...shown, draft: '我自己在打' })).toEqual([])
    expect(visibleFollowUps({ ...shown, idle: false })).toEqual([])
    expect(visibleFollowUps({ ...shown, welcome: true })).toEqual([])
    expect(visibleFollowUps({ ...shown, historyBlocked: true })).toEqual([])
    expect(visibleFollowUps({ ...shown, turns: { 'turn-1': footer('turn-1') } })).toEqual([])
  })

  it('澄清和待确认的轮不问、也不显示', () => {
    const clarifying = [
      ...messages,
      {
        kind: 'clarification' as const,
        id: 'ask',
        turnId: 'turn-1',
        question: '哪种？',
        options: ['夜景'],
      },
    ]
    const confirming = [
      ...messages,
      {
        kind: 'tool' as const,
        id: 'tool',
        turnId: 'turn-1',
        toolCallId: 'call',
        title: '海报',
        status: 'awaiting_confirmation' as const,
      },
    ]
    expect(shouldPollFollowUps({ turnId: 'turn-1', messages, turns })).toBe(true)
    expect(shouldPollFollowUps({ turnId: 'turn-1', messages: clarifying, turns })).toBe(false)
    expect(visibleFollowUps({ ...shown, messages: clarifying })).toEqual([])
    expect(shouldPollFollowUps({ turnId: 'turn-1', messages: confirming, turns })).toBe(false)
    expect(
      shouldPollFollowUps({
        turnId: 'turn-1',
        messages,
        turns: {
          'turn-1': { ...footer('turn-1'), stopReason: 'failed', error: 'agent_run_failed' },
        },
      }),
    ).toBe(false)
  })

  it('还在生成就再问，换了会话或已经有句子就停', async () => {
    const waits: number[] = []
    let pending = true
    const lines = await pollFollowUps(
      'conversation',
      'turn-1',
      () => true,
      async () => {
        if (pending) {
          pending = false
          return null
        }
        return ['换成方形。', '灯光暖一点。']
      },
      async (ms) => {
        waits.push(ms)
      },
    )
    expect(lines).toEqual(['换成方形。', '灯光暖一点。'])
    expect(waits).toEqual([2000])

    expect(
      await pollFollowUps(
        'conversation',
        'turn-1',
        () => false,
        async () => ['不该读到'],
        async () => {},
      ),
    ).toBeNull()
  })

  it('空数组是问完了，不再把失败当成还在生成', async () => {
    const read = vi.fn(async () => [] as const)
    const waits: number[] = []
    expect(
      await pollFollowUps(
        'conversation',
        'turn-1',
        () => true,
        read,
        async (ms) => {
          waits.push(ms)
        },
      ),
    ).toBeNull()
    expect(read).toHaveBeenCalledTimes(1)
    expect(waits).toEqual([])
  })

  it('一直还在生成就退避问到 45 秒', async () => {
    const waits: number[] = []
    let reads = 0
    expect(
      await pollFollowUps(
        'conversation',
        'turn-1',
        () => true,
        async () => {
          reads += 1
          return null
        },
        async (ms) => {
          waits.push(ms)
        },
      ),
    ).toBeNull()
    expect(reads).toBe(10)
    expect(waits).toEqual([2_000, 2_000, 3_000, 4_000, 5_000, 6_000, 7_000, 8_000, 8_000])
    expect(waits.reduce((sum, ms) => sum + ms, 0)).toBe(45_000)
  })
})

it('点下一句只把整句填进输入框', async () => {
  const filled: string[] = []
  const unregister = setAgentComposerFill((content) => {
    filled.push(typeof content === 'string' ? content : content.text)
  })
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  await act(async () => {
    root.render(<AgentFollowUps lines={LINES} />)
  })
  const button = [...host.querySelectorAll('button')].find((node) =>
    node.textContent?.includes('夜晚橱窗'),
  )
  expect(button?.getAttribute('type')).toBe('button')
  expect(
    host.getAttribute('aria-label') ??
      host.querySelector('[aria-label]')?.getAttribute('aria-label'),
  ).toBe('下一句')
  await act(async () => {
    button?.click()
  })
  expect(filled).toEqual(['再出一版，背景改成夜晚橱窗。'])
  act(() => root.unmount())
  unregister()
})

it('下一句接口认 null、句子和缺字段', async () => {
  _setRuntimeConfigForTesting({ bff: { enabled: true, baseUrl: 'https://bff.test' } })
  const calls: { url: string; init?: RequestInit }[] = []
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init })
    const followUps = calls.length === 1 ? null : calls.length === 2 ? LINES : undefined
    return Response.json(followUps === undefined ? { messages: [] } : { followUps })
  })
  expect(await fetchFollowUps('conversation/1', 'turn/1', fetcher)).toBeNull()
  expect(await fetchFollowUps('conversation/1', 'turn/1', fetcher)).toEqual(LINES)
  expect(await fetchFollowUps('conversation/1', 'turn/1', fetcher)).toEqual([])
  expect(calls[0]?.url).toBe(
    'https://bff.test/api/agent/conversations/conversation%2F1/follow-ups/turn%2F1',
  )
  expect(calls[0]?.init?.headers).toMatchObject({ 'x-device-id': 'device-abcdefgh' })
})
