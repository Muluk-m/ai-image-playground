import { and, asc, eq, gt, inArray, isNull, or, sql } from 'drizzle-orm'
import { db, schema } from '../../db/client'
import type { BffTransaction } from '../private-overlay'
import { type QueueTaskTerminalRow, queueTaskOutcome } from '../taskSubmission'
import { AGENT_EXECUTION_LEASE_MS } from './execution'
import { enqueueAgentWake } from './inbox'
import { type MaskedPlanCarry, mergeMaskedPlanCarries } from './masked-plan'

/**
 * 唤醒：后台任务结束后让智能体再起一轮去看结果。规则只在这里：
 *
 * - 智能体提交的任务失败一律唤醒；成功只在它提交时选了复核（`wake_on_success`）才唤醒；
 *   被取消的（用户取消、删除会话）不唤醒，那是用户自己的决定。
 * - 同一次提交（同一轮提交的那些任务）全部结束、提交它们的那一轮也收了尾，才唤醒一次；
 *   第一个结束之后等了 {@link AGENT_WAKE_BATCH_WAIT_MS} 还有没结束的，先带着已结束的唤醒，
 *   剩下的结束时再算一次。
 *
 * 判断发生在写任务终态的同一个事务里（worker 的 `finishTask` / `cancelTasks`），另有 BFF 的巡查
 * 兜底超时与「任务先结束、提交的那一轮后收尾」。会话行上的锁把同一会话的判断排成一列，
 * `delivered_at` 让同一个任务只投递一次。唤醒本身是收件箱里的一条 `task_result`，由持会话租约的
 * 那个实例起轮（见 `start-turn.ts`），滚动发布时新旧实例并存也只有一个执行者。
 */

/** 同一次提交里第一个结束之后，最多等其余的这么久。 */
export const AGENT_WAKE_BATCH_WAIT_MS = 2 * 60 * 1_000

/** 数据库通知的频道：写进一条唤醒时发出，载荷是会话 id。 */
export const AGENT_WAKE_CHANNEL = 'agent_wake'

const jobs = schema.agent_jobs
const tasks = schema.tasks

const TERMINAL = ['completed', 'failed', 'cancelled'] as const

type Executor = typeof db | BffTransaction

interface PendingJob {
  readonly taskId: string
  readonly turnId: string
  readonly wakeOnSuccess: boolean
  readonly task: (QueueTaskTerminalRow & { readonly completedAt: number | null }) | null
  readonly deviceId: string | null
}

/** 任务行不在即执行记录丢了：按失败算，得有人告诉用户。 */
function ended(job: PendingJob): boolean {
  return job.task === null || (TERMINAL as readonly string[]).includes(job.task.status)
}

function wakes(job: PendingJob): boolean {
  if (!job.task) return true
  const outcome = queueTaskOutcome(job.task)
  if (!outcome) return false
  if (outcome.kind === 'completed') return job.wakeOnSuccess
  return !('cancelled' in outcome)
}

/**
 * 这个会话里到了该投递的那几批就投递：写唤醒进收件箱、记下已投递。返回写进了几条唤醒。
 * 必须在事务里调用：会话行锁住之后，并发结束的另一个任务看得到这边提交的结果。
 */
