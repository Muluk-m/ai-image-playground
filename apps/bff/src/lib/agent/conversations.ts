import type {
  AgentContentBlock,
  AgentConversationView,
  AgentMessageRole,
  AgentMessageView,
} from '@image-playground/shared'
import { and, asc, eq, isNull, sql } from 'drizzle-orm'
import { db, schema } from '../../db/client'
import type { BffTransaction } from '../private-overlay'

/** 归属互斥由 `agent_conversations_owner_check` 兜底，这里用联合类型让调用方无从写出两者并存。 */
export type AgentOwner =
  | { readonly kind: 'user'; readonly userId: string }
  | { readonly kind: 'device'; readonly deviceId: string }

type Executor = typeof db | BffTransaction

export interface AppendAgentMessage {
  readonly id?: string
  readonly conversationId: string
  readonly turnId: string
  readonly role: AgentMessageRole
  readonly content: readonly AgentContentBlock[]
}

function ownerWhere(owner: AgentOwner) {
  return owner.kind === 'user'
    ? eq(schema.agent_conversations.user_id, owner.userId)
    : eq(schema.agent_conversations.device_id, owner.deviceId)
}

function conversationView(row: {
  id: string
  title: string
  created_at: number
  updated_at: number
}): AgentConversationView {
  return {
    id: row.id,
    title: row.title,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function messageView(row: {
  id: string
  turn_id: string
  role: AgentMessageRole
  content: AgentContentBlock[]
  created_at: number
}): AgentMessageView {
  return {
    id: row.id,
    turnId: row.turn_id,
    role: row.role,
    content: row.content,
    createdAt: row.created_at,
  }
}

export async function createAgentConversation(
  owner: AgentOwner,
  title: string,
  now = Date.now(),
): Promise<AgentConversationView> {
  const [row] = await db
    .insert(schema.agent_conversations)
    .values({
      id: crypto.randomUUID(),
      user_id: owner.kind === 'user' ? owner.userId : null,
      device_id: owner.kind === 'device' ? owner.deviceId : null,
      title,
      created_at: now,
      updated_at: now,
    })
    .returning()
  return conversationView(row!)
}

export async function findAgentConversation(
  id: string,
  owner: AgentOwner,
): Promise<AgentConversationView | null> {
  const [row] = await db
    .select()
    .from(schema.agent_conversations)
    .where(
      and(
        eq(schema.agent_conversations.id, id),
        ownerWhere(owner),
        isNull(schema.agent_conversations.deleted_at),
      ),
    )
    .limit(1)
  return row ? conversationView(row) : null
}

export async function setAgentConversationTitle(id: string, title: string): Promise<void> {
  await db
    .update(schema.agent_conversations)
    .set({ title })
    .where(eq(schema.agent_conversations.id, id))
}

export async function touchAgentConversation(id: string, now = Date.now()): Promise<void> {
  await db
    .update(schema.agent_conversations)
    .set({ updated_at: now })
    .where(eq(schema.agent_conversations.id, id))
}

export async function softDeleteAgentConversation(id: string, owner: AgentOwner): Promise<void> {
  const now = Date.now()
  await db
    .update(schema.agent_conversations)
    .set({ deleted_at: now, updated_at: now })
    .where(and(eq(schema.agent_conversations.id, id), ownerWhere(owner)))
}

export async function appendAgentMessage(
  executor: Executor,
  message: AppendAgentMessage,
  now = Date.now(),
): Promise<AgentMessageView> {
  const [row] = await executor
    .insert(schema.agent_messages)
    .values({
      conversation_id: message.conversationId,
      id: message.id ?? crypto.randomUUID(),
      turn_id: message.turnId,
      // 序号在插入语句里算，省掉一次往返；并发写靠会话内 seq 的唯一索引兜底。
      seq: sql`(SELECT COALESCE(MAX(${schema.agent_messages.seq}), 0) + 1 FROM ${schema.agent_messages} WHERE ${schema.agent_messages.conversation_id} = ${message.conversationId})`,
      role: message.role,
      content: [...message.content],
      created_at: now,
    })
    .returning()
  return messageView(row!)
}

export async function listAgentMessages(conversationId: string): Promise<AgentMessageView[]> {
  const rows = await db
    .select()
    .from(schema.agent_messages)
    .innerJoin(
      schema.agent_conversations,
      eq(schema.agent_conversations.id, schema.agent_messages.conversation_id),
    )
    .where(
      and(
        eq(schema.agent_messages.conversation_id, conversationId),
        isNull(schema.agent_messages.deleted_at),
        isNull(schema.agent_conversations.deleted_at),
      ),
    )
    .orderBy(asc(schema.agent_messages.seq))
  return rows.map((row) => messageView(row.agent_messages))
}
