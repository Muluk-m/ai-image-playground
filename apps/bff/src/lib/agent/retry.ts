import type {
  AgentMessageView,
  AgentToolErrorCode,
  AgentToolResultBlock,
} from '@image-playground/shared'
import { agentToolRetryable } from '@image-playground/shared'
import { and, asc, eq, isNull, sql } from 'drizzle-orm'
import { db, schema } from '../../db/client'
import { cancelTasks } from '../../db/task-transitions'
import { resolveQueueModel } from '../channels'
import { hydrateInputImages } from '../imageArchive'
import { log } from '../logger'
import type { BffTransaction } from '../private-overlay'
import { asQueueProvider } from '../queueProvider'
import { createQueueTask } from '../taskSubmission'
import { settleAgentJobs } from './background-jobs'
import { appendAgentMessage } from './conversations'
import { queueRefusalCode } from './tools/errors'

/**
 * 单张重试：用户在一个失败占位上点重试，按那次调用起跑时的参数快照与此刻的价格重出这一张，
 * 不调用对话模型。重试不改写原卡，而是在对话末尾追加一条重试记录；记录本身是一个后台任务，
 * 结局照后台任务的规矩结算（见 `background-jobs.ts`）。重试失败不唤醒智能体：失败就在用户眼前。
 *
 * 重试排成会话级的队：同一时刻一个会话只跑一条重试，其余的记录以 `queued` 落库，刷新、换设备
 * 都看得见，可以逐条撤回。前一条结束后按先后提交下一条；轮到的那条因积分或额度不够、没登录
 * 被拒时，队里剩下的全部撤回，不刷出一串同样的错。
 */

export interface AgentRetryInput {
  /** 已经按归属确权过的会话。 */
  readonly conversationId: string
  readonly messageId: string
  readonly placeholderId?: string
  readonly deviceId: string
  readonly userId: string | null
}

export type AgentRetryOutcome =
  | { readonly kind: 'created'; readonly message: AgentMessageView }
  /** 同一个失败占位上已有一次重试在跑（或已经补上）：原样给回那一条，不再扣第二次。 */
  | { readonly kind: 'replayed'; readonly message: AgentMessageView }
  | { readonly kind: 'not_found' }
  | { readonly kind: 'not_retryable' }
  | { readonly kind: 'refused'; readonly code: AgentToolErrorCode }

/** 轮到时被拒就让队里剩下的全部撤回的那几类：换哪一条都会同样被拒。 */
const QUEUE_STOPPING_CODES: ReadonlySet<AgentToolErrorCode> = new Set([
  'insufficient_credits',
  'quota_exceeded',
  'authentication_required',
])

type ToolMessage = AgentMessageView & { readonly block: AgentToolResultBlock }

/** 读回来的消息先结算后台任务，卡上的状态才是此刻的样子。 */
async function settledToolMessages(
  conversationId: string,
  rows: readonly (typeof schema.agent_messages.$inferSelect)[],
): Promise<ToolMessage[]> {
  const settled = await settleAgentJobs(
    conversationId,
    rows.map((row) => ({
      id: row.id,
      turnId: row.turn_id,
      role: row.role,
      content: row.content,
      createdAt: row.created_at,
    })),
  )
  return settled.flatMap((message) => {
    const block = message.content.find(
      (one): one is AgentToolResultBlock => one.type === 'toolResult',
    )
    return block ? [{ ...message, block }] : []
  })
}

/**
 * 同一张失败卡、同一个失败占位上还在排队、在跑或已经补上的那条重试。双击、另一台设备在云端
 * 文档刷新之前再点一次，都落到这里：给回它，而不是再排一次、再扣一次。失败、中止或撤回的重试
 * 不算，用户还能接着重试。
 */