export async function deliverAgentWakes(
  tx: BffTransaction,
  conversationId: string,
  now = Date.now(),
): Promise<number> {
  const [conversation] = await tx
    .select({ deletedAt: schema.agent_conversations.deleted_at })
    .from(schema.agent_conversations)
    .where(eq(schema.agent_conversations.id, conversationId))
    .for('update')
  if (!conversation) return 0
  const rows = await tx
    .select({
      taskId: jobs.task_id,
      turnId: jobs.turn_id,
      wakeOnSuccess: jobs.wake_on_success,
      status: tasks.status,
      provider: tasks.provider,
      result_payload: tasks.result_payload,
      error_message: tasks.error_message,
      error_type: tasks.error_type,
      completedAt: tasks.completed_at,
      deviceId: tasks.device_id,
    })
    .from(jobs)
    .leftJoin(tasks, eq(tasks.id, jobs.task_id))
    .where(and(eq(jobs.conversation_id, conversationId), isNull(jobs.delivered_at)))
    .orderBy(asc(jobs.submitted_at), asc(jobs.task_id))
  if (rows.length === 0) return 0
  const batches = new Map<string, PendingJob[]>()
  for (const row of rows) {
    const job: PendingJob = {
      taskId: row.taskId,
      turnId: row.turnId,
      wakeOnSuccess: row.wakeOnSuccess,
      task: row.status
        ? {
            status: row.status,
            provider: row.provider!,
            result_payload: row.result_payload,
            error_message: row.error_message,
            error_type: row.error_type,
            completedAt: row.completedAt,
          }
        : null,
      deviceId: row.deviceId,
    }
    batches.set(job.turnId, [...(batches.get(job.turnId) ?? []), job])
  }
  // 提交这一批的那一轮还在跑，就还可能再提交：等它收尾再算「全部结束」。
  const [running] = await tx
    .select({ turnId: schema.agent_executions.turn_id })
    .from(schema.agent_executions)
    .where(
      and(
        eq(schema.agent_executions.conversation_id, conversationId),
        eq(schema.agent_executions.state, 'running'),
        gt(schema.agent_executions.heartbeat_at, now - AGENT_EXECUTION_LEASE_MS),
      ),
    )

  let woken = 0
  for (const [turnId, batch] of batches) {
    const done = batch.filter(ended)
    if (done.length === 0) continue
    const firstEnd = Math.min(...done.map((job) => job.task?.completedAt ?? now))
    const complete = done.length === batch.length && running?.turnId !== turnId
    if (!complete && now - firstEnd < AGENT_WAKE_BATCH_WAIT_MS) continue
    const waking = done.filter(wakes)
    let wakeId: string | null = null
    // 删掉的会话不再唤醒：记成已投递，别让巡查一遍遍回来看它。
    if (waking.length > 0 && !conversation.deletedAt) {
      wakeId = await enqueueAgentWake(
        tx,
        conversationId,
        {
          turnId,
          taskIds: waking.map((job) => job.taskId),
          deviceId: waking.find((job) => job.deviceId)?.deviceId ?? '',
        },
        now,
      )
      woken += 1
    }
    await tx
      .update(jobs)
      .set({ delivered_at: now })
      .where(
        inArray(
          jobs.task_id,
          done.map((job) => job.taskId),
        ),
      )
    if (wakeId)
      await tx
        .update(jobs)
        .set({ wake_id: wakeId })
        .where(
          inArray(
            jobs.task_id,
            waking.map((job) => job.taskId),
          ),
        )
  }
  // 提交时才送达；BFF 的巡查同样会看到这条唤醒，通知只是让它不必等下一次巡查。
  if (woken > 0) await tx.execute(sql`SELECT pg_notify(${AGENT_WAKE_CHANNEL}, ${conversationId})`)
  return woken
}

/**
 * 写任务终态的事务里调用：这些任务若是智能体提交的后台任务，就在同一个事务里判断它们所在的
 * 那一批能不能唤醒。不是后台任务（用户自己提交的、对话任务）时只多一次按主键的查询。
 */
export async function agentJobsEnded(
  tx: BffTransaction,
  taskIds: readonly string[],
  now = Date.now(),
): Promise<void> {
  if (taskIds.length === 0) return
  const rows = await tx
    .selectDistinct({ conversationId: jobs.conversation_id })
    .from(jobs)
    .where(and(inArray(jobs.task_id, [...taskIds]), isNull(jobs.delivered_at)))
  // 按 id 排序加锁：同时结束的两批跨会话任务不会互相等成死锁。
  for (const conversationId of rows.map((row) => row.conversationId).sort())
    await deliverAgentWakes(tx, conversationId, now)
}

/**
 * 有已经结束、还没投递的后台任务的会话：交给巡查去判断到没到时候。其中有些还没到时候（同一批
 * 还有没结束的、提交的那一轮还在跑），每次巡查都会再看一遍，所以上限放得比接手排队消息宽。
 */
export async function conversationsWithEndedJobs(
  limit = 200,
  executor: Executor = db,
): Promise<string[]> {
  const rows = await executor
    .selectDistinct({ id: jobs.conversation_id })
    .from(jobs)
    .leftJoin(tasks, eq(tasks.id, jobs.task_id))
    .where(
      and(isNull(jobs.delivered_at), or(isNull(tasks.id), inArray(tasks.status, [...TERMINAL]))),
    )
    .limit(limit)
  return rows.map((row) => row.id)
}

/** 巡查与轮收尾时用：每个会话各开一个事务去判断。返回写进了几条唤醒。 */
export async function deliverDueAgentWakes(
  conversationIds?: readonly string[],
  now = Date.now(),
): Promise<number> {
  let woken = 0
  for (const conversationId of conversationIds ?? (await conversationsWithEndedJobs())) {
    woken += await db.transaction((tx) => deliverAgentWakes(tx, conversationId, now))
  }
  return woken
}

/**
 * 唤醒点名的那几个任务提交时记下的改图计划，合成一份交给唤醒轮：它接着提交那一轮的计划走，
 * 已经付过费的内容不能重提，授权原文仍是用户最初的原话。一个都没记下时返回 undefined。
 */
export async function wakePlan(
  taskIds: readonly string[],
  executor: Executor = db,
): Promise<MaskedPlanCarry | undefined> {
  if (taskIds.length === 0) return undefined
  const rows = await executor
    .select({ plan: jobs.plan })
    .from(jobs)
    .where(inArray(jobs.task_id, [...taskIds]))
    .orderBy(asc(jobs.submitted_at), asc(jobs.task_id))
  return mergeMaskedPlanCarries(rows.flatMap((row) => (row.plan ? [row.plan] : [])))
}
