import { type AgentMessage, estimateContextTokens } from '@earendil-works/pi-agent-core'
import { contentText } from '@earendil-works/pi-ai'
import type { AgentCompactionNarrative } from '@image-playground/shared'
import { estimateMessageTokens } from './token-estimate'

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
  /** 摘要里逐字保留用户原话的 token 上限，超出的最旧几条降级为占位。 */
  readonly verbatimTokens: number
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
  /**
   * 这一轮请求里不由消息承担的那部分：系统说明与工具清单（见 `request-budget.ts`）。
   * 塑形只管得着消息，可闸门管的是整份请求，所以消息能占的预算要先把它让出来。
   */
  readonly overheadTokens: number
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

/**
 * 这段上下文此刻有多大 —— 压缩的触发判据。
 *
 * 锚点来自 pi 的 `estimateContextTokens`：最后一条带上游真实用量的助手消息，那个数是上游
 * 用自己的分词器数的**整份请求**，系统说明、工具清单、图片都已经在里面。我们自己按字符数
 * 是数不出这些的（这个部署光系统说明加工具声明就实测 3.3k），所以这个锚补的正是我们一直
 * 看不见的那部分。锚之后新追加的消息没有对应用量，只能估。
 *
 * 但锚只能当**下界**用，不能直接替掉字符估算，理由有二：
 * - 上游报的是上一份请求，这一份追加了什么它不知道；
 * - 我们的估算器对中文另有校正（见 `token-estimate.ts`），pi 内部那个 `ceil(chars/4)` 会
 *   把中文历史数得偏小。真让它当唯一判据，就会出现「压缩说不用压、出站硬闸说发不出去」
 *   的死角——那一轮直接以「内容太长」收场，而它本来是压一下就能发的。
 *
 * 所以两个口径取大的：谁说它更大就听谁的。硬闸量的是字符估算那一路，这样触发判据永远不会
 * 比硬闸松。
 */
export function contextSizeTokens(
  messages: readonly AgentMessage[],
  overheadTokens: number,
): number {
  const estimated = overheadTokens + tokensOf(messages)
  const { usageTokens, lastUsageIndex } = estimateContextTokens([...messages])
  if (lastUsageIndex === null) return estimated
  return Math.max(usageTokens + tokensOf(messages.slice(lastUsageIndex + 1)), estimated)
}

/**
 * 起轮前按 token 预扣时的上限。压缩保证真正送出去的输入不超过阈值，所以再长的历史
 * 也不该按原样预扣——问的是压缩，不是把整个 budget 借出去自己挑一项。
 */
export function reservationCeiling(settings: CompactionSettings): number {
  return compactionBudget(settings).threshold
}

/**
 * 消息能占的那一份：整份请求的上限先让出固定开销（系统说明与工具清单，见 `request-budget.ts`）。
 *
 * 塑形与兜底截尾必须按同一个数来，否则「兜底也不超阈值」这句话不成立，所以只此一处。
 * 开销自己就把上限吃光时留一个最小正数：塑形照样收敛到最新那一条，超不超交给出站硬闸判。
 */
export function messageBudget(settings: CompactionSettings, overheadTokens: number): number {
  return Math.max(1, compactionBudget(settings).threshold - overheadTokens)
}

const CLOSED_BREAKER: CompactionBreaker = { failureCount: 0, openedAt: null }

/** 这个钩子每次模型请求都跑一遍，而前缀逐字节不变；不记住就每次重扫整段历史。 */
const tokenCache = new WeakMap<AgentMessage, number>()

function tokens(message: AgentMessage): number {
  const cached = tokenCache.get(message)
  if (cached !== undefined) return cached
  const estimated = estimateMessageTokens(message)
  tokenCache.set(message, estimated)
  return estimated
}

function tokensOf(messages: readonly AgentMessage[]): number {
  return messages.reduce((total, message) => total + tokens(message), 0)
}

function plain(messages: readonly CompactionMessage[]): AgentMessage[] {
  return messages.map((entry) => entry.message)
}

function isUser(entry: CompactionMessage): boolean {
  return entry.message.role === 'user'
}

