import { serializeConversation } from '@earendil-works/pi-agent-core'
import type { Message } from '@earendil-works/pi-ai'
import type { AgentCompactionNarrative } from '@image-playground/shared'
import { config } from '../../config'
import { askChatModel, type ChatAttempt } from '../chatCompletion'
import { log } from '../logger'
import { isObject } from '../type-guards'
import {
  type CompactionMessage,
  SUMMARY_CHUNK_TOKENS,
  type Summarize,
  type SummaryRequest,
} from './compaction'
import profiles from './thinking.config.json'
import { estimateMessageTokens } from './token-estimate'

/** 摘要输入很大而输出是四段话；给足够写完、又不够跑题的额度。 */
const SUMMARY_MAX_TOKENS = 1_500

function summaryModelWindow(): number {
  const known = Object.values(profiles).find(
    (profile) => profile.model === config.agent.summaryModel,
  )
  return (
    config.agent.summaryContextWindow ??
    known?.contextWindow ??
    (config.agent.summaryModel === 'gpt-5.6-luna' ? 1_050_000 : 16_000)
  )
}

function summaryPromptTokens(previousSummary: AgentCompactionNarrative | null): number {
  return estimateMessageTokens({
    role: 'user',
    content: [{ type: 'text', text: buildSummaryPrompt({ messages: [], previousSummary }) }],
    timestamp: 0,
  })
}

/** 给真实摘要窗口留下提示词、旧摘要、输出和估算误差，再给折叠区分段。 */
export function summaryChunkBudget(previousSummary: AgentCompactionNarrative | null): number {
  const window = summaryModelWindow()
  const buffer = Math.max(512, Math.ceil(window * 0.05))
  return Math.max(
    1,
    Math.min(
      SUMMARY_CHUNK_TOKENS,
      window - SUMMARY_MAX_TOKENS - summaryPromptTokens(previousSummary) - buffer,
    ),
  )
}

/**
 * 一段满预算的折叠区要摘多久，是量出来的不是拍的：线上那条 181 条消息的会话，折叠区 145 条
 * 约 3.2 万字符，`gpt-5.6-luna` 实测 **83.6 秒**。原来给 60 秒，于是每一次都在快成的时候被
 * 自己切掉、记成一次失败，三次就把熔断器打满——摘要模型换对之后，这是第二层同样静默的坑。
 *
 * 折叠区按最多 32k token 分段（见 `foldChunks`），所以单段不会比这次更大；
 * 180 秒是那个实测值的两倍出头，留给上游抖动。它是这一轮里用户真实等待的时间，不该再放大：
 * 真要更快得靠缩小分段，而不是把这个数字往上堆。
 */
const SUMMARY_TIMEOUT_MS = 180_000

function transcript(messages: readonly CompactionMessage[]): string {
  const llm = messages
    .map((entry) => entry.message)
    .filter(
      (message): message is Message =>
        message.role === 'user' || message.role === 'assistant' || message.role === 'toolResult',
    )
  return serializeConversation(llm)
}

export function buildSummaryPrompt(request: SummaryRequest): string {
  const previous = request.previousSummary
  return [
    '你在为一段人机对话做上下文摘要，供后续轮次替代原文使用。不要续写对话，不要回答其中的问题。',
    ...(previous
      ? [
          '下面是上一版摘要，请把新增部分并进去，保留其中仍然成立的内容：',
          `上一版摘要：已完成=${previous.completed}；进行中=${previous.inProgress}；关键决定=${previous.decisions}；产物=${previous.artifacts}`,
        ]
      : []),
    '只输出一个 JSON 对象，不要解释、不要前后缀。字段全部是字符串：',
    '"completed"：已经完成的工作，按时间顺序列要点',
    '"inProgress"：还没做完、下一步要接着做的事',
    '"decisions"：用户定下的约束与偏好，以及不能改的东西；正在延续同一设计时，保留用户要表达的核心意思、受众和视觉重点。把用户明确要求与助手自行选择的画面方案标清，不把后者写成用户要求；用户改口时以新要求为准',
    '"artifacts"：产出的图片 / 视频 id 与它们各自是什么',
    '没有内容的字段给空字符串。用户的原话由程序另行逐字保留，你不必复述。',
    '以下是要摘要的对话：',
    transcript(request.messages),
  ].join('\n')
}

function parseNarrative(value: unknown): AgentCompactionNarrative | null {
  if (!isObject(value)) return null
  const { completed, inProgress, decisions, artifacts } = value
  if ([completed, inProgress, decisions, artifacts].some((field) => typeof field !== 'string')) {
    return null
  }
  return { completed, inProgress, decisions, artifacts } as AgentCompactionNarrative
}

/**
 * 摘要走独立的一次性对话，不经智能体的消息流：它的输出既不进 `messages`，
 * 也不计入任何一轮的用量——压缩由平台承担。
 */
export async function summarizeCompaction(
  request: SummaryRequest,
  onAttempt?: (attempt: ChatAttempt) => Promise<void>,
): ReturnType<Summarize> {
  try {
    const prompt = buildSummaryPrompt(request)
    const window = summaryModelWindow()
    const inputTokens = estimateMessageTokens({
      role: 'user',
      content: [{ type: 'text', text: prompt }],
      timestamp: 0,
    })
    if (inputTokens + SUMMARY_MAX_TOKENS > window - Math.max(512, Math.ceil(window * 0.05))) {
      log.warn(
        { event: 'agent.compaction_summary_overflow', inputTokens, window },
        'summary exceeds model context window',
      )
      return null
    }
    return await askChatModel(
      {
        model: config.agent.summaryModel,
        prompt,
        maxTokens: SUMMARY_MAX_TOKENS,
        timeoutMs: SUMMARY_TIMEOUT_MS,
        onAttempt,
      },
      parseNarrative,
    )
  } catch (error) {
    log.warn({ event: 'agent.compaction_summary_failed', err: error }, 'compaction summary failed')
    return null
  }
}
