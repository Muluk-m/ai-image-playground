import type {
  AgentCompactionRecord,
  AgentContentBlock,
  AgentConversationView,
  AgentMessageRole,
  AgentMessageView,
  AgentToolCallSnapshot,
} from '@image-playground/shared'
import { and, asc, desc, eq, gt, inArray, isNull, lte, type SQL, sql } from 'drizzle-orm'
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

export async function softDeleteAgentConversation(
  id: string,
  owner: AgentOwner,
  executor: Executor = db,
): Promise<void> {
  const now = Date.now()
  await executor
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

/**
 * 三条读路径共用的一条：`scope` 划出这一次要读的那一段，之外的部分三边完全一样。
 * 归属只长在会话表上——消息表没有归属列，不 join 过去就认不出这一段该不该交给这个调用方。
 */
async function readAgentMessages(
  conversationId: string,
  owner: AgentOwner,
  scope?: SQL,
): Promise<AgentMessageView[]> {
  const rows = await db
    .select({
      id: schema.agent_messages.id,
      turn_id: schema.agent_messages.turn_id,
      role: schema.agent_messages.role,
      content: schema.agent_messages.content,
      created_at: schema.agent_messages.created_at,
    })
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
        scope,
      ),
    )
    .orderBy(asc(schema.agent_messages.seq))
  // 已经结束的后台任务先结算成终局：快照、续轮的历史与任务列表读到的都是这一份。
  const messages = await settleAgentJobs(conversationId, rows.map(messageView))
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
  // 只认挂在这个已经确权的会话下的任务：产物 id 本身证明不了归属。
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

/** 面板要的是整段历史：会话快照与任务列表里翻得到的每一条都得在，这里不按压缩收窄。 */
export async function listAgentMessages(
  conversationId: string,
  owner: AgentOwner,
): Promise<AgentMessageView[]> {
  return readAgentMessages(conversationId, owner)
}

export interface AgentHistoryWindow {
  /** 锚点之后的消息；摘要作废或压根没有摘要时，就是整段历史。 */
  readonly messages: readonly AgentMessageView[]
  /** 已经折进摘要、没有随 `messages` 读出来的条数。没有摘要时为 0。 */
  readonly coveredCount: number
  /**
   * 这个会话的压缩记录。锚点那条消息已经不在、或它之前还活着的条数与记的对不上时，
   * `summary` / `anchor` / `verbatim` 在这里就已经清空（熔断器的两个计数保留），
   * 调用方拿到的永远是一份可以直接用的记录。
   */
  readonly compaction: AgentCompactionRecord
}

/** 与消息读同一套归属过滤：会话不归这个调用方（或已删）时连记录都读不到，窗口跟着退化成空窗口。 */
async function loadOwnedCompaction(
  conversationId: string,
  owner: AgentOwner,
): Promise<AgentCompactionRecord | null> {
  const [row] = await db
    .select({ compaction: schema.agent_conversations.compaction })
    .from(schema.agent_conversations)
    .where(
      and(
        eq(schema.agent_conversations.id, conversationId),
        ownerWhere(owner),
        isNull(schema.agent_conversations.deleted_at),
      ),
    )
    .limit(1)
  return row?.compaction ?? null
}

/**
 * 摘要作废后的那一份记录。熔断器的两个计数留着：作废是历史自己变了，不是压缩又失败了一次，
 * 清掉就等于放开一个正在熔断的会话，让它一直重试一直失败。
 */
function withoutSummary(record: AgentCompactionRecord | null): AgentCompactionRecord {
  return {
    summary: null,
    anchor: null,
    verbatim: null,
    failureCount: record?.failureCount ?? 0,
    openedAt: record?.openedAt ?? null,
  }
}

/**
 * 锚点还作数时给出它的序号，否则 null。
 *
 * 只认 id 在不在是不够的：折进摘要之后又被软删的那一条，锚点照样在，删掉的内容就一直冻在
 * 摘要里——它不随窗口读回来，也没有谁再回去动那份摘要。数一遍锚点及其之前还活着的条数，
 * 与折的时候记下的对不上就整份作废，下一轮按现在的历史重折。
 */
async function liveAnchorSeq(
  conversationId: string,
  anchor: NonNullable<AgentCompactionRecord['anchor']>,
): Promise<number | null> {
  const [found] = await db
    .select({ seq: schema.agent_messages.seq })
    .from(schema.agent_messages)
    .where(
      and(
        eq(schema.agent_messages.conversation_id, conversationId),
        eq(schema.agent_messages.id, anchor.lastMessageId),
        isNull(schema.agent_messages.deleted_at),
      ),
    )
    .limit(1)
  if (!found) return null
  // 只数不取：这一段走 `(conversation_id, seq)` 索引的区间，覆盖区的行一条都不用拉回来。
  const [covered] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(schema.agent_messages)
    .where(
      and(
        eq(schema.agent_messages.conversation_id, conversationId),
        lte(schema.agent_messages.seq, found.seq),
        isNull(schema.agent_messages.deleted_at),
      ),
    )
  return covered?.count === anchor.coveredCount ? found.seq : null
}

/**
 * 续轮要的历史：摘要盖住的那一截不读回来，DB 扫描、结算与产物水合都只按窗口这一段走。
 */
export async function listAgentHistoryWindow(
  conversationId: string,
  owner: AgentOwner,
): Promise<AgentHistoryWindow> {
  const record = await loadOwnedCompaction(conversationId, owner)
  // verbatim 与 summary 同生共死：旧记录缺这一节，用户原话补不出来，只能当摘要作废重折一次。
  if (record?.summary && record.anchor && record.verbatim) {
    const seq = await liveAnchorSeq(conversationId, record.anchor)
    if (seq !== null) {
      return {
        messages: await readAgentMessages(
          conversationId,
          owner,
          gt(schema.agent_messages.seq, seq),
        ),
        coveredCount: record.anchor.coveredCount,
        compaction: record,
      }
    }
  }
  return {
    messages: await readAgentMessages(conversationId, owner),
    coveredCount: 0,
    compaction: withoutSummary(record),
  }
}

/**
 * 指定几轮的全部消息，按 seq 升序。唤醒点名的那一轮、授权原话所在的那一轮都可能比历史窗口
 * 更老：定点取这几条回来，不必为了它们把整段历史再读一遍。
 */
export async function listAgentTurnMessages(
  conversationId: string,
  owner: AgentOwner,
  turnIds: readonly string[],
): Promise<AgentMessageView[]> {
  if (!turnIds.length) return []
  return readAgentMessages(
    conversationId,
    owner,
    inArray(schema.agent_messages.turn_id, [...turnIds]),
  )
}
