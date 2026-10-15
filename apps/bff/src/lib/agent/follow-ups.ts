import { type AgentMessageView, agentMessageText } from '@image-playground/shared'
import { and, desc, eq } from 'drizzle-orm'
import { config } from '../../config'
import { db, schema } from '../../db/client'
import { askChatModel, ChatTimeoutError, isTransientChatError } from '../chatCompletion'
import { log } from '../logger'
import { isObject } from '../type-guards'

/**
 * 中文一句加上 Haiku 的思考会顶满旧的 180：线上 claude-haiku-5-5 以
 * finish_reason=length 把句子截断。400 留给思考和这一句 JSON。
 */
const FOLLOW_UP_MAX_TOKENS = 400
/**
 * 线上小模型也经常要 15 秒以上才答完，15 秒的 deadline 会把还在写的下一句切成超时。
 * 单次给 30 秒。超时和瞬时故障再试一次，两次就是上限，不再往上加。
 */
const FOLLOW_UP_TIMEOUT_MS = 30_000
const FOLLOW_UP_ATTEMPTS = 2
/** 第一次超时后稍等再问，避免立刻撞上同一次拥塞。测试可以收成 0。 */
const FOLLOW_UP_RETRY_DELAY_MS = 500
const FOLLOW_UP_INPUT_CHARS = 2_000
const FOLLOW_UP_CONTEXT_CHARS = 1_500
const FOLLOW_UP_MAX_CHARS = 80
/** 模型可以多写，只留第一句：那是概率最高的预测。 */
const FOLLOW_UP_PREDICT_LINES = 1
/** 读旧行时仍认以前写下的两三句，界面只用第一句。 */
const FOLLOW_UP_MAX_LINES = 3
const EMPTY_ASSISTANT = '（这一轮没有文字回复）'
const EMPTY_CONTEXT = '（没有更早的对话）'

export interface FollowUpSource {
  readonly userText: string
  readonly assistantText: string
  /** 这一轮助手回复之外的近几句，按时间排，带「用户：」「助手：」。可空。 */
  readonly recentContext?: string
}

type FollowUpAsk = (prompt: string) => Promise<unknown>

function clip(text: string): string {
  const trimmed = text.trim()
  return trimmed.length <= FOLLOW_UP_INPUT_CHARS ? trimmed : trimmed.slice(0, FOLLOW_UP_INPUT_CHARS)
}

function tailClip(text: string, max = FOLLOW_UP_CONTEXT_CHARS): string {
  const trimmed = text.trim()
  return trimmed.length <= max ? trimmed : trimmed.slice(trimmed.length - max)
}

/**
 * 这一轮里最后一句用户的话、最后一段助手文字，以及这段回复之外的近几句。
 * 这一轮没有用户原话时用户那侧是空的。
 */
export function followUpTexts(messages: readonly AgentMessageView[]): FollowUpSource {
  const lines: { role: 'user' | 'assistant'; text: string }[] = []
  for (const message of [...messages].sort((a, b) => a.createdAt - b.createdAt)) {
    if (message.role !== 'user' && message.role !== 'assistant') continue
    const text = agentMessageText(message).trim()
    if (!text) continue
    lines.push({ role: message.role, text })
  }
  let assistantAt = -1
  let userText = ''
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]
    if (!line) continue
    if (assistantAt < 0 && line.role === 'assistant') assistantAt = index
    if (!userText && line.role === 'user') userText = line.text
  }
  const recentContext = lines
    .filter((_, index) => index !== assistantAt)
    .map((line) => `${line.role === 'user' ? '用户' : '助手'}：${line.text}`)
    .join('\n')
  return {
    userText,
    assistantText: assistantAt >= 0 ? (lines[assistantAt]?.text ?? '') : '',
    recentContext: tailClip(recentContext),
  }
}

/** 这一轮自己带了用户原话才返回。出图后的复查没有新的用户消息，调用方再去会话里找上一句。 */
export function followUpSource(messages: readonly AgentMessageView[]): FollowUpSource | null {
  const texts = followUpTexts(messages)
  if (!texts.userText) return null
  return texts
}

