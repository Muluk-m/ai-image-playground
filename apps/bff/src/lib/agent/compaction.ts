import { type AgentMessage, estimateTokens } from '@earendil-works/pi-agent-core'
import type { AgentCompactionNarrative } from '@image-playground/shared'
import { isObject } from '../type-guards'

/**
 * 上下文压缩：消息与锚点进，塑形后的消息与新锚点出。纯模块，不碰数据库也不发请求——
 * 摘要调用由外部注入，四态才能直接测。
 */

/** 压缩只塑造送给模型的输入，`id` 是消息在存储里的身份，用于锚点吻合。 */
export interface CompactionMessage {
  readonly id: string
  readonly message: AgentMessage
}

/** 摘要覆盖到哪条、覆盖几条。两个都记：只记 id 认不出中间某条被删。 */
export interface CompactionAnchor {
  readonly lastMessageId: string
  readonly coveredCount: number
}

export interface CompactionState {
  readonly narrative: AgentCompactionNarrative
  readonly anchor: CompactionAnchor
  /** 自上次全量重做以来的连续增量折叠次数。 */
  readonly foldCount: number
}

/** 熔断器：`openedAt` 非空表示熔断中，冷却期满自动归零。 */
export interface CompactionBreaker {
  readonly failureCount: number
  readonly openedAt: number | null
}

export interface CompactionSettings {
  readonly contextWindow: number
  /** 模型的最大输出。它不是窗口：当成窗口会让刚到一成容量就触发压缩。 */
  readonly maxOutputTokens: number
  readonly outputReserveTokens: number
  readonly bufferTokens: number
  readonly keepRecentMessages: number
  readonly maxIncrementalFolds: number
  readonly failureThreshold: number
  readonly breakerCooldownMs: number
}

export interface SummaryRequest {
  /** 这次要折进摘要的消息。增量折叠时只有新增那一段。 */
  readonly messages: readonly CompactionMessage[]
  readonly previousSummary: AgentCompactionNarrative | null
}

export type Summarize = (request: SummaryRequest) => Promise<AgentCompactionNarrative | null>

/** Tier 1 工具结果外置的接缝。本仓库的工具结果是图片 id 与几行元数据，触发不到，故不实现。 */
export type ToolResultOffload = (
  messages: readonly CompactionMessage[],
) => Promise<readonly CompactionMessage[]>

export type CompactionMode = 'none' | 'reuse' | 'incremental' | 'rebuild' | 'truncate'

export interface CompactionResult {
  readonly messages: readonly AgentMessage[]
  readonly state: CompactionState | null
  readonly breaker: CompactionBreaker
  readonly mode: CompactionMode
}

export interface CompactionInput {
  readonly messages: readonly CompactionMessage[]
  readonly state: CompactionState | null
  readonly breaker: CompactionBreaker
  readonly settings: CompactionSettings
  readonly now: number
  readonly summarize: Summarize
  readonly offloadToolResults?: ToolResultOffload
}

export interface CompactionBudget {
  readonly effectiveWindow: number
  readonly threshold: number
}

export function compactionBudget(settings: CompactionSettings): CompactionBudget {
  const reserved = Math.min(settings.maxOutputTokens, settings.outputReserveTokens)
  const effectiveWindow = settings.contextWindow - reserved
  return { effectiveWindow, threshold: effectiveWindow - settings.bufferTokens }
}

const CLOSED_BREAKER: CompactionBreaker = { failureCount: 0, openedAt: null }

function tokensOf(messages: readonly CompactionMessage[]): number {
  return messages.reduce((total, entry) => total + estimateTokens(entry.message), 0)
}

function plain(messages: readonly CompactionMessage[]): AgentMessage[] {
  return messages.map((entry) => entry.message)
}

function isUser(entry: CompactionMessage): boolean {
  return entry.message.role === 'user'
}

function messageText(entry: CompactionMessage): string {
  const message = entry.message
  if (!('content' in message)) return ''
  const content: string | readonly unknown[] = message.content
  if (typeof content === 'string') return content
  return content
    .map((block) => (isObject(block) && typeof block.text === 'string' ? block.text : ''))
    .join('')
}

function anchorMatches(messages: readonly CompactionMessage[], anchor: CompactionAnchor): boolean {
  const covered = anchor.coveredCount
  return (
    covered > 0 && covered <= messages.length && messages[covered - 1]!.id === anchor.lastMessageId
  )
}

/**
 * 切点是第一条保留原文的消息。向前吸附到用户消息边界，工具调用与其结果才不会被拆散；
 * 尾段没有边界时向后吸附——只做向前那一半，整段尾巴会被摘要吃掉。
 */
function cutPoint(
  messages: readonly CompactionMessage[],
  keepRecentMessages: number,
  floor: number,
): number {
  const target = Math.max(floor, messages.length - Math.max(1, keepRecentMessages))
  for (let index = target; index > floor; index -= 1) {
    if (isUser(messages[index]!)) return index
  }
  for (let index = target + 1; index < messages.length; index += 1) {
    if (isUser(messages[index]!)) return index
  }
  return target
}

/** 兜底的纯截尾窗口：至少留最新一条，开头不留工具结果（没有配对的调用，上游会拒）。 */
function trailingWindow(
  messages: readonly CompactionMessage[],
  budget: number,
): CompactionMessage[] {
  let start = messages.length - 1
  let used = estimateTokens(messages[start]!.message)
  while (start > 0) {
    const cost = estimateTokens(messages[start - 1]!.message)
    if (used + cost > budget) break
    start -= 1
    used += cost
  }
  while (start < messages.length - 1 && messages[start]!.message.role === 'toolResult') {
    start += 1
  }
  return messages.slice(start)
}