async function liveRetryOf(
  conversationId: string,
  messageId: string,
  placeholderId: string | undefined,
): Promise<ToolMessage | null> {
  const rows = await db
    .select()
    .from(schema.agent_messages)
    .where(
      and(
        eq(schema.agent_messages.conversation_id, conversationId),
        isNull(schema.agent_messages.deleted_at),
        // 重试记录只有一块：那张结果卡。
        sql`${schema.agent_messages.content} -> 0 -> 'retryOf' ->> 'messageId' = ${messageId}`,
      ),
    )
    .orderBy(asc(schema.agent_messages.seq))
  const records = await settledToolMessages(conversationId, rows)
  return (
    records.find(
      (record) =>
        record.block.retryOf?.placeholderId === placeholderId &&
        (record.block.status === 'queued' ||
          record.block.status === 'submitted' ||
          record.block.status === 'succeeded'),
    ) ?? null
  )
}

/** 读一张工具结果卡；没结算的后台任务先结算，卡上的状态才是此刻的样子。 */
async function readToolMessage(
  conversationId: string,
  messageId: string,
): Promise<ToolMessage | null> {
  const [row] = await db
    .select()
    .from(schema.agent_messages)
    .where(
      and(
        eq(schema.agent_messages.conversation_id, conversationId),
        eq(schema.agent_messages.id, messageId),
        isNull(schema.agent_messages.deleted_at),
      ),
    )
    .limit(1)
  if (!row) return null
  const [message] = await settledToolMessages(conversationId, [row])
  return message ?? null
}

