import { resolvedTaskArchivePayload, resolvedTaskResultPayload } from '@image-playground/db'
import {
  type AgentBackgroundJobProgress,
  type AgentBackgroundJobView,
  type AgentContentBlock,
  type AgentJobQueuePosition,
  type AgentMessageView,
  type AgentToolResultBlock,
  type AgentWakeSkipReason,
  agentTool,
  taskFailureCode,
} from '@image-playground/shared'
import { and, eq, inArray, isNull, or, sql } from 'drizzle-orm'
import { db, schema } from '../../../db/client'
import { accountConcurrencyLimit, accountQueuePositions } from '../../../lib/account-concurrency'
import { type BffTransaction, loadMeteringPort } from '../../../lib/billing-ports'
import { isCapabilityEnabled } from '../../../lib/capabilities'
import { log } from '../../../lib/logger'
import { taskProgressPhase } from '../../../lib/task-progress'
import { cancelUpstreamOfCancelledTasks } from '../../../lib/upstream-cancel'
import {
  cancelTasks,
  type ExternalExecutionTransaction,
  type QueueTaskTerminalRow,
  queueTaskOutcome,
} from '../../execution'
import { queueArtifacts } from '../contracts'

/**
 * 后台任务的结局只有一个来源：任务表。结果块在提交时写成 `submitted`，读回会话时对照任务行
 * 就地改写成终局并落库——刷新、换设备、服务重启之后读到的都是同一份，下一轮的模型也照它看到结果。
 * 任务行过了保留期会被清掉，所以终局必须写回消息，不能每次现算。
 */

type PendingJobBlock = AgentToolResultBlock & {
  readonly job: NonNullable<AgentToolResultBlock['job']>
}

function pendingJob(block: AgentContentBlock): block is PendingJobBlock {
  return block.type === 'toolResult' && block.status === 'submitted' && block.job !== undefined
}

/** 对照任务行算出的终局；任务还在跑就是 null。任务行不在即执行记录丢了，结局查不到。 */
export function settledJobBlock(
  block: PendingJobBlock,
  task: QueueTaskTerminalRow | undefined,
  chargedCredits?: number,
): AgentToolResultBlock | null {
  const outcome = task
    ? queueTaskOutcome(task)
    : {
        kind: 'failed' as const,
        reason: '任务丢失了',
        errorType: 'upstream_result_unknown' as const,
      }
  if (!outcome) return null
  const job = chargedCredits === undefined ? block.job : { ...block.job, chargedCredits }
  if (outcome.kind === 'completed') {
    const artifacts = queueArtifacts(job.taskId, job.media, outcome.result).map((artifact) =>
      job.video && artifact.media === 'video' ? { ...artifact, video: job.video } : artifact,
    )
    return { ...block, status: agentTool.step('submitted', 'succeed'), artifacts, job }
  }
  return {
    ...block,
    status: agentTool.step('submitted', 'fail'),
    job,
    message: outcome.reason,
    errorCode: 'cancelled' in outcome ? 'cancelled' : taskFailureCode(outcome.errorType),
  }
}

const MAX_SETTLE_CAS_ATTEMPTS = 5

function applySettlementToContent(
  content: readonly AgentContentBlock[],
  byId: ReadonlyMap<string, QueueTaskTerminalRow>,
  credits: Readonly<Record<string, number>>,
): { readonly changed: boolean; readonly content: AgentContentBlock[] } {
  let changed = false
  const next = content.map((block) => {
    if (block.type !== 'toolResult' || !block.job) return block
    const amount = credits[block.job.taskId]
    const charge = Number.isSafeInteger(amount) && amount >= 0 ? amount : undefined
    if (pendingJob(block)) {
      const settledBlock = settledJobBlock(block, byId.get(block.job.taskId), charge)
      if (!settledBlock) return block
      changed = true
      return settledBlock
    }
    if (block.job.chargedCredits !== undefined || charge === undefined) return block
    changed = true
    return { ...block, job: { ...block.job, chargedCredits: charge } }
  })
  return { changed, content: next }
}

