import type { DbHandle } from '@image-playground/db'
import type { AgentToolErrorCode, TaskErrorType } from '@image-playground/shared'

export type ExecutionTransaction = Parameters<Parameters<DbHandle['db']['transaction']>[0]>[0]

export interface GenerationMediaLink {
  role: 'input' | 'mask' | 'output'
  position: number
  mediaId: string
}

export type TerminalTaskStatus = 'completed' | 'failed' | 'cancelled'

export interface ExecutionTaskUsage {
  quantity: number
  unitMultiplier: number
  tokens?: { input: number; output: number; cachedInput?: number }
}

export interface TaskFinishedEvent {
  readonly taskId: string
  readonly taskKind?: string
  readonly agentConversationId?: string | null
  readonly agentTurnId?: string | null
  readonly userId: string | null
  readonly model: string
  readonly status: TerminalTaskStatus
  readonly completedAt: number
  readonly errorType?: TaskErrorType
  readonly upstreamStatus?: number | null
  readonly upstreamInvocationCount: number
  readonly meteringMode: 'credits' | 'none'
  readonly actualUsage?: ExecutionTaskUsage
  readonly resultPayload?: unknown
  readonly media?: readonly GenerationMediaLink[]
}

export interface CancelledTaskRecord {
  readonly taskId: string
  readonly taskKind?: string
  readonly agentConversationId?: string | null
  readonly agentTurnId?: string | null
  readonly userId: string | null
  readonly meteringMode: 'credits' | 'none'
  readonly upstreamInvocationCount: number
}

export interface TasksCancelledEvent {
  readonly tasks: readonly CancelledTaskRecord[]
  readonly completedAt: number
  readonly failedAs?: AgentToolErrorCode
}

/**
 * 事务内终态监听器的执行阶段：
 * - `before-settlement`：在计费结算前执行（媒体落表、画布预留回填），保持既有锁顺序（先持 media 锁再进计费锁）。
 * - `settlement`：计费终态结算（预扣转实扣或退款），由 fail-closed 断言保护，缺失时回滚终态事务。
 * - `after-settlement`：在计费结算后执行（模型自动下架、智能体后台任务唤醒）。
 */
export type TaskLifecycleStage = 'before-settlement' | 'settlement' | 'after-settlement'

export class MissingTaskLifecycleListenerError extends Error {
  constructor(readonly listenerId: string) {
    super(
      `Task lifecycle listener "${listenerId}" is not registered; ensure bootstrap/task-lifecycle is loaded`,
    )
    this.name = 'MissingTaskLifecycleListenerError'
  }
}

export interface TaskLifecycleListener {
  readonly id: string
  readonly stage: TaskLifecycleStage
  /** 可选的事务外预热（例如惰性加载计费模块），避免持有数据库事务连接时做冷启动初始化。 */
  prepare?(): Promise<void>
  onTaskFinished?(tx: ExecutionTransaction, event: TaskFinishedEvent): Promise<void>
  onTasksCancelled?(tx: ExecutionTransaction, event: TasksCancelledEvent): Promise<void>
  /**
   * 终态事务提交后执行的异步投影钩子（例如把任务结局与已提交实扣写回 `agent_messages`）。
   * 异常会被捕获隔离，绝不反向影响已经提交的任务终态。
   */
  afterTaskFinished?(event: TaskFinishedEvent): Promise<void>
  afterTasksCancelled?(event: TasksCancelledEvent): Promise<void>
}

const listenersById = new Map<string, TaskLifecycleListener>()
const listenersByStage: Record<TaskLifecycleStage, TaskLifecycleListener[]> = {
  'before-settlement': [],
  settlement: [],
  'after-settlement': [],
}

/**
 * 注册事务内任务终态监听器。
 * - 同一对象重复注册幂等忽略；
 * - 相同 id 指向不同定义直接抛错，避免装配根静默覆盖。
 * 返回注销函数供单测清理。
 */
export function registerTaskLifecycleListener(listener: TaskLifecycleListener): () => void {
  const existing = listenersById.get(listener.id)
  if (existing) {
    if (existing === listener) return () => unregisterTaskLifecycleListener(listener)
    throw new Error(`Conflicting task lifecycle listener registration for id: ${listener.id}`)
  }
  listenersById.set(listener.id, listener)
  listenersByStage[listener.stage].push(listener)
  return () => unregisterTaskLifecycleListener(listener)
}

function unregisterTaskLifecycleListener(listener: TaskLifecycleListener): void {
  if (listenersById.get(listener.id) !== listener) return
  listenersById.delete(listener.id)
  const bucket = listenersByStage[listener.stage]
  const index = bucket.indexOf(listener)
  if (index >= 0) bucket.splice(index, 1)
}

export function assertTaskLifecycleListenerRegistered(id: string): void {
  if (!listenersById.has(id)) {
    throw new MissingTaskLifecycleListenerError(id)
  }
}

export async function prepareTaskLifecycleStage(stage: TaskLifecycleStage): Promise<void> {
  for (const listener of [...listenersByStage[stage]]) {
    await listener.prepare?.()
  }
}

/**
 * 在当前 PostgreSQL 事务内按注册顺序串行派发终态事件。
 * 任一监听器抛错立即向外冒泡以回滚整笔事务，保持任务终态与下游副作用的原子性。
 */
export async function emitTaskFinished(
  tx: ExecutionTransaction,
  stage: TaskLifecycleStage,
  event: TaskFinishedEvent,
): Promise<void> {
  // 拷贝快照防止监听器执行期间集合变动影响遍历。
  for (const listener of [...listenersByStage[stage]]) {
    await listener.onTaskFinished?.(tx, event)
  }
}

export async function emitTasksCancelled(
  tx: ExecutionTransaction,
  stage: TaskLifecycleStage,
  event: TasksCancelledEvent,
): Promise<void> {
  for (const listener of [...listenersByStage[stage]]) {
    await listener.onTasksCancelled?.(tx, event)
  }
}

const STAGE_ORDER: readonly TaskLifecycleStage[] = [
  'before-settlement',
  'settlement',
  'after-settlement',
]

/**
 * 终态事务提交之后按阶段顺序派发提交后投影钩子。
 * 单个监听器的异常由调用方回调记录并隔离，不阻断后续监听器或破坏已提交的终态结果。
 */
export async function emitTaskFinishedAfterCommit(
  event: TaskFinishedEvent,
  onError?: (listenerId: string, error: unknown) => void,
): Promise<void> {
  for (const stage of STAGE_ORDER) {
    for (const listener of [...listenersByStage[stage]]) {
      if (!listener.afterTaskFinished) continue
      try {
        await listener.afterTaskFinished(event)
      } catch (error) {
        onError?.(listener.id, error)
      }
    }
  }
}

export async function emitTasksCancelledAfterCommit(
  event: TasksCancelledEvent,
  onError?: (listenerId: string, error: unknown) => void,
): Promise<void> {
  for (const stage of STAGE_ORDER) {
    for (const listener of [...listenersByStage[stage]]) {
      if (!listener.afterTasksCancelled) continue
      try {
        await listener.afterTasksCancelled(event)
      } catch (error) {
        onError?.(listener.id, error)
      }
    }
  }
}

export function listTaskLifecycleListenerIds(stage?: TaskLifecycleStage): readonly string[] {
  if (stage) return listenersByStage[stage].map((listener) => listener.id)
  return [...listenersById.keys()]
}

export function _resetTaskLifecycleListenersForTesting(): void {
  listenersById.clear()
  listenersByStage['before-settlement'].length = 0
  listenersByStage.settlement.length = 0
  listenersByStage['after-settlement'].length = 0
}
