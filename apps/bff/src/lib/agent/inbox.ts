import type {
  AgentInboxPayload,
  AgentInboxResumePayload,
  AgentInboxTaskResultPayload,
  AgentInboxUserMessagePayload,
} from '@image-playground/db'
import {
  AGENT_QUEUE_MAX_PENDING,
  type AgentMode,
  type AgentQueuedMessageFailure,
  type AgentQueuedMessageState,
  type AgentQueuedMessageView,
  type AgentQueueInterjectResult,
  type AgentQueueWithdrawResult,
  type AgentReturnedQueuedMessage,
  type AgentTurnParams,
  type AgentTurnReference,
} from '@image-playground/shared'
import { and, asc, desc, eq, gt, inArray, isNotNull, isNull, not, sql } from 'drizzle-orm'
import { db, schema } from '../../db/client'
import type { BffTransaction } from '../private-overlay'

/**
 * 会话收件箱（`agent_inbox`）里的用户消息与唤醒。忙时发的话排在这里，当前回复可以结束时由
 * `start-turn` 按序号取，每轮一条；后台任务结束要唤醒智能体时，worker 也往这里写一条
 * `task_result`（见 `wake.ts`），与用户消息按同一个序号排队。撤回与取走都是同一条记录上 `pending` 之后的原子更新，
 * 两者只有一个成立。轮到时开不了轮的那一条记成 `failed` 并带上错误码：它不再挡后面的，
 * 留在列表里让用户知道为什么没处理，撤掉才算完。
 *
 * 对澄清卡片的答复（`clarification_answer`）排在队首：智能体停下来等的问题最先得到回答。
 * 智能体问了澄清、还没人作答时，问之前就排着的那些话先等着，不抢在答复前面开轮。
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
  /** 这是对澄清卡片的答复：排在队首，不占普通排队消息的名额。 */
  readonly clarificationAnswer?: boolean
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

/** 用户消息那一类的载荷；唤醒记录不进排队列表，也不按客户端消息 id 查。 */
function userPayload(payload: AgentInboxPayload): AgentInboxUserMessagePayload {
  return 'text' in payload ? payload : { text: '', deviceId: '', referenceCount: 0 }
}

function entryOf(row: InboxRow): InboxEntry {
  const payload = userPayload(row.payload)
  return {
    view: {
      id: row.id,
      clientMessageId: row.client_message_id ?? row.id,
      text: payload.text,
      referenceCount: payload.referenceCount,
      createdAt: row.created_at,
      ...(row.status === 'failed' && row.failure ? { failure: row.failure } : {}),
      ...(row.kind === 'clarification_answer' ? { clarificationAnswer: true as const } : {}),
    },
    state: row.status,
    consumedTurnId: row.consumed_turn_id,
  }
}

const inbox = schema.agent_inbox

/** 用户说的话：普通排队消息与澄清答复。 */
const USER_KINDS = ['user_message', 'clarification_answer'] as const

const isPendingUserMessage = (conversationId: string) =>
  and(
    eq(inbox.conversation_id, conversationId),
    inArray(inbox.kind, [...USER_KINDS]),
    eq(inbox.status, 'pending'),
  )

/**
 * 处理顺序：中断续跑最先（它接着的是更早那一轮没做完的事），然后是澄清答复，其余按序号。
 */
const processingOrder = [
  desc(sql`${inbox.kind} = 'system_event'`),
  desc(sql`${inbox.kind} = 'clarification_answer'`),
  asc(inbox.seq),
]

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
    // 只有会话真在等澄清答复时才让它插到队首：标记由客户端报，可能来自另一台设备上过时的
    // 画面，也可能是有意插队。没在等就当普通消息，照常排队、照常占名额。
    const answering =
      message.clarificationAnswer === true &&
      (await awaitingClarificationSince(conversationId, tx)) !== null
    const kind = answering ? 'clarification_answer' : 'user_message'
    // 名额按种类各算各的：排满了普通消息，也得答得了澄清。
    const [pending] = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(inbox)
      .where(and(isPendingUserMessage(conversationId), eq(inbox.kind, kind)))
    if ((pending?.count ?? 0) >= AGENT_QUEUE_MAX_PENDING) return { kind: 'full' }
    const payload: AgentInboxUserMessagePayload = {
      text: message.text,
      deviceId: message.deviceId,
      referenceCount: message.references.length,
      ...(message.mode ? { mode: message.mode } : {}),
      ...(message.params ? { params: message.params } : {}),
      ...(answering ? { clarificationAnswer: true as const } : {}),
    }
    const [row] = await tx
      .insert(inbox)
      .values({
        conversation_id: conversationId,
        id: crypto.randomUUID(),
        seq: sql`(SELECT COALESCE(MAX(${inbox.seq}), 0) + 1 FROM ${inbox} WHERE ${inbox.conversation_id} = ${conversationId})`,
        kind,
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
        inArray(inbox.kind, [...USER_KINDS]),
        inArray(inbox.status, ['pending', 'failed']),
      ),
    )
    .orderBy(...processingOrder)
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