function section(value: string): string {
  return value.trim() || '（无）'
}

/**
 * 折叠区里的用户消息逐字进摘要，这是硬规定。装不下时最旧的降级为一行占位，
 * 但不许消失——用户看不到自己说过的话被吞掉。
 */
function verbatimSection(covered: readonly CompactionMessage[], budget: number): string {
  const texts = covered.filter(isUser).map(messageText)
  const kept = new Set<number>()
  let used = 0
  for (let index = texts.length - 1; index >= 0; index -= 1) {
    const cost = Math.ceil(texts[index]!.length / 4)
    if (used + cost > budget) break
    used += cost
    kept.add(index)
  }
  return texts
    .map((text, index) =>
      kept.has(index)
        ? `${index + 1}. ${text}`
        : `${index + 1}. [第 ${index + 1} 条用户消息已省略，约 ${text.length} 字]`,
    )
    .join('\n')
}

function summaryMessage(
  narrative: AgentCompactionNarrative,
  covered: readonly CompactionMessage[],
  verbatimBudget: number,
): AgentMessage {
  const text = [
    `# 会话摘要（较早的 ${covered.length} 条消息已折叠，原文仍在用户的历史里）`,
    '',
    '## 已完成',
    section(narrative.completed),
    '',
    '## 进行中',
    section(narrative.inProgress),
    '',
    '## 关键决定与约束',
    section(narrative.decisions),
    '',
    '## 产物',
    section(narrative.artifacts),
    '',
    '## 用户原话（逐字）',
    verbatimSection(covered, verbatimBudget),
  ].join('\n')
  return { role: 'user', content: [{ type: 'text', text }], timestamp: Date.now() }
}

function shaped(
  narrative: AgentCompactionNarrative,
  messages: readonly CompactionMessage[],
  cut: number,
  verbatimBudget: number,
): AgentMessage[] {
  return [
    summaryMessage(narrative, messages.slice(0, cut), verbatimBudget),
    ...plain(messages.slice(cut)),
  ]
}

/** 摘要在、但尾巴仍然超预算时的形状：摘要保住，尾巴截到装得下。 */
function shapedWithinBudget(
  narrative: AgentCompactionNarrative,
  messages: readonly CompactionMessage[],
  cut: number,
  verbatimBudget: number,
  threshold: number,
): AgentMessage[] {
  const summary = summaryMessage(narrative, messages.slice(0, cut), verbatimBudget)
  const tail = messages.slice(cut)
  if (tail.length === 0) return [summary]
  return [summary, ...plain(trailingWindow(tail, threshold - estimateTokens(summary)))]
}

function cooled(
  breaker: CompactionBreaker,
  now: number,
  settings: CompactionSettings,
): CompactionBreaker {
  if (breaker.openedAt === null) return breaker
  return now - breaker.openedAt >= settings.breakerCooldownMs ? CLOSED_BREAKER : breaker
}

function afterFailure(
  breaker: CompactionBreaker,
  now: number,
  settings: CompactionSettings,
): CompactionBreaker {
  const failureCount = breaker.failureCount + 1
  return { failureCount, openedAt: failureCount >= settings.failureThreshold ? now : null }
}

export async function shapeAgentContext(input: CompactionInput): Promise<CompactionResult> {
  const messages = input.offloadToolResults
    ? await input.offloadToolResults(input.messages)
    : input.messages
  const { effectiveWindow, threshold } = compactionBudget(input.settings)
  const verbatimBudget = Math.max(1, Math.floor(effectiveWindow / 4))
  const breaker = cooled(input.breaker, input.now, input.settings)

  if (messages.length === 0 || tokensOf(messages) <= threshold) {
    return { messages: plain(messages), state: input.state, breaker, mode: 'none' }
  }

  // 锚点失配等同于没有摘要：继续用它会把中间被删的内容永久冻在摘要里。
  const state = input.state && anchorMatches(messages, input.state.anchor) ? input.state : null

  const fallback = (next: CompactionBreaker): CompactionResult =>
    state
      ? {
          messages: shapedWithinBudget(
            state.narrative,
            messages,
            state.anchor.coveredCount,
            verbatimBudget,
            threshold,
          ),
          state,
          breaker: next,
          mode: 'reuse',
        }
      : {
          messages: plain(trailingWindow(messages, threshold)),
          state: input.state,
          breaker: next,
          mode: 'truncate',
        }

  if (breaker.openedAt !== null) return fallback(breaker)

  if (state) {
    const reused = shaped(state.narrative, messages, state.anchor.coveredCount, verbatimBudget)
    if (reused.reduce((total, message) => total + estimateTokens(message), 0) <= threshold) {
      return { messages: reused, state, breaker, mode: 'reuse' }
    }
  }

  const floor = state ? state.anchor.coveredCount : 0
  const cut = cutPoint(messages, input.settings.keepRecentMessages, floor)
  if (cut <= floor) return fallback(breaker)

  const incremental = state !== null && state.foldCount < input.settings.maxIncrementalFolds
  const narrative = await input.summarize({
    messages: messages.slice(incremental ? floor : 0, cut),
    previousSummary: incremental && state ? state.narrative : null,
  })
  if (!narrative) return fallback(afterFailure(breaker, input.now, input.settings))

  return {
    messages: shaped(narrative, messages, cut, verbatimBudget),
    state: {
      narrative,
      anchor: { lastMessageId: messages[cut - 1]!.id, coveredCount: cut },
      foldCount: incremental && state ? state.foldCount + 1 : 0,
    },
    breaker: CLOSED_BREAKER,
    mode: incremental ? 'incremental' : 'rebuild',
  }
}