async function persistSettledMessage(
  conversationId: string,
  initial: AgentMessageView,
  byId: ReadonlyMap<string, QueueTaskTerminalRow>,
  credits: Readonly<Record<string, number>>,
): Promise<AgentContentBlock[]> {
  let currentContent: readonly AgentContentBlock[] = initial.content
  for (let attempt = 0; attempt < MAX_SETTLE_CAS_ATTEMPTS; attempt += 1) {
    const applied = applySettlementToContent(currentContent, byId, credits)
    if (!applied.changed) return [...currentContent]
    // 乐观锁 CAS：校验实际更新到行；同一消息多个后台任务并发终态或与 wakeSkipped 交错时，重读最新行合并重试。
    const updated = await db
      .update(schema.agent_messages)
      .set({ content: applied.content })
      .where(
        and(
          eq(schema.agent_messages.conversation_id, conversationId),
          eq(schema.agent_messages.id, initial.id),
          isNull(schema.agent_messages.deleted_at),
          // 参数先定成 text 再转：直接写 `::jsonb`，驱动会把这串 JSON 再编码成一个 jsonb 字符串。
          sql`${schema.agent_messages.content} = ${JSON.stringify(currentContent)}::text::jsonb`,
        ),
      )
      .returning({ id: schema.agent_messages.id })
    if (updated.length > 0) return applied.content
    const [fresh] = await db
      .select({ content: schema.agent_messages.content })
      .from(schema.agent_messages)
      .where(
        and(
          eq(schema.agent_messages.conversation_id, conversationId),
          eq(schema.agent_messages.id, initial.id),
          isNull(schema.agent_messages.deleted_at),
        ),
      )
      .limit(1)
    if (!fresh) return applied.content
    currentContent = fresh.content
  }
  throw new Error(
    `Agent job settlement CAS contention exceeded ${MAX_SETTLE_CAS_ATTEMPTS} attempts for message ${initial.id}`,
  )
}

export interface AgentJobSettlementTarget {
  readonly taskId: string
  readonly turnId?: string | null
}

/**
 * 把这些消息里已经结束的后台任务结算成终局。
 * - `persist = true`（默认，用于终态提交后监听、清任务前强制兜底、单张重试等写路径）：将结果回写落库；
 * - `persist = false`（{@link projectSettledAgentJobs}，用于会话读路径）：仅在内存中投影视图，不执行任何 DB 写操作。
 * 调用方负责确权：消息必须来自已经按归属查出来的会话，任务也只认挂在这个会话下的。
 */
export async function settleAgentJobs(
  conversationId: string,
  messages: readonly AgentMessageView[],
  options: { readonly requireCharges?: boolean; readonly persist?: boolean } = {},
): Promise<AgentMessageView[]> {
  const pendingIds = messages.flatMap((message) =>
    message.content.filter(pendingJob).map((block) => block.job.taskId),
  )
  // 旧终局卡也补一次实扣：确认生成可能发生在轮结束之后，轮页脚里没有这笔钱。
  // 金额写回结果卡，任务行过了保留期仍能展示同一张账单。
  const unpricedIds = messages.flatMap((message) =>
    message.content.flatMap((block) =>
      block.type === 'toolResult' && block.job && block.job.chargedCredits === undefined
        ? [block.job.taskId]
        : [],
    ),
  )
  if (pendingIds.length === 0 && unpricedIds.length === 0) return [...messages]
  const lookupIds = [...new Set([...pendingIds, ...unpricedIds])]
  const tasks = lookupIds.length
    ? await db
        .select({
          id: schema.tasks.id,
          status: schema.tasks.status,
          provider: schema.tasks.provider,
          result_payload: resolvedTaskResultPayload,
          error_message: schema.tasks.error_message,
          error_type: schema.tasks.error_type,
        })
        .from(schema.tasks)
        .leftJoin(schema.task_payloads, eq(schema.task_payloads.task_id, schema.tasks.id))
        .where(
          and(
            inArray(schema.tasks.id, lookupIds),
            eq(schema.tasks.agent_conversation_id, conversationId),
          ),
        )
    : []
  const byId = new Map(tasks.map((task) => [task.id, task]))
  let credits: Readonly<Record<string, number>> = {}
  const billableIds = [
    ...new Set(
      unpricedIds.filter((taskId) => {
        const status = byId.get(taskId)?.status
        return status === 'completed' || status === 'failed' || status === 'cancelled'
      }),
    ),
  ]
  if (billableIds.length) {
    try {
      const metering = await loadMeteringPort()
      credits = await metering.taskCredits({ taskIds: billableIds })
    } catch (err) {
      if (options.requireCharges) throw err
      // 报价不可用时照常交付产物；缺席金额不冒充零扣费。
      log.warn(
        { event: 'agent.job_credits_unavailable', conversationId, err },
        'job charge unavailable',
      )
    }
  }
  if (
    options.requireCharges &&
    isCapabilityEnabled('billing:credits') &&
    billableIds.some((taskId) => !Number.isSafeInteger(credits[taskId]) || credits[taskId] < 0)
  ) {
    throw new Error('Agent job charge unavailable before task purge')
  }

  const settled: AgentMessageView[] = []
  for (const message of messages) {
    const applied = applySettlementToContent(message.content, byId, credits)
    if (!applied.changed) {
      settled.push(message)
      continue
    }
    const content =
      options.persist !== false
        ? await persistSettledMessage(conversationId, message, byId, credits)
        : applied.content
    settled.push({ ...message, content })
  }
  return settled
}