/**
 * 会话在等澄清答复时，那条澄清落下的时刻：它之后还没有用户消息。不在等就是 null。
 * 澄清之后才发的话本来就是在回答它（界面也这么认），只有问之前就排着的那些要等。
 */
async function awaitingClarificationSince(
  conversationId: string,
  executor: typeof db | BffTransaction = db,
): Promise<number | null> {
  const messages = schema.agent_messages
  const live = and(eq(messages.conversation_id, conversationId), isNull(messages.deleted_at))
  const lastUser = executor
    .select({ seq: sql`COALESCE(MAX(${messages.seq}), 0)` })
    .from(messages)
    .where(and(live, eq(messages.role, 'user')))
  const [row] = await executor
    .select({ createdAt: messages.created_at })
    .from(messages)
    .where(
      and(
        live,
        eq(messages.role, 'assistant'),
        sql`${messages.content} @> '[{"type":"clarification"}]'::jsonb`,
        gt(messages.seq, sql`(${lastUser})`),
      ),
    )
    .orderBy(desc(messages.seq))
    .limit(1)
  return row?.createdAt ?? null
}

/**
 * 收件箱这一行是问澄清之前就排着的普通消息、而那条澄清还没人答：它得等答复先处理。与
 * {@link awaitingClarificationSince} 同一个口径，写成相关子查询，好让巡查在 SQL 里就把它
 * 排除掉——不然一直没人答的澄清会占满巡查的一批，真没人处理的会话反倒轮不上。
 */
export const heldByClarification = sql`(${inbox.kind} = 'user_message' AND EXISTS (
  SELECT 1 FROM ${schema.agent_messages} clarifying
  WHERE clarifying.conversation_id = ${inbox.conversation_id}
    AND clarifying.deleted_at IS NULL
    AND clarifying.role = 'assistant'
    AND clarifying.content @> '[{"type":"clarification"}]'::jsonb
    AND clarifying.created_at >= ${inbox.created_at}
    AND clarifying.seq > (
      SELECT COALESCE(MAX(answered.seq), 0) FROM ${schema.agent_messages} answered
      WHERE answered.conversation_id = ${inbox.conversation_id}
        AND answered.deleted_at IS NULL
        AND answered.role = 'user'
    )
))`

/** 收件箱里有没有还没起轮的唤醒或中断续跑：它们不是用户的话，没人发送时要有人来开轮。 */
export async function hasPendingAgentWake(conversationId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: inbox.id })
    .from(inbox)
    .where(
      and(
        eq(inbox.conversation_id, conversationId),
        inArray(inbox.kind, ['task_result', 'system_event']),
        eq(inbox.status, 'pending'),
      ),
    )
    .limit(1)
  return row !== undefined
}

/** 一条待处理的唤醒：同一次提交里该让智能体回来看的那几个后台任务。 */
export interface QueuedWake extends AgentInboxTaskResultPayload {
  readonly id: string
}

/** 一条待处理的中断续跑：被打断的是哪一轮，续跑沿用它的创作类型与参数。 */
export interface QueuedResume extends AgentInboxResumePayload {
  readonly id: string
}

/** 收件箱里下一件该起一轮去处理的事；澄清答复也算用户消息。 */
export type NextInboxEntry =
  | ({ readonly kind: 'user_message' } & QueuedUserMessage)
  | ({ readonly kind: 'task_result' } & QueuedWake)
  | ({ readonly kind: 'resume' } & QueuedResume)

/** 起一轮去处理的那几类：用户说的话、唤醒与中断续跑（系统事件）。 */
export const TURN_KINDS = [...USER_KINDS, 'task_result', 'system_event'] as const

function queuedMessageOf(row: InboxRow): QueuedUserMessage {
  const payload = userPayload(row.payload)
  return {
    id: row.id,
    clientMessageId: row.client_message_id ?? row.id,
    text: payload.text,
    deviceId: payload.deviceId,
    references: row.attachments ?? [],
    ...(payload.mode ? { mode: payload.mode } : {}),
    ...(payload.params ? { params: payload.params } : {}),
  }
}

