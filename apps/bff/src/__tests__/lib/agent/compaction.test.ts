import { describe, expect, it } from 'bun:test'
import {
  type CompactionBreaker,
  type CompactionMessage,
  type CompactionSettings,
  type CompactionState,
  compactionBudget,
  type SummaryRequest,
  shapeAgentContext,
} from '../../../lib/agent/compaction'
import { assistant, body, textOf, toolResult, user } from '../../helpers/agentMessages'

const SETTINGS: CompactionSettings = {
  contextWindow: 400,
  maxOutputTokens: 50,
  outputReserveTokens: 100,
  bufferTokens: 50,
  keepRecentMessages: 2,
  verbatimTokens: 87,
  maxIncrementalFolds: 5,
  failureThreshold: 3,
  breakerCooldownMs: 6 * 60 * 60 * 1000,
}

const CLOSED: CompactionBreaker = { failureCount: 0, openedAt: null }

function narrative() {
  return {
    completed: '已经出了三张图',
    inProgress: '正在调整背景',
    decisions: '主体不能换',
    artifacts: 'img-1、img-2',
  }
}

function summarizerOf(calls: SummaryRequest[]) {
  return async (request: SummaryRequest) => {
    calls.push(request)
    return narrative()
  }
}

const failing = async () => null

describe('compactionBudget', () => {
  it('reserves the smaller of model max output and the configured reserve', () => {
    expect(compactionBudget(SETTINGS)).toEqual({ effectiveWindow: 350, threshold: 300 })
  })

  it('does not treat the model max output as the window', () => {
    const budget = compactionBudget({
      ...SETTINGS,
      contextWindow: 128_000,
      maxOutputTokens: 8_000,
      outputReserveTokens: 20_000,
      bufferTokens: 13_000,
    })
    expect(budget).toEqual({ effectiveWindow: 120_000, threshold: 107_000 })
  })
})

