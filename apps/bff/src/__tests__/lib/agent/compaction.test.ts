import { describe, expect, it } from 'bun:test'
import type { AgentMessage } from '@earendil-works/pi-agent-core'
import {
  type CompactionBreaker,
  type CompactionMessage,
  type CompactionSettings,
  type CompactionState,
  compactionBudget,
  type SummaryRequest,
  shapeAgentContext,
  truncateToBudget,
} from '../../../lib/agent/compaction'
import { estimateMessageTokens } from '../../../lib/agent/token-estimate'
import {
  assistant,
  assistantReporting,
  body,
  textOf,
  toolResult,
  user,
} from '../../helpers/agentMessages'

/** 与压缩内部同一个估算器：断言「没超预算」不能另起一套算法。 */
function tokensOfMessages(messages: readonly AgentMessage[]): number {
  return messages.reduce((total, message) => total + estimateMessageTokens(message), 0)
}

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
      foldedBefore: 0,
      breaker: CLOSED,
      settings: SETTINGS,
      now: 1_000,
      overheadTokens: 0,
      summarize: summarizerOf(calls),
    })

    expect(result.mode).toBe('none')
    expect(result.messages).toHaveLength(2)
    expect(result.state).toBeNull()
    expect(calls).toHaveLength(0)
  })

  // 上游报的用量只当下界，不替掉字符估算：它说的是上一份请求，这一份追加了什么它不知道。
  // 这里上游报 250 没过线，锚之后又续了两条 —— 加起来才把它顶过 300。
  it('adds the messages appended after the usage anchor', async () => {
    const messages = [
      assistantReporting('m1', body('a'), 250),
      user('m2', body('b')),
      user('m3', body('c')),
    ]
    const calls: SummaryRequest[] = []
    const result = await shapeAgentContext({
      messages,
      state: null,
      foldedBefore: 0,
      breaker: CLOSED,
      settings: SETTINGS,
      now: 1_000,
      overheadTokens: 0,
      summarize: summarizerOf(calls),
    })

    // 锚本身 250 没过 300 的线，锚后两条各 100 才把它顶过去。
    expect(result.mode).toBe('rebuild')
    expect(calls).toHaveLength(1)
  })

  // 死角防线：上游报的数比我们自己估的小（中文校正让字符估算偏保守）也不能就此放行——
  // 出站硬闸量的是字符估算那一路，触发判据一旦更松，那一轮就会以「内容太长」直接收场。
  it('still compacts when the character estimate exceeds the upstream usage', async () => {
    const messages = [
      user('m1', body('a')),
      user('m2', body('b')),
      user('m3', body('c')),
      user('m4', body('d')),
      assistantReporting('m5', body('e'), 120),
    ]
    const calls: SummaryRequest[] = []
    const result = await shapeAgentContext({
      messages,
      state: null,
      foldedBefore: 0,
      breaker: CLOSED,
      settings: SETTINGS,
      now: 1_000,
      overheadTokens: 0,
      summarize: summarizerOf(calls),
    })

    expect(tokensOfMessages(messages.map((entry) => entry.message))).toBeGreaterThan(
      compactionBudget(SETTINGS).threshold,
    )
    expect(result.mode).toBe('rebuild')
    expect(tokensOfMessages(result.messages)).toBeLessThanOrEqual(
      compactionBudget(SETTINGS).threshold,
    )
  })

  // 反过来：字符数看着不多，可上游报的用量已经压线——系统说明、工具声明、图片都在那个数里，
  // 我们自己数消息永远看不见。按锚判就该压。
  it('compacts when the upstream usage is over budget even if the text looks short', async () => {
    const messages = [
      user('m1', body('a')),
      assistantReporting('m2', body('b'), 400),
      user('m3', '再来一张'),
    ]
    const calls: SummaryRequest[] = []
    const result = await shapeAgentContext({
      messages,
      state: null,
      foldedBefore: 0,
      breaker: CLOSED,
      settings: SETTINGS,
      now: 1_000,
      overheadTokens: 0,
      summarize: summarizerOf(calls),
    })

    expect(tokensOfMessages(messages.map((m) => m.message))).toBeLessThan(
      compactionBudget(SETTINGS).threshold,
    )
    expect(result.mode).toBe('rebuild')
    expect(calls).toHaveLength(1)
  })

  // 会话第一轮还没有任何用量锚，pi 只能数消息——系统说明与工具声明这时得我们自己补上。
  it('adds the fixed overhead while no upstream usage anchor exists yet', async () => {
    const messages = [user('m1', body('a')), user('m2', body('b'))]
    const calls: SummaryRequest[] = []
    const shape = (overheadTokens: number) =>
      shapeAgentContext({
        messages,
        state: null,
        foldedBefore: 0,
        breaker: CLOSED,
        settings: SETTINGS,
        now: 1_000,
        overheadTokens,
        summarize: summarizerOf(calls),
      })

    expect((await shape(0)).mode).toBe('none')
    expect((await shape(250)).mode).toBe('rebuild')
  })

  // 摘要请求自己也是一次出站。折叠区比预算长时分段折，每一段都在预算内，且一条不落——
  // 从前面截掉的话，截掉的那截既不在摘要里也不在尾巴里，用户说过的话会无声消失。
  it('folds an oversized region in bounded chunks without dropping a message', async () => {
    const messages = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'].map((marker, at) =>
      at % 2 === 0 ? user(`m${at + 1}`, body(marker)) : assistant(`m${at + 1}`, body(marker)),
    )
    const calls: SummaryRequest[] = []
    const result = await shapeAgentContext({
      messages,
      state: null,
      foldedBefore: 0,
      breaker: CLOSED,
      settings: SETTINGS,
      now: 1_000,
      overheadTokens: 0,
      summarize: summarizerOf(calls),
    })

    const limit = compactionBudget(SETTINGS).threshold
    expect(calls.length).toBeGreaterThan(1)
    for (const call of calls) {
      expect(tokensOfMessages(call.messages.map((entry) => entry.message))).toBeLessThanOrEqual(
        limit,
      )
    }
    // 分段之间靠上一段的摘要接力：第一段没有前情，后面每一段都带着。
    expect(calls[0]!.previousSummary).toBeNull()
    expect(calls.slice(1).every((call) => call.previousSummary !== null)).toBe(true)
    // 折叠区的每一条都恰好进了某一段，顺序不变，没有重复也没有遗漏。
    expect(calls.flatMap((call) => call.messages.map((entry) => entry.id))).toEqual(
      messages.slice(0, 8).map((entry) => entry.id),
    )
    expect(result.mode).toBe('rebuild')
  })

  // 段界向前吸附到用户消息，与 cutPoint 同一条规矩：一段里不出现没有调用的工具结果。
  it('starts every fold chunk at a user message', async () => {
    const messages = [
      user('m1', body('a')),
      assistant('m2', body('b')),
      toolResult('m3', body('c')),
      user('m4', body('d')),
      assistant('m5', body('e')),
      toolResult('m6', body('f')),
      user('m7', body('g')),
      assistant('m8', body('h')),
      user('m9', body('i')),
    ]
    const calls: SummaryRequest[] = []
    await shapeAgentContext({
      messages,
      state: null,
      foldedBefore: 0,
      breaker: CLOSED,
      settings: SETTINGS,
      now: 1_000,
      overheadTokens: 0,
      summarize: summarizerOf(calls),
    })

    expect(calls.length).toBeGreaterThan(1)
    expect(calls.map((call) => call.messages[0]!.message.role)).toEqual(
      calls.map(() => 'user' as const),
    )
  })

  it('rebuilds a summary and keeps the recent tail verbatim within the budget', async () => {
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
      foldedBefore: 0,
      breaker: CLOSED,
      settings: SETTINGS,
      now: 1_000,
      overheadTokens: 0,
      summarize: summarizerOf(calls),
    })

    expect(result.mode).toBe('rebuild')
    expect(calls).toHaveLength(1)
    expect(calls[0]!.previousSummary).toBeNull()
    // 切点向前吸附到 m3 这条用户消息；摘要加尾巴整体收进预算，装不下的最旧几条尾巴让位。
    // 让位的那几条既不在摘要（它只覆盖折叠区）也不在尾巴里，所以位置上留一行占位——
    // 用户说过的话可以不随这次请求发出，但不许无声消失。
    expect(textOf(result.messages[1]!)).toContain('这里有 2 条消息')
    expect(result.messages.slice(2).map(textOf)).toEqual([body('e')])
    expect(result.state).toEqual({
      narrative: narrative(),
      // 这一条 400 字，逐字预算 87 token 装不下，所以只留条数与字数。
      verbatim: { omittedCount: 1, omittedChars: 400, kept: [] },
      foldedHere: 2,
      foldCount: 0,
    })
    expect(textOf(result.messages[0]!)).toContain('已经出了三张图')
  })

  // 以前新折出来的摘要这一支不校验预算，是整条路径上唯一能吐出超预算结果的地方。
  it('never returns more than the budget, not even right after folding', async () => {
    const messages = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].map((marker, at) =>
      at % 2 === 0 ? user(`m${at + 1}`, body(marker)) : assistant(`m${at + 1}`, body(marker)),
    )
    const result = await shapeAgentContext({
      messages,
      state: null,
      foldedBefore: 0,
      breaker: CLOSED,
      settings: SETTINGS,
      now: 1_000,
      overheadTokens: 0,
      summarize: summarizerOf([]),
    })

    expect(result.mode).toBe('rebuild')
    expect(tokensOfMessages(result.messages)).toBeLessThanOrEqual(
      compactionBudget(SETTINGS).threshold,
    )
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
      foldedBefore: 0,
      breaker: CLOSED,
      settings: SETTINGS,
      now: 1_000,
      overheadTokens: 0,
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
      foldedBefore: 0,
      breaker: CLOSED,
      settings: SETTINGS,
      now: 1_000,
      overheadTokens: 0,
      summarize: summarizerOf([]),
    })

    const summary = textOf(result.messages[0]!)
    expect(summary).not.toContain(half('a'))
    // 让位的永远是最旧的那一截，所以一行就说得清是几条、多少字。
    expect(summary).toContain('最早的 2 条用户消息已省略，约 400 字')
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
      foldedBefore: 0,
      breaker: CLOSED,
      settings: SETTINGS,
      now: 1_000,
      overheadTokens: 0,
      summarize: summarizerOf([]),
    })

    // 保留最近 2 条会落在 m5（工具结果）上，向前吸附无边界，只能向后吸附——没有更晚的
    // 用户消息时保持原切点，工具调用与其结果不被摘要吃掉半截。
    expect(result.mode).toBe('rebuild')
    expect(result.state?.foldedHere).toBe(4)
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
      verbatim: { omittedCount: 0, omittedChars: 0, kept: ['m2 的原话'] },
      foldedHere: 2,
      foldCount: 1,
    }
    const calls: SummaryRequest[] = []
    const result = await shapeAgentContext({
      messages,
      state,
      foldedBefore: 0,
      breaker: CLOSED,
      settings: SETTINGS,
      now: 1_000,
      overheadTokens: 0,
      summarize: summarizerOf(calls),
    })

    // 摘要照旧排在最前，原文尾巴跟在后面；这一轮没新折任何东西，所以是 `none`。
    expect(result.mode).toBe('none')
    expect(calls).toHaveLength(0)
    expect(result.state).toBe(state)
    expect(textOf(result.messages[0]!)).toContain('已经出了三张图')
    expect(result.messages.slice(1).map(textOf)).toEqual([body('c'), body('d')])
  })

  // 有界历史查询之后，锚点之前的原文可能根本不在这一份 messages 里。用户原话只能从存档
  // 来——这里故意让 messages 前两条写着别的内容，从原文重建就会把它们印进摘要。
  it('quotes the archived user text rather than rebuilding it from the messages', async () => {
    const messages = [
      user('m1', '这句不该出现在摘要里'),
      assistant('m2', body('b')),
      user('m3', body('c')),
      assistant('m4', body('d')),
    ]
    const state: CompactionState = {
      narrative: narrative(),
      verbatim: { omittedCount: 3, omittedChars: 42, kept: ['把主体换成白色马克杯'] },
      foldedHere: 2,
      foldCount: 1,
    }
    const result = await shapeAgentContext({
      messages,
      state,
      foldedBefore: 8,
      breaker: CLOSED,
      settings: SETTINGS,
      now: 1_000,
      overheadTokens: 0,
      summarize: summarizerOf([]),
    })

    const summary = textOf(result.messages[0]!)
    expect(result.mode).toBe('none')
    expect(summary).toContain('把主体换成白色马克杯')
    expect(summary).not.toContain('这句不该出现在摘要里')
    expect(summary).toContain('最早的 3 条用户消息已省略')
    // 标题上的总数要算上没读进来的那几条，否则模型以为只折了眼前这两条。
    expect(summary).toContain('较早的 10 条消息已折叠')
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
      verbatim: { omittedCount: 0, omittedChars: 0, kept: ['m2 的原话'] },
      foldedHere: 2,
      foldCount: 1,
    }
    const calls: SummaryRequest[] = []
    const result = await shapeAgentContext({
      messages,
      state,
      foldedBefore: 0,
      breaker: CLOSED,
      settings: SETTINGS,
      now: 1_000,
      overheadTokens: 0,
      summarize: summarizerOf(calls),
    })

    expect(result.mode).toBe('incremental')
    expect(calls).toHaveLength(1)
    expect(calls[0]!.previousSummary).toEqual(narrative())
    expect(calls[0]!.messages.map((entry) => entry.id)).toEqual(['m3', 'm4'])
    expect(result.state?.foldCount).toBe(2)
    expect(result.state?.foldedHere).toBe(4)
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
      verbatim: { omittedCount: 0, omittedChars: 0, kept: ['m2 的原话'] },
      foldedHere: 2,
      foldCount: 5,
    }
    const calls: SummaryRequest[] = []
    const result = await shapeAgentContext({
      messages,
      state,
      foldedBefore: 0,
      breaker: CLOSED,
      settings: SETTINGS,
      now: 1_000,
      overheadTokens: 0,
      summarize: summarizerOf(calls),
    })

    expect(result.mode).toBe('rebuild')
    expect(calls[0]!.previousSummary).toBeNull()
    // 从 m1 起重折，不是接着锚点往下——这一段超预算所以分了段，合起来仍是整段前缀。
    expect(calls.flatMap((call) => call.messages.map((entry) => entry.id))).toEqual([
      'm1',
      'm2',
      'm3',
      'm4',
    ])
    expect(result.state?.foldCount).toBe(0)
  })

  // 折叠满次数本来要丢开旧摘要重做，可锚点之前的原文已经读不回来了。那时重做等于把
  // 它们的摘要一起抹掉——只能接着增量折，让失真也好过让整段上下文消失。
  it('keeps folding incrementally past the cap once earlier messages are out of reach', async () => {
    const messages = [
      user('m1', body('a')),
      assistant('m2', body('b')),
      user('m3', '再把杯子调小一点'),
      assistant('m4', body('d')),
      user('m5', body('e')),
      assistant('m6', body('f')),
    ]
    const state: CompactionState = {
      narrative: narrative(),
      verbatim: { omittedCount: 0, omittedChars: 0, kept: ['更早那段里用户说的话'] },
      foldedHere: 2,
      foldCount: 5,
    }
    const calls: SummaryRequest[] = []
    const result = await shapeAgentContext({
      messages,
      state,
      foldedBefore: 30,
      breaker: CLOSED,
      settings: SETTINGS,
      now: 1_000,
      overheadTokens: 0,
      summarize: summarizerOf(calls),
    })

    expect(result.mode).toBe('incremental')
    expect(calls[0]!.previousSummary).toEqual(narrative())
    // 存档接着往上加，早先那句不许在重做里蒸发。
    expect(result.state?.verbatim.kept).toContain('更早那段里用户说的话')
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
      foldedBefore: 0,
      breaker: CLOSED,
      settings: SETTINGS,
      now: 1_000,
      overheadTokens: 0,
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
      foldedBefore: 0,
      breaker: { failureCount: 2, openedAt: null },
      settings: SETTINGS,
      now: 5_000,
      overheadTokens: 0,
      summarize: failing,
    })

    expect(result.breaker).toEqual({ failureCount: 3, openedAt: 5_000 })
  })

  // 装得下的会话在早返回那一步就出去了，碰不到熔断器这一支：这里要的历史得真的超预算。
  it('still reuses an existing summary while the breaker is open', async () => {
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
      verbatim: { omittedCount: 0, omittedChars: 0, kept: ['m2 的原话'] },
      foldedHere: 2,
      foldCount: 1,
    }
    const calls: SummaryRequest[] = []
    const result = await shapeAgentContext({
      messages,
      state,
      foldedBefore: 0,
      breaker: { failureCount: 3, openedAt: 5_000 },
      settings: SETTINGS,
      now: 6_000,
      overheadTokens: 0,
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
      foldedBefore: 0,
      breaker: { failureCount: 3, openedAt: 5_000 },
      settings: SETTINGS,
      now: 6_000,
      overheadTokens: 0,
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
      foldedBefore: 0,
      breaker: { failureCount: 3, openedAt: 5_000 },
      settings: SETTINGS,
      now: 5_000 + SETTINGS.breakerCooldownMs,
      overheadTokens: 0,
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
      foldedBefore: 0,
      breaker: { failureCount: 2, openedAt: null },
      settings: SETTINGS,
      now: 1_000,
      overheadTokens: 0,
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
      foldedBefore: 0,
      breaker: CLOSED,
      settings: SETTINGS,
      now: 1_000,
      overheadTokens: 0,
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
      foldedBefore: 0,
      breaker: { failureCount: 3, openedAt: 5_000 },
      settings: SETTINGS,
      now: 6_000,
      overheadTokens: 0,
      summarize: summarizerOf([]),
    })

    expect(result.mode).toBe('truncate')
    expect(result.messages.map(textOf)).toEqual([body('b').repeat(10)])
  })
})

/**
 * 整条压缩路径出岔子时的兜底（`compaction-transform.ts` 的 catch 用它）。
 * 它存在的理由只有一个：摘要失败不能回退成发完整历史——那一刻历史正是最长的那一份。
 */
describe('truncateToBudget', () => {
  const HISTORY = [user('m1', body('a')), user('m2', body('b')), user('m3', body('c'))].map(
    (entry) => entry.message,
  )

  it('按预算从最旧的开始裁，留下最新那几条', () => {
    // 每条 100 token：250 的预算装得下最新两条。
    expect(truncateToBudget(HISTORY, 250).map(textOf)).toEqual([body('b'), body('c')])
  })

  it('预算连一条都装不下时仍留最新那一条', () => {
    // 什么都不发这一轮就没法推进了；超不超由出站硬闸最后判。
    expect(truncateToBudget(HISTORY, 1).map(textOf)).toEqual([body('c')])
  })

  it('没有消息就没有消息', () => {
    expect(truncateToBudget([], 250)).toEqual([])
  })
})
