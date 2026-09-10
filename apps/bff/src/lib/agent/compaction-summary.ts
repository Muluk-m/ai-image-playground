import { serializeConversation } from '@earendil-works/pi-agent-core'
import type { Message } from '@earendil-works/pi-ai'
import type { AgentCompactionNarrative } from '@image-playground/shared'
import { config } from '../../config'
import { askChatModel } from '../chatCompletion'
import { log } from '../logger'
import { isObject } from '../type-guards'
import type { CompactionMessage, Summarize, SummaryRequest } from './compaction'

/** 摘要输入很大而输出是四段话；给足够写完、又不够跑题的额度。 */
const SUMMARY_MAX_TOKENS = 1_500
const SUMMARY_TIMEOUT_MS = 60_000

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
    '"decisions"：用户定下的约束与偏好，以及不能改的东西',
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
export const summarizeCompaction: Summarize = async (request) => {
  try {
    return await askChatModel(
      {
        model: config.agent.summaryModel,
        prompt: buildSummaryPrompt(request),
        maxTokens: SUMMARY_MAX_TOKENS,
        timeoutMs: SUMMARY_TIMEOUT_MS,
      },
      parseNarrative,
    )
  } catch (error) {
    log.warn({ event: 'agent.compaction_summary_failed', err: error }, 'compaction summary failed')
    return null
  }
}
