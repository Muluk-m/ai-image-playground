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
 * 同一张失败卡、同一个失败占位上还在跑或已经补上的那条重试。双击、另一台设备在云端文档刷新
 * 之前再点一次，都落到这里：给回它，而不是再提交一次、再扣一次。失败或中止的重试不算，
 * 用户还能接着重试。
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
        (record.block.status === 'submitted' || record.block.status === 'succeeded'),
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

/**
 * 同一个失败占位上的重试排成一队：两次点击（或两台设备）不会各自看见「还没有重试」然后各扣一次。
 * 锁随事务放开，那时前一条重试记录已经落库，后到的据此原样给回它。
 */
export async function retryAgentToolCall(input: AgentRetryInput): Promise<AgentRetryOutcome> {
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${JSON.stringify(['agent-retry', input.conversationId, input.messageId, input.placeholderId ?? null])}, 0))`,
    )
    const live = await liveRetryOf(input.conversationId, input.messageId, input.placeholderId)
    if (live) {
      const { block: _block, ...message } = live
      return { kind: 'replayed', message }
    }
    return submitRetry(tx, input)
  })
}

async function submitRetry(tx: BffTransaction, input: AgentRetryInput): Promise<AgentRetryOutcome> {
  const failed = await readToolMessage(input.conversationId, input.messageId)
  if (!failed) return { kind: 'not_found' }
  const { block } = failed
  if (!agentToolRetryable(block) || !block.job || !block.snapshot?.target)
    return { kind: 'not_retryable' }

  // 模型要的是快照里那一个：它下线了就不原样重试，交给智能体换个做法。
  const media = block.job.media
  const target = resolveQueueModel(media, block.snapshot.target.model)
  if (!target || target.model !== block.snapshot.target.model)
    return { kind: 'refused', code: 'model_unavailable' }

  // 参数来自起跑时的快照，那次调用实际送出的请求（含已归档的输入图）也按它落在失败任务上；
  // 字节从这里取，就不必在轮外重新解析模型说过的图片 id。
  const [original] = await db
    .select({ provider: schema.tasks.provider, request: schema.tasks.request_payload })
    .from(schema.tasks)
    .where(
      and(
        eq(schema.tasks.id, block.job.taskId),
        eq(schema.tasks.agent_conversation_id, input.conversationId),
      ),
    )
    .limit(1)
  if (!original || asQueueProvider(original.provider) !== target.provider)
    return { kind: 'not_retryable' }
  const { video, client_request_id: _command, ...persisted } = original.request
  const { video: _hydratedVideo, ...request } = await hydrateInputImages(persisted)

  // 重试自成一轮：任务、项目预留与重试记录都挂在它下面，与原来那一轮互不相干。
  const turnId = crypto.randomUUID()
  const submitted = await createQueueTask({
    provider: target.provider,
    model: target.model,
    request: { ...request, n: 1, device_id: input.deviceId },
    ...(video ? { video } : {}),
    userId: input.userId,
    agent: { conversationId: input.conversationId, turnId },
    ...(input.placeholderId ? { projectSlot: input.placeholderId } : {}),
  })
  if (submitted.kind !== 'created')
    return { kind: 'refused', code: queueRefusalCode(submitted.kind) }

  const record: AgentToolResultBlock = {
    type: 'toolResult',
    toolCallId: `retry-${turnId}`,
    toolName: block.toolName,
    status: 'submitted',
    title: block.title,
    ...(block.prompt ? { prompt: block.prompt } : {}),
    ...(block.anchorObjectId ? { anchorObjectId: block.anchorObjectId } : {}),
    snapshot: block.snapshot,
    job: {
      taskId: submitted.taskId,
      media,
      ...(block.job.video ? { video: block.job.video } : {}),
    },
    retryOf: {
      messageId: failed.id,
      toolCallId: block.toolCallId,
      ...(input.placeholderId ? { placeholderId: input.placeholderId } : {}),
    },
  }
  try {
    const message = await appendAgentMessage(tx, {
      conversationId: input.conversationId,
      turnId,
      role: 'assistant',
      content: [record],
    })
    return { kind: 'created', message }
  } catch (error) {
    // 记录没落下，任务就不能留着花钱：撤掉它，按原桶退回。
    log.error(
      { event: 'agent.retry_record_failed', taskId: submitted.taskId, err: error },
      'retry record failed',
    )
    await cancelTasks(eq(schema.tasks.id, submitted.taskId), { failedAs: block.errorCode })
    throw error
  }
}

export type AgentRetryCancelOutcome = 'cancelled' | 'not_found' | 'finished'

/**
 * 中止一条还在跑的重试，按原桶退回。云端项目里它占的位置留作原来那次失败，用户还能再点重试。
 */
export async function cancelAgentRetry(
  conversationId: string,
  messageId: string,
): Promise<AgentRetryCancelOutcome> {
  const record = await readToolMessage(conversationId, messageId)
  if (!record?.block.retryOf || !record.block.job) return 'not_found'
  if (record.block.status !== 'submitted') return 'finished'
  const origin = await readToolMessage(conversationId, record.block.retryOf.messageId)
  const cancelled = await cancelTasks(
    and(
      eq(schema.tasks.id, record.block.job.taskId),
      eq(schema.tasks.agent_conversation_id, conversationId),
    )!,
    origin?.block.errorCode ? { failedAs: origin.block.errorCode } : {},
  )
  return cancelled.length > 0 ? 'cancelled' : 'finished'
}
