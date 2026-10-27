import { eq } from 'drizzle-orm'
import { db, schema } from '../db/client'
import { log } from '../lib/logger'
import { cancelUpstreamTasks } from '../lib/upstream'

/**
 * 用户取消（含中止一轮带出的取消，BUG-32）被 worker 察觉之后，尽力叫停上游那一头。只在库里的状态
 * 真是 `cancelled` 时调用：租约丢失、停机排空、转去核查（reconciling）也会中断执行，那些情形上游
 * 的任务还要接着轮询或核查，绝不能去取消它。
 *
 * 积分早在取消事务里退回，这里的结果只写进 `task.upstream_cancel` 日志，作为「上游有没有真停」
 * 的证据：`cancelled` 上游接受了取消；`rejected` 上游拒绝（方舟：任务已在运行，会跑完计费）；
 * `unsupported` 这条线路没有取消接口（同步线路靠断开连接收手，sub2api / xAI / Veo 只能停止轮询）；
 * `no_upstream_task` 还没拿到上游任务 id（排队中或同步请求）。
 */
export async function cancelUpstreamOfCancelledTask(taskId: string): Promise<void> {
  const [task] = await db
    .select({
      provider: schema.tasks.provider,
      model: schema.tasks.model,
      upstreamTaskIds: schema.tasks.upstream_task_ids,
      upstreamInvocationCount: schema.tasks.upstream_invocation_count,
    })
    .from(schema.tasks)
    .where(eq(schema.tasks.id, taskId))
  if (!task) return
  const upstreamTaskIds = task.upstreamTaskIds ?? []
  const base = {
    event: 'task.upstream_cancel',
    taskId,
    provider: task.provider,
    model: task.model,
    upstreamInvocationCount: task.upstreamInvocationCount,
  }
  if (upstreamTaskIds.length === 0) {
    log.info(
      {
        ...base,
        outcome: task.upstreamInvocationCount > 0 ? 'connection_aborted' : 'no_upstream_task',
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
