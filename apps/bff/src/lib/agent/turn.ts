import { Agent, type AgentMessage } from '@earendil-works/pi-agent-core'
import type { AgentMessageView, AgentTurnErrorCode, AgentTurnEvent } from '@image-playground/shared'
import { agentMessageText } from '@image-playground/shared'
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
  return history.map((message) =>
    message.role === 'user'
      ? {
          role: 'user',
          content: [{ type: 'text', text: agentMessageText(message) }],
          timestamp: message.createdAt,
        }
      : ({
          role: 'assistant',
          content: [{ type: 'text', text: agentMessageText(message) }],
          api: model.api,
          provider: model.provider,
          model: model.id,
          usage: EMPTY_USAGE,
          stopReason: 'stop',
          timestamp: message.createdAt,
        } satisfies AgentMessage),
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
  readonly error?: AgentTurnErrorCode
}

/**
 * 跑一轮，把 pi 的事件翻成线协议事件。落库由调用方做：这里不碰数据库，
 * 结果通过 `onSettled` 交回去。
 */
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

  yield {
    type: 'turnStart',
    turnId: input.turnId,
    userMessageId: input.userMessageId,
    assistantMessageId: input.assistantMessageId,
  }
  for await (const event of queue.drain()) yield event
  await running

  const last = agent.state.messages.at(-1)
  const text = last?.role === 'assistant' ? assistantText(last) : ''
  if (!error && !text) error = 'agent_run_failed'

  await onSettled({ text, error })
  if (error) {
    yield { type: 'error', error }
    return
  }
  yield { type: 'turnEnd', turnId: input.turnId, durationMs: Date.now() - startedAt }
}

function assistantText(message: AgentMessage): string {
  if (message.role !== 'assistant') return ''
  return message.content
    .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
    .map((block) => block.text)
    .join('')
}