/**
 * 起轮的取件顺序：澄清答复最先，其次是用户消息，唤醒最后；同类按序号。有用户消息排着时唤醒
 * 不单独起轮，而是并进那条消息的轮（见 `start-turn.ts`）：用户的话优先，也省一轮费用。
 */
const turnOrder = [
  desc(sql`${inbox.kind} = 'clarification_answer'`),
  asc(sql`${inbox.kind} = 'task_result'`),
  asc(inbox.seq),
]

/**
 * 下一件该处理的事：用户消息或唤醒；只看不取，取走由 {@link consumeAgentMessage} 在起轮事务里做。
 * 澄清答复先取，用户消息先于唤醒，同类按序号先来先处理；会话在等澄清答复时，问之前就排着的话不取。
 */
export async function nextAgentInboxEntry(conversationId: string): Promise<NextInboxEntry | null> {
  const [row] = await db
    .select()
    .from(inbox)
    .where(
      and(
        eq(inbox.conversation_id, conversationId),
        inArray(inbox.kind, [...TURN_KINDS]),
        eq(inbox.status, 'pending'),
        not(heldByClarification),
      ),
    )
    .orderBy(...turnOrder)
    .limit(1)
  if (!row) return null
  if (row.kind === 'task_result' && 'taskIds' in row.payload)
    return { kind: 'task_result', id: row.id, ...row.payload }
  if (row.kind === 'system_event' && 'interruptedTurnId' in row.payload)
    return { kind: 'resume', id: row.id, ...row.payload }
  return { kind: 'user_message', ...queuedMessageOf(row) }
}

/** 还没起轮的全部唤醒，按序号；用户消息的轮据此把它们一并带上。 */
export async function pendingAgentWakes(conversationId: string): Promise<QueuedWake[]> {
  const rows = await db
    .select()
    .from(inbox)
    .where(
      and(
        eq(inbox.conversation_id, conversationId),
        eq(inbox.kind, 'task_result'),
        eq(inbox.status, 'pending'),
      ),
    )
    .orderBy(asc(inbox.seq))
  return rows.flatMap((row) => ('taskIds' in row.payload ? [{ id: row.id, ...row.payload }] : []))
}

/**
 * 没有起轮就了结一条唤醒（积分不足、连续唤醒到了上限）：记成已撤回，不算作一次唤醒。
 * 只有它仍待处理时才成立。
 */
export async function skipAgentWake(
  tx: BffTransaction,
  conversationId: string,
  id: string,
): Promise<boolean> {
  const rows = await tx
    .update(inbox)
    .set({ status: 'cancelled' })
    .where(
      and(
        eq(inbox.conversation_id, conversationId),
        eq(inbox.id, id),
        eq(inbox.kind, 'task_result'),
        eq(inbox.status, 'pending'),
      ),
    )
    .returning({ id: inbox.id })
  return rows.length > 0
}

/**
 * 用户上次说话之后，连续自动唤醒起过几轮。唤醒轮是取走了唤醒、自己没有用户消息、并且真的跑过
 * （留下了页脚）的那一轮；并进用户消息那一轮的唤醒不算，被跳过的唤醒也不算。用户一说话就从零算起。
 */
export async function consecutiveAgentWakes(
  conversationId: string,
  executor: typeof db | BffTransaction = db,
): Promise<number> {
  const messages = schema.agent_messages
  const lastUserAt = executor
    .select({ at: sql`COALESCE(MAX(${messages.created_at}), '-infinity'::timestamptz)` })
    .from(messages)
    .where(
      and(
        eq(messages.conversation_id, conversationId),
        eq(messages.role, 'user'),
        isNull(messages.deleted_at),
      ),
    )
  const [row] = await executor
    .select({ count: sql<number>`count(DISTINCT ${inbox.consumed_turn_id})::int` })
    .from(inbox)
    .where(
      and(
        eq(inbox.conversation_id, conversationId),
        eq(inbox.kind, 'task_result'),
        eq(inbox.status, 'consumed'),
        gt(inbox.created_at, sql`(${lastUserAt})`),
        sql`NOT EXISTS (
          SELECT 1 FROM ${messages} spoken
          WHERE spoken.conversation_id = ${inbox.conversation_id}
            AND spoken.turn_id = ${inbox.consumed_turn_id}
            AND spoken.role = 'user'
        )`,
        sql`EXISTS (
          SELECT 1 FROM ${schema.agent_turns} ran
          WHERE ran.conversation_id = ${inbox.conversation_id}
            AND ran.turn_id = ${inbox.consumed_turn_id}
        )`,
      ),
    )
  return row?.count ?? 0
}

