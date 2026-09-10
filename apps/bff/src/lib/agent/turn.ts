import { Agent, type AgentMessage } from '@earendil-works/pi-agent-core'
import type { AgentMessageView, AgentTurnErrorCode, AgentTurnUsage } from '@image-playground/shared'
import { agentMessageText } from '@image-playground/shared'
import { db } from '../../db/client'
import { log } from '../logger'
import { createCompactionTransform } from './compaction-transform'
import { type AgentOwner, appendAgentMessage, touchAgentConversation } from './conversations'
import { lastAgentEventSeq } from './events'
import { agentModel, agentStreamFn } from './model'
import { type RunningTurn, registerRunningTurn, turnEventLog } from './runningTurns'

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

export interface StartAgentTurnInput {
  readonly conversationId: string
  readonly owner: AgentOwner
  readonly turnId: string
  readonly userMessageId: string
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

interface OpenAssistantMessage {
  readonly id: string
  text: string
}

/**
 * 全零就是没报：中转网关吞掉 `stream_options` 时 pi 也只能填零，与真·零 token 不可区分。
 * 只认智能体转录里的用量：上下文压缩的摘要走独立请求，它的 token 不计入任何一轮，别加进来。
 */
function reportedUsage(message: AgentMessage | undefined): AgentTurnUsage | null {
  if (message?.role !== 'assistant') return null
  const { input, output } = message.usage
  if (!input && !output) return null
  return { inputTokens: input, outputTokens: output }
}

/** 起一轮并立刻返回把手；`read()` 可以被断开再重开。 */
export async function startAgentTurn(input: StartAgentTurnInput): Promise<RunningTurn> {
  const { conversationId, owner, turnId, userMessageId, text: prompt } = input
  const startedAt = Date.now()
  const events = turnEventLog(conversationId, turnId, await lastAgentEventSeq(conversationId))
  const agent = new Agent({
    initialState: {
      systemPrompt: SYSTEM_PROMPT,
      model: agentModel(),
      messages: replayed(input.history),
    },
    streamFn: agentStreamFn(),
    transformContext: createCompactionTransform({
      conversationId: input.conversationId,
      turnId: input.turnId,
      historyIds: input.history.map((message) => message.id),
      userMessageId: input.userMessageId,
    }),
  })

  let error: AgentTurnErrorCode | undefined
  let aborted = false
  let storedAny = false
  let open: OpenAssistantMessage | null = null
  let queued: { readonly id: string; readonly text: string }[] = []
  // 消息表的读回顺序是插入顺序，所以落库排成一条链，不让插话抢在半截回复前面。
  let writes: Promise<void> = Promise.resolve()

  const write = (append: () => Promise<void>) => {
    writes = writes.then(append)
    return writes
  }

  const closeOpen = async () => {
    const current = open
    open = null
    if (current) await store(current)
  }

  const flushQueued = () => {
    const pending = queued
    queued = []
    for (const message of pending) {
      write(async () => {
        await appendAgentMessage(db, {
          id: message.id,
          conversationId,
          turnId,
          role: 'user',
          content: [{ type: 'text', text: message.text }],
        })
      })
    }
  }

  const store = (message: OpenAssistantMessage) =>
    write(async () => {
      if (!message.text) return
      await appendAgentMessage(db, {
        id: message.id,
        conversationId,
        turnId,
        role: 'assistant',
        content: [{ type: 'text', text: message.text }],
      })
      storedAny = true
    })

  agent.subscribe(async (event) => {
    if (event.type === 'message_start' && event.message.role === 'assistant') {
      open = { id: crypto.randomUUID(), text: '' }
    }
    if (event.type === 'message_update' && event.assistantMessageEvent.type === 'text_delta') {
      const current = open
      if (!current) return
      // 上游报错的那条助手消息一个字都没有，不为它开一个空气泡。
      if (!current.text) events.emit({ type: 'assistantStart', messageId: current.id })
      current.text += event.assistantMessageEvent.delta
      events.emit({
        type: 'textDelta',
        messageId: current.id,
        delta: event.assistantMessageEvent.delta,
      })
    }
    if (event.type === 'message_end' && event.message.role === 'assistant') {
      // pi 不为上游失败抛异常，它把失败写进助手消息的停因。
      if (event.message.stopReason === 'error') error = 'agent_upstream_error'
      else await closeOpen()
      open = null
      flushQueued()
    }
  })

  events.emit({ type: 'turnStart', turnId, userMessageId })

  const turn: RunningTurn = {
    conversationId,
    turnId,
    read: (afterSeq) => events.read(afterSeq),
    interject(text) {
      const messageId = crypto.randomUUID()
      // 插话要等当前这条助手消息落库；pi 也是等它跑完才把插话喂进去。
      queued.push({ id: messageId, text })
      if (!open) flushQueued()
      events.emit({ type: 'interjection', messageId, text })
      agent.steer({ role: 'user', content: [{ type: 'text', text }], timestamp: Date.now() })
      return messageId
    },
    abort() {
      aborted = true
      agent.abort()
    },
  }
  const unregister = registerRunningTurn(turn)

  void agent
    .prompt(prompt)
    .catch((thrown) => {
      if (aborted) return
      log.warn({ event: 'agent.turn_failed', err: thrown }, 'agent turn failed')
      error = 'agent_run_failed'
    })
    .then(async () => {
      // 中止时 pi 可能走不到 message_end，已经流给用户的半截回复要自己落库。
      await closeOpen()
      flushQueued()
      await writes
      if (!error && !aborted && !storedAny) error = 'agent_run_failed'

      const usage = reportedUsage(agent.state.messages.at(-1))
      log.info(
        { event: 'agent.turn_settled', turnId, usage, error: error ?? null },
        'agent turn settled',
      )
      events.emit({
        type: 'turnEnd',
        turnId,
        durationMs: Date.now() - startedAt,
        stopReason: error ? 'failed' : aborted ? 'aborted' : 'completed',
        ...(error ? { error } : {}),
        usage,
      })
      await touchAgentConversation(conversationId, owner)
      await events.flush()
      unregister()
      events.close()
    })

  return turn
}
