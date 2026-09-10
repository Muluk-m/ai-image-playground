import { Agent, type AgentMessage } from '@earendil-works/pi-agent-core'
import type {
  AgentMessageView,
  AgentTurnErrorCode,
  AgentTurnEvent,
  AgentTurnUsage,
} from '@image-playground/shared'
import { agentMessageText, agentTextFromBlocks } from '@image-playground/shared'
import { log } from '../logger'
import { agentModel, agentStreamFn } from './model'

const EMPTY_USAGE = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
}

const SYSTEM_PROMPT = [
  '你是创作模式画布旁的助手，帮用户把想法变成画布上的图。',
  '用中文回答，简短、具体，不要复述用户的话。',
  '现在你还没有可调用的工具，只能对着用户描述的内容给出建议。',
].join('\n')

export interface AgentTurnInput {
  readonly turnId: string
  readonly userMessageId: string
  readonly assistantMessageId: string
  readonly history: readonly AgentMessageView[]
  readonly text: string
}

/** 历史消息回放成 pi 的形状；助手消息的用量与停因是回放占位，不进任何计费。 */
function replayed(history: readonly AgentMessageView[]): AgentMessage[] {
  const model = agentModel()
  return history.map(
    (message): AgentMessage =>
      message.role === 'user'
        ? {
            role: 'user',
            content: [{ type: 'text', text: agentMessageText(message) }],
            timestamp: message.createdAt,
          }
        : {
            role: 'assistant',
            content: [{ type: 'text', text: agentMessageText(message) }],
            api: model.api,
            provider: model.provider,
            model: model.id,
            usage: EMPTY_USAGE,
            stopReason: 'stop',
            timestamp: message.createdAt,
          },
  )
}

interface EventQueue {
  push(event: AgentTurnEvent): void
  finish(): void
  drain(): AsyncGenerator<AgentTurnEvent>
}

function eventQueue(): EventQueue {
  const buffered: AgentTurnEvent[] = []
  let wake: (() => void) | null = null
  let finished = false
  return {
    push(event) {
      buffered.push(event)
      wake?.()
      wake = null
    },
    finish() {
      finished = true
      wake?.()
      wake = null
    },
    async *drain() {
      while (true) {
        while (buffered.length > 0) yield buffered.shift()!
        if (finished) return
        await new Promise<void>((resolve) => {
          wake = resolve
        })
      }
    },
  }
}

export interface AgentTurnResult {
  readonly text: string
  readonly usage: AgentTurnUsage | null
  readonly error?: AgentTurnErrorCode
}

/** 全零就是没报：中转网关吞掉 `stream_options` 时 pi 也只能填零，与真·零 token 不可区分。 */
function reportedUsage(message: AgentMessage | undefined): AgentTurnUsage | null {
  if (message?.role !== 'assistant') return null
  const { input, output } = message.usage
  if (!input && !output) return null
  return { inputTokens: input, outputTokens: output }
}

/** 这里不碰数据库：落库由调用方在 `onSettled` 里做。 */
export async function* runAgentTurn(
  input: AgentTurnInput,
  onSettled: (result: AgentTurnResult) => Promise<void>,
): AsyncGenerator<AgentTurnEvent> {
  const startedAt = Date.now()
  const queue = eventQueue()
  const agent = new Agent({
    initialState: {
      systemPrompt: SYSTEM_PROMPT,
      model: agentModel(),
      messages: replayed(input.history),
    },
    streamFn: agentStreamFn(),
  })

  let error: AgentTurnErrorCode | undefined
  agent.subscribe((event) => {
    if (event.type === 'message_update' && event.assistantMessageEvent.type === 'text_delta') {
      queue.push({ type: 'textDelta', delta: event.assistantMessageEvent.delta })
    }
    // pi 不为上游失败抛异常，它把失败写进助手消息的停因。
    if (event.type === 'message_end' && event.message.role === 'assistant') {
      if (event.message.stopReason === 'error') error = 'agent_upstream_error'
    }
  })

  const running = agent
    .prompt(input.text)
    .catch((thrown) => {
      log.warn({ event: 'agent.turn_failed', err: thrown }, 'agent turn failed')
      error = 'agent_run_failed'
    })
    .finally(() => queue.finish())

  try {
    yield {
      type: 'turnStart',
      turnId: input.turnId,
      userMessageId: input.userMessageId,
      assistantMessageId: input.assistantMessageId,
    }
    for await (const event of queue.drain()) yield event

    const last = agent.state.messages.at(-1)
    const text = last?.role === 'assistant' ? agentTextFromBlocks(last.content) : ''
    const usage = reportedUsage(last)
    if (!error && !text) error = 'agent_run_failed'

    log.info(
      { event: 'agent.turn_settled', turnId: input.turnId, usage, error: error ?? null },
      'agent turn settled',
    )
    await onSettled({ text, usage, error })
    if (error) {
      yield { type: 'error', error }
      return
    }
    yield {
      type: 'turnEnd',
      turnId: input.turnId,
      durationMs: Date.now() - startedAt,
      usage,
    }
  } finally {
    // 客户端断开时消费者停止拉取，不中止上游就会把整轮 token 烧完。
    agent.abort()
    await running
  }
}
