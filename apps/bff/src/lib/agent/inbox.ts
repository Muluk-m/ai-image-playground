import type { AgentInboxUserMessagePayload } from '@image-playground/db'
import {
  AGENT_QUEUE_MAX_PENDING,
  type AgentMode,
  type AgentQueuedMessageFailure,
  type AgentQueuedMessageState,
  type AgentQueuedMessageView,
  type AgentQueueWithdrawResult,
  type AgentTurnParams,
  type AgentTurnReference,
} from '@image-playground/shared'
import { and, asc, eq, inArray, sql } from 'drizzle-orm'
import { db, schema } from '../../db/client'
import type { BffTransaction } from '../private-overlay'

/**
 * 会话收件箱（`agent_inbox`）里的用户消息。忙时发的话排在这里，当前回复可以结束时由
 * `start-turn` 按序号取，每轮一条。撤回与取走都是同一条记录上 `pending` 之后的原子更新，
 * 两者只有一个成立。轮到时开不了轮的那一条记成 `failed` 并带上错误码：它不再挡后面的，
 * 留在列表里让用户知道为什么没处理，撤掉才算完。
 */

type InboxRow = typeof schema.agent_inbox.$inferSelect

export interface QueuedUserMessage {
  readonly id: string
  readonly clientMessageId: string
  readonly text: string
  readonly deviceId: string
  readonly references: readonly AgentTurnReference[]
  readonly mode?: AgentMode
  readonly params?: AgentTurnParams
}

export interface EnqueueUserMessage {
  readonly clientMessageId: string
  readonly text: string
  readonly deviceId: string
  readonly references: readonly AgentTurnReference[]
  readonly mode?: AgentMode
  readonly params?: AgentTurnParams
}

export interface InboxEntry {
  readonly view: AgentQueuedMessageView
  readonly state: AgentQueuedMessageState
  readonly consumedTurnId: string | null
}

export type EnqueueResult =
  | { readonly kind: 'queued'; readonly entry: InboxEntry }
  /** 同一个客户端消息 id 已经在收件箱里：原样交回那一条此刻的状态，不再排第二次。 */
  | { readonly kind: 'duplicate'; readonly entry: InboxEntry }
  | { readonly kind: 'full' }

function entryOf(row: InboxRow): InboxEntry {
  return {
    view: {
      id: row.id,
      clientMessageId: row.client_message_id ?? row.id,
      text: row.payload.text,
      referenceCount: row.payload.referenceCount,
      createdAt: row.created_at,
      ...(row.status === 'failed' && row.failure ? { failure: row.failure } : {}),
    },
    state: row.status,
    consumedTurnId: row.consumed_turn_id,
  }
}

const inbox = schema.agent_inbox

const isPendingUserMessage = (conversationId: string) =>
  and(
    eq(inbox.conversation_id, conversationId),
    eq(inbox.kind, 'user_message'),
    eq(inbox.status, 'pending'),
  )

/**
 * 收一条用户消息进收件箱。会话行上的锁把同一会话的入队排成一列：满额判断与序号都不会被
 * 并发的另一次入队抢在中间。
 */
export async function enqueueAgentUserMessage(
  conversationId: string,
  message: EnqueueUserMessage,
  now = Date.now(),
): Promise<EnqueueResult> {
  return db.transaction(async (tx) => {
    await tx
      .select({ id: schema.agent_conversations.id })
      .from(schema.agent_conversations)
      .where(eq(schema.agent_conversations.id, conversationId))
      .for('update')
    const [existing] = await tx
      .select()
      .from(inbox)
      .where(
        and(
          eq(inbox.conversation_id, conversationId),
          eq(inbox.client_message_id, message.clientMessageId),
        ),
      )
    if (existing) return { kind: 'duplicate', entry: entryOf(existing) }
    const [pending] = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(inbox)
      .where(isPendingUserMessage(conversationId))
    if ((pending?.count ?? 0) >= AGENT_QUEUE_MAX_PENDING) return { kind: 'full' }
    const payload: AgentInboxUserMessagePayload = {
      text: message.text,
      deviceId: message.deviceId,
      referenceCount: message.references.length,
      ...(message.mode ? { mode: message.mode } : {}),
      ...(message.params ? { params: message.params } : {}),
    }
    const [row] = await tx
      .insert(inbox)
      .values({
        conversation_id: conversationId,
        id: crypto.randomUUID(),
        seq: sql`(SELECT COALESCE(MAX(${inbox.seq}), 0) + 1 FROM ${inbox} WHERE ${inbox.conversation_id} = ${conversationId})`,
        kind: 'user_message',
        status: 'pending',
        client_message_id: message.clientMessageId,
        payload,
        attachments: message.references.length ? [...message.references] : null,
        created_at: now,
      })
      .returning()
    return { kind: 'queued', entry: entryOf(row!) }
  })
}