/**
 * 纯只读投影：会话消息读取路径不再触发 `UPDATE agent_messages` 写副作用。
 * 正常任务终态由 TaskLifecycleBus 提交后监听落库；此处仅在内存为历史未落账卡片或并发竞态窗口补齐展示视图。
 */
export function projectSettledAgentJobs(
  conversationId: string,
  messages: readonly AgentMessageView[],
): Promise<AgentMessageView[]> {
  return settleAgentJobs(conversationId, messages, { persist: false })
}

async function findMessagesForTaskIds(
  conversationId: string,
  taskIds: readonly string[],
  turnIds?: readonly string[],
) {
  if (taskIds.length === 0) return []
  return db
    .select({
      id: schema.agent_messages.id,
      turn_id: schema.agent_messages.turn_id,
      role: schema.agent_messages.role,
      content: schema.agent_messages.content,
      created_at: schema.agent_messages.created_at,
    })
    .from(schema.agent_messages)
    .where(
      and(
        eq(schema.agent_messages.conversation_id, conversationId),
        ...(turnIds && turnIds.length > 0
          ? [inArray(schema.agent_messages.turn_id, [...turnIds])]
          : []),
        isNull(schema.agent_messages.deleted_at),
        or(
          ...taskIds.map(
            (taskId) =>
              sql`${schema.agent_messages.content} @> ${JSON.stringify([
                { type: 'toolResult', job: { taskId } },
              ])}::text::jsonb`,
          ),
        ),
      ),
    )
}

/**
 * 任务终态提交后按 `(conversationId, turnId, taskId)` 精准定向结算并回写对应的结果卡消息：
 * 优先走 `idx_agent_messages_turn (conversation_id, turn_id)` 索引，仅检查当轮消息而非扫描整段会话历史；
 * 仅对缺少 `turnId` 或未命中的历史任务才回退会话级兜底查询。
 */
export async function settleAgentJobsForTasks(
  conversationId: string,
  targets: readonly AgentJobSettlementTarget[],
): Promise<void> {
  const byTaskId = new Map<string, string | null>()
  for (const target of targets) {
    if (!byTaskId.has(target.taskId) || (!byTaskId.get(target.taskId) && target.turnId)) {
      byTaskId.set(target.taskId, target.turnId ?? null)
    }
  }
  if (byTaskId.size === 0) return

  const scopedTaskIds: string[] = []
  const scopedTurnIds = new Set<string>()
  const unscopedTaskIds: string[] = []
  for (const [taskId, turnId] of byTaskId) {
    if (turnId) {
      scopedTaskIds.push(taskId)
      scopedTurnIds.add(turnId)
    } else {
      unscopedTaskIds.push(taskId)
    }
  }

  const rowsById = new Map<
    string,
    {
      id: string
      turn_id: string
      role: AgentMessageView['role']
      content: AgentContentBlock[]
      created_at: number
    }
  >()
  if (scopedTaskIds.length > 0) {
    const scopedRows = await findMessagesForTaskIds(conversationId, scopedTaskIds, [
      ...scopedTurnIds,
    ])
    for (const row of scopedRows) rowsById.set(row.id, row)
  }
  if (unscopedTaskIds.length > 0) {
    const fallbackRows = await findMessagesForTaskIds(conversationId, unscopedTaskIds)
    for (const row of fallbackRows) rowsById.set(row.id, row)
  }
  if (rowsById.size === 0) return
  await settleAgentJobs(
    conversationId,
    [...rowsById.values()].map((row) => ({
      id: row.id,
      turnId: row.turn_id,
      role: row.role,
      content: row.content,
      createdAt: row.created_at,
    })),
  )
}

