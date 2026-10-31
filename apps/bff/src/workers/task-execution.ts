import { hostname } from 'node:os'
import type { PersistedSubmitRequest, QueueProvider } from '@image-playground/shared'
import { and, eq, isNull, lte, or, type SQL, type SQLWrapper, sql } from 'drizzle-orm'
import { config } from '../config'
import { db, schema } from '../db/client'
import { publishGenerations } from '../db/generation-events'
import {
  finishTask,
  heldBy,
  reconcileTasks,
  requeueTask,
  requeueTaskArchive,
  saveArchiveCheckpoint,
  type TerminalTaskUpdate,
} from '../db/task-transitions'
import { accountConcurrencyLimit } from '../lib/account-concurrency'
import { getRoutableChannels } from '../lib/channels'
import { durableGenerationInputs } from '../lib/generationMedia'
import { log } from '../lib/logger'
import { type BffTransaction, loadPrivateBffOverlay } from '../lib/private-overlay'
import { taskConcurrencyScope } from '../lib/upstream'
import { cancelLateUpstreamTasks } from '../lib/upstream-cancel'
import { checkIdleSlot, lockIdleSlotClaims, providerConcurrencyLimit } from './idle-concurrency'

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

/**
 * 续租这一下抛错（连接断了、超时）时，租约是不是已经保不住了。还撑得到下一次心跳就接着跑：
 * 数据库闪断一下就掐掉上游请求，等于把一张已经付了钱的图扔掉。撑不到时必须停，
 * 过了到期时间回收扫描会接手这一行。
 */
export function leaseLostAfterFailedRenewal(
  now: number,
  leaseExpiresAt: number,
  intervalMs: number,
): boolean {
  return leaseExpiresAt - now <= intervalMs
}

type TaskRow = typeof schema.tasks.$inferSelect