/**
 * 写一条唤醒进收件箱，排在已有的之后。调用方已经锁着会话行（见 `wake.ts`），序号不会与并发的
 * 入队撞上。返回它的 id。
 */
export async function enqueueAgentWake(
  tx: BffTransaction,
  conversationId: string,
  payload: AgentInboxTaskResultPayload,
  now: number,
): Promise<string> {
  const id = crypto.randomUUID()
  await tx.insert(inbox).values({
    conversation_id: conversationId,
    id,
    seq: sql`(SELECT COALESCE(MAX(${inbox.seq}), 0) + 1 FROM ${inbox} WHERE ${inbox.conversation_id} = ${conversationId})`,
    kind: 'task_result',
    status: 'pending',
    payload,
    created_at: now,
  })
  return id
}

/** 中断续跑记录的客户端消息 id：同一轮只能排进一次，重复的补写不会排出第二条。 */
export const agentResumeKey = (turnId: string) => `resume:${turnId}`

/**
 * 为被打断的那一轮排一次中断续跑。同一轮只排一次（按客户端消息 id 去重），所以反复补写、
 * 多个实例同时接手都只续一次。返回这一次是不是真排进去了。传入事务时在那个事务里排：
 * 补写页脚的一方用它把「排上续跑」与「落下页脚」写成同一件事。
 */
export async function enqueueAgentResume(
  conversationId: string,
  payload: AgentInboxResumePayload,
  now = Date.now(),
  executor?: BffTransaction,
): Promise<boolean> {
  const write = async (tx: BffTransaction) => {
    // 锁住会话行：序号与并发的入队、唤醒排成一列，不会撞号。
    await tx
      .select({ id: schema.agent_conversations.id })
      .from(schema.agent_conversations)
      .where(eq(schema.agent_conversations.id, conversationId))
      .for('update')
    const rows = await tx
      .insert(inbox)
      .values({
        conversation_id: conversationId,
        id: crypto.randomUUID(),
        seq: sql`(SELECT COALESCE(MAX(${inbox.seq}), 0) + 1 FROM ${inbox} WHERE ${inbox.conversation_id} = ${conversationId})`,
        kind: 'system_event',
        status: 'pending',
        client_message_id: agentResumeKey(payload.interruptedTurnId),
        payload,
        created_at: now,
      })
      .onConflictDoNothing()
      .returning({ id: inbox.id })
    return rows.length > 0
  }
  return executor ? write(executor) : db.transaction(write)
}

/** 这一轮被打断后是否排上过中断续跑（不论后来有没有跑完）。 */
export async function agentResumeQueued(conversationId: string, turnId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: inbox.id })
    .from(inbox)
    .where(
      and(
        eq(inbox.conversation_id, conversationId),
        eq(inbox.client_message_id, agentResumeKey(turnId)),
      ),
    )
    .limit(1)
  return row !== undefined
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
  if (rows.length === 0) return false
  // 之前停止时退回的那几条留着参考图，只为让丢了响应的客户端重试时还拿得回；开了新的一轮，
  // 那次停止早已尘埃落定，原件不再留。
  await tx
    .update(inbox)
    .set({ attachments: null })
    .where(
      and(
        eq(inbox.conversation_id, conversationId),
        eq(inbox.status, 'cancelled'),
        isNotNull(inbox.attachments),
      ),
    )
  return true
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

/**
 * 要升级为插话的那一条此刻的正文与参考图：只看不取。取走由 {@link claimAgentMessageForInterjection}
 * 在插话真正进那一轮的前一刻做——参考图校验与归档要花几秒，这期间它仍然排着，停止、撤回、
 * 起轮都照常拿得到它；进程半路没了，它也还在队里。
 */
export async function pendingAgentMessage(
  conversationId: string,
  id: string,
): Promise<
  | { readonly kind: 'pending'; readonly message: QueuedUserMessage }
  | { readonly kind: 'unavailable'; readonly result: AgentQueueInterjectResult }
> {
  const [row] = await db
    .select()
    .from(inbox)
    .where(and(eq(inbox.conversation_id, conversationId), eq(inbox.id, id)))
  if (!row || !USER_KINDS.includes(row.kind as (typeof USER_KINDS)[number]))
    return { kind: 'unavailable', result: 'not_found' }
  if (row.status === 'pending') return { kind: 'pending', message: queuedMessageOf(row) }
  return {
    kind: 'unavailable',
    result: row.status === 'consumed' ? 'already_consumed' : 'cancelled',
  }
}