export function followUpPrompt(source: FollowUpSource): string {
  return [
    '你在预测用户接下来最可能原样打进输入框的那一句。',
    '依据是这一轮助手的回复，以及最近的对话。',
    '只输出 JSON：{"lines":["..."]}',
    '规则：',
    '- 只写一句，就是用户最可能打的那一句。',
    '- 用用户的口吻、第一人称，写成可以直接发出去的话。',
    '- 用用户上一条消息的语言写。',
    '- 短。中文尽量不超过 40 个字；任何语言都不要超过 80 个字符。',
    '- 助手如果在问参数、选择或确认，就用合理的具体取值直接回答，不要反问。',
    '- 下一步很明显时，写成那条指令。',
    '- 不要写成助手的提问、建议清单或短标签。',
    '- 不要重复用户刚说的那一句。',
    '- 不要解释，不要编号。',
    '',
    '最近的对话：',
    source.recentContext?.trim() || EMPTY_CONTEXT,
    '',
    '这一轮助手刚回复：',
    source.assistantText,
  ].join('\n')
}

/** 丢掉空句、重复、超长和用户刚说过的那句。只留第一句可用的预测。 */
export function normalizeFollowUpLines(value: unknown, blocked = ''): readonly string[] {
  if (!isObject(value) || !Array.isArray(value.lines)) return []
  const skip = blocked.trim()
  const seen = new Set<string>()
  const lines: string[] = []
  for (const item of value.lines) {
    if (typeof item !== 'string') continue
    const line = item.trim()
    if (!line || line === skip || line.length > FOLLOW_UP_MAX_CHARS || seen.has(line)) continue
    seen.add(line)
    lines.push(line)
    if (lines.length === FOLLOW_UP_PREDICT_LINES) break
  }
  return lines
}

async function askFollowUpModel(prompt: string, userText: string): Promise<unknown> {
  return askChatModel(
    {
      model: config.agent.followUpModel,
      prompt,
      maxTokens: FOLLOW_UP_MAX_TOKENS,
      timeoutMs: FOLLOW_UP_TIMEOUT_MS,
      // Luna can finish with plain text despite the prompt; require JSON on the wire too.
      responseFormat: 'json_object',
    },
    (value) => (normalizeFollowUpLines(value, userText).length > 0 ? value : null),
  )
}

let followUpRetryDelayMs = FOLLOW_UP_RETRY_DELAY_MS

/** 测试把重试前的等待收成 0。不传则恢复生产值。 */
export function setFollowUpRetryDelayForTesting(delayMs?: number): void {
  followUpRetryDelayMs = delayMs ?? FOLLOW_UP_RETRY_DELAY_MS
}

/** 测试锁住预算，避免超时又被改回 15 秒或重试变成循环。 */
export function followUpLimitsForTesting(): {
  readonly timeoutMs: number
  readonly attempts: number
} {
  return { timeoutMs: FOLLOW_UP_TIMEOUT_MS, attempts: FOLLOW_UP_ATTEMPTS }
}

/**
 * askChatModel 不重试自己的 deadline：那会把还在跑的主轮拖长。
 * 下一句在终帧之后，主轮已经结束，超时再问一次不会挡住用户。
 * 配额耗尽、答歪、本地预算拒绝都不算瞬时故障，重试只是再撞一次墙。
 */
function isFollowUpRetryable(err: unknown): boolean {
  if (err instanceof ChatTimeoutError) return true
  return isTransientChatError(err, config.agent.followUpModel)
}

function retryPause(): Promise<void> {
  if (followUpRetryDelayMs <= 0) return Promise.resolve()
  return new Promise((resolve) => setTimeout(resolve, followUpRetryDelayMs))
}

/** 最多两次。列在两次都结束前保持 null，调用方据此把「还在问」和「问完是空的」分开。 */
async function askFollowUps(ask: FollowUpAsk, prompt: string): Promise<unknown> {
  let lastError: unknown
  for (let attempt = 1; attempt <= FOLLOW_UP_ATTEMPTS; attempt += 1) {
    try {
      return await ask(prompt)
    } catch (err) {
      lastError = err
      if (attempt >= FOLLOW_UP_ATTEMPTS || !isFollowUpRetryable(err)) throw err
      log.warn({ event: 'agent.follow_ups_retry', attempt, err }, 'follow-up suggestion retried')
      await retryPause()
    }
  }
  throw lastError
}

/**
 * 用小模型预测用户最可能打的下一句。单次最多 30 秒，超时或瞬时故障再试一次，
 * 总次数有界。失败或答不出一句都是空数组：主轮已经结束，这里不能再抛。
 */
