import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createHistoryCacheWriter,
  type HistoryCacheHandle,
  type HistoryCacheView,
} from '../../../../features/agent/lib/historyCacheWriter'
import type { AgentPanelMessage } from '../../../../features/agent/types'

function handle(current = true) {
  return {
    isCurrent: vi.fn(() => current),
    write: vi.fn(async () => {}),
    remove: vi.fn(async () => {}),
  } satisfies HistoryCacheHandle
}

const text = (id: string, extra: Partial<AgentPanelMessage> = {}) =>
  ({ kind: 'text', id, role: 'assistant', text: id, ...extra }) as AgentPanelMessage

const view = (patch: Partial<HistoryCacheView> = {}): HistoryCacheView => ({
  conversationId: 'c1',
  messages: [],
  turns: {},
  turn: 'idle',
  historyCached: false,
  historyLoading: false,
  historyFailed: false,
  ...patch,
})

function harness() {
  const handles = new Map<string, ReturnType<typeof handle>>()
  const openCache = vi.fn((conversationId: string) => {
    const one = handles.get(conversationId) ?? handle()
    handles.set(conversationId, one)
    return one
  })
  const writer = createHistoryCacheWriter({ openCache, runningDelayMs: 500 })
  // 先切进 c1，之后的面板变化才有写入目标。
  writer.observe(view(), view({ conversationId: null }))
  return { writer, openCache, c1: handles.get('c1')!, handles }
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('createHistoryCacheWriter', () => {
  it('空闲时面板一变就写，且不写本机未上轮的用户气泡，流式文本按已结束存', () => {
    const { writer, c1 } = harness()
    const before = view()
    const messages = [
      text('a', { streaming: true } as Partial<AgentPanelMessage>),
      text('u', { role: 'user', pending: true } as Partial<AgentPanelMessage>),
    ]
    writer.observe(view({ messages, turns: { t: {} as never } }), before)
    expect(c1.write).toHaveBeenCalledTimes(1)
    const [panel] = c1.write.mock.calls[0] as unknown as [
      { messages: AgentPanelMessage[]; turns: unknown },
    ]
    expect(panel.messages.map((message) => message.id)).toEqual(['a'])
    expect(panel.messages[0]).toMatchObject({ streaming: false })
    expect(panel.turns).toEqual({ t: {} })
  })

  it('一轮在跑时合并 500ms 内的变化，只写最后一份', () => {
    const { writer, c1 } = harness()
    let previous = view({ turn: 'running' })
    for (const id of ['a', 'b', 'c']) {
      const next = view({ turn: 'running', messages: [...previous.messages, text(id)] })
      writer.observe(next, previous)
      previous = next
    }
    expect(c1.write).not.toHaveBeenCalled()
    vi.advanceTimersByTime(500)
    expect(c1.write).toHaveBeenCalledTimes(1)
    expect(
      (c1.write.mock.calls[0] as unknown as [{ messages: AgentPanelMessage[] }])[0].messages,
    ).toHaveLength(3)
  })

  it.each([
    ['缓存预览', { historyCached: true }],
    ['读取中', { historyLoading: true }],
    ['读取失败', { historyFailed: true }],
  ] as const)('%s 时不写', (_, patch) => {
    const { writer, c1 } = harness()
    writer.observe(view({ messages: [text('a')], ...patch }), view())
    expect(c1.write).not.toHaveBeenCalled()
  })

  it('空面板、消息与轮次都没变、或句柄已失效（换账号或后端）时不写', () => {
    const { writer, c1 } = harness()
    const same = view({ messages: [text('a')] })
    writer.observe(view(), view({ turn: 'running' }))
    writer.observe(same, same)
    c1.isCurrent.mockReturnValue(false)
    writer.observe(view({ messages: [text('b')] }), view())
    expect(c1.write).not.toHaveBeenCalled()
  })

  it('换会话前先落下排着的写，写进的是原会话', () => {
    const { writer, c1, handles } = harness()
    const running = view({ turn: 'running', messages: [text('a')] })
    writer.observe(running, view({ turn: 'running' }))
    writer.observe(view({ conversationId: 'c2' }), running)
    expect(c1.write).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(500)
    expect(c1.write).toHaveBeenCalledTimes(1)
    expect(handles.get('c2')!.write).not.toHaveBeenCalled()
  })

  it('离开会话（conversationId 置空）后不再写', () => {
    const { writer, c1 } = harness()
    writer.observe(view({ conversationId: null }), view())
    writer.observe(
      view({ conversationId: null, messages: [text('a')] }),
      view({ conversationId: null }),
    )
    expect(c1.write).not.toHaveBeenCalled()
  })

  it('flush 立刻落下合并窗口里的写', () => {
    const { writer, c1 } = harness()
    writer.observe(view({ turn: 'running', messages: [text('a')] }), view({ turn: 'running' }))
    writer.flush()
    expect(c1.write).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(500)
    expect(c1.write).toHaveBeenCalledTimes(1)
  })

  it('bind 先落下旧目标的写，之后改写到新句柄', () => {
    const { writer, c1 } = harness()
    writer.observe(view({ turn: 'running', messages: [text('a')] }), view({ turn: 'running' }))
    const next = handle()
    expect(writer.bind(next)).toBe(next)
    expect(c1.write).toHaveBeenCalledTimes(1)
    writer.observe(view({ messages: [text('b')] }), view())
    expect(next.write).toHaveBeenCalledTimes(1)
    expect(c1.write).toHaveBeenCalledTimes(1)
  })

  it('forget 先落下排着的写再删快照', async () => {
    const { writer, c1 } = harness()
    const order: string[] = []
    c1.write.mockImplementation(async () => void order.push('write'))
    c1.remove.mockImplementation(async () => void order.push('remove'))
    writer.observe(view({ turn: 'running', messages: [text('a')] }), view({ turn: 'running' }))
    await writer.forget('c1')
    expect(order).toEqual(['write', 'remove'])
  })
})
