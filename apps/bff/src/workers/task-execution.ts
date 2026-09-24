import { hostname } from 'node:os'
import type { PersistedSubmitRequest, QueueProvider } from '@image-playground/shared'
import { and, eq, isNull, lte, or, type SQL, sql } from 'drizzle-orm'
import { config } from '../config'
import { db, schema } from '../db/client'
import { publishGenerations } from '../db/generation-events'
import {
  finishTask,
  heldBy,
  requeueTask,
  requeueTaskArchive,
  saveArchiveCheckpoint,
  type TerminalTaskUpdate,
} from '../db/task-transitions'
import { durableGenerationInputs } from '../lib/generationMedia'
import { log } from '../lib/logger'
import { type BffTransaction, loadPrivateBffOverlay } from '../lib/private-overlay'

/**
 * 任务执行：认领 → 带 fence 的写 → 收尾。
 *
 * 认领成功给出一个**执行句柄**，它是这一行在 worker 侧唯一的写入途径：每一次写都带
 * `status='in_progress' ∧ 本次执行令牌 ∧ 租约未过期`，不带 fence 的写在这里写不出来。
 * 令牌、租约续期、失租即中止都是实现，调用方只看见 `signal` 与几个带 fence 的操作。
 *
 * 一次认领的一生：`claimTaskExecution` 登记进程内的在跑表 → 句柄按心跳续租 → `release()`
 * 停表并摘掉登记。没人续的租约到点之后，这一行交给回收扫描（`db/maintenance`）接手。
 *
 * 非 worker 的写入方（cancel route、回收扫描、对话轮结算）不经句柄，它们各自在
 * `db/task-transitions` 上显式给出归属范围，见那边的说明。
 */

/** 租约窗口：失去它的执行者写不动这一行，回收扫描过了它才接手。 */
const TASK_LEASE_MS = 60_000
/** 续租间隔，必须远小于租约窗口：一次续不上还有下一次。 */
const TASK_HEARTBEAT_MS = 10_000

let heartbeatMs = TASK_HEARTBEAT_MS

/** 测试注入点；undefined 恢复真实心跳（否则失租要等真的 10 秒）。必须远小于租约窗口。 */
export function setTaskHeartbeatForTesting(intervalMs?: number): void {
  heartbeatMs = intervalMs ?? TASK_HEARTBEAT_MS
}

type TaskRow = typeof schema.tasks.$inferSelect

/** 认领时一并读到的这一行：worker 要的列，一次 `UPDATE ... RETURNING` 拿齐。 */
export type ClaimedTask = Pick<
  TaskRow,
  | 'provider'
  | 'model'
  | 'request_payload'
  | 'user_id'
  | 'archive_payload'
  | 'attempt_count'
  | 'upstream_task_ids'
  | 'upstream_submitted_at'
  | 'upstream_invocation_count'
>

/** 已提交的上游异步任务：回读只为补提交缺口，已落库的 id 一律只轮不重提。 */
export interface UpstreamSubmission {
  taskIds: string[]
  submittedAt: number
  invocationCount: number
}

export interface TaskExecution {
  readonly taskId: string
  /** 认领时读到的行。`preserveInputs` 换掉 request_payload 后以它的返回值为准。 */
  readonly task: ClaimedTask
  readonly claimedAt: number
  /** 上游 fetch 的中止信号：取消、停机、失租都从这里出。 */
  readonly signal: AbortSignal
  /** 主动停掉这次执行的上游请求；扇出的兄弟请求共用这个信号，一并停。 */
  abort(): void
  /** 记账：上游真的被调用过。返回 false 表示这一行已经不归本次执行。 */
  recordUpstreamInvocation(count?: number): Promise<boolean>
  /** 落上游异步任务 id；补提交缺口时不推锚点，否则重试等于领一份新的超时预算。 */
  recordUpstreamTaskIds(taskIds: readonly string[], anchorAlreadySet: boolean): Promise<void>
  /** 回读本次执行落下的上游提交；不归本次执行时给 undefined。 */
  readUpstreamSubmission(): Promise<UpstreamSubmission | undefined>
  /** 把输入原件挪进长期存储并落库；失去这一行时返回 null，原 request_payload 不动。 */
  preserveInputs(request: PersistedSubmitRequest): Promise<PersistedSubmitRequest | null>
  /** 存档检查点：产物字节已经落地，收尾前先把去处记下来。 */
  saveCheckpoint(payload: TaskRow['archive_payload']): Promise<boolean>
  /** 写终态并触发结算、唤醒与产物发布。 */
  finish(update: TerminalTaskUpdate): Promise<boolean>
  /** 退回 queued 等下一次尝试。 */
  requeue(attemptJustFailed: number, nextRetryAt: number): Promise<boolean>
  /** 退回 queued 只重试保存：结果还在，不消耗模型尝试次数。 */
  requeueArchive(nextRetryAt: number, payload?: TaskRow['archive_payload']): Promise<boolean>
  /** 停心跳并摘掉进程内登记：这次执行不再被 cancel / 停机点名。 */
  release(): void
}

