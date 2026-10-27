import { eq } from 'drizzle-orm'
import { db, schema } from '../db/client'
import { log } from './logger'
import { cancelUpstreamTasks } from './upstream'

/**
 * 用户取消（含中止一轮带出的取消，BUG-32）提交之后，尽力叫停上游那一头。积分早在取消事务里退回，
 * 这里的结果只写进 `task.upstream_cancel` 日志，作为「上游有没有真停」的证据：`cancelled` 上游接受
 * 了取消；`partial` 有的被拒（方舟：任务已在运行，会跑完计费）；`unsupported` 这条线路没有取消
 * 接口（sub2api / xAI / Veo 只能停止轮询）；`upstream_id_unknown` 已向上游发出请求但没有任务 id（同步请求靠 worker 断开连接收手；异步提交的 id 晚到时由 `cancelLateUpstreamTasks` 补发）；
 * `no_upstream_task` 还没向上游提交。
 *
 * 由取消入口在取消事务提交之后直接触发，不依赖 worker 的运行中登记：排队等待续轮询、已有上游 id
 * 的任务同样会被叫停。只认库里此刻真是 `cancelled` 的行：取消时转去核查（reconciling）的任务上游
 * 还要接着核查，绝不能去取消它。从不抛出。
 */
export async function cancelUpstreamOfCancelledTasks(taskIds: readonly string[]): Promise<void> {
  await Promise.all(
    taskIds.map((taskId) =>
      cancelOne(taskId).catch((err) =>
        log.warn(
          { event: 'task.upstream_cancel', taskId, outcome: 'error', err: String(err) },
          'upstream cancel crashed',
        ),
      ),
    ),
  )
}

/**
 * 取消落库时上游 id 还在路上：提交请求已经在上游建起任务，但 `recordUpstreamTaskIds` 晚于取消事务，
 * 被 in_progress 栅栏挡下。此时由写入方带着刚拿到的 id 补发取消，否则这条上游任务会被永久漏掉。
 * 任务不是 `cancelled`（租约易主、转核查）时不动。从不抛出。
 */
export async function cancelLateUpstreamTasks(
  taskId: string,
  upstreamTaskIds: readonly string[],
): Promise<void> {
  await cancelOne(taskId, upstreamTaskIds).catch((err) =>
    log.warn(
      { event: 'task.upstream_cancel', taskId, outcome: 'error', late: true, err: String(err) },
      'late upstream cancel crashed',
    ),
  )
}

async function cancelOne(taskId: string, lateIds?: readonly string[]): Promise<void> {
  const [task] = await db
    .select({
      status: schema.tasks.status,
      provider: schema.tasks.provider,
      model: schema.tasks.model,
      upstreamTaskIds: schema.tasks.upstream_task_ids,
      upstreamInvocationCount: schema.tasks.upstream_invocation_count,
    })
    .from(schema.tasks)
    .where(eq(schema.tasks.id, taskId))
  if (!task || task.status !== 'cancelled') return
  const upstreamTaskIds = lateIds ?? task.upstreamTaskIds ?? []
  const base = {
    event: 'task.upstream_cancel',
    taskId,
    provider: task.provider,
    model: task.model,
    upstreamInvocationCount: task.upstreamInvocationCount,
    ...(lateIds ? { late: true } : {}),
  }
  if (upstreamTaskIds.length === 0) {
    log.info(
      {
        ...base,
        outcome: task.upstreamInvocationCount > 0 ? 'upstream_id_unknown' : 'no_upstream_task',
      },
      'cancelled task has no upstream async task to cancel',
    )
    return
  }
  const results = await cancelUpstreamTasks(task.provider, task.model, upstreamTaskIds)
  if (!results) {
    log.info(
      { ...base, outcome: 'unsupported', upstreamTaskIds },
      'upstream offers no cancel endpoint; it keeps running and billing',
    )
    return
  }
  const outcome = results.every((one) => one.outcome === 'cancelled') ? 'cancelled' : 'partial'
  log.info({ ...base, outcome, results }, 'upstream cancel attempted')
}
