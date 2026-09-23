import { eq } from 'drizzle-orm'
import { db, schema } from '../../db/client'
import type { TerminalTaskUpdate } from '../../db/task-transitions'
import { claimTaskExecution, type TaskExecution } from '../../workers/task-execution'

/** 收尾时给的那份终态，完成时刻可省。 */
export type WorkerSettlement = Omit<TerminalTaskUpdate, 'completedAt'> & { completedAt?: number }

/** 夹具里那个 worker 手上攥着的认领：一条任务一次，收尾时还回来。 */
const claims = new Map<string, TaskExecution>()

/**
 * 夹具里的「worker 领走了这条任务」：行进到 in_progress，租约在，还没收尾。
 * 同一条任务重复领拿到的是同一个句柄——一条任务只有一个执行者。
 */
export async function workerClaims(taskId: string): Promise<TaskExecution> {
  const held = claims.get(taskId)
  if (held) return held
  const execution = await claimTaskExecution(taskId)
  if (!execution) throw new Error(`task ${taskId} 排队中才认领得到，当前认领不到`)
  claims.set(taskId, execution)
  return execution
}

/**
 * 夹具里的「worker 把这条任务跑完了」：走真实的认领 → 执行句柄 → 收尾，
 * 结算、唤醒与项目产物这些副作用一个不少，跟线上同一条路。
 *
 * 只有**故意**要一个半路状态的夹具才该自己写任务行：租约过期、强停回收、
 * scheduler 的替身执行器。那些地方写的是「没人收尾」，不是「worker 收尾了」。
 */
export async function workerSettles(taskId: string, update: WorkerSettlement): Promise<boolean> {
  const execution = await workerClaims(taskId)
  try {
    return await execution.finish({ completedAt: Date.now(), ...update })
  } finally {
    execution.release()
    claims.delete(taskId)
  }
}

/**
 * 夹具里那个后台 mini worker 跑一轮：把此刻排着的任务按真实路径收尾。
 * 认领不到的直接跳过——它在轮询，不是权威：用例清库或另一条路已经把行推走都算正常。
 */
export async function settleQueuedTasks(
  settlementOf: (task: typeof schema.tasks.$inferSelect) => WorkerSettlement,
): Promise<void> {
  const queued = await db.select().from(schema.tasks).where(eq(schema.tasks.status, 'queued'))
  for (const task of queued) {
    const execution = await claimTaskExecution(task.id)
    if (!execution) continue
    try {
      await execution.finish({ completedAt: Date.now(), ...settlementOf(task) })
    } finally {
      execution.release()
    }
  }
}

/** 放掉还攥在手里的认领（停心跳）。领了不收尾的用例放进 afterEach。 */
export function releaseWorkerClaims(): void {
  for (const execution of claims.values()) execution.release()
  claims.clear()
}