/** 本进程正在执行的任务：cancel 要打断谁、停机要 abort 谁、崩了谁还能收尾，都看它。 */
const running = new Map<string, TaskExecutionHandle>()

class TaskExecutionHandle implements TaskExecution {
  readonly #token: string
  readonly #controller = new AbortController()
  #heartbeat: ReturnType<typeof setInterval> | undefined
  #renewing = false

  constructor(
    readonly taskId: string,
    token: string,
    readonly claimedAt: number,
    readonly task: ClaimedTask,
  ) {
    this.#token = token
    this.#heartbeat = setInterval(() => void this.#renewLease(), heartbeatMs)
  }

  get signal(): AbortSignal {
    return this.#controller.signal
  }

  /** 本次执行对这一行的 fence：状态、令牌与租约缺一不可。 */
  #fence(): SQL {
    return heldBy(this.#token)
  }

  #own(): SQL {
    return and(
      eq(schema.tasks.id, this.taskId),
      eq(schema.tasks.status, 'in_progress'),
      this.#fence(),
    )!
  }

  /** 续不上租约就是失去了这一行：立刻中止上游 fetch，别再往下写。 */
  async #renewLease(): Promise<void> {
    if (this.#renewing) return
    this.#renewing = true
    try {
      const renewed = await db
        .update(schema.tasks)
        .set({ lease_expires_at: Date.now() + TASK_LEASE_MS })
        .where(this.#own())
        .returning({ id: schema.tasks.id })
      if (renewed.length === 0) this.#controller.abort()
    } catch (error) {
      log.warn(
        { event: 'task.lease_renew_failed', taskId: this.taskId, err: String(error) },
        'task lease renewal failed',
      )
      this.#controller.abort()
    } finally {
      this.#renewing = false
    }
  }

  abort(): void {
    this.#controller.abort()
  }

  async recordUpstreamInvocation(count = 1): Promise<boolean> {
    const updated = await db
      .update(schema.tasks)
      .set({
        upstream_invocation_count: sql`${schema.tasks.upstream_invocation_count} + ${count}`,
      })
      .where(this.#own())
      .returning({ id: schema.tasks.id })
    return updated.length > 0
  }

  async recordUpstreamTaskIds(
    taskIds: readonly string[],
    anchorAlreadySet: boolean,
  ): Promise<void> {
    await db
      .update(schema.tasks)
      .set({
        upstream_task_ids: [...taskIds],
        ...(anchorAlreadySet ? {} : { upstream_submitted_at: Date.now() }),
      })
      .where(this.#own())
  }

  async readUpstreamSubmission(): Promise<UpstreamSubmission | undefined> {
    const [row] = await db
      .select({
        taskIds: schema.tasks.upstream_task_ids,
        submittedAt: schema.tasks.upstream_submitted_at,
        invocationCount: schema.tasks.upstream_invocation_count,
      })
      .from(schema.tasks)
      .where(and(eq(schema.tasks.id, this.taskId), this.#fence()))
      .limit(1)
    if (!row?.taskIds?.length || row.submittedAt === null) return undefined
    return {
      taskIds: row.taskIds,
      submittedAt: row.submittedAt,
      invocationCount: row.invocationCount,
    }
  }

  async preserveInputs(request: PersistedSubmitRequest): Promise<PersistedSubmitRequest | null> {
    const next = await durableGenerationInputs(request)
    const updated = await db
      .update(schema.tasks)
      .set({ request_payload: next })
      .where(this.#own())
      .returning({ id: schema.tasks.id })
    return updated.length > 0 ? next : null
  }

  saveCheckpoint(payload: TaskRow['archive_payload']): Promise<boolean> {
    return saveArchiveCheckpoint(this.taskId, payload, this.#fence())
  }

  finish(update: TerminalTaskUpdate): Promise<boolean> {
    return finishTask(this.taskId, update, this.#fence())
  }

  requeue(attemptJustFailed: number, nextRetryAt: number): Promise<boolean> {
    return requeueTask(this.taskId, attemptJustFailed, nextRetryAt, this.#fence())
  }

  requeueArchive(nextRetryAt: number, payload?: TaskRow['archive_payload']): Promise<boolean> {
    return requeueTaskArchive(this.taskId, nextRetryAt, payload, this.#fence())
  }

  release(): void {
    if (this.#heartbeat) clearInterval(this.#heartbeat)
    this.#heartbeat = undefined
    if (running.get(this.taskId) === this) running.delete(this.taskId)
  }
}

/**
 * 认领一条排着的任务。只有 `status='queued'` 且 `next_retry_at` 已到才认领得到，
 * 认领与令牌、租约同一次写入：滚动发布时两个实例抢同一行，只有一个拿得到句柄。
 */
export async function claimTaskExecution(
  id: string,
  claimedAt = Date.now(),
): Promise<TaskExecution | null> {
  const token = `${hostname()}:${crypto.randomUUID()}`
  const claimed = await db.transaction(async (tx) => {
    const [candidate] = await tx
      .select({ userId: schema.tasks.user_id, provider: schema.tasks.provider })
      .from(schema.tasks)
      .where(and(eq(schema.tasks.id, id), eq(schema.tasks.status, 'queued')))
      .limit(1)
    if (!candidate) return null
    if (candidate.userId) {
      // The user row serializes claims across worker instances. Count and status update must
      // share this transaction, otherwise two workers can both see the last free account slot.
      await tx
        .select({ id: schema.users.id })
        .from(schema.users)
        .where(eq(schema.users.id, candidate.userId))
        .for('update')
      const limits = await accountGenerationLimits(
        tx,
        candidate.userId,
        candidate.provider,
        claimedAt,
      )
      const [active] = await tx
        .select({
          total: sql<number>`count(*)::int`,
          provider: sql<number>`count(*) filter (where ${schema.tasks.provider} = ${candidate.provider})::int`,
        })
        .from(schema.tasks)
        .where(
          and(
            eq(schema.tasks.user_id, candidate.userId),
            eq(schema.tasks.kind, 'queue'),
            eq(schema.tasks.status, 'in_progress'),
          ),
        )
      if (
        Number(active?.total ?? 0) >= limits.total ||
        Number(active?.provider ?? 0) >= limits.provider
      )
        return null
    }
    const [row] = await tx
      .update(schema.tasks)
      .set({
        status: 'in_progress',
        started_at: claimedAt,
        execution_token: token,
        lease_expires_at: claimedAt + TASK_LEASE_MS,
      })
      .where(
        and(
          eq(schema.tasks.id, id),
          eq(schema.tasks.status, 'queued'),
          or(isNull(schema.tasks.next_retry_at), lte(schema.tasks.next_retry_at, claimedAt)),
        ),
      )
      .returning({
        provider: schema.tasks.provider,
        model: schema.tasks.model,
        request_payload: schema.tasks.request_payload,
        user_id: schema.tasks.user_id,
        archive_payload: schema.tasks.archive_payload,
        attempt_count: schema.tasks.attempt_count,
        upstream_task_ids: schema.tasks.upstream_task_ids,
        upstream_submitted_at: schema.tasks.upstream_submitted_at,
        upstream_invocation_count: schema.tasks.upstream_invocation_count,
      })
    if (row) await publishGenerations(tx, [id])
    return row
  })
  if (!claimed) return null
  const execution = new TaskExecutionHandle(id, token, claimedAt, claimed)
  running.set(id, execution)
  return execution
}

/** The claim is authoritative; the scheduler also reads this to skip accounts at capacity. */
export async function accountGenerationLimits(
  tx: BffTransaction,
  userId: string,
  provider: QueueProvider,
  now: number,
): Promise<{ total: number; provider: number }> {
  const overlay = await loadPrivateBffOverlay()
  const entitled = (await overlay.taskHooks.accountConcurrencyLimit?.({ tx, userId, now })) ?? 3
  const requested = Number.isInteger(entitled) && entitled > 0 ? entitled : 1
  const providerSlots =
    provider === 'openai-compat'
      ? config.worker.concurrency.openaiCompat
      : config.worker.concurrency.gemini
  return { total: requested, provider: Math.max(1, providerSlots - 1) }
}

/** cancel route / scheduler 调用：打断对应任务的上游 fetch。返回是否找到。 */
export function abortRunningTask(id: string): boolean {
  const execution = running.get(id)
  if (!execution) return false
  execution.abort()
  return true
}

/** drain 窗口耗尽时调用：abort 剩下的执行。回收交给调用方，见 worker-index。 */
export function abortAllRunningTasks(): number {
  const count = running.size
  for (const execution of running.values()) execution.abort()
  return count
}

export function runningTaskIds(): string[] {
  return Array.from(running.keys())
}

/**
 * executor 在本进程里崩了：只有它当时的认领人结算得了这一行。已经收过尾（句柄已 release）
 * 或压根没认领到的，这里一律不写——无主行留给回收扫描按租约处理。
 */
export async function failCrashedExecution(id: string, errorMessage: string): Promise<boolean> {
  const execution = running.get(id)
  if (!execution) return false
  try {
    return await execution.finish({
      status: 'failed',
      errorType: 'interrupted',
      errorMessage,
      completedAt: Date.now(),
    })
  } finally {
    execution.release()
  }
}