/** 认领时一并读到的这一行：worker 要的列，一次 `UPDATE ... RETURNING` 拿齐。 */
export type ClaimedTask = Pick<
  TaskRow,
  | 'reconciliation_required'
  | 'provider'
  | 'model'
  | 'request_payload'
  | 'user_id'
  | 'archive_payload'
  | 'archive_retry_started_at'
  | 'attempt_count'
  | 'upstream_task_ids'
  | 'upstream_submitted_at'
  | 'upstream_invocation_count'
  | 'submitted_at'
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
  /** 这次认领用的是空闲时可用并发（弹性名额），不是套餐的保证并发。 */
  readonly idleSlot: boolean
  /** 上游 fetch 的中止信号：取消、停机、失租都从这里出。 */
  readonly signal: AbortSignal
  /** 主动停掉这次执行的上游请求；扇出的兄弟请求共用这个信号，一并停。 */
  abort(): void
  /** 记账：上游真的被调用过。返回 false 表示这一行已经不归本次执行。 */
  recordUpstreamInvocation(count?: number): Promise<boolean>
  recordDispatchIntent(): Promise<string | null>
  recordDispatchStarted(id: string): Promise<void>
  recordDispatchRequestId(id: string, requestId: string): Promise<void>
  recordDispatchTaskId(id: string, taskId: string): Promise<void>
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
  reconcile(reason: string, options?: { requireReconciliation?: boolean }): Promise<boolean>
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
  #leaseExpiresAt: number

  constructor(
    readonly taskId: string,
    token: string,
    readonly claimedAt: number,
    readonly task: ClaimedTask,
    readonly idleSlot = false,
  ) {
    this.#token = token
    this.#leaseExpiresAt = claimedAt + TASK_LEASE_MS
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

  /** 这一行已被接手就立刻中止上游 fetch；续租请求本身失败时撑到租约将尽才中止。 */
  async #renewLease(): Promise<void> {
    if (this.#renewing) return
    this.#renewing = true
    try {
      const leaseExpiresAt = Date.now() + TASK_LEASE_MS
      const renewed = await db
        .update(schema.tasks)
        .set({ lease_expires_at: leaseExpiresAt })
        .where(this.#own())
        .returning({ id: schema.tasks.id })
      if (renewed.length === 0) this.#controller.abort()
      else this.#leaseExpiresAt = leaseExpiresAt
    } catch (error) {
      const lost = leaseLostAfterFailedRenewal(Date.now(), this.#leaseExpiresAt, heartbeatMs)
      log.warn(
        { event: 'task.lease_renew_failed', taskId: this.taskId, lost, err: String(error) },
        'task lease renewal failed',
      )
      if (lost) this.#controller.abort()
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

  async recordDispatchIntent(): Promise<string | null> {
    return db.transaction(async (tx) => {
      const updated = await tx
        .update(schema.tasks)
        .set({
          upstream_invocation_count: sql`${schema.tasks.upstream_invocation_count} + 1`,
        })
        .where(this.#own())
        .returning({ id: schema.tasks.id })
      if (!updated.length) return null
      const id = crypto.randomUUID()
      await tx
        .insert(schema.task_dispatches)
        .values({ id, task_id: this.taskId, execution_token: this.#token, intended_at: Date.now() })
      return id
    })
  }

  async recordDispatchStarted(id: string): Promise<void> {
    await db
      .update(schema.task_dispatches)
      .set({ dispatched_at: Date.now() })
      .where(
        and(
          eq(schema.task_dispatches.id, id),
          eq(schema.task_dispatches.execution_token, this.#token),
        ),
      )
  }

  async recordDispatchRequestId(id: string, requestId: string): Promise<void> {
    await db
      .update(schema.task_dispatches)
      .set({ upstream_request_id: requestId.slice(0, 256) })
      .where(
        and(
          eq(schema.task_dispatches.id, id),
          eq(schema.task_dispatches.execution_token, this.#token),
        ),
      )
  }

  /** The old lease may report its own response, but this never grants permission to settle. */
  async recordDispatchTaskId(id: string, taskId: string): Promise<void> {
    await db
      .update(schema.task_dispatches)
      .set({ upstream_task_id: taskId })
      .where(
        and(
          eq(schema.task_dispatches.id, id),
          eq(schema.task_dispatches.task_id, this.taskId),
          eq(schema.task_dispatches.execution_token, this.#token),
        ),
      )
  }

  async recordUpstreamTaskIds(
    taskIds: readonly string[],
    anchorAlreadySet: boolean,
  ): Promise<void> {
    const updated = await db
      .update(schema.tasks)
      .set({
        upstream_task_ids: [...taskIds],
        ...(anchorAlreadySet ? {} : { upstream_submitted_at: Date.now() }),
      })
      .where(this.#own())
      .returning({ id: schema.tasks.id })
    // A late response remains dispatch evidence, but the former owner must not start polling.
    if (!updated.length) {
      this.abort()
      // 取消先落库、上游 id 后到：取消入口当时看不到这个 id，由这里补发（BUG-32）。
      void cancelLateUpstreamTasks(this.taskId, taskIds)
    }
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

  async reconcile(
    reason: string,
    options: { requireReconciliation?: boolean } = {},
  ): Promise<boolean> {
    if (!options.requireReconciliation)
      return (await reconcileTasks(this.#own(), reason)).length > 0
    return db.transaction(async (tx) => {
      const updated = await tx
        .update(schema.tasks)
        .set({ reconciliation_required: true })
        .where(this.#own())
        .returning({ id: schema.tasks.id })
      if (!updated.length) return false
      return (await reconcileTasks(this.#own(), reason, tx)).length > 0
    })
  }

  finish(update: TerminalTaskUpdate): Promise<boolean> {
    if (
      this.task.reconciliation_required &&
      update.status === 'failed' &&
      update.errorType === 'upstream_result_unknown'
    )
      return this.reconcile(update.errorMessage ?? '上游结果待核查')
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
 * 正在等重试的任务替自己留着那个并发位的最长等待（BUG-84）。上游重试退避最长 60s
 * （RETRY_BACKOFF_MS），多出的余量给时钟和调度抖动；超过这个时长的等待（如存档重试、
 * 运维手动推迟）不再占位，免得一条长等待把账号卡死。
 */
export const RETRY_SLOT_HOLD_MS = 90_000

/**
 * 这一行是否是「刚失败、等着按退避重试」的任务：它让出 in_progress 只是为了等时间，
 * 账号并发位应当还算它的（BUG-84：370b97db 进入 10s 重试等待后 0.5s，同账号排队的
 * 915fad3f 抢走了位置，370b97db 等了四分多钟）。只认上游重试（attempt_count > 0、
 * 没有存档载荷），等待时长在 {@link RETRY_SLOT_HOLD_MS} 以内。
 *
 * 写成可复用的 SQL 条件：之后统一调度层接管计数时，只需把这一类行算进它的占位。
 */
export function retryHoldsSlot(alias: string, now: number): SQL {
  const t = sql.identifier(alias)
  return sql`(${t}.status = 'queued'
    and ${t}.attempt_count > 0
    and ${t}.archive_payload is null
    and ${t}.next_retry_at > to_timestamp(${now} / 1000.0)
    and ${t}.next_retry_at <= to_timestamp(${now + RETRY_SLOT_HOLD_MS} / 1000.0))`
}

/**
 * 智能体同一轮里，同模型最多同时跑几条。原先一律一条（2026-10-29：一轮 5 单 Flash Lite 同时起跑，
 * 在同一个按模型限速的配额上互相挤出 429），连没有限速的模型也被串行：2026-10-30 线上一轮 5 张
 * gpt-image-2.5-flare 每张约 34s，一张接一张跑了近 3 分钟，worker 还空着 3 个位。
 * 现在只有在 channels.json 声明了并发上限的模型（共享一份按模型限速的配额，如 Vertex）还一次一条；
 * 其他模型同轮最多 {@link TURN_SIBLING_PARALLELISM} 条，账号并发和 worker 并发照旧在后面把关。
 */
export const TURN_SIBLING_PARALLELISM = 3

/** 返回指定 provider 下声明了并发上限的模型名；不传 provider 时仅供诊断测试读取全部模型。 */
export function turnSerializedModels(provider?: QueueProvider): string[] {
  const models = new Set<string>()
  for (const channel of getRoutableChannels()) {
    const channelProvider =
      channel.kind === 'gemini-queue'
        ? ('gemini' as const)
        : channel.kind === 'openai-queue'
          ? ('openai-compat' as const)
          : null
    if (!channelProvider || (provider && channelProvider !== provider)) continue
    for (const model of channel.models)
      for (const id of taskConcurrencyScope(channelProvider, model.id)?.models ?? []) models.add(id)
  }
  return [...models].sort()
}

/** 这个 provider + model 同轮同时能跑几条，写成 SQL 表达式。 */
function turnSiblingLimit(provider: SQLWrapper, model: SQLWrapper): SQL {
  const scopes: SQL[] = []
  for (const [scopeProvider, models] of [
    ['gemini' as const, turnSerializedModels('gemini')],
    ['openai-compat' as const, turnSerializedModels('openai-compat')],
  ] as const) {
    if (models.length)
      scopes.push(
        sql`when ${provider} = ${scopeProvider} and ${model} in (${sql.join(
          models.map((id) => sql`${id}`),
          sql`, `,
        )}) then 1`,
      )
  }
  return scopes.length
    ? sql`case ${sql.join(scopes, sql` `)} else ${TURN_SIBLING_PARALLELISM} end`
    : sql`${TURN_SIBLING_PARALLELISM}`
}

/** 同一轮同模型、还在跑或等重试的兄弟任务是否已经占满上限。 */
export function turnSiblingsAtLimit(
  taskId: SQLWrapper,
  provider: SQLWrapper,
  model: SQLWrapper,
  now = Date.now(),
): SQL {
  return sql`((
    select count(*) from ${schema.agent_jobs} as turn_mine
    join ${schema.agent_jobs} as turn_sibling
      on turn_sibling.conversation_id = turn_mine.conversation_id
      and turn_sibling.turn_id = turn_mine.turn_id
      and turn_sibling.task_id <> turn_mine.task_id
      and turn_sibling.delivered_at is null
    join ${schema.tasks} as turn_sibling_task on turn_sibling_task.id = turn_sibling.task_id
    where turn_mine.task_id = ${taskId}
      and (turn_sibling_task.status = 'in_progress' or ${retryHoldsSlot('turn_sibling_task', now)})
      and turn_sibling_task.provider = ${provider}
      and turn_sibling_task.model = ${model}
  ) >= ${turnSiblingLimit(provider, model)})`
}

/**
 * 匿名智能体任务（`user_id` 为空）的同轮串行：没有用户行可锁，改拿这一轮的事务级咨询锁，
 * 再查 {@link turnSiblingsAtLimit}。同一轮的两条并发认领因此一前一后，后一条看得见前一条
 * 刚提交的 in_progress。不是智能体提交的任务没有 agent_jobs 行，不拿锁，也不受影响。
 * 锁顺序「轮锁 → provider 锁」，匿名认领不碰用户行，不会与登录用户的认领成环。
 */
async function anonymousTurnSiblingRunning(
  tx: BffTransaction,
  taskId: string,
  provider: string,
  model: string,
  now: number,
): Promise<boolean> {
  const locked = await tx
    .select({
      turn: sql`pg_advisory_xact_lock(hashtextextended('agent-turn-claim:' || ${schema.agent_jobs.conversation_id} || ':' || ${schema.agent_jobs.turn_id}, 0))`,
    })
    .from(schema.agent_jobs)
    .where(eq(schema.agent_jobs.task_id, taskId))
  if (locked.length === 0) return false
  const [sibling] = await tx
    .select({
      running: turnSiblingsAtLimit(sql`${taskId}`, sql`${provider}`, sql`${model}`, now),
    })
    .from(sql`(select 1) as one`)
  return Boolean(sibling?.running)
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
  let idleSlot:
    | { activeTotal: number; runningOnProvider: number; runningInScope: number | null }
    | undefined
  const claimed = await db.transaction(async (tx) => {
    idleSlot = undefined
    const [candidate] = await tx
      .select({
        userId: schema.tasks.user_id,
        provider: schema.tasks.provider,
        model: schema.tasks.model,
      })
      .from(schema.tasks)
      .where(
        and(
          eq(schema.tasks.id, id),
          eq(schema.tasks.status, 'queued'),
          eq(schema.tasks.kind, 'queue'),
        ),
      )
      .limit(1)
    if (!candidate) return null
    // 开了弹性名额时，同一 provider 上的所有认领（保证、弹性、匿名）都串在一把锁上：
    // 否则弹性判定读完正在跑的数之后、看排队之前，别人的保证认领提交了，两边都看不见对方而超发。
    // 锁顺序固定为「用户行 → provider 锁」，匿名任务没有用户行只拿 provider 锁。
    const serializeProviderClaims = config.worker.idleConcurrencyEnabled
    if (candidate.userId) {
      // Serialize account counts/claims while permitting FK KEY SHARE: a finishing task may
      // hold user_change_heads before inserting user_changes, which references this user.
      await tx
        .select({ id: schema.users.id })
        .from(schema.users)
        .where(eq(schema.users.id, candidate.userId))
        .for('no key update')
      const [sibling] = await tx
        .select({
          running: turnSiblingsAtLimit(
            sql`${id}`,
            sql`${candidate.provider}`,
            sql`${candidate.model}`,
            claimedAt,
          ),
        })
        .from(sql`(select 1) as one`)
      if (sibling?.running) return null
      if (serializeProviderClaims) await lockIdleSlotClaims(tx, candidate.provider)
      const limits = await accountGenerationLimits(
        tx,
        candidate.userId,
        candidate.provider,
        claimedAt,
      )
      // 在跑的，加上同账号正在等重试、替自己留着位置的（BUG-84）；候选自己不算。
      const [active] = await tx
        .select({
          total: sql<number>`count(*)::int`,
          provider: sql<number>`count(*) filter (where account_task.provider = ${candidate.provider})::int`,
        })
        .from(sql`${schema.tasks} as account_task`)
        .where(
          sql`account_task.user_id = ${candidate.userId}
            and account_task.kind = 'queue'
            and account_task.id <> ${id}
            and (account_task.status = 'in_progress' or ${retryHoldsSlot('account_task', claimedAt)})`,
        )
      const activeTotal = Number(active?.total ?? 0)
      if (Number(active?.provider ?? 0) >= limits.provider) return null
      if (activeTotal >= limits.total) {
        // 保证并发用满了：只剩弹性名额。先拿锁再判定，多个 worker 同时放弹性名额也不会超发。
        if (activeTotal >= limits.idle) return null
        const decision = await checkIdleSlot(tx, {
          provider: candidate.provider,
          model: candidate.model,
          userId: candidate.userId,
          now: claimedAt,
        })
        if (!decision.granted) {
          log.info(
            {
              event: 'task.idle_slot_denied',
              taskId: id,
              userId: candidate.userId,
              provider: candidate.provider,
              model: candidate.model,
              reason: decision.reason,
              activeTotal,
              guaranteed: limits.total,
              idle: limits.idle,
            },
            'idle concurrency slot denied',
          )
          return null
        }
        idleSlot = {
          activeTotal,
          runningOnProvider: decision.runningOnProvider,
          runningInScope: decision.runningInScope,
        }
      }
    } else {
      if (await anonymousTurnSiblingRunning(tx, id, candidate.provider, candidate.model, claimedAt))
        return null
      if (serializeProviderClaims) await lockIdleSlotClaims(tx, candidate.provider)
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
          eq(schema.tasks.kind, 'queue'),
          or(isNull(schema.tasks.next_retry_at), lte(schema.tasks.next_retry_at, claimedAt)),
        ),
      )
      .returning({
        reconciliation_required: schema.tasks.reconciliation_required,
        provider: schema.tasks.provider,
        model: schema.tasks.model,
        request_payload: schema.tasks.request_payload,
        user_id: schema.tasks.user_id,
        archive_payload: schema.tasks.archive_payload,
        archive_retry_started_at: schema.tasks.archive_retry_started_at,
        attempt_count: schema.tasks.attempt_count,
        upstream_task_ids: schema.tasks.upstream_task_ids,
        upstream_submitted_at: schema.tasks.upstream_submitted_at,
        upstream_invocation_count: schema.tasks.upstream_invocation_count,
        submitted_at: schema.tasks.submitted_at,
      })
    if (row) await publishGenerations(tx, [id])
    return row
  })
  if (!claimed) return null
  if (idleSlot)
    log.info(
      {
        event: 'task.idle_slot_granted',
        taskId: id,
        userId: claimed.user_id,
        provider: claimed.provider,
        model: claimed.model,
        idleSlot: true,
        activeTotalBefore: idleSlot.activeTotal,
        runningOnProvider: idleSlot.runningOnProvider,
        providerLimit: providerConcurrencyLimit(claimed.provider),
        runningInModelScope: idleSlot.runningInScope,
      },
      'task claimed on idle concurrency slot',
    )
  const execution = new TaskExecutionHandle(id, token, claimedAt, claimed, Boolean(idleSlot))
  running.set(id, execution)
  return execution
}

/** The claim is authoritative; the scheduler also reads this to skip accounts at capacity. */
export async function accountGenerationLimits(
  tx: BffTransaction,
  userId: string,
  provider: QueueProvider,
  now: number,
): Promise<{ total: number; provider: number; idle: number }> {
  const overlay = await loadPrivateBffOverlay()
  const hooks = overlay.taskHooks
  const entitlement = hooks.accountConcurrencyEntitlement
    ? await hooks.accountConcurrencyEntitlement({ tx, userId, now })
    : { guaranteed: await accountConcurrencyLimit(tx, userId, now), idle: 0 }
  const guaranteed = entitlement.guaranteed
  const requested = Number.isInteger(guaranteed) && guaranteed > 0 ? guaranteed : 1
  const idle =
    config.worker.idleConcurrencyEnabled && Number.isInteger(entitlement.idle)
      ? Math.max(requested, entitlement.idle)
      : requested
  return {
    total: requested,
    provider: Math.max(1, providerConcurrencyLimit(provider) - 1),
    idle,
  }
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
    if (await execution.reconcile(errorMessage)) return true
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
