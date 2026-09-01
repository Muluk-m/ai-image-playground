import { QUEUE_TIMEOUTS } from '@image-playground/shared'
import { and, eq, inArray, isNotNull, lt, notInArray, type SQL } from 'drizzle-orm'
import { log } from '../lib/logger'
import { objectStore } from '../lib/objectStore'
import { loadPrivateBffOverlay } from '../lib/private-overlay'
import { planNextAttempt } from '../lib/retry'
import { db, schema } from './client'
import { finishTask, requeueTask } from './task-transitions'

export interface RecoveredTasks {
  requeued: number
  failed: number
}

/**
 * 停机 abort 之后点名回收：这些 task 的 fetch 已经断了，但没人写终态。
 * id 必须在 abort **之前**取，settle 期间自己跑完的行由 status 守卫挡住。
 */
export function recoverTasksByIds(
  ids: readonly string[],
  now = Date.now(),
): Promise<RecoveredTasks> {
  if (ids.length === 0) return Promise.resolve({ requeued: 0, failed: 0 })
  return recoverTasks(inArray(schema.tasks.id, [...ids]), now)
}

/**
 * 扫描无主 in_progress（SIGKILL 遗留、历史残行）。`ownedIds` 是本进程正在跑的 task，
 * 上传产物可能让活着的行超过年龄阈值，必须排除。
 */
export function recoverAbandonedTasks(
  ownedIds: readonly string[] = [],
  now = Date.now(),
): Promise<RecoveredTasks> {
  const stale = lt(schema.tasks.started_at, now - QUEUE_TIMEOUTS.STALE_IN_PROGRESS_MS)
  const scope =
    ownedIds.length === 0 ? stale : and(stale, notInArray(schema.tasks.id, [...ownedIds]))
  return recoverTasks(scope as SQL, now)
}

/**
 * 按 task-runner 同一套重试预算回收中断的 in_progress：写回 queued（attempt+1），
 * 预算用尽才落终态 failed。明知重试可能重复消耗上游配额也要做——卡在 in_progress
 * 的行没有任何东西会回收它，预扣的额度会永久悬挂。
 */
async function recoverTasks(scope: SQL, now: number): Promise<RecoveredTasks> {
  const candidates = await db
    .select({ id: schema.tasks.id, attemptCount: schema.tasks.attempt_count })
    .from(schema.tasks)
    .where(and(eq(schema.tasks.status, 'in_progress'), scope))

  let requeued = 0
  let failed = 0
  for (const candidate of candidates) {
    const attemptJustFailed = candidate.attemptCount + 1
    const plan = planNextAttempt(attemptJustFailed, now)
    const written = plan.shouldRetry
      ? await requeueTask(candidate.id, attemptJustFailed, plan.nextRetryAt)
      : await finishTask(candidate.id, {
          status: 'failed',
          attemptCount: attemptJustFailed,
          errorMessage: '任务 worker 中断，重试次数已用尽',
          errorType: 'interrupted',
          completedAt: now,
        })
    if (!written) continue
    if (plan.shouldRetry) requeued += 1
    else failed += 1
  }

  if (requeued > 0 || failed > 0) {
    log.info(
      { event: 'task.interrupted_recovered', requeued, failed },
      'recovered interrupted in-progress tasks',
    )
  }
  return { requeued, failed }
}

/** Runs optional private-tree maintenance (for example, the billing fallback scan). */
export async function runPrivateMaintenance(now = Date.now()): Promise<void> {
  const taskHooks = (await loadPrivateBffOverlay()).taskHooks
  await taskHooks.runMaintenance(now)
}

/**
 * 删除 30 天前完成的任务（成功 / 失败 / 取消）。不删 queued/in_progress，避免
 * 误清正在跑的；worker 的 recoverAbandonedTasks 会收拾无主 in_progress。
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
