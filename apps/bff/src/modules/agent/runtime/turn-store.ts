import {
  type AgentContentBlock,
  type AgentMessageView,
  type AgentStoredReference,
  type AgentToolCallSnapshot,
  type AgentToolName,
  type AgentTurnReference,
  collectUserReplyText,
  compileReplyScripts,
  createReplyScriptGate,
} from '@image-playground/shared'
import { and, eq } from 'drizzle-orm'
import { db, schema } from '../../../db/client'
import type { BffTransaction } from '../../../lib/private-overlay'
import type { TurnEventLog } from '../contracts'
import {
  appendAgentMessage,
  claimConversationMedia,
  InvalidSelectionError,
  recordAgentToolCall,
  settleSubmittedTaskIfTerminal,
} from '../conversation'
import type { OpenAssistantMessage, PreparedAgentTurn, QueuedInterjection } from './turn-types'

export interface TurnMessageStore {
  write(fn: (executor: typeof db | BffTransaction) => Promise<void>): Promise<void>
  waitWrites(): Promise<void>
  recordToolCall(
    messageId: string,
    toolCallId: string,
    toolName: AgentToolName,
    snapshot: AgentToolCallSnapshot,
  ): Promise<void>
  openAssistant(): void
  pushTextDelta(delta: string): void
  closeOpen(allowFallback: boolean): Promise<void>
  clearOpenRef(): void
  discardOpen(): Promise<void> | undefined
  storeBlock(block: AgentContentBlock, messageId: string): Promise<void>
  enqueueClaimedInterjection(message: QueuedInterjection): void
  flushQueued(): void
  admitDirectInterjection(input: {
    readonly messageId: string
    readonly text: string
    readonly references: readonly AgentTurnReference[]
    readonly stored: readonly AgentStoredReference[]
    readonly isAccepting: () => boolean
  }): Promise<'accepted' | 'duplicate' | 'rejected'>
  hasOpen(): boolean
  hasOpenText(): boolean
  storedAny(): boolean
  storedMessageValues(): AgentMessageView[]
}

/**
 * 单轮消息落库串行链与助手流式气泡状态：
 * 保证消息插入顺序严格单调（插话不会抢在半截回复前），并在 `storedMessages` 中留存原貌快照。
 */
