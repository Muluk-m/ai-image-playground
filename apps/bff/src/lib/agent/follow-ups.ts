import { type AgentMessageView, agentMessageText } from '@image-playground/shared'
import { and, desc, eq } from 'drizzle-orm'
import { config } from '../../config'
import { db, schema } from '../../db/client'
import { askChatModel } from '../chatCompletion'
import { log } from '../logger'
import { isObject } from '../type-guards'

const FOLLOW_UP_MAX_TOKENS = 180
const FOLLOW_UP_TIMEOUT_MS = 15_000
const FOLLOW_UP_INPUT_CHARS = 2_000
const FOLLOW_UP_MAX_CHARS = 80
const FOLLOW_UP_MIN_LINES = 2
const FOLLOW_UP_MAX_LINES = 3
const EMPTY_ASSISTANT = '（这一轮没有文字回复）'

export interface FollowUpSource {
  readonly userText: string
  readonly assistantText: string
}

type FollowUpAsk = (prompt: string) => Promise<unknown>

function clip(text: string): string {
  const trimmed = text.trim()
  return trimmed.length <= FOLLOW_UP_INPUT_CHARS ? trimmed : trimmed.slice(0, FOLLOW_UP_INPUT_CHARS)
}

/** 这一轮里最后一句用户的话，和最后一段助手文字。这一轮没有用户原话时用户那侧是空的。 */
export function followUpTexts(messages: readonly AgentMessageView[]): FollowUpSource {
  let userText = ''
  let assistantText = ''
  for (const message of [...messages].sort((a, b) => a.createdAt - b.createdAt)) {
    const text = agentMessageText(message).trim()
    if (!text) continue
    if (message.role === 'user') userText = text
    else if (message.role === 'assistant') assistantText = text
  }
  return { userText, assistantText }
}

/** 这一轮自己带了用户原话才返回。出图后的复查没有新的用户消息，调用方再去会话里找上一句。 */
export function followUpSource(messages: readonly AgentMessageView[]): FollowUpSource | null {
  const texts = followUpTexts(messages)
  if (!texts.userText) return null
  return texts
}

export function followUpPrompt(userText: string, assistantText: string): string {
  return [
    '你在为图像和视频创作助手准备用户下一句可能发出的话。',
    '只输出 JSON：{"lines":["...","...","..."]}',
    '规则：',
    '- 用用户上一条消息的语言写。',
    '- 每句都是用户会原样发出的完整一句，不要写成助手的提问，也不要写成短标签。',
    '- 中文尽量不超过 40 个字；任何语言都不要超过 80 个字符。',
    '- 不要重复用户刚说的那一句。',
    '- 三句顺着当前作品往下走，分别碰画面、风格或比例、以及下一步生成。',
    '- 不要解释，不要编号。',
    '',
    '用户刚说：',
    userText,
    '',
    '助手刚回复：',
    assistantText,
  ].join('\n')
}

/** 丢掉空句、重复、超长和用户刚说过的那句。凑不满两句就当没有。 */
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
    if (lines.length === FOLLOW_UP_MAX_LINES) break
  }
  return lines.length >= FOLLOW_UP_MIN_LINES ? lines : []
}

async function askSummaryModel(prompt: string, userText: string): Promise<unknown> {
  return askChatModel(
    {
      model: config.agent.summaryModel,
      prompt,
      maxTokens: FOLLOW_UP_MAX_TOKENS,
      timeoutMs: FOLLOW_UP_TIMEOUT_MS,
    },
    (value) =>
      normalizeFollowUpLines(value, userText).length >= FOLLOW_UP_MIN_LINES ? value : null,
  )
}

/**
 * 用概括标题的同一个小模型问三句下一句。失败、答歪、凑不满两句都是空数组：
 * 主轮已经结束，这里不能再抛。
 */
export async function suggestFollowUps(
  source: FollowUpSource,
  ask?: FollowUpAsk,
): Promise<readonly string[]> {
  const userText = clip(source.userText)
  if (!userText) return []
  const assistantText = clip(source.assistantText) || EMPTY_ASSISTANT
  const prompt = followUpPrompt(userText, assistantText)
  try {
    const value = await (ask ?? ((next: string) => askSummaryModel(next, userText)))(prompt)
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
 * null：这一轮的行在，句子还没写上。
 * 数组：已经定了。行本身不在（页脚没落上）时返回空数组，调用方不用再等。
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
 * 终帧之后再问，不进这一轮的账单，也不挡终帧。只问一次：写成空数组也算问过。
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
    // 出图完成后的复查往往只有助手的话。沿用会话里上一句用户的话，否则胶囊出不来。
    let userText = draft.userText
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
    }
    if (!userText) {
      write([])
      return
    }
    // bun test 会把 NODE_ENV 设成 test。没注入 ask 就不问模型：别的用例把同一条 chat fetch
    // 当成自己的计数器，旁路再打一次会把次数和重试预算打乱。列保持 null，那些用例不用认识它。
    if (!ask && process.env.NODE_ENV === 'test') return
    write(await suggestFollowUps({ userText, assistantText: draft.assistantText }, ask))
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