/**
 * 覆盖「任务先到达终态、结果卡后提交落库」的竞态窗口（如 `auto-submit`、单张重试、崩溃重放）：
 * 结果卡写入事务提交后做一次按主键查任务状态；任务仍在排队/执行时立刻返回，已终态则定向落库结果卡。
 */
export async function settleSubmittedTaskIfTerminal(
  conversationId: string,
  taskId: string,
  turnId?: string | null,
): Promise<void> {
  try {
    const [task] = await db
      .select({ status: schema.tasks.status })
      .from(schema.tasks)
      .where(
        and(eq(schema.tasks.id, taskId), eq(schema.tasks.agent_conversation_id, conversationId)),
      )
      .limit(1)
    if (
      !task ||
      (task.status !== 'completed' && task.status !== 'failed' && task.status !== 'cancelled')
    ) {
      return
    }
    await settleAgentJobsForTasks(conversationId, [{ taskId, turnId }])
  } catch (err) {
    log.warn(
      { event: 'agent.job_settlement_post_write_failed', conversationId, taskId, err },
      'post-card-write agent job settlement failed; read projection and pre-purge sweep will recover',
    )
  }
}

/**
 * 这些后台任务本该唤醒智能体却没有唤醒：在它们的结果卡上记下原因，面板据此说明智能体没有
 * 查看结果。结果卡在唤醒之前已经结算成终局，这里只添一个标记，别的不动。
 */
export async function markAgentJobsWakeSkipped(
  tx: BffTransaction,
  conversationId: string,
  taskIds: readonly string[],
  reason: AgentWakeSkipReason,
): Promise<void> {
  await setAgentJobsWakeSkipped(tx, conversationId, taskIds, reason)
}

/**
 * 这几条唤醒在起轮事务里被取走、智能体确实接着看了结果：卡上先前记下的「没接着做」已经过时，
 * 抹掉。比如确认门续跑因积分不够被撤回、卡上记了原因，之后用户充了值，任务结束的唤醒照常起轮。
 * 必须在取走唤醒的那个事务里调用：起轮回滚时标记也原样留着。
 */
export async function clearAgentWakeSkippedForWakes(
  tx: BffTransaction,
  conversationId: string,
  wakeIds: readonly string[],
): Promise<void> {
  if (wakeIds.length === 0) return
  const rows = await tx
    .select({ taskId: schema.agent_jobs.task_id })
    .from(schema.agent_jobs)
    .where(
      and(
        eq(schema.agent_jobs.conversation_id, conversationId),
        inArray(schema.agent_jobs.wake_id, [...wakeIds]),
      ),
    )
  await setAgentJobsWakeSkipped(
    tx,
    conversationId,
    rows.map((row) => row.taskId),
    null,
  )
}

async function setAgentJobsWakeSkipped(
  tx: BffTransaction,
  conversationId: string,
  taskIds: readonly string[],
  reason: AgentWakeSkipReason | null,
): Promise<void> {
  if (taskIds.length === 0) return
  const wanted = new Set(taskIds)
  // 只锁这几个任务自己的结果卡：起轮时每次都会走到这里，不能把整段会话历史都锁一遍。
  const rows = await tx
    .select({ id: schema.agent_messages.id, content: schema.agent_messages.content })
    .from(schema.agent_messages)
    .where(
      and(
        eq(schema.agent_messages.conversation_id, conversationId),
        or(
          ...[...wanted].map(
            (taskId) =>
              sql`${schema.agent_messages.content} @> ${JSON.stringify([
                { type: 'toolResult', job: { taskId } },
              ])}::text::jsonb`,
          ),
        ),
      ),
    )
    .for('update')
  for (const row of rows) {
    let changed = false
    const content = row.content.map((block) => {
      if (block.type !== 'toolResult' || !block.job || !wanted.has(block.job.taskId)) return block
      if (reason === null) {
        if (block.wakeSkipped === undefined) return block
        changed = true
        const { wakeSkipped: _cleared, ...rest } = block
        return rest
      }
      changed = true
      return { ...block, wakeSkipped: reason }
    })
    if (!changed) continue
    await tx
      .update(schema.agent_messages)
      .set({ content })
      .where(
        and(
          eq(schema.agent_messages.conversation_id, conversationId),
          eq(schema.agent_messages.id, row.id),
        ),
      )
  }
}

