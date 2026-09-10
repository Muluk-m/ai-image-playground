import { QUEUE_TIMEOUTS } from '@image-playground/shared'
import { and, eq, inArray, isNotNull, lt, notInArray, type SQL } from 'drizzle-orm'
import { log } from '../lib/logger'
import { objectStore } from '../lib/objectStore'
import { loadPrivateBffOverlay } from '../lib/private-overlay'
import { planNextAttempt, type RetryPlan } from '../lib/retry'
import { ASSET_OBJECT_ROOT, assetOwnerPrefix } from '../lib/sync-assets'
import { db, schema } from './client'
import { finishTask, requeueTask, requeueTasksForPolling } from './task-transitions'

export interface RecoveredTasks {
  requeued: number
  failed: number
  /** 有上游异步 task id、回队接着轮询的行；这些既没重提交也没进重试预算。 */
  resumedPolling: number
}

/**
 * 停机 abort 之后点名回收：这些 task 的 fetch 已经断了，但没人写终态。
 * id 必须在 abort **之前**取，settle 期间自己跑完的行由 status 守卫挡住。
 */
export function recoverTasksByIds(
  ids: readonly string[],
  now = Date.now(),
): Promise<RecoveredTasks> {
  if (ids.length === 0) return Promise.resolve({ requeued: 0, failed: 0, resumedPolling: 0 })
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
 * 回收中断的 in_progress。有上游 task id 的回队接着轮（不 attempt+1，轮询阶段自己按
 * 首次提交时刻判超时，不会无限回队）；没有的只能按重试预算重跑，预算用尽才落 failed。
 */
async function recoverTasks(scope: SQL, now: number): Promise<RecoveredTasks> {
  const candidates = await db
    .select({
      id: schema.tasks.id,
      kind: schema.tasks.kind,
      attemptCount: schema.tasks.attempt_count,
      upstreamTaskIds: schema.tasks.upstream_task_ids,
    })
    .from(schema.tasks)
    .where(and(eq(schema.tasks.status, 'in_progress'), scope))

  // 轮询恢复没有 per-row 计算，一条 UPDATE 收掉；启动与 SIGTERM drain 都在等这个结果。
  const resumedPolling = await requeueTasksForPolling(
    candidates.filter((c) => c.upstreamTaskIds?.length).map((c) => c.id),
  )

  let requeued = 0
  let failed = 0
  for (const candidate of candidates) {
    if (candidate.upstreamTaskIds?.length) continue
    const attemptJustFailed = candidate.attemptCount + 1
    // 对话轮不能回队：worker 会把它当生图任务重跑一遍。断了就是断了，退款收场。
    const plan: RetryPlan =
      candidate.kind === 'chat' ? { shouldRetry: false } : planNextAttempt(attemptJustFailed, now)
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

  if (requeued > 0 || failed > 0 || resumedPolling > 0) {
    log.info(
      { event: 'task.interrupted_recovered', requeued, failed, resumedPolling },
      'recovered interrupted in-progress tasks',
    )
  }
  return { requeued, failed, resumedPolling }
}

/** Runs optional private-tree maintenance (for example, the billing fallback scan). */
export async function runPrivateMaintenance(now = Date.now()): Promise<void> {
  const taskHooks = (await loadPrivateBffOverlay()).taskHooks
  await taskHooks.runMaintenance(now)
}

/**
 * 用户行删掉后素材台账随外键级联消失，对象存储里那批 key 只有靠这一趟扫描收走。
 * 只有在 users 表明确查不到该 owner 时才删，查询失败一律不动。
 */
export async function purgeOrphanedAssetObjects(): Promise<number> {
  const owners = new Set<string>()
  for (const key of await objectStore().listPrefix(ASSET_OBJECT_ROOT)) {
    const owner = key.slice(ASSET_OBJECT_ROOT.length).split('/')[0]
    if (owner) owners.add(owner)
  }
  if (owners.size === 0) return 0

  const alive = new Set(
    (
      await db
        .select({ id: schema.users.id })
        .from(schema.users)
        .where(inArray(schema.users.id, [...owners]))
    ).map((row) => row.id),
  )

  let removed = 0
  for (const owner of owners) {
    if (alive.has(owner)) continue
    try {
      await objectStore().deletePrefix(assetOwnerPrefix(owner))
      removed += 1
    } catch (error) {
      log.warn(
        { event: 'object_store.orphan_cleanup_failed', userId: owner, err: String(error) },
        'orphaned asset objects left for the next sweep',
      )
    }
  }
  return removed
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
