import type {
  AgentCompactionRecord,
  AgentContentBlock,
  AgentConversationView,
  AgentMessageRole,
  AgentMessageView,
  AgentToolCallSnapshot,
} from '@image-playground/shared'
import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm'
import { db, schema } from '../../db/client'
import type { BffTransaction } from '../private-overlay'
import { settleAgentJobs } from './background-jobs'

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
  executor: Executor = db,
): Promise<AgentConversationView> {
  const [row] = await executor
    .insert(schema.agent_conversations)
    .values({
      id: crypto.randomUUID(),
      user_id: owner.kind === 'user' ? owner.userId : null,
      device_id: owner.kind === 'device' ? owner.deviceId : null,
      title,
      runtime_generation: 1,
      created_at: now,
      updated_at: now,
    })
    .returning()
  return conversationView(row!)
}

export async function findAgentConversation(
  id: string,
  owner: AgentOwner,
  executor: Executor = db,
): Promise<AgentConversationView | null> {
  const [row] = await executor
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

export async function listAgentConversations(owner: AgentOwner): Promise<AgentConversationView[]> {
  // 显式列：整行会把会话上的压缩摘要一起拉回来，那是服务端私有状态，列表用不到。
  const rows = await db
    .select({
      id: schema.agent_conversations.id,
      title: schema.agent_conversations.title,
      created_at: schema.agent_conversations.created_at,
      updated_at: schema.agent_conversations.updated_at,
    })
    .from(schema.agent_conversations)
    .where(and(ownerWhere(owner), isNull(schema.agent_conversations.deleted_at)))
    .orderBy(desc(schema.agent_conversations.updated_at))
  return rows.map(conversationView)
}

/** 幂等靠改挂本身：设备名下的行一次搬空，重复登录再扫就是空集。 */
export async function adoptDeviceConversations(deviceId: string, userId: string): Promise<number> {
  const rows = await db
    .update(schema.agent_conversations)
    .set({ user_id: userId, device_id: null })
    .where(eq(schema.agent_conversations.device_id, deviceId))
    .returning({ id: schema.agent_conversations.id })
  return rows.length
}

export async function setAgentConversationTitle(
  executor: Executor,
  id: string,
  owner: AgentOwner,
  title: string,
  /** 给出时就是一次比较写入：标题已经不是这一句，说明有人写过，这次不改。 */
  expect?: string,
): Promise<void> {
  await executor
    .update(schema.agent_conversations)
    .set({ title })
    .where(
      and(
        eq(schema.agent_conversations.id, id),
        ownerWhere(owner),
        ...(expect === undefined ? [] : [eq(schema.agent_conversations.title, expect)]),
      ),
    )
}

/**
 * 不收归属：轮跑到一半用户登录，领养会把行改挂到 user_id，按起轮时的归属限定就再也
 * 匹配不上，收尾这一下会静默丢掉。会话 id 本身已由起轮时的确权给出。
 */
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

/** 压缩状态是会话的服务端私有列，读写都不碰消息表——存储里的消息一条不改。 */
export async function loadAgentCompaction(id: string): Promise<AgentCompactionRecord | null> {
  const [row] = await db
    .select({ compaction: schema.agent_conversations.compaction })
    .from(schema.agent_conversations)
    .where(eq(schema.agent_conversations.id, id))
    .limit(1)
  return row?.compaction ?? null
}

export async function saveAgentCompaction(
  id: string,
  record: AgentCompactionRecord,
): Promise<void> {
  await db
    .update(schema.agent_conversations)
    .set({ compaction: record })
    .where(eq(schema.agent_conversations.id, id))
}

/**
 * 消息写入在会话内排队：序号按 MAX(seq)+1 现算，两路写者（在跑的那一轮与轮外的单张重试）
 * 同时算会撞上同一个序号。事务级咨询锁把它们串成一条，锁在事务提交时放开，
 * 后到者的插入语句开始时已经看得见前者落下的那一行。
 */
async function lockAgentMessages(executor: Executor, conversationId: string): Promise<void> {
  await executor.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${JSON.stringify(['agent-messages', conversationId])}, 0))`,
  )
}

export async function appendAgentMessage(
  executor: Executor,
  message: AppendAgentMessage,
  now = Date.now(),
): Promise<AgentMessageView> {
  // 没有外层事务时自开一个：咨询锁只在事务里才管得到插入那一句。
  if (executor === db) return db.transaction((tx) => appendAgentMessage(tx, message, now))
  await lockAgentMessages(executor, message.conversationId)
  const [row] = await executor
    .insert(schema.agent_messages)
    .values({
      conversation_id: message.conversationId,
      id: message.id ?? crypto.randomUUID(),
      turn_id: message.turnId,
      // 序号在插入语句里算，省掉一次往返；同会话的写者已由上面的锁串行，唯一索引只是最后一道兜底。
      seq: sql`(SELECT COALESCE(MAX(${schema.agent_messages.seq}), 0) + 1 FROM ${schema.agent_messages} WHERE ${schema.agent_messages.conversation_id} = ${message.conversationId})`,
      role: message.role,
      content: [...message.content],
      created_at: now,
    })
    .returning()
  return messageView(row!)
}

export interface AgentToolCallRecord {
  readonly conversationId: string
  readonly turnId: string
  /** 这次调用那张结果卡的消息 id。 */
  readonly messageId: string
  readonly toolCallId: string
  readonly toolName: string
  readonly snapshot: AgentToolCallSnapshot
}

/** 工具起跑就记下模型选定的参数；结果卡要到工具跑完才写进消息表。 */
export async function recordAgentToolCall(
  executor: Executor,
  call: AgentToolCallRecord,
  now = Date.now(),
): Promise<void> {
  await executor.insert(schema.agent_tool_calls).values({
    conversation_id: call.conversationId,
    message_id: call.messageId,
    turn_id: call.turnId,
    tool_call_id: call.toolCallId,
    tool_name: call.toolName,
    snapshot: call.snapshot,
    created_at: now,
  })
}

/** 一轮里起跑过的工具调用，按起跑先后。 */
export async function listAgentToolCalls(
  conversationId: string,
  turnId: string,
): Promise<AgentToolCallRecord[]> {
  const rows = await db
    .select()
    .from(schema.agent_tool_calls)
    .where(
      and(
        eq(schema.agent_tool_calls.conversation_id, conversationId),
        eq(schema.agent_tool_calls.turn_id, turnId),
      ),
    )
    .orderBy(asc(schema.agent_tool_calls.created_at))
  return rows.map((row) => ({
    conversationId: row.conversation_id,
    turnId: row.turn_id,
    messageId: row.message_id,
    toolCallId: row.tool_call_id,
    toolName: row.tool_name,
    snapshot: row.snapshot,
  }))
}

/**
 * 维护任务清任务行之前调用：把这个会话里已经结束的后台任务先结算成终局写回消息，否则没人读过的
 * 会话在任务行清掉之后只剩「任务丢失了」。内部路径，不按归属查，调用方不得把结果交给用户。
 */
export async function settleAgentConversationJobs(conversationId: string): Promise<void> {
  const rows = await db
    .select()
    .from(schema.agent_messages)
    .where(
      and(
        eq(schema.agent_messages.conversation_id, conversationId),
        isNull(schema.agent_messages.deleted_at),
      ),
    )
    .orderBy(asc(schema.agent_messages.seq))
  await settleAgentJobs(conversationId, rows.map(messageView))
}

export async function listAgentMessages(
  conversationId: string,
  owner: AgentOwner,
): Promise<AgentMessageView[]> {
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
        ownerWhere(owner),
        isNull(schema.agent_messages.deleted_at),
        isNull(schema.agent_conversations.deleted_at),
      ),
    )
    .orderBy(asc(schema.agent_messages.seq))
  // 已经结束的后台任务先结算成终局：快照、续轮的历史与任务列表读到的都是这一份。
  const messages = await settleAgentJobs(
    conversationId,
    rows.map((row) => messageView(row.agent_messages)),
  )
  const taskIds = [
    ...new Set(
      messages.flatMap((message) =>
        message.content.flatMap((block) =>
          block.type === 'toolResult' && !block.prompt
            ? (block.artifacts ?? []).map((artifact) => artifact.taskId)
            : [],
        ),
      ),
    ),
  ]
  if (!taskIds.length) return messages
  // Only recover tasks tied to this already-authorized conversation; never trust artifact IDs alone.
  const tasks = await db
    .select({ id: schema.tasks.id, request: schema.tasks.request_payload })
    .from(schema.tasks)
    .where(
      and(
        inArray(schema.tasks.id, taskIds),
        eq(schema.tasks.agent_conversation_id, conversationId),
      ),
    )
  const prompts = new Map(tasks.map((task) => [task.id, task.request.prompt]))
  return messages.map((message) => ({
    ...message,
    content: message.content.map((block) => {
      if (block.type !== 'toolResult' || block.prompt) return block
      const prompt = (block.artifacts ?? [])
        .map((artifact) => prompts.get(artifact.taskId))
        .find(Boolean)
      return prompt ? { ...block, prompt } : block
    }),
  }))
}