export async function suggestFollowUps(
  source: FollowUpSource,
  ask?: FollowUpAsk,
): Promise<readonly string[]> {
  const userText = clip(source.userText)
  if (!userText) return []
  const assistantText = clip(source.assistantText) || EMPTY_ASSISTANT
  const prompt = followUpPrompt({
    userText,
    assistantText,
    recentContext: tailClip(source.recentContext ?? ''),
  })
  try {
    const value = await askFollowUps(
      ask ?? ((next: string) => askFollowUpModel(next, userText)),
      prompt,
    )
    return normalizeFollowUpLines(value, userText)
  } catch (err) {
    log.warn({ event: 'agent.follow_ups_failed', err }, 'follow-up suggestions were not generated')
    return []
  }
}

/** 只更新这一列。页脚重写走另一条 upsert，不能把已经写好的句子清掉。匹配不到行就作罢。 */
export async function recordAgentFollowUps(
  conversationId: string,
  turnId: string,
  lines: readonly string[],
): Promise<void> {
  await db
    .update(schema.agent_turns)
    .set({ follow_ups: [...lines] })
    .where(
      and(
        eq(schema.agent_turns.conversation_id, conversationId),
        eq(schema.agent_turns.turn_id, turnId),
      ),
    )
}

/**
 * null：还在问，句子还没写上。调用方继续等。
 * 空数组：问完了但没有句子，或这一轮的行不在。这是终态，调用方不用再等。
 * 非空数组：可以显示的句子。
 */
export async function readAgentFollowUps(
  conversationId: string,
  turnId: string,
): Promise<readonly string[] | null> {
  const [row] = await db
    .select({ followUps: schema.agent_turns.follow_ups })
    .from(schema.agent_turns)
    .where(
      and(
        eq(schema.agent_turns.conversation_id, conversationId),
        eq(schema.agent_turns.turn_id, turnId),
      ),
    )
    .limit(1)
  if (!row) return []
  if (row.followUps == null) return null
  if (!Array.isArray(row.followUps)) return []
  return row.followUps
    .filter((line): line is string => typeof line === 'string' && line.trim() !== '')
    .slice(0, FOLLOW_UP_MAX_LINES)
}

/**
 * 终帧之后再问，不进这一轮的账单，也不挡终帧。调用方不要 await。
 * 问完才落库：超时或瞬时故障最多再试一次，两次都失败才写成空数组。
 * 写成空数组也算问过。问的过程中列保持 null，读接口据此区分还在等和已经没有。
 */
export function scheduleAgentFollowUps(
  input: {
    readonly conversationId: string
    readonly turnId: string
    readonly messages: readonly AgentMessageView[]
  },
  ask?: FollowUpAsk,
): void {
  const write = (lines: readonly string[]) => {
    void recordAgentFollowUps(input.conversationId, input.turnId, lines).catch((err) => {
      log.warn(
        { event: 'agent.follow_ups_failed', turnId: input.turnId, err },
        'follow-up suggestions were not stored',
      )
    })
  }
  const draft = followUpTexts(input.messages)
  void (async () => {
    // 出图完成后的复查往往只有助手的话。沿用会话里上一句用户的话，否则预测没有口吻可跟。
    let userText = draft.userText
    let recentContext = draft.recentContext ?? ''
    if (!userText) {
      try {
        userText = await previousUserText(input.conversationId)
      } catch (err) {
        log.warn(
          { event: 'agent.follow_ups_failed', turnId: input.turnId, err },
          'follow-up suggestions were not generated',
        )
        write([])
        return
      }
      if (userText) {
        recentContext = tailClip(
          [`用户：${userText}`, recentContext].filter((part) => part.trim()).join('\n'),
        )
      }
    }
    if (!userText) {
      write([])
      return
    }
    // bun test 会把 NODE_ENV 设成 test。没注入 ask 就不问模型：别的用例把同一条 chat fetch
    // 当成自己的计数器，旁路再打一次会把次数和重试预算打乱。列保持 null，那些用例不用认识它。
    if (!ask && process.env.NODE_ENV === 'test') return
    write(
      await suggestFollowUps({ userText, assistantText: draft.assistantText, recentContext }, ask),
    )
  })()
}

/** 会话里最近一句用户的话。这一轮自己没有时用它。 */
async function previousUserText(conversationId: string): Promise<string> {
  const [row] = await db
    .select({ content: schema.agent_messages.content })
    .from(schema.agent_messages)
    .where(
      and(
        eq(schema.agent_messages.conversation_id, conversationId),
        eq(schema.agent_messages.role, 'user'),
      ),
    )
    .orderBy(desc(schema.agent_messages.created_at))
    .limit(1)
  if (!row) return ''
  return agentMessageText({
    id: '',
    turnId: '',
    role: 'user',
    content: row.content,
    createdAt: 0,
  }).trim()
}
