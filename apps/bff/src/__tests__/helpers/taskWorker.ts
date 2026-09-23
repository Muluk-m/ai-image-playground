import type { TerminalTaskUpdate } from '../../db/task-transitions'
import { claimTaskExecution } from '../../workers/task-execution'

/**
 * 夹具里的「worker 把这条任务跑完了」：走真实的认领 → 执行句柄 → 收尾，
 * 结算、唤醒与项目产物这些副作用一个不少，跟线上同一条路。
 *
 * 只有**故意**要一个半路状态的夹具才该自己写任务行：租约过期、强停回收、
 * scheduler 的替身执行器。那些地方写的是「没人收尾」，不是「worker 收尾了」。
 */
export async function settleTaskAsWorker(
  taskId: string,
  update: Omit<TerminalTaskUpdate, 'completedAt'> & { completedAt?: number },
): Promise<boolean> {
  const execution = await claimTaskExecution(taskId)
  if (!execution) throw new Error(`task ${taskId} 排队中才认领得到，当前认领不到`)
  try {
    return await execution.finish({ completedAt: Date.now(), ...update })
  } finally {
    execution.release()
  }
}