/** 删除会话时一并取消分析任务的扩展回调，避免 conversation 层反向依赖批量分析层。 */
export type CancelConversationAnalysisTasks = (
  conversationId: string,
  tx: BffTransaction,
) => Promise<number>

/**
 * 删除会话时一并取消它的后台任务；对话任务不在此列，它跟着轮走。取消按原桶退回。
 * 给了事务就在它上面做：删会话时墓碑与取消要同一次提交（见 `routes/agent.ts`）。
 */
export async function cancelAgentConversationJobsWith(
  conversationId: string,
  cancelExtra: CancelConversationAnalysisTasks | undefined,
  external?: ExternalExecutionTransaction,
): Promise<number> {
  const cancel = async (executor: ExternalExecutionTransaction) => {
    const cancelled = await cancelTasks(
      and(eq(schema.tasks.agent_conversation_id, conversationId), eq(schema.tasks.kind, 'queue'))!,
      executor,
    )
    const analysis = cancelExtra ? await cancelExtra(conversationId, executor.tx) : 0
    return cancelled.length + analysis
  }
  if (external) return cancel(external)
  const postCommitHooks: Array<() => Promise<void>> = []
  const count = await db.transaction((tx) =>
    cancel({ tx, onCommit: (hook) => postCommitHooks.push(hook) }),
  )
  for (const hook of postCommitHooks) await hook()
  return count
}

/**
 * 这些消息里提交过后台任务的调用，结果块是此刻的样子。还没结束的带上任务表里的进度：
 * 排着队、在生成、在重连还是在确认，什么时候受理的。消息应当已经结算过（{@link settleAgentJobs}）。
 * 重试记录不论有没有提交过都在列：别的设备据此看到排队态，轮到时看到它换成在跑；没提交就结束的
 * （撤回、轮到时被拒）也在列，客户端只从这里得知它的终局。
 */
export async function agentJobViews(
  conversationId: string,
  messages: readonly AgentMessageView[],
): Promise<AgentBackgroundJobView[]> {
  const jobs = messages.flatMap((message) =>
    message.content.flatMap((block) =>
      block.type === 'toolResult' && (block.job || block.retryOf)
        ? [{ messageId: message.id, turnId: message.turnId, result: block }]
        : [],
    ),
  )
  const pending = jobs.flatMap((job) =>
    job.result.status === 'submitted' && job.result.job ? [job.result.job.taskId] : [],
  )
  if (pending.length === 0) return jobs
  const tasks = await db
    .select({
      id: schema.tasks.id,
      status: schema.tasks.status,
      submitted_at: schema.tasks.submitted_at,
      archive_payload: resolvedTaskArchivePayload,
      upstream_task_ids: schema.tasks.upstream_task_ids,
      lease_expires_at: schema.tasks.lease_expires_at,
      next_retry_at: schema.tasks.next_retry_at,
      reconcile_started_at: schema.tasks.reconcile_started_at,
      user_id: schema.tasks.user_id,
    })
    .from(schema.tasks)
    .leftJoin(schema.task_payloads, eq(schema.task_payloads.task_id, schema.tasks.id))
    .where(
      and(
        inArray(schema.tasks.id, [...new Set(pending)]),
        eq(schema.tasks.agent_conversation_id, conversationId),
      ),
    )
  const queue = await accountQueue(tasks)
  // 阶段按任务表的持久字段算（ADR 0009），不压扁成只看 status：重启或滚动发布后重新排队、
  // 但已有上游任务号的是在重连，执行器租约过期的也是，不能说成「排队」或「生成中」。
  const progress = new Map(
    tasks.flatMap((task): [string, AgentBackgroundJobProgress][] =>
      task.status === 'queued' || task.status === 'in_progress' || task.status === 'reconciling'
        ? [
            [
              task.id,
              {
                stage: task.status === 'queued' ? 'submitted' : 'running',
                submittedAt: task.submitted_at,
                phase: taskProgressPhase(task),
                ...(task.status === 'reconciling' && task.reconcile_started_at != null
                  ? { phaseSince: task.reconcile_started_at }
                  : {}),
                ...(queue.has(task.id) ? { queue: queue.get(task.id) } : {}),
              },
            ],
          ]
        : [],
    ),
  )
  return jobs.map((job) => {
    const current =
      job.result.status === 'submitted' && job.result.job
        ? progress.get(job.result.job.taskId)
        : undefined
    return current ? { ...job, progress: current } : job
  })
}

