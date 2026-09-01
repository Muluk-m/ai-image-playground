import { QUEUE_TIMEOUTS } from '@image-playground/shared'
import { and, eq, inArray, isNotNull, lt, notInArray, type SQL } from 'drizzle-orm'
import { log } from '../lib/logger'
import { objectStore } from '../lib/objectStore'
import { loadPrivateBffOverlay } from '../lib/private-overlay'
import { planNextAttempt } from '../lib/retry'
import { db, schema } from './client'

/**
 * 无主 in_progress 的筛选口径。`ids` 用于停机尾声点名回收本进程的任务；
 * `startedBefore` 用于扫描 SIGKILL / 历史遗留，必须排除本进程正在跑的 id。
 */
export type InterruptedTaskFilter =
  | { ids: readonly string[] }
  | { startedBefore: number; excludeIds?: readonly string[] }

export interface RecoveredTasks {
  requeued: number
  failed: number
}

/**
 * 回收中断的 in_progress：按 task-runner 同一套重试语义写回 queued（attempt+1），
 * 超出 MAX_ATTEMPTS 才落终态 failed，让计费 reversal 正常发生。
 *
 * 上游可能已经在跑，重试会重复消耗配额；这里仍选择重试，因为卡在 in_progress
 * 的行没有任何东西会回收它——scheduler 只领 queued，预扣的额度会永久悬挂。
 */
export async function recoverInterruptedTasks(
  filter: InterruptedTaskFilter = {
    startedBefore: Date.now() - QUEUE_TIMEOUTS.STALE_IN_PROGRESS_MS,
  },
  now = Date.now(),
): Promise<RecoveredTasks> {
  const predicate = buildInterruptedPredicate(filter)
  if (!predicate) return { requeued: 0, failed: 0 }

  const candidates = await db
    .select({
      id: schema.tasks.id,
      attemptCount: schema.tasks.attempt_count,
    })
    .from(schema.tasks)
    .where(and(eq(schema.tasks.status, 'in_progress'), predicate))
  if (candidates.length === 0) return { requeued: 0, failed: 0 }

  const taskHooks = (await loadPrivateBffOverlay()).taskHooks
  let requeued = 0
  let failed = 0
  for (const candidate of candidates) {
    const attemptJustFailed = candidate.attemptCount + 1
    const plan = planNextAttempt(attemptJustFailed, now)
    if (plan.shouldRetry) {
      const updated = await db
        .update(schema.tasks)
        .set({
          status: 'queued',
          attempt_count: attemptJustFailed,
          next_retry_at: plan.nextRetryAt,
          error_message: null,
          error_type: null,
          result_payload: null,
          upstream_status: null,
          upstream_body: null,
        })
        .where(and(eq(schema.tasks.id, candidate.id), eq(schema.tasks.status, 'in_progress')))
        .returning({ id: schema.tasks.id })
      if (updated.length > 0) requeued += 1
      continue
    }

    const settled = await db.transaction(async (tx) => {
      const [row] = await tx
        .update(schema.tasks)
        .set({
          status: 'failed',
          attempt_count: attemptJustFailed,
          error_message: '任务 worker 重启时中断，重试次数已用尽',
          error_type: 'interrupted' as const,
          completed_at: now,
        })
        .where(and(eq(schema.tasks.id, candidate.id), eq(schema.tasks.status, 'in_progress')))
        .returning({
          id: schema.tasks.id,
          upstreamInvocationCount: schema.tasks.upstream_invocation_count,
        })
      if (!row) return false
      await taskHooks.finalizeTask({
        tx,
        taskId: row.id,
        upstreamInvocationCount: row.upstreamInvocationCount,
      })
      return true
    })
    if (settled) failed += 1
  }

  if (requeued > 0 || failed > 0) {
    log.info(
      { event: 'task.interrupted_recovered', requeued, failed },
      'recovered interrupted in-progress tasks',
    )
  }
  return { requeued, failed }
}

function buildInterruptedPredicate(filter: InterruptedTaskFilter): SQL | undefined {
  if ('ids' in filter) {
    return filter.ids.length === 0 ? undefined : inArray(schema.tasks.id, [...filter.ids])
  }
  const stale = lt(schema.tasks.started_at, filter.startedBefore)
  const excluded = filter.excludeIds ?? []
  return excluded.length === 0 ? stale : and(stale, notInArray(schema.tasks.id, [...excluded]))
}

/** Runs optional private-tree maintenance (for example, the billing fallback scan). */
export async function runPrivateMaintenance(now = Date.now()): Promise<void> {
  const taskHooks = (await loadPrivateBffOverlay()).taskHooks
  await taskHooks.runMaintenance(now)
}

/**
 * 删除 30 天前完成的任务（成功 / 失败 / 取消）。不删 queued/in_progress，避免
 * 误清正在跑的；worker 的 recoverInterruptedTasks 会收拾无主 in_progress。
 */
export async function purgeOldTasks(
  retentionMs = QUEUE_TIMEOUTS.TASK_RETENTION_MS,
): Promise<number> {
  const threshold = Date.now() - retentionMs
  const deleted = await db
    .delete(schema.tasks)
    .where(
      and(
        inArray(schema.tasks.status, ['completed', 'failed', 'cancelled']),
        isNotNull(schema.tasks.completed_at),
        lt(schema.tasks.completed_at, threshold),
      ),
    )
    .returning({ id: schema.tasks.id })

  for (const task of deleted) {
    try {
      await objectStore().deletePrefix(`${task.id}/`)
    } catch (error) {
      log.warn(
        { event: 'object_store.cleanup_failed', taskId: task.id, err: String(error) },
        'task row deleted; object prefix left for lifecycle cleanup',
      )
    }
  }
  return deleted.length
}
