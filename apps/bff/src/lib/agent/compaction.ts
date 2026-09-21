import { type AgentMessage, estimateContextTokens } from '@earendil-works/pi-agent-core'
import { contentText } from '@earendil-works/pi-ai'
import type {
  AgentCompactionNarrative,
  AgentCompactionRecord,
  AgentCompactionVerbatim,
} from '@image-playground/shared'
import { estimateMessageTokens } from './token-estimate'

/**
 * 上下文压缩：消息与状态进，塑形后的消息与新状态出。纯模块，不碰数据库也不发请求——
 * 摘要调用由外部注入，四态才能直接测。
 *
 * `messages` 是**锚点之后**那一段，不是整段历史：更早的已经折进摘要，存储层根本不会把它们
 * 读出来（#708）。锚点本身归存储层校验，走到这里的 `state` 一定是可以直接用的。
 */

/** 压缩只塑造送给模型的输入，`id` 是消息在存储里的身份，落回锚点时要用。 */
export interface CompactionMessage {
  readonly id: string
  readonly message: AgentMessage
}

/**
 * 折叠区里用户原话的存档：逐字保留最近几条，更早的只留条数与字数。
 *
 * 不从原文重建，因为原文可能已经不在这一份历史里了。装不下时永远丢最旧的，被省略的
 * 因此必然是连续的一截前缀，一个计数加一个字数就说得清。
 */
export type CompactionVerbatim = AgentCompactionVerbatim