/**
 * 还在排队的那几条在本账号队列里排第几：账号同时生成的张数由套餐定，用户只看到「排队中」
 * 不知道在等什么（BUG-17）。只在确有排队、还没拿到上游任务号时才多读一次；读不到就不给，
 * 界面照旧只说排队中。
 */
async function accountQueue(
  tasks: readonly {
    id: string
    status: string
    user_id: string | null
    upstream_task_ids: string[] | null
  }[],
): Promise<Map<string, AgentJobQueuePosition>> {
  const waiting = tasks.filter(
    (task) => task.status === 'queued' && task.user_id && !task.upstream_task_ids?.length,
  )
  const userId = waiting[0]?.user_id
  if (!userId) return new Map()
  try {
    return await db.transaction(async (tx) => {
      const unfinished = await tx
        .select({
          id: schema.tasks.id,
          status: schema.tasks.status,
          submittedAt: schema.tasks.submitted_at,
          nextRetryAt: schema.tasks.next_retry_at,
        })
        .from(schema.tasks)
        .where(
          and(
            eq(schema.tasks.user_id, userId),
            eq(schema.tasks.kind, 'queue'),
            inArray(schema.tasks.status, ['queued', 'in_progress']),
          ),
        )
      const now = Date.now()
      const limit = await accountConcurrencyLimit(tx, userId, now)
      return accountQueuePositions(
        waiting.map((task) => task.id),
        unfinished.flatMap((task) =>
          task.status === 'queued' || task.status === 'in_progress'
            ? [
                {
                  id: task.id,
                  status: task.status,
                  submittedAt: task.submittedAt,
                  nextRetryAt: task.nextRetryAt,
                },
              ]
            : [],
        ),
        limit,
        now,
      )
    })
  } catch (error) {
    log.warn({ event: 'agent.job_queue_position_failed', err: error }, 'queue position unavailable')
    return new Map()
  }
}

/**
 * 用户点「中止」停下这一轮时，连带取消这一轮自己提交、还在排队或在跑的出图任务，按原桶退回积分
 * （ADR 0012 修订，BUG-32）。只认 `agent_turn_id` 指向这一轮的工具任务：早先轮次提交的、用户在卡上
 * 确认过的不归这一轮，照旧跑完。已经完成的照常扣费；已向上游派发、要核查的批量项按原规则进
 * reconciling，预扣留到核查定论。重复调用是空操作：只动 queued / in_progress 的行，预扣已释放的
 * 不会再退一次（结算侧按预扣状态幂等）。
 *
 * 批量计划不在此列：计划项挂在提出计划的那一轮上，而那一轮在用户确认计划前就已收尾，执行中能被
 * 中止的只会是之后的轮次；计划卡上有自己的暂停。
 */
export async function cancelStoppedTurnJobs(
  conversationId: string,
  turnId: string,
): Promise<string[]> {
  const cancelled = await cancelTasks(
    and(
      eq(schema.tasks.agent_conversation_id, conversationId),
      eq(schema.tasks.agent_turn_id, turnId),
      eq(schema.tasks.kind, 'queue'),
    )!,
  )
  if (cancelled.length > 0)
    log.info(
      {
        event: 'agent.stop_cancelled_jobs',
        conversationId,
        turnId,
        taskIds: cancelled.map((row) => row.id),
      },
      'stopping the turn cancelled its in-flight jobs',
    )
  void cancelUpstreamOfCancelledTasks(cancelled.map((row) => row.id))
  return cancelled.map((row) => row.id)
}

/**
 * 用户单独取消这个会话里的一个后台任务，按原桶退回。只认挂在这个会话下、由工具提交的任务；
 * 已经结束的任务不动。返回是否真的取消了一个任务。
 */
export async function cancelAgentJob(conversationId: string, taskId: string): Promise<boolean> {
  const cancelled = await cancelTasks(
    and(
      eq(schema.tasks.id, taskId),
      eq(schema.tasks.agent_conversation_id, conversationId),
      eq(schema.tasks.kind, 'queue'),
    )!,
  )
  void cancelUpstreamOfCancelledTasks(cancelled.map((row) => row.id))
  return cancelled.length > 0
}