/**
 * 排队列表：按处理顺序列出还排着的用户消息，连同轮到时没能开轮、用户还没撤掉的那几条
 * （带 `failure`）。
 */
export async function queuedAgentMessages(
  conversationId: string,
): Promise<AgentQueuedMessageView[]> {
  const rows = await db
    .select()
    .from(inbox)
    .where(
      and(
        eq(inbox.conversation_id, conversationId),
        eq(inbox.kind, 'user_message'),
        inArray(inbox.status, ['pending', 'failed']),
      ),
    )
    .orderBy(asc(inbox.seq))
  return rows.map((row) => entryOf(row).view)
}

/** 收件箱里一条记录此刻的状态；发送的 202 据此如实回报，不拿入队那一刻的旧状态。 */
export async function agentInboxEntry(
  conversationId: string,
  id: string,
): Promise<InboxEntry | null> {
  const [row] = await db
    .select()
    .from(inbox)
    .where(and(eq(inbox.conversation_id, conversationId), eq(inbox.id, id)))
  return row ? entryOf(row) : null
}

/**
 * 轮到它时开不了轮：记下错误码，让它不再挡着后面的。只有仍待处理时才成立——同时被撤回的
 * 那一条就还是撤回。
 */
export async function failAgentMessage(
  conversationId: string,
  id: string,
  failure: AgentQueuedMessageFailure,
): Promise<boolean> {
  const rows = await db
    .update(inbox)
    .set({ status: 'failed', failure, attachments: null })
    .where(
      and(eq(inbox.conversation_id, conversationId), eq(inbox.id, id), eq(inbox.status, 'pending')),
    )
    .returning({ id: inbox.id })
  return rows.length > 0
}

/** 下一条该处理的用户消息；只看不取，取走由 {@link consumeAgentMessage} 在起轮事务里做。 */
export async function nextAgentMessage(conversationId: string): Promise<QueuedUserMessage | null> {
  const [row] = await db
    .select()
    .from(inbox)
    .where(isPendingUserMessage(conversationId))
    .orderBy(asc(inbox.seq))
    .limit(1)
  if (!row) return null
  return {
    id: row.id,
    clientMessageId: row.client_message_id ?? row.id,
    text: row.payload.text,
    deviceId: row.payload.deviceId,
    references: row.attachments ?? [],
    ...(row.payload.mode ? { mode: row.payload.mode } : {}),
    ...(row.payload.params ? { params: row.payload.params } : {}),
  }
}

/**
 * 在起轮的事务里取走一条：只有它仍待处理时才成立。与撤回争同一行，输的一方更新不到任何行。
 * 参考图原件此时已交给这一轮归档，不再留在收件箱里。
 */
export async function consumeAgentMessage(
  tx: BffTransaction,
  conversationId: string,
  id: string,
  turnId: string,
): Promise<boolean> {
  const rows = await tx
    .update(inbox)
    .set({ status: 'consumed', consumed_turn_id: turnId, attachments: null })
    .where(
      and(eq(inbox.conversation_id, conversationId), eq(inbox.id, id), eq(inbox.status, 'pending')),
    )
    .returning({ id: inbox.id })
  return rows.length > 0
}

/**
 * 撤回一条排队消息；没能开轮的那一条也由撤回撤掉。`fresh` 表示是这一次撤回让它变成已撤回——
 * 只有这一次该通知别的设备。
 */
export async function withdrawAgentMessage(
  conversationId: string,
  id: string,
): Promise<{ readonly result: AgentQueueWithdrawResult; readonly fresh: boolean }> {
  const withdrawn = await db
    .update(inbox)
    .set({ status: 'cancelled', attachments: null })
    .where(
      and(
        eq(inbox.conversation_id, conversationId),
        eq(inbox.id, id),
        inArray(inbox.status, ['pending', 'failed']),
      ),
    )
    .returning({ id: inbox.id })
  if (withdrawn.length) return { result: 'cancelled', fresh: true }
  const [row] = await db
    .select({ status: inbox.status })
    .from(inbox)
    .where(and(eq(inbox.conversation_id, conversationId), eq(inbox.id, id)))
  if (!row) return { result: 'not_found', fresh: false }
  return { result: row.status === 'consumed' ? 'already_consumed' : 'cancelled', fresh: false }
}
