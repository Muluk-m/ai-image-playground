import { type AlertMessage, QUEUE_TIMEOUTS } from '@image-playground/shared'
import { and, asc, eq, isNull, lte, or } from 'drizzle-orm'
import { db, schema } from '../db/client'
import { createAlertSender } from '../ops/alert-sender'
import { log } from './logger'
import { reconcilingDue, shouldConfirmNoResult } from './reconcile-timing'
import { reconcileTask } from './task-reconciliation'

const alerted = new Set<string>()
const sender = createAlertSender({
  webhookUrl: process.env.OPS_ALERT_WEBHOOK_URL,
  deployment: process.env.OPS_DEPLOYMENT_NAME?.trim() || 'deployment',
})

/**
 * 结果确认超过 5 分钟就向上游核对一次。查到结果就归档完成；确认没有结果就失败退款并唤醒助手。
 * 查询本身失败则保持原状。超过 30 分钟仍未结束，通知运维。
 */
export async function autoReconcileTasks(now = Date.now()): Promise<void> {
  const dueAt = now - QUEUE_TIMEOUTS.AUTO_RECONCILE_AFTER_MS
  const rows = await db
    .select({
      id: schema.tasks.id,
      userId: schema.tasks.user_id,
      since: schema.tasks.next_retry_at,
    })
    .from(schema.tasks)
    .where(
      and(
        eq(schema.tasks.status, 'reconciling'),
        eq(schema.tasks.kind, 'queue'),
        or(isNull(schema.tasks.next_retry_at), lte(schema.tasks.next_retry_at, dueAt)),
        or(isNull(schema.tasks.execution_token), lte(schema.tasks.lease_expires_at, now)),
      ),
    )
    .orderBy(asc(schema.tasks.next_retry_at))
    .limit(5)
  for (const task of rows) {
    try {
      await reconcileOne(task, now)
    } catch (error) {
      log.warn(
        {
          event: 'task.auto_reconcile_failed',
          taskId: task.id,
          err: error instanceof Error ? error.message : String(error),
        },
        'automatic result check failed and will retry',
      )
    }
  }
}

/** 任务自己的上游号，加上每次派发记下的号。两边都空，说明这次查询没有问过上游。 */
async function countUpstreamTasks(taskId: string): Promise<number> {
  const [row] = await db
    .select({ ids: schema.tasks.upstream_task_ids })
    .from(schema.tasks)
    .where(eq(schema.tasks.id, taskId))
  const dispatches = await db
    .select({ upstreamTaskId: schema.task_dispatches.upstream_task_id })
    .from(schema.task_dispatches)
    .where(eq(schema.task_dispatches.task_id, taskId))
  return new Set([
    ...(row?.ids ?? []),
    ...dispatches.flatMap((item) => (item.upstreamTaskId ? [item.upstreamTaskId] : [])),
  ]).size
}

async function reconcileOne(
  task: { id: string; userId: string | null; since: number | null },
  now: number,
): Promise<void> {
  const window = Math.floor(now / QUEUE_TIMEOUTS.AUTO_RECONCILE_AFTER_MS)
  const lookup = await reconcileTask(task.id, {
    commandId: `auto-lookup:${task.id}:${window}`,
    operatorId: 'system',
    evidence: '结果确认已超过 5 分钟，自动向上游核对',
    action: 'lookup',
  })
  let status = lookup.status
  // 没有上游任务号时查询没有发出去，不能当成「确认没有结果」去退款。
  if (
    status === 'reconciling' &&
    lookup.reason === 'manual_verification_required' &&
    shouldConfirmNoResult(lookup.reason, await countUpstreamTasks(task.id))
  ) {
    const closed = await reconcileTask(task.id, {
      commandId: `auto-none:${task.id}`,
      operatorId: 'system',
      evidence: '自动核对确认上游没有可交付结果',
      action: 'confirm_no_result',
    })
    status = closed.status
  }
  log.info(
    { event: 'task.auto_reconciled', taskId: task.id, status, reason: lookup.reason },
    'automatic result check finished',
  )
  if (
    status === 'reconciling' &&
    reconcilingDue(task.since, now, QUEUE_TIMEOUTS.RECONCILE_ALERT_AFTER_MS) &&
    !alerted.has(task.id)
  ) {
    const message: AlertMessage = {
      rule: 'reconciling',
      kind: 'firing',
      text: `结果确认超过 30 分钟：任务 ${task.id}，用户 ${task.userId ?? '匿名'}`,
    }
    await sender([message])
    alerted.add(task.id)
  }
}