export function createTurnMessageStore(
  prepared: PreparedAgentTurn,
  events: TurnEventLog,
): TurnMessageStore {
  const { conversationId, turnId, execution, input } = prepared
  // 唤醒轮的 text 是系统说明，不是用户的话。清洗认整段会话的用户原文，再加这一轮的用户原话。
  const replyLanguageSource = collectUserReplyText(
    input.history.messages,
    prepared.wake?.authorizationPrompt || input.text,
  )
  // 这一轮允许的文字只算这一次。后面的流式增量只拿这份结果。
  const replyScripts = compileReplyScripts(replyLanguageSource)

  let storedAnyFlag = false
  let open: OpenAssistantMessage | null = null
  const storedMessages = new Map<string, AgentMessageView>()
  const remember = (message: AgentMessageView) =>
    storedMessages.set(message.id, structuredClone(message))
  if (prepared.storedUserMessage) remember(prepared.storedUserMessage)

  const append = async (
    executor: typeof db | BffTransaction,
    id: string,
    role: 'user' | 'assistant',
    content: AgentContentBlock[],
  ) => remember(await appendAgentMessage(executor, { id, conversationId, turnId, role, content }))

  let queued: QueuedInterjection[] = []
  // 消息表的读回顺序是插入顺序，所以落库排成一条链，不让插话抢在半截回复前面。
  let writes: Promise<void> = Promise.resolve()

  const write = (fn: (executor: typeof db | BffTransaction) => Promise<void>) => {
    writes = writes.then(() => execution.write(fn))
    return writes
  }

  const store = (message: OpenAssistantMessage) =>
    write(async (executor) => {
      if (!message.text) return
      if (message.persisted) {
        await executor
          .update(schema.agent_messages)
          .set({ content: [{ type: 'text', text: message.text }] })
          .where(
            and(
              eq(schema.agent_messages.conversation_id, conversationId),
              eq(schema.agent_messages.id, message.id),
            ),
          )
        const previous = storedMessages.get(message.id)
        if (previous) remember({ ...previous, content: [{ type: 'text', text: message.text }] })
      } else {
        await append(executor, message.id, 'assistant', [{ type: 'text', text: message.text }])
      }
      storedAnyFlag = true
    })

  const storeBlock = (block: AgentContentBlock, messageId: string) =>
    write(async (executor) => {
      await append(executor, messageId, 'assistant', [block])
      storedAnyFlag = true
    }).then(() => {
      if (block.type === 'toolResult' && block.status === 'submitted' && block.job) {
        return settleSubmittedTaskIfTerminal(conversationId, block.job.taskId, turnId)
      }
    })

  const flushQueued = () => {
    const pending = queued
    queued = []
    for (const message of pending) {
      write(async (executor) => {
        await append(executor, message.id, 'user', [
          {
            type: 'text',
            text: message.text,
            ...(message.references.length ? { references: [...message.references] } : {}),
          },
        ])
      })
    }
  }

  return {
    write,
    waitWrites: () => writes,
    recordToolCall(messageId, toolCallId, toolName, snapshot) {
      return write((executor) =>
        recordAgentToolCall(executor, {
          conversationId,
          turnId,
          messageId,
          toolCallId,
          toolName,
          snapshot,
        }),
      )
    },
    openAssistant() {
      open = {
        id: crypto.randomUUID(),
        text: '',
        script: createReplyScriptGate(replyLanguageSource, replyScripts),
        started: false,
      }
    },
    pushTextDelta(delta) {
      const current = open
      if (!current) return
      const piece = current.script.push(delta)
      if (!piece) return
      // 杂字被清掉时先不开气泡；第一段看得见的正文再开。
      if (!current.started) {
        events.emit({ type: 'assistantStart', messageId: current.id })
        current.started = true
      }
      current.text = current.script.text()
      events.emit({
        type: 'textDelta',
        messageId: current.id,
        delta: piece,
      })
    },
    async closeOpen(allowFallback) {
      const current = open
      if (current) {
        // 用户中止时只落已经能确定的正文，不把没露出来的杂字换成兜底句。
        const piece = current.script.finish(allowFallback)
        if (piece) {
          if (!current.started) events.emit({ type: 'assistantStart', messageId: current.id })
          current.started = true
          current.text = current.script.text()
          events.emit({ type: 'textDelta', messageId: current.id, delta: piece })
        }
      }
      open = null
      if (current) await store(current)
    },
    clearOpenRef() {
      open = null
    },
    discardOpen() {
      const current = open
      open = null
      if (!current) return
      return write(async (executor) => {
        // An admission ahead of this write may still be committing the provisional message.
        if (!current.persisted) return
        await executor
          .delete(schema.agent_messages)
          .where(
            and(
              eq(schema.agent_messages.conversation_id, conversationId),
              eq(schema.agent_messages.id, current.id),
            ),
          )
        storedMessages.delete(current.id)
      })
    },
    storeBlock,
    enqueueClaimedInterjection(message) {
      queued.push(message)
      if (!open) flushQueued()
    },
    flushQueued,
    async admitDirectInterjection({ messageId, text, references, stored, isAccepting }) {
      // Reserve the visible assistant message's position without ending its stream.
      const current = open
      let persistedCurrent = false
      const refused = new Error('interjection_not_accepted')
      try {
        const previousWrites = writes
        const admission = previousWrites
          .then(() =>
            execution.write(async (tx) => {
              const [existing] = await tx
                .select({ id: schema.agent_messages.id })
                .from(schema.agent_messages)
                .where(
                  and(
                    eq(schema.agent_messages.conversation_id, conversationId),
                    eq(schema.agent_messages.id, messageId),
                  ),
                )
                .limit(1)
              if (existing) return 'duplicate' as const
              if (!isAccepting()) return 'rejected' as const
              if (!(await claimConversationMedia(conversationId, prepared.userId, references, tx)))
                throw new InvalidSelectionError('参考图或选区不可用，请重新添加')
              // Stopping while waiting for the media owner lock must roll back every claim.
              if (!isAccepting()) throw refused
              if (current?.text && !current.persisted) {
                await append(tx, current.id, 'assistant', [{ type: 'text', text: current.text }])
                persistedCurrent = true
              }
              await append(tx, messageId, 'user', [
                { type: 'text', text, ...(stored.length ? { references: [...stored] } : {}) },
              ])
              return 'accepted' as const
            }),
          )
          .then((result) => {
            if (persistedCurrent && current) {
              current.persisted = true
              storedAnyFlag = true
            }
            return result
          })
        // Only local admission refusals are recoverable; a failed earlier write still poisons finalization.
        writes = previousWrites.then(() =>
          admission.then(
            () => {},
            (error) => {
              if (error !== refused && !(error instanceof InvalidSelectionError)) throw error
            },
          ),
        )
        // Finalization observes the original rejection after the stream ends.
        void writes.catch(() => {})
        return await admission
      } catch (error) {
        if (error === refused) return 'rejected'
        throw error
      }
    },
    hasOpen: () => open !== null,
    hasOpenText: () => Boolean(open?.text),
    storedAny: () => storedAnyFlag,
    storedMessageValues: () => [...storedMessages.values()],
  }
}