function messageText(entry: CompactionMessage): string {
  const message = entry.message
  return 'content' in message ? contentText(message.content, '') : ''
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

/**
 * 兜底的纯截尾窗口：至少留最新一条，开头不留工具结果（没有配对的调用，上游会拒）。
 *
 * 整条压缩路径出岔子时也走它（`compaction-transform.ts` 的 catch），理由只有一个：
 * **摘要失败不能回退成发完整历史**——那一刻历史正是最长的那一份（#400 验收第 2 条）。
 * 连一条都装不下时仍留最新那条：什么都不发这一轮就没法推进，超不超由出站硬闸最后判。
 */
export function truncateToBudget(
  messages: readonly AgentMessage[],
  budget: number,
): AgentMessage[] {
  if (messages.length === 0) return []
  let start = messages.length - 1
  let used = tokens(messages[start]!)
  while (start > 0) {
    const cost = tokens(messages[start - 1]!)
    if (used + cost > budget) break
    start -= 1
    used += cost
  }
  while (start < messages.length - 1 && messages[start]!.role === 'toolResult') {
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
  const users = covered.filter(isUser)
  const texts = users.map(messageText)
  const kept = new Set<number>()
  let used = 0
  for (let index = texts.length - 1; index >= 0; index -= 1) {
    const cost = tokens(users[index]!.message)
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
/**
 * 预算容不下的那几条近期消息：位置上留一行，模型才知道这里断过，而不是以为衔接完好。
 * 它们没丢——下一轮的增量折叠会把它们折进摘要，用户的历史里也一直都在。
 */
function gapNote(count: number): AgentMessage {
  const text = `[这里有 ${count} 条消息因长度没有随本次请求发出；需要时向用户确认，不要凭空假设]`
  return { role: 'user', content: [{ type: 'text', text }], timestamp: Date.now() }
}

/** 占位那一行自己也占预算。它的长度只随条数的位数变，按一条代表性的预留就够。 */
const GAP_NOTE_TOKENS = tokens(gapNote(0))

/**
 * 摘要 + 尾巴，整体收进预算。
 *
 * 尾巴按预算从最旧的一头裁起——摘要覆盖的是折叠区，裁尾巴丢的是较早的近期消息，代价最小。
 * 以前新折出来的摘要这一支不校验，理由是「裁掉尾巴就等于两边都没有」，可那样一来它是整条
 * 路径上唯一能吐出超预算结果的地方，出站硬闸只能把整轮拒掉（#400 验收第 2 条）。
 * 真裁到了就留一行占位：被裁的那几条既不在摘要里也不在尾巴里，不能无声消失（验收第 4 条）。
 */
function shaped(
  summary: AgentMessage,
  tail: readonly CompactionMessage[],
  tailBudget: number,
): AgentMessage[] {
  if (tail.length === 0) return [summary]
  const budget = tailBudget - tokens(summary)
  const whole = truncateToBudget(plain(tail), budget)
  if (whole.length === tail.length) return [summary, ...whole]
  const kept = truncateToBudget(plain(tail), budget - GAP_NOTE_TOKENS)
  return [summary, gapNote(tail.length - kept.length), ...kept]
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
  const messages = input.messages
  const { threshold: limit } = compactionBudget(input.settings)
  // 塑形时逐条数消息，所以它的预算要先让出固定开销（系统说明与工具清单）。
  const threshold = messageBudget(input.settings, input.overheadTokens)
  const breaker = cooled(input.breaker, input.now, input.settings)

  // 要不要压缩，问的是「这段上下文此刻多大」，按整份请求的上限判（`contextSizeTokens`
  // 已经把固定开销算在内，不像下面的 threshold 要先减掉）。
  if (messages.length === 0 || contextSizeTokens(plain(messages), input.overheadTokens) <= limit) {
    return { messages: plain(messages), state: input.state, breaker, mode: 'none' }
  }

  // 锚点失配等同于没有摘要：继续用它会把中间被删的内容永久冻在摘要里。
  const state = input.state && anchorMatches(messages, input.state.anchor) ? input.state : null
  const covered = state ? state.anchor.coveredCount : 0
  const reusedSummary = state
    ? summaryMessage(state.narrative, messages.slice(0, covered), input.settings.verbatimTokens)
    : null

  const fallback = (next: CompactionBreaker): CompactionResult =>
    state && reusedSummary
      ? {
          messages: shaped(reusedSummary, messages.slice(covered), threshold),
          state,
          breaker: next,
          mode: 'reuse',
        }
      : {
          messages: truncateToBudget(plain(messages), threshold),
          state: input.state,
          breaker: next,
          mode: 'truncate',
        }

  if (breaker.openedAt !== null) return fallback(breaker)

  // 复用旧摘要这一支先按不裁尾巴试一次：装得下就原样用，保住完整的近期原文窗口。
  if (state && reusedSummary) {
    const reused = [reusedSummary, ...plain(messages.slice(covered))]
    if (tokensOf(reused) <= threshold) {
      return { messages: reused, state, breaker, mode: 'reuse' }
    }
  }

  const cut = cutPoint(messages, input.settings.keepRecentMessages, covered)
  if (cut <= covered) return fallback(breaker)

  // 折叠满次数就丢开旧摘要从头重做，免得增量摘要一路失真下去。
  const previous = state && state.foldCount < input.settings.maxIncrementalFolds ? state : null
  // TODO(#400)：摘要请求自己也是一次出站，折叠区却没有上限——长会话下它发的正是最长的那段
  // 前缀。这里不能简单按预算截断：切点要与 `cutPoint` 一样吸附到用户消息边界，否则会把
  // 工具调用与它的结果拆开。留给下一票与有界历史查询一起做。

  const narrative = await input.summarize({
    messages: messages.slice(previous ? covered : 0, cut),
    previousSummary: previous ? previous.narrative : null,
  })
  if (!narrative) return fallback(afterFailure(breaker, input.now, input.settings))

  const summary = summaryMessage(narrative, messages.slice(0, cut), input.settings.verbatimTokens)
  return {
    messages: shaped(summary, messages.slice(cut), threshold),
    state: {
      narrative,
      anchor: { lastMessageId: messages[cut - 1]!.id, coveredCount: cut },
      foldCount: previous ? previous.foldCount + 1 : 0,
    },
    breaker: CLOSED_BREAKER,
    mode: previous ? 'incremental' : 'rebuild',
  }
}
