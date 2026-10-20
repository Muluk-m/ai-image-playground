import { type AlertMessage, QUEUE_TIMEOUTS } from '@image-playground/shared'
import { and, asc, eq, isNull, lte, or } from 'drizzle-orm'
import { db, schema } from '../db/client'
import { type AlertSender, createAlertSender } from '../ops/alert-sender'
import { log } from './logger'
import { nextAutoReconcileAt, reconcilingDue, shouldConfirmNoResult } from './reconcile-timing'
import { reconcileTask } from './task-reconciliation'

let sender: AlertSender = createAlertSender({
  webhookUrl: process.env.OPS_ALERT_WEBHOOK_URL,
  deployment: process.env.OPS_DEPLOYMENT_NAME?.trim() || 'deployment',
})

/** 测试替换告警出口；不传则恢复读环境变量的那个。 */
export function setAutoReconcileAlertSenderForTesting(next?: AlertSender): void {
  sender =
    next ??
    createAlertSender({
      webhookUrl: process.env.OPS_ALERT_WEBHOOK_URL,
      deployment: process.env.OPS_DEPLOYMENT_NAME?.trim() || 'deployment',
    })
}

/**
 * 结果确认到期就向上游核对一次。查到结果就归档完成；确认没有可交付结果就失败退款并唤醒助手。
 * 查询失败或上游仍在生成则保持原状，并把下次核对往后推，避免少数对不上的任务占满每一轮名额。
 * 进入超过 30 分钟仍未结束的，单独扫出来通知运维；去重写在任务行上，重启和多 worker 不会重复发。
 */
export async function autoReconcileTasks(now = Date.now()): Promise<void> {
  const rows = await db
    .select({
      id: schema.tasks.id,
      startedAt: schema.tasks.reconcile_started_at,
      alertedAt: schema.tasks.reconcile_alerted_at,
    })
    .from(schema.tasks)
    .where(
      and(
        eq(schema.tasks.status, 'reconciling'),
        eq(schema.tasks.kind, 'queue'),
        or(isNull(schema.tasks.next_retry_at), lte(schema.tasks.next_retry_at, now)),
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
  await alertOverdue(now)
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
  task: { id: string; startedAt: number | null; alertedAt: number | null },
  now: number,
): Promise<void> {
  const window = Math.floor(now / QUEUE_TIMEOUTS.AUTO_RECONCILE_AFTER_MS)
  let status: 'reconciling' | 'completed' | 'failed' = 'reconciling'
  try {
    const lookup = await reconcileTask(task.id, {
      commandId: `auto-lookup:${task.id}:${window}`,
      operatorId: 'system',
      evidence: '结果确认已到期，自动向上游核对',
      action: 'lookup',
    })
    status = terminal(lookup.status)
    // 上游仍在生成、查询超时或没问到上游，都不是「确认没有结果」。
    // 仍在生成时终查抛超时，原因是 upstream_result_unknown，不会走进退款。
    if (
      status === 'reconciling' &&
      shouldConfirmNoResult(lookup.reason, await countUpstreamTasks(task.id))
    ) {
      const closed = await reconcileTask(task.id, {
        commandId: `auto-none:${task.id}`,
        operatorId: 'system',
        evidence: '自动核对确认上游没有可交付结果',
        action: 'confirm_no_result',
      })
      status = terminal(closed.status)
    }
    log.info(
      { event: 'task.auto_reconciled', taskId: task.id, status, reason: lookup.reason },
      'automatic result check finished',
    )
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
  if (status !== 'reconciling') return
  // 先把名额让出去，再发告警。告警发送失败不能把这行留在队首。
  await db
    .update(schema.tasks)
    .set({ next_retry_at: nextAutoReconcileAt(task.startedAt, task.alertedAt, now) })
    .where(and(eq(schema.tasks.id, task.id), eq(schema.tasks.status, 'reconciling')))
}

function terminal(status: unknown): 'reconciling' | 'completed' | 'failed' {
  return status === 'completed' || status === 'failed' ? status : 'reconciling'
}

/** 超过 30 分钟仍在确认的，不依赖本轮有没有轮到核对。 */
async function alertOverdue(now: number): Promise<void> {
  const dueAt = now - QUEUE_TIMEOUTS.RECONCILE_ALERT_AFTER_MS
  const rows = await db
    .select({
      id: schema.tasks.id,
      userId: schema.tasks.user_id,
      startedAt: schema.tasks.reconcile_started_at,
    })
    .from(schema.tasks)
    .where(
      and(
        eq(schema.tasks.status, 'reconciling'),
        eq(schema.tasks.kind, 'queue'),
        isNull(schema.tasks.reconcile_alerted_at),
        or(
          isNull(schema.tasks.reconcile_started_at),
          lte(schema.tasks.reconcile_started_at, dueAt),
        ),
      ),
    )
    .orderBy(asc(schema.tasks.reconcile_started_at))
    .limit(20)
  for (const task of rows) {
    if (!reconcilingDue(task.startedAt, now, QUEUE_TIMEOUTS.RECONCILE_ALERT_AFTER_MS)) continue
    try {
      await claimAndSendAlert(task, now)
    } catch (error) {
      log.warn(
        {
          event: 'task.auto_reconcile_alert_failed',
          taskId: task.id,
          err: error instanceof Error ? error.message : String(error),
        },
        'result-confirmation alert was not delivered and will retry',
      )
    }
  }
}

async function claimAndSendAlert(
  task: { id: string; userId: string | null },
  now: number,
): Promise<void> {
  const claimed = await db
    .update(schema.tasks)
    .set({ reconcile_alerted_at: now })
    .where(
      and(
        eq(schema.tasks.id, task.id),
        eq(schema.tasks.status, 'reconciling'),
        isNull(schema.tasks.reconcile_alerted_at),
      ),
    )
    .returning({ id: schema.tasks.id })
  if (claimed.length === 0) return
  const message: AlertMessage = {
    rule: 'reconciling',
    kind: 'firing',
    text: `结果确认超过 30 分钟：任务 ${task.id}，用户 ${task.userId ?? '匿名'}`,
  }
  try {
    await sender([message])
  } catch (error) {
    await db
      .update(schema.tasks)
      .set({ reconcile_alerted_at: null })
      .where(and(eq(schema.tasks.id, task.id), eq(schema.tasks.reconcile_alerted_at, now)))
    throw error
  }
}