/** 重试队列的会话锁：入队、提交下一条、撤回都在它下面串成一条，跨实例、跨设备也只有一个结局。 */
async function lockRetryQueue(tx: BffTransaction, conversationId: string): Promise<void> {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${JSON.stringify(['agent-retry-queue', conversationId])}, 0))`,
  )
}

/** 队里还没结束的重试记录（排着的与在跑的），按先后。在跑的先结算，状态才是此刻的样子。 */
async function openRetryRecords(conversationId: string): Promise<ToolMessage[]> {
  const rows = await db
    .select()
    .from(schema.agent_messages)
    .where(
      and(
        eq(schema.agent_messages.conversation_id, conversationId),
        isNull(schema.agent_messages.deleted_at),
        sql`${schema.agent_messages.content} -> 0 -> 'retryOf' IS NOT NULL`,
        sql`${schema.agent_messages.content} -> 0 ->> 'status' IN ('queued', 'submitted')`,
      ),
    )
    .orderBy(asc(schema.agent_messages.seq))
  const records = await settledToolMessages(conversationId, rows)
  return records.filter(
    (record) => record.block.status === 'queued' || record.block.status === 'submitted',
  )
}

/** 把一条重试记录就地改写；只在它还是读到时的样子才写，返回是否写上了。 */
async function rewriteRecord(
  conversationId: string,
  record: ToolMessage,
  block: AgentToolResultBlock,
): Promise<boolean> {
  const updated = await db
    .update(schema.agent_messages)
    .set({ content: [block] })
    .where(
      and(
        eq(schema.agent_messages.conversation_id, conversationId),
        eq(schema.agent_messages.id, record.id),
        // 参数先定成 text 再转：直接写 `::jsonb`，驱动会把这串 JSON 再编码成一个 jsonb 字符串。
        sql`${schema.agent_messages.content} = ${JSON.stringify(record.content)}::text::jsonb`,
      ),
    )
    .returning({ id: schema.agent_messages.id })
  return updated.length > 0
}

/** 撤回（用户撤的，或轮到的那条被拒后整队撤的）：记录收成取消，失败占位回到原来那次失败。 */
function withdrawnBlock(block: AgentToolResultBlock, message: string): AgentToolResultBlock {
  const { job: _job, ...rest } = block
  return { ...rest, status: 'failed', errorCode: 'cancelled', message }
}

interface RetryPlan {
  readonly failed: ToolMessage
  readonly job: NonNullable<AgentToolResultBlock['job']>
  readonly snapshot: NonNullable<AgentToolResultBlock['snapshot']>
  readonly target: { readonly provider: string; readonly model: string }
}

/** 这张失败卡此刻能不能原样重试、用哪个模型。模型要的是快照里那一个：它下线了就交给智能体。 */
async function planRetry(
  conversationId: string,
  messageId: string,
): Promise<RetryPlan | Exclude<AgentRetryOutcome, { kind: 'created' | 'replayed' }>> {
  const failed = await readToolMessage(conversationId, messageId)
  if (!failed) return { kind: 'not_found' }
  const { block } = failed
  if (!agentToolRetryable(block) || !block.job || !block.snapshot?.target)
    return { kind: 'not_retryable' }
  const target = resolveQueueModel(block.job.media, block.snapshot.target.model)
  if (!target || target.model !== block.snapshot.target.model)
    return { kind: 'refused', code: 'model_unavailable' }
  return { failed, job: block.job, snapshot: block.snapshot, target }
}

function isPlan(value: RetryPlan | AgentRetryOutcome): value is RetryPlan {
  return !('kind' in value)
}

/** 一条重试记录：挂在对话末尾、指回原失败卡与要落回的那个失败占位。 */
function retryRecord(
  plan: RetryPlan,
  turnId: string,
  placeholderId: string | undefined,
  job: AgentToolResultBlock['job'],
): AgentToolResultBlock {
  const { block } = plan.failed
  return {
    type: 'toolResult',
    toolCallId: `retry-${turnId}`,
    toolName: block.toolName,
    status: job ? 'submitted' : 'queued',
    title: block.title,
    ...(block.prompt ? { prompt: block.prompt } : {}),
    ...(block.anchorObjectId ? { anchorObjectId: block.anchorObjectId } : {}),
    snapshot: plan.snapshot,
    ...(job ? { job } : {}),
    retryOf: {
      messageId: plan.failed.id,
      toolCallId: block.toolCallId,
      ...(placeholderId ? { placeholderId } : {}),
    },
  }
}

type SubmitOutcome =
  | { readonly kind: 'created'; readonly job: NonNullable<AgentToolResultBlock['job']> }
  | { readonly kind: 'not_retryable' }
  | { readonly kind: 'refused'; readonly code: AgentToolErrorCode }

/**
 * 按快照提交这一张。参数来自起跑时的快照，那次调用实际送出的请求（含已归档的输入图）也按它
 * 落在失败任务上；字节从这里取，就不必在轮外重新解析模型说过的图片 id。设备缺席（队里轮到时
 * 没有请求在场）就沿用那次调用的设备。
 */
async function submitRetryTask(
  plan: RetryPlan,
  input: {
    readonly conversationId: string
    readonly turnId: string
    readonly placeholderId: string | undefined
    readonly deviceId: string | undefined
    readonly userId: string | null
  },
): Promise<SubmitOutcome> {
  const [original] = await db
    .select({ provider: schema.tasks.provider, request: schema.tasks.request_payload })
    .from(schema.tasks)
    .where(
      and(
        eq(schema.tasks.id, plan.job.taskId),
        eq(schema.tasks.agent_conversation_id, input.conversationId),
      ),
    )
    .limit(1)
  if (!original || asQueueProvider(original.provider) !== plan.target.provider)
    return { kind: 'not_retryable' }
  const { video, client_request_id: _command, ...persisted } = original.request
  const { video: _hydratedVideo, ...request } = await hydrateInputImages(persisted)
  const deviceId = input.deviceId ?? persisted.device_id
  const submitted = await createQueueTask({
    provider: plan.target.provider,
    model: plan.target.model,
    request: { ...request, n: 1, ...(deviceId ? { device_id: deviceId } : {}) },
    ...(video ? { video } : {}),
    userId: input.userId,
    // 重试自成一轮：任务、项目预留与重试记录都挂在它下面，与原来那一轮互不相干。
    agent: { conversationId: input.conversationId, turnId: input.turnId },
    ...(input.placeholderId ? { projectSlot: input.placeholderId } : {}),
  })
  if (submitted.kind !== 'created')
    return { kind: 'refused', code: queueRefusalCode(submitted.kind) }
  return {
    kind: 'created',
    job: {
      taskId: submitted.taskId,
      media: plan.job.media,
      ...(plan.job.video ? { video: plan.job.video } : {}),
    },
  }
}

/**
 * 用户在一个失败占位上点了重试。同一个占位上已有一条排着、在跑或已补上的就原样给回它；会话里
 * 已有别的重试没结束，这一条以 `queued` 排在后面；否则当场提交。
 */
export async function retryAgentToolCall(input: AgentRetryInput): Promise<AgentRetryOutcome> {
  const outcome = await db.transaction(async (tx) => {
    await lockRetryQueue(tx, input.conversationId)
    const live = await liveRetryOf(input.conversationId, input.messageId, input.placeholderId)
    if (live) {
      const { block: _block, ...message } = live
      return { kind: 'replayed' as const, message }
    }
    const plan = await planRetry(input.conversationId, input.messageId)
    if (!isPlan(plan)) return plan
    const turnId = crypto.randomUUID()
    if ((await openRetryRecords(input.conversationId)).length > 0) {
      const message = await appendAgentMessage(tx, {
        conversationId: input.conversationId,
        turnId,
        role: 'assistant',
        content: [retryRecord(plan, turnId, input.placeholderId, undefined)],
      })
      return { kind: 'created' as const, message }
    }
    const submitted = await submitRetryTask(plan, {
      conversationId: input.conversationId,
      turnId,
      placeholderId: input.placeholderId,
      deviceId: input.deviceId,
      userId: input.userId,
    })
    if (submitted.kind !== 'created') return submitted
    try {
      const message = await appendAgentMessage(tx, {
        conversationId: input.conversationId,
        turnId,
        role: 'assistant',
        content: [retryRecord(plan, turnId, input.placeholderId, submitted.job)],
      })
      return { kind: 'created' as const, message }
    } catch (error) {
      // 记录没落下，任务就不能留着花钱：撤掉它，按原桶退回。
      log.error(
        { event: 'agent.retry_record_failed', taskId: submitted.job.taskId, err: error },
        'retry record failed',
      )
      await cancelTasks(eq(schema.tasks.id, submitted.job.taskId), {
        failedAs: plan.failed.block.errorCode,
      })
      throw error
    }
  })
  const record = outcome.kind === 'created' ? outcome.message.content[0] : undefined
  if (record?.type === 'toolResult' && record.status === 'queued')
    watchRetryQueue(input.conversationId)
  return outcome
}

/**
 * 推进一个会话的重试队列：在跑的那条还没结束就什么也不做；否则按先后提交排着的下一条。
 * 轮到的那条提交不了就记成失败（按拒绝的码给出路）；是积分、额度或登录的问题就把剩下的全部撤回。
 * 返回推进之后还排着的条数。
 */
export async function advanceAgentRetryQueue(conversationId: string): Promise<number> {
  return db.transaction(async (tx) => {
    await lockRetryQueue(tx, conversationId)
    const [conversation] = await db
      .select({ userId: schema.agent_conversations.user_id })
      .from(schema.agent_conversations)
      .where(
        and(
          eq(schema.agent_conversations.id, conversationId),
          isNull(schema.agent_conversations.deleted_at),
        ),
      )
      .limit(1)
    if (!conversation) return 0
    const open = await openRetryRecords(conversationId)
    const queued = open.filter((record) => record.block.status === 'queued')
    if (queued.length === 0 || open.some((record) => record.block.status === 'submitted'))
      return queued.length
    for (const [index, record] of queued.entries()) {
      const code = await submitQueuedRecord(conversationId, record, conversation.userId)
      if (code === null) return queued.length - index - 1
      if (code === 'written_elsewhere') continue
      if (QUEUE_STOPPING_CODES.has(code)) {
        for (const rest of queued.slice(index + 1))
          await rewriteRecord(
            conversationId,
            rest,
            withdrawnBlock(rest.block, `前一条重试没能提交（${code}），排队的重试已撤回`),
          )
        return 0
      }
    }
    return 0
  })
}

/**
 * 提交排着的这一条重试。提交上了返回 null；记录在锁外被改过（不该发生）返回
 * `written_elsewhere`；否则把记录收成失败并返回拒绝的码。任何一步抛错都收成 `unknown` 的失败：
 * 队头不能卡住，后面的重试也不能跟着永远排着。
 */
async function submitQueuedRecord(
  conversationId: string,
  record: ToolMessage,
  userId: string | null,
): Promise<AgentToolErrorCode | 'written_elsewhere' | null> {
  const origin = record.block.retryOf!
  let code: AgentToolErrorCode
  try {
    const plan = await planRetry(conversationId, origin.messageId)
    const submitted: SubmitOutcome = isPlan(plan)
      ? await submitRetryTask(plan, {
          conversationId,
          turnId: record.turnId,
          placeholderId: origin.placeholderId,
          deviceId: undefined,
          userId,
        })
      : plan.kind === 'refused'
        ? plan
        : { kind: 'refused', code: 'unknown' }
    if (submitted.kind === 'created') {
      const failedAs = isPlan(plan) ? plan.failed.block.errorCode : undefined
      let written: boolean
      try {
        written = await rewriteRecord(conversationId, record, {
          ...record.block,
          status: 'submitted',
          job: submitted.job,
        })
      } catch (error) {
        // 记录没改上，任务就不能留着花钱，否则下一次巡到还会再提交一遍、再扣一次。
        await cancelTasks(eq(schema.tasks.id, submitted.job.taskId), failedAs ? { failedAs } : {})
        throw error
      }
      if (written) return null
      // 记录在锁外被改过（不该发生）：任务不能留着花钱。
      await cancelTasks(eq(schema.tasks.id, submitted.job.taskId), failedAs ? { failedAs } : {})
      return 'written_elsewhere'
    }
    code = submitted.kind === 'refused' ? submitted.code : 'unknown'
  } catch (err) {
    log.error(
      { event: 'agent.retry_submit_failed', conversationId, messageId: record.id, err },
      'queued retry could not be submitted',
    )
    code = 'unknown'
  }
  await rewriteRecord(conversationId, record, {
    ...record.block,
    status: 'failed',
    errorCode: code,
    message: `重试没能提交（${code}）`,
  })
  return code
}

/** 推进重试队列，但不让它的失败连累调用方：列后台任务、撤回之后的补位都不该因此报错。 */
export async function advanceAgentRetryQueueSafely(conversationId: string): Promise<void> {
  try {
    await advanceAgentRetryQueue(conversationId)
  } catch (err) {
    log.error(
      { event: 'agent.retry_advance_failed', conversationId, err },
      'retry queue could not be advanced',
    )
  }
}

export type AgentRetryCancelOutcome = 'cancelled' | 'not_found' | 'finished'

/**
 * 撤回一条排着的重试，或中止一条还在跑的重试（按原桶退回）。两者之后失败占位都回到原来那次
 * 失败，用户还能再点；队里的下一条随即补上。云端项目里在跑那条占的位置留作原来那次失败。
 */
export async function cancelAgentRetry(
  conversationId: string,
  messageId: string,
): Promise<AgentRetryCancelOutcome> {
  const outcome = await db.transaction(async (tx): Promise<AgentRetryCancelOutcome> => {
    await lockRetryQueue(tx, conversationId)
    const record = await readToolMessage(conversationId, messageId)
    if (!record?.block.retryOf) return 'not_found'
    if (record.block.status === 'queued') {
      const written = await rewriteRecord(
        conversationId,
        record,
        withdrawnBlock(record.block, '重试已撤回'),
      )
      return written ? 'cancelled' : 'finished'
    }
    if (record.block.status !== 'submitted') return 'finished'
    if (!record.block.job) return 'not_found'
    const origin = await readToolMessage(conversationId, record.block.retryOf.messageId)
    const cancelled = await cancelTasks(
      and(
        eq(schema.tasks.id, record.block.job.taskId),
        eq(schema.tasks.agent_conversation_id, conversationId),
      )!,
      origin?.block.errorCode ? { failedAs: origin.block.errorCode } : {},
    )
    return cancelled.length > 0 ? 'cancelled' : 'finished'
  })
  if (outcome === 'cancelled') await advanceAgentRetryQueueSafely(conversationId)
  return outcome
}

/**
 * 重试队列的推进不跟请求：前一条重试的任务在 worker 里结束，没有人来敲门。这里按间隔巡：本实例
 * 知道有排队的会话每次都看，全表每隔几次（以及开机时）扫一遍，接手别的实例留下的队。
 * 看着这个会话的客户端每次问后台任务时也会推一下（`GET .../jobs`），不必等巡到。
 */
const watchedQueues = new Set<string>()

export function watchRetryQueue(conversationId: string): void {
  watchedQueues.add(conversationId)
}

/** 一次最多接手这么多个会话；剩下的下一次再接。 */
const RETRY_PICKUP_BATCH = 50
export const AGENT_RETRY_PICKUP_INTERVAL_MS = 5_000
/** 每巡这么多次扫一次全表。 */
const RETRY_FULL_SCAN_EVERY = 12

/** 还有排着的重试、会话没被删的那几个会话。 */
export async function queuedRetryConversations(limit = RETRY_PICKUP_BATCH): Promise<string[]> {
  const rows = await db
    .selectDistinct({ id: schema.agent_messages.conversation_id })
    .from(schema.agent_messages)
    .innerJoin(
      schema.agent_conversations,
      eq(schema.agent_conversations.id, schema.agent_messages.conversation_id),
    )
    .where(
      and(
        isNull(schema.agent_messages.deleted_at),
        isNull(schema.agent_conversations.deleted_at),
        sql`${schema.agent_messages.content} -> 0 -> 'retryOf' IS NOT NULL`,
        sql`${schema.agent_messages.content} -> 0 ->> 'status' = 'queued'`,
      ),
    )
    .limit(limit)
  return rows.map((row) => row.id)
}

/** 巡一次：推进每个有排队重试的会话。`full` 时先扫全表。返回推进之后仍有排队的会话数。 */
export async function pickUpRetryQueues(full: boolean): Promise<number> {
  if (full) for (const id of await queuedRetryConversations()) watchedQueues.add(id)
  for (const conversationId of [...watchedQueues]) {
    try {
      const left = await advanceAgentRetryQueue(conversationId)
      if (left === 0) watchedQueues.delete(conversationId)
    } catch (err) {
      log.error(
        { event: 'agent.retry_pickup_failed', conversationId, err },
        'queued retry could not be advanced',
      )
    }
  }
  return watchedQueues.size
}

/** 开机先扫一遍全表，之后按间隔巡。返回停止函数。 */
export function startRetryQueuePickup(intervalMs = AGENT_RETRY_PICKUP_INTERVAL_MS): () => void {
  let running = false
  let ticks = 0
  const tick = async () => {
    if (running) return
    running = true
    try {
      await pickUpRetryQueues(ticks % RETRY_FULL_SCAN_EVERY === 0)
    } catch (err) {
      log.error({ event: 'agent.retry_pickup_failed', err }, 'retry queue scan failed')
    } finally {
      ticks += 1
      running = false
    }
  }
  void tick()
  const timer = setInterval(() => void tick(), intervalMs)
  return () => clearInterval(timer)
}