/**
 * 把一条排队消息记成被这一轮以插话取走：与撤回、停止、起轮争同一行，只有一个成立。插不进去
 * （那一轮刚好收尾）就用 {@link requeueAgentMessage} 放回去。
 */
export async function claimAgentMessageForInterjection(
  conversationId: string,
  id: string,
  turnId: string,
): Promise<boolean> {
  const rows = await db
    .update(inbox)
    .set({ status: 'consumed', consumed_turn_id: turnId })
    .where(
      and(eq(inbox.conversation_id, conversationId), eq(inbox.id, id), eq(inbox.status, 'pending')),
    )
    .returning({ id: inbox.id })
  return rows.length > 0
}

/** 插话已经进了那一轮：参考图原件归那一轮归档，收件箱里不再留。 */
export async function settleAgentInterjection(conversationId: string, id: string): Promise<void> {
  await db
    .update(inbox)
    .set({ attachments: null })
    .where(and(eq(inbox.conversation_id, conversationId), eq(inbox.id, id)))
}

/** 升级没成（那一轮刚好收尾）：放回待处理，照旧排在原来的位置。 */
export async function requeueAgentMessage(
  conversationId: string,
  id: string,
  turnId: string,
): Promise<void> {
  await db
    .update(inbox)
    .set({ status: 'pending', consumed_turn_id: null })
    .where(
      and(
        eq(inbox.conversation_id, conversationId),
        eq(inbox.id, id),
        eq(inbox.status, 'consumed'),
        eq(inbox.consumed_turn_id, turnId),
      ),
    )
}

/** 停止退回的结果：`returned` 是这次停止退回的全部，`fresh` 是这一次调用才撤下的那几条。 */
export interface ReturnedAgentMessages {
  readonly returned: AgentReturnedQueuedMessage[]
  readonly fresh: readonly string[]
}

const returnedBy = (conversationId: string, turnId: string) =>
  and(
    eq(inbox.conversation_id, conversationId),
    inArray(inbox.kind, [...USER_KINDS]),
    eq(inbox.status, 'cancelled'),
    eq(inbox.consumed_turn_id, turnId),
  )

const returnedView = (row: InboxRow): AgentReturnedQueuedMessage => ({
  id: row.id,
  text: userPayload(row.payload).text,
  references: row.attachments ?? [],
})

/**
 * 停止当前回复时把还没处理的排队消息全部退回：一次原子更新撤掉它们（连同轮到时没能开轮的
 * 那几条），按原先的处理顺序交还正文与参考图，由客户端放回输入框。
 *
 * 退回的记录记下是哪一轮的停止退回的，参考图也先留着：停止的响应丢了（超时、断网），客户端
 * 重发同一个停止请求时拿得回同一批，不会因为服务端已经撤掉而两头落空。
 */
export async function returnAgentMessages(
  conversationId: string,
  turnId: string,
): Promise<ReturnedAgentMessages> {
  return db.transaction(async (tx) => {
    // 锁住这几行再撤：与之并发的起轮、撤回、升级都得等这一笔落定，结局只有一个。
    const rows = await tx
      .select({ id: inbox.id })
      .from(inbox)
      .where(
        and(
          eq(inbox.conversation_id, conversationId),
          inArray(inbox.kind, [...USER_KINDS]),
          inArray(inbox.status, ['pending', 'failed']),
        ),
      )
      .for('update')
    const fresh = rows.map((row) => row.id)
    if (fresh.length)
      await tx
        .update(inbox)
        .set({ status: 'cancelled', consumed_turn_id: turnId })
        .where(and(eq(inbox.conversation_id, conversationId), inArray(inbox.id, fresh)))
    const returned = await tx
      .select()
      .from(inbox)
      .where(returnedBy(conversationId, turnId))
      .orderBy(...processingOrder)
    return { returned: returned.map(returnedView), fresh }
  })
}

/** 某一轮的停止已经退回的排队消息；那一轮已经收尾、客户端重发停止请求时据此交还。 */
export async function returnedAgentMessages(
  conversationId: string,
  turnId: string,
): Promise<AgentReturnedQueuedMessage[]> {
  const rows = await db
    .select()
    .from(inbox)
    .where(returnedBy(conversationId, turnId))
    .orderBy(...processingOrder)
  return rows.map(returnedView)
}