export interface CompactionState {
  readonly narrative: AgentCompactionNarrative
  readonly verbatim: CompactionVerbatim
  /** `messages` 里前多少条已经折进摘要。锚点之前那些不算在内，它们由 `foldedBefore` 记。 */
  readonly foldedHere: number
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
  /** 近期原文保留多少 token；切点按它从最新一条往回收。 */
  readonly keepRecentTokens: number
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

/**
 * 这一轮做了什么。`none` 是「没有新折任何东西」——已经存在的摘要仍照常排在上下文最前，
 * 那不是这一轮的压缩动作，不该计进 `agent.compacted`。
 */
export type CompactionMode = 'none' | 'reuse' | 'incremental' | 'rebuild' | 'truncate'

export interface CompactionResult {
  readonly messages: readonly AgentMessage[]
  readonly state: CompactionState | null
  readonly breaker: CompactionBreaker
  readonly mode: CompactionMode
}

export interface CompactionInput {
  /** 锚点之后的那一段历史，加上本轮新生成的消息。 */
  readonly messages: readonly CompactionMessage[]
  /**
   * 更早折进摘要、这一份 `messages` 里根本没有的条数。摘要标题上的总数要算上它，
   * 否则模型以为只折了眼前这些。
   */
  readonly foldedBefore: number
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

/**
 * 切点是第一条保留原文的消息。
 *
 * 按 token 预算从最新一条往回收，不按条数：一条消息可能 1 token 也可能 1 万，我们这边
 * 图片、工具结果与短对话混在一起，尺寸波动正是常态，按条数取出来的那一刀落在哪儿全看运气。
 * 这也是 pi 的口径（`keepRecentTokens`）。
 *
 * 至少留最新一条：预算连它都装不下时也不能什么都不留，那一轮就没法推进了。
 * 再向前吸附到用户消息边界，工具调用与其结果才不会被拆散；尾段没有边界时向后吸附——
 * 只做向前那一半，整段尾巴会被摘要吃掉。
 */
function cutPoint(
  messages: readonly CompactionMessage[],
  keepRecentTokens: number,
  floor: number,
): number {
  let target = messages.length - 1
  // 最新那条自己也占预算。它超了也留：什么都不留这一轮就没法推进，超不超由出站硬闸最后判。
  let used = tokens(messages[target]!.message)
  while (target > floor) {
    const cost = tokens(messages[target - 1]!.message)
    if (used + cost > keepRecentTokens) break
    used += cost
    target -= 1
  }
  for (let index = target; index > floor; index -= 1) {
    if (isUser(messages[index]!)) return index
  }
  for (let index = target + 1; index < messages.length; index += 1) {
    if (isUser(messages[index]!)) return index
  }
  return target
}

/**
 * 折叠区按预算切成几段，逐段折叠。
 *
 * 摘要请求自己也是一次出站，可折叠区从来没有上限——长会话第一次重建时，它发的正是整段
 * 历史，比任何一次智能体请求都长。按预算从前面截掉不行：截掉的那截既不在摘要里也不在
 * 尾巴里，用户说过的话会无声消失。所以改成分段，每一段带上一段的摘要往下传（复用已有的
 * `previousSummary` 通道），内容一点不丢，每一次请求都有界。
 *
 * 段界向前吸附到用户消息，与 `cutPoint` 同一条规矩：一段里不出现没有调用的工具结果。
 * 单独一条就超预算时自成一段——再切也没用，那一份超不超由上游说了算。
 */
function foldChunks(
  region: readonly CompactionMessage[],
  budget: number,
): readonly CompactionMessage[][] {
  const chunks: CompactionMessage[][] = []
  let start = 0
  while (start < region.length) {
    let end = start + 1
    let used = tokens(region[start]!.message)
    while (end < region.length) {
      const cost = tokens(region[end]!.message)
      if (used + cost > budget) break
      used += cost
      end += 1
    }
    if (end < region.length) {
      // 吸附：段界落在用户消息上，下一段就从一轮对话的开头起。吸不到就按原样切，
      // 不然这一段会一路吞到底，分段等于没做。
      for (let at = end; at > start + 1; at -= 1) {
        if (isUser(region[at]!)) {
          end = at
          break
        }
      }
    }
    chunks.push(region.slice(start, end))
    start = end
  }
  return chunks
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

/** 逐字那一节自己也占预算，所以按同一个估算器量它，而不是数字符。 */
function verbatimCost(text: string): number {
  return tokens({ role: 'user', content: [{ type: 'text', text }], timestamp: 0 })
}

const EMPTY_VERBATIM: CompactionVerbatim = { omittedCount: 0, omittedChars: 0, kept: [] }

/**
 * 把新折进去的用户原话并进存档，超预算的从最旧的一头让位。
 *
 * 让位的只记条数与字数，不记正文——正文一直在用户自己的历史里，模型需要时问用户即可。
 * 永远从最旧的丢，所以被省略的始终是连续的一截前缀，存档因此有界（#708）。
 */
function extendVerbatim(
  previous: CompactionVerbatim,
  folded: readonly CompactionMessage[],
  budget: number,
): CompactionVerbatim {
  const texts = [...previous.kept, ...folded.filter(isUser).map(messageText)]
  let used = 0
  let from = texts.length
  while (from > 0) {
    const cost = verbatimCost(texts[from - 1]!)
    if (used + cost > budget) break
    used += cost
    from -= 1
  }
  const dropped = texts.slice(0, from)
  return {
    omittedCount: previous.omittedCount + dropped.length,
    omittedChars: previous.omittedChars + dropped.reduce((total, text) => total + text.length, 0),
    kept: texts.slice(from),
  }
}

/**
 * 折叠区里的用户消息逐字进摘要，这是硬规定。装不下的最旧几条降级为一行占位，
 * 但不许消失——用户看不到自己说过的话被吞掉。
 */
function verbatimSection(verbatim: CompactionVerbatim): string {
  const omitted =
    verbatim.omittedCount > 0
      ? [`[最早的 ${verbatim.omittedCount} 条用户消息已省略，约 ${verbatim.omittedChars} 字]`]
      : []
  const kept = verbatim.kept.map((text, index) => `${verbatim.omittedCount + index + 1}. ${text}`)
  return [...omitted, ...kept].join('\n') || '（无）'
}

function summaryMessage(
  narrative: AgentCompactionNarrative,
  verbatim: CompactionVerbatim,
  foldedCount: number,
): AgentMessage {
  const text = [
    `# 会话摘要（较早的 ${foldedCount} 条消息已折叠，原文仍在用户的历史里）`,
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
    verbatimSection(verbatim),
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

/**
 * 存档下来的那份摘要发出去有多大。
 *
 * 它永远排在上下文最前（见 `shapeAgentContext`），可 `messages` 里没有它。预扣估算不算上
 * 这一块，压缩过的会话就会系统性少扣——历史越长少扣得越多，正好反了。
 */
export function storedSummaryTokens(record: AgentCompactionRecord): number {
  if (!record.summary || !record.verbatim) return 0
  return tokens(summaryMessage(record.summary, record.verbatim, record.anchor?.coveredCount ?? 0))
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

  // 锚点归存储层校验（`listAgentHistoryWindow`）：只比 id 认不出中间某条被删，那边是拿
  // 活着的条数对的。走到这里的 state 已经可以直接用。
  const state = input.state
  const covered = state ? state.foldedHere : 0
  // 摘要不是「超预算才加」的补丁，而是这一份上下文的开头。锚点之前的原文根本没读出来
  // （#708），不带上它，一个压缩过的会话只要这一轮装得下就会静默丢掉早先的全部上下文。
  const reusedSummary = state
    ? summaryMessage(state.narrative, state.verbatim, input.foldedBefore + covered)
    : null
  const tail = messages.slice(covered)
  const base = reusedSummary ? [reusedSummary, ...plain(tail)] : plain(tail)

  // 要不要再折一次，问的是「这段上下文此刻多大」，按整份请求的上限判（`contextSizeTokens`
  // 已经把固定开销算在内，不像上面的 threshold 要先减掉）。
  if (base.length === 0 || contextSizeTokens(base, input.overheadTokens) <= limit) {
    return { messages: base, state, breaker, mode: 'none' }
  }

  const fallback = (next: CompactionBreaker): CompactionResult =>
    reusedSummary
      ? { messages: shaped(reusedSummary, tail, threshold), state, breaker: next, mode: 'reuse' }
      : {
          messages: truncateToBudget(plain(messages), threshold),
          state: input.state,
          breaker: next,
          mode: 'truncate',
        }

  if (breaker.openedAt !== null) return fallback(breaker)

  const cut = cutPoint(messages, input.settings.keepRecentTokens, covered)
  if (cut <= covered) return fallback(breaker)

  // 折叠满次数就丢开旧摘要从头重做，免得增量摘要一路失真下去。但这只在整段历史都还在
  // 窗口里时办得到：锚点之前的原文已经读不回来了（#708），那时「重做」等于连同它们的
  // 摘要一起丢掉——宁可让增量继续失真，也不能把用户早先说过的话整段抹了。
  const rebuildable = input.foldedBefore === 0
  const previous =
    state && (!rebuildable || state.foldCount < input.settings.maxIncrementalFolds) ? state : null
  // 摘要请求也是一次出站，按智能体那份请求的同一条上限量它：折叠区超了就分段，
  // 每一段带上一段的摘要往下传，内容不丢而每一次请求都有界。
  const folded = messages.slice(previous ? covered : 0, cut)
  const chunks = foldChunks(folded, compactionBudget(input.settings).threshold)
  let narrative = previous ? previous.narrative : null
  for (const chunk of chunks) {
    const next = await input.summarize({ messages: chunk, previousSummary: narrative })
    // 中途哪一段没折成就整体作废：半截摘要盖不住整个折叠区，用它会把没摘到的内容丢掉。
    if (!next) return fallback(afterFailure(breaker, input.now, input.settings))
    narrative = next
  }
  // `cut > covered` 已经保过折叠区非空，所以上面至少折了一段。这一行只为收敛类型，
  // 走到它说明前面的不变量破了——那不是摘要失败，不该记进熔断器。
  if (!narrative) return fallback(breaker)

  // 重做时旧存档一并作废：它覆盖的那些消息这一次会从头折一遍，留着会把同一句记两遍。
  const verbatim = extendVerbatim(
    previous ? previous.verbatim : EMPTY_VERBATIM,
    folded,
    input.settings.verbatimTokens,
  )
  const summary = summaryMessage(narrative, verbatim, input.foldedBefore + cut)
  return {
    messages: shaped(summary, messages.slice(cut), threshold),
    state: {
      narrative,
      verbatim,
      foldedHere: cut,
      foldCount: previous ? previous.foldCount + 1 : 0,
    },
    breaker: CLOSED_BREAKER,
    mode: previous ? 'incremental' : 'rebuild',
  }
}