describe('shapeAgentContext', () => {
  it('passes the messages through untouched below the threshold', async () => {
    const messages = [user('m1', body('a')), assistant('m2', body('b'))]
    const calls: SummaryRequest[] = []
    const result = await shapeAgentContext({
      messages,
      state: null,
      breaker: CLOSED,
      settings: SETTINGS,
      now: 1_000,
      summarize: summarizerOf(calls),
    })

    expect(result.mode).toBe('none')
    expect(result.messages).toHaveLength(2)
    expect(result.state).toBeNull()
    expect(calls).toHaveLength(0)
  })

  it('rebuilds a summary and keeps the recent tail verbatim', async () => {
    const messages = [
      user('m1', body('a')),
      assistant('m2', body('b')),
      user('m3', body('c')),
      assistant('m4', body('d')),
      user('m5', body('e')),
    ]
    const calls: SummaryRequest[] = []
    const result = await shapeAgentContext({
      messages,
      state: null,
      breaker: CLOSED,
      settings: SETTINGS,
      now: 1_000,
      summarize: summarizerOf(calls),
    })

    expect(result.mode).toBe('rebuild')
    expect(calls).toHaveLength(1)
    expect(calls[0]!.previousSummary).toBeNull()
    // 保留最近 2 条，切点向前吸附到 m3 这条用户消息
    expect(result.messages.slice(1).map(textOf)).toEqual([body('c'), body('d'), body('e')])
    expect(result.state).toEqual({
      narrative: narrative(),
      anchor: { lastMessageId: 'm2', coveredCount: 2 },
      foldCount: 0,
    })
    expect(textOf(result.messages[0]!)).toContain('已经出了三张图')
  })

  it('keeps every folded user message verbatim in the summary', async () => {
    const messages = [
      user('m1', '把主体换成白色马克杯'),
      assistant('m2', body('b')),
      user('m3', '背景换成浅木色'),
      assistant('m4', body('d')),
      user('m5', body('e')),
      assistant('m6', body('f')),
    ]
    const result = await shapeAgentContext({
      messages,
      state: null,
      breaker: CLOSED,
      settings: SETTINGS,
      now: 1_000,
      summarize: summarizerOf([]),
    })

    const summary = textOf(result.messages[0]!)
    expect(summary).toContain('把主体换成白色马克杯')
    expect(summary).toContain('背景换成浅木色')
  })

  it('degrades the oldest user message to a placeholder instead of dropping it', async () => {
    const half = (marker: string) => marker.repeat(200)
    const messages = [
      user('m1', half('a')),
      user('m2', half('b')),
      user('m3', half('c')),
      assistant('m4', body('d')),
      user('m5', body('e')),
      assistant('m6', body('f')),
    ]
    const result = await shapeAgentContext({
      messages,
      state: null,
      breaker: CLOSED,
      settings: SETTINGS,
      now: 1_000,
      summarize: summarizerOf([]),
    })

    const summary = textOf(result.messages[0]!)
    expect(summary).not.toContain(half('a'))
    expect(summary).toMatch(/第 1 条用户消息/)
    expect(summary).toMatch(/第 2 条用户消息/)
    expect(summary).toContain(half('c'))
  })

  it('adheres the cut point forward when the tail has no user boundary', async () => {
    const messages = [
      user('m1', body('a')),
      assistant('m2', body('b')),
      toolResult('m3', body('c')),
      assistant('m4', body('d')),
      toolResult('m5', body('e')),
      assistant('m6', body('f')),
    ]
    const result = await shapeAgentContext({
      messages,
      state: null,
      breaker: CLOSED,
      settings: SETTINGS,
      now: 1_000,
      summarize: summarizerOf([]),
    })

    // 保留最近 2 条会落在 m5（工具结果）上，向前吸附无边界，只能向后吸附——没有更晚的
    // 用户消息时保持原切点，工具调用与其结果不被摘要吃掉半截。
    expect(result.mode).toBe('rebuild')
    expect(result.state?.anchor.coveredCount).toBe(4)
  })

  it('reuses a matching anchor without calling the summary model', async () => {
    const messages = [
      user('m1', body('a')),
      assistant('m2', body('b')),
      user('m3', body('c')),
      assistant('m4', body('d')),
    ]
    const state: CompactionState = {
      narrative: narrative(),
      anchor: { lastMessageId: 'm2', coveredCount: 2 },
      foldCount: 1,
    }
    const calls: SummaryRequest[] = []
    const result = await shapeAgentContext({
      messages,
      state,
      breaker: CLOSED,
      settings: SETTINGS,
      now: 1_000,
      summarize: summarizerOf(calls),
    })

    expect(result.mode).toBe('reuse')
    expect(calls).toHaveLength(0)
    expect(result.state).toBe(state)
    expect(result.messages.slice(1).map(textOf)).toEqual([body('c'), body('d')])
  })

  it('folds incrementally when the reused shape still exceeds the threshold', async () => {
    const messages = [
      user('m1', body('a')),
      assistant('m2', body('b')),
      user('m3', body('c')),
      assistant('m4', body('d')),
      user('m5', body('e')),
      assistant('m6', body('f')),
    ]
    const state: CompactionState = {
      narrative: narrative(),
      anchor: { lastMessageId: 'm2', coveredCount: 2 },
      foldCount: 1,
    }
    const calls: SummaryRequest[] = []
    const result = await shapeAgentContext({
      messages,
      state,
      breaker: CLOSED,
      settings: SETTINGS,
      now: 1_000,
      summarize: summarizerOf(calls),
    })

    expect(result.mode).toBe('incremental')
    expect(calls).toHaveLength(1)
    expect(calls[0]!.previousSummary).toEqual(narrative())
    expect(calls[0]!.messages.map((entry) => entry.id)).toEqual(['m3', 'm4'])
    expect(result.state?.foldCount).toBe(2)
    expect(result.state?.anchor).toEqual({ lastMessageId: 'm4', coveredCount: 4 })
  })

  it('forces a full rebuild once consecutive folds hit the cap', async () => {
    const messages = [
      user('m1', body('a')),
      assistant('m2', body('b')),
      user('m3', body('c')),
      assistant('m4', body('d')),
      user('m5', body('e')),
      assistant('m6', body('f')),
    ]
    const state: CompactionState = {
      narrative: narrative(),
      anchor: { lastMessageId: 'm2', coveredCount: 2 },
      foldCount: 5,
    }
    const calls: SummaryRequest[] = []
    const result = await shapeAgentContext({
      messages,
      state,
      breaker: CLOSED,
      settings: SETTINGS,
      now: 1_000,
      summarize: summarizerOf(calls),
    })

    expect(result.mode).toBe('rebuild')
    expect(calls[0]!.previousSummary).toBeNull()
    expect(calls[0]!.messages.map((entry) => entry.id)).toEqual(['m1', 'm2', 'm3', 'm4'])
    expect(result.state?.foldCount).toBe(0)
  })

  it('rebuilds when the anchored count no longer lands on the anchored message', async () => {
    // m2 被删，第 2 条现在是 m3：只比锚点 id 会把已删内容永久冻进摘要。
    const messages = [
      user('m1', body('a')),
      user('m3', body('c')),
      assistant('m4', body('d')),
      user('m5', body('e')),
      assistant('m6', body('f')),
    ]
    const state: CompactionState = {
      narrative: narrative(),
      anchor: { lastMessageId: 'm2', coveredCount: 2 },
      foldCount: 1,
    }
    const calls: SummaryRequest[] = []
    const result = await shapeAgentContext({
      messages,
      state,
      breaker: CLOSED,
      settings: SETTINGS,
      now: 1_000,
      summarize: summarizerOf(calls),
    })

    expect(result.mode).toBe('rebuild')
    expect(calls[0]!.previousSummary).toBeNull()
    expect(result.state?.foldCount).toBe(0)
  })

  it('falls back to a trailing window when the summary call fails without a usable summary', async () => {
    const messages = [
      user('m1', body('a')),
      assistant('m2', body('b')),
      user('m3', body('c')),
      assistant('m4', body('d')),
      user('m5', body('e')),
    ]
    const result = await shapeAgentContext({
      messages,
      state: null,
      breaker: CLOSED,
      settings: SETTINGS,
      now: 1_000,
      summarize: failing,
    })

    expect(result.mode).toBe('truncate')
    expect(result.state).toBeNull()
    expect(result.breaker).toEqual({ failureCount: 1, openedAt: null })
    expect(result.messages.map(textOf)).toEqual([body('c'), body('d'), body('e')])
  })

  it('opens the breaker after consecutive failures hit the threshold', async () => {
    const messages = [
      user('m1', body('a')),
      assistant('m2', body('b')),
      user('m3', body('c')),
      assistant('m4', body('d')),
    ]
    const result = await shapeAgentContext({
      messages,
      state: null,
      breaker: { failureCount: 2, openedAt: null },
      settings: SETTINGS,
      now: 5_000,
      summarize: failing,
    })

    expect(result.breaker).toEqual({ failureCount: 3, openedAt: 5_000 })
  })

  it('still reuses an existing summary while the breaker is open', async () => {
    const messages = [
      user('m1', body('a')),
      assistant('m2', body('b')),
      user('m3', body('c')),
      assistant('m4', body('d')),
    ]
    const state: CompactionState = {
      narrative: narrative(),
      anchor: { lastMessageId: 'm2', coveredCount: 2 },
      foldCount: 1,
    }
    const calls: SummaryRequest[] = []
    const result = await shapeAgentContext({
      messages,
      state,
      breaker: { failureCount: 3, openedAt: 5_000 },
      settings: SETTINGS,
      now: 6_000,
      summarize: summarizerOf(calls),
    })

    expect(result.mode).toBe('reuse')
    expect(calls).toHaveLength(0)
    expect(result.state).toBe(state)
    expect(textOf(result.messages[0]!)).toContain('已经出了三张图')
  })

  it('degrades to a trailing window while the breaker is open and no summary exists', async () => {
    const messages = [
      user('m1', body('a')),
      assistant('m2', body('b')),
      user('m3', body('c')),
      assistant('m4', body('d')),
      user('m5', body('e')),
    ]
    const calls: SummaryRequest[] = []
    const result = await shapeAgentContext({
      messages,
      state: null,
      breaker: { failureCount: 3, openedAt: 5_000 },
      settings: SETTINGS,
      now: 6_000,
      summarize: summarizerOf(calls),
    })

    expect(result.mode).toBe('truncate')
    expect(calls).toHaveLength(0)
    expect(result.messages.map(textOf)).toEqual([body('c'), body('d'), body('e')])
  })

  it('closes the breaker once the cooldown has elapsed', async () => {
    const messages = [
      user('m1', body('a')),
      assistant('m2', body('b')),
      user('m3', body('c')),
      assistant('m4', body('d')),
    ]
    const calls: SummaryRequest[] = []
    const result = await shapeAgentContext({
      messages,
      state: null,
      breaker: { failureCount: 3, openedAt: 5_000 },
      settings: SETTINGS,
      now: 5_000 + SETTINGS.breakerCooldownMs,
      summarize: summarizerOf(calls),
    })

    expect(result.mode).toBe('rebuild')
    expect(calls).toHaveLength(1)
    expect(result.breaker).toEqual({ failureCount: 0, openedAt: null })
  })

  it('clears the failure count after a successful summary', async () => {
    const messages = [
      user('m1', body('a')),
      assistant('m2', body('b')),
      user('m3', body('c')),
      assistant('m4', body('d')),
    ]
    const result = await shapeAgentContext({
      messages,
      state: null,
      breaker: { failureCount: 2, openedAt: null },
      settings: SETTINGS,
      now: 1_000,
      summarize: summarizerOf([]),
    })

    expect(result.breaker).toEqual({ failureCount: 0, openedAt: null })
  })

  it('leaves the input messages untouched', async () => {
    const messages = [
      user('m1', body('a')),
      assistant('m2', body('b')),
      user('m3', body('c')),
      assistant('m4', body('d')),
      user('m5', body('e')),
    ]
    const snapshot = JSON.stringify(messages)
    await shapeAgentContext({
      messages,
      state: null,
      breaker: CLOSED,
      settings: SETTINGS,
      now: 1_000,
      summarize: summarizerOf([]),
    })

    expect(messages).toHaveLength(5)
    expect(JSON.stringify(messages)).toBe(snapshot)
  })

  it('keeps at least the newest message when the trailing window cannot fit', async () => {
    const messages = [user('m1', body('a')), user('m2', body('b').repeat(10))]
    const result = await shapeAgentContext({
      messages,
      state: null,
      breaker: { failureCount: 3, openedAt: 5_000 },
      settings: SETTINGS,
      now: 6_000,
      summarize: summarizerOf([]),
    })

    expect(result.mode).toBe('truncate')
    expect(result.messages.map(textOf)).toEqual([body('b').repeat(10)])
  })
})
