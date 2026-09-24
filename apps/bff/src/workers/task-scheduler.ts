import { type QueueProvider, type TaskStatus } from '@image-playground/shared'
import { and, asc, eq, inArray, isNull, lte, or, sql } from 'drizzle-orm'
import { config } from '../config'
import { db, schema } from '../db/client'
import { log } from '../lib/logger'
import {
  abortRunningTask,
  accountGenerationLimit,
  failCrashedExecution,
  runningTaskIds,
} from './task-execution'
import { runTask } from './task-runner'

type ExecuteTask = (id: string) => Promise<void>

export interface TaskSchedulerOptions {
  pollIntervalMs?: number
  concurrency?: Partial<Record<QueueProvider, number>>
  executeTask?: ExecuteTask
  clock?: () => number
}

const PROVIDERS: readonly QueueProvider[] = ['openai-compat', 'gemini']

export class TaskScheduler {
  private readonly pollIntervalMs: number
  private readonly concurrency: Record<QueueProvider, number>
  private readonly executeTask: ExecuteTask
  private readonly clock: () => number
  private readonly active = new Map<QueueProvider, Map<string, Promise<void>>>(
    PROVIDERS.map((provider) => [provider, new Map()]),
  )
  private timer: ReturnType<typeof setInterval> | null = null
  private ticking = false
  private stopped = true
  private draining = false
  private lastSuccessfulPollTimestamp: number | null = null

  constructor(options: TaskSchedulerOptions = {}) {
    this.pollIntervalMs = options.pollIntervalMs ?? config.worker.pollIntervalMs
    this.concurrency = {
      'openai-compat':
        options.concurrency?.['openai-compat'] ?? config.worker.concurrency.openaiCompat,
      gemini: options.concurrency?.gemini ?? config.worker.concurrency.gemini,
    }
    this.executeTask = options.executeTask ?? runTask
    this.clock = options.clock ?? Date.now
  }

  start(): void {
    if (this.timer) return
    this.stopped = false
    void this.tick()
    this.timer = setInterval(() => void this.tick(), this.pollIntervalMs)
  }

  resume(): void {
    this.draining = false
  }

  drain(): void {
    this.draining = true
  }

  drainStatus() {
    return {
      draining: this.draining,
      active: this.activeCount(),
      safeToStop: this.draining && !this.ticking && this.activeCount() === 0,
    }
  }

  stop(): void {
    this.stopped = true
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  activeCount(): number {
    let count = 0
    for (const tasks of this.active.values()) count += tasks.size
    return count
  }

  lastSuccessfulPollAt(): number | null {
    return this.lastSuccessfulPollTimestamp
  }

  /** 最多等 timeoutMs 让 inflight 跑完，返回是否真的等空了。 */
  async waitForIdle(timeoutMs: number): Promise<boolean> {
    const promises = Array.from(this.active.values()).flatMap((tasks) => Array.from(tasks.values()))
    const settled = Promise.allSettled(promises)
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([
        settled.then(() => true),
        new Promise<boolean>((resolve) => {
          timer = setTimeout(() => resolve(false), timeoutMs)
        }),
      ])
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  async tick(now = this.clock()): Promise<void> {
    if (this.stopped || this.ticking) return
    this.ticking = true
    try {
      await this.abortTasksCancelledInDatabase()
      if (this.draining) {
        this.lastSuccessfulPollTimestamp = this.clock()
        return
      }
      for (const provider of PROVIDERS) {
        if (this.stopped || this.draining) return
        const active = this.active.get(provider)!
        const available = this.concurrency[provider] - active.size
        if (available <= 0) continue

        const due = await db
          .select({ id: schema.tasks.id, userId: schema.tasks.user_id })
          .from(schema.tasks)
          .where(
            and(
              eq(schema.tasks.provider, provider),
              eq(schema.tasks.status, 'queued'),
              or(isNull(schema.tasks.next_retry_at), lte(schema.tasks.next_retry_at, now)),
            ),
          )
          // Give each account its oldest task before taking a second task from any account.
          // This keeps one large backlog from hiding another account's runnable work.
          .orderBy(
            sql`row_number() over (partition by coalesce(${schema.tasks.user_id}, ${schema.tasks.id}) order by ${schema.tasks.submitted_at}, ${schema.tasks.id})`,
            asc(schema.tasks.submitted_at),
          )
          .limit(available + this.concurrency[provider] * 3)

        if (this.stopped || this.draining) return
        const selected = await db.transaction(async (tx) => {
          const userIds = [...new Set(due.flatMap((task) => (task.userId ? [task.userId] : [])))]
          const activeRows = userIds.length
            ? await tx
                .select({ userId: schema.tasks.user_id, count: sql<number>`count(*)::int` })
                .from(schema.tasks)
                .where(
                  and(
                    inArray(schema.tasks.user_id, userIds),
                    eq(schema.tasks.kind, 'queue'),
                    eq(schema.tasks.status, 'in_progress'),
                  ),
                )
                .groupBy(schema.tasks.user_id)
            : []
          const activeCounts = new Map(activeRows.map((row) => [row.userId, Number(row.count)]))
          const limits = new Map<string, number>()
          const selected: typeof due = []
          for (const task of due) {
            if (task.userId) {
              let limit = limits.get(task.userId)
              if (limit === undefined) {
                limit = await accountGenerationLimit(tx, task.userId, now)
                limits.set(task.userId, limit)
              }
              const count = activeCounts.get(task.userId) ?? 0
              if (count >= limit) continue
              activeCounts.set(task.userId, count + 1)
            }
            selected.push(task)
            if (selected.length >= available) break
          }
          return selected
        })
        if (this.stopped || this.draining) return
        for (const task of selected) this.launch(provider, task.id)
      }
      this.lastSuccessfulPollTimestamp = this.clock()
    } catch (err) {
      log.error(
        { event: 'worker.tick_failed', err: err instanceof Error ? err.message : String(err) },
        'worker scheduler tick failed',
      )
    } finally {
      this.ticking = false
    }
  }

  private launch(provider: QueueProvider, id: string): void {
    const active = this.active.get(provider)!
    if (active.has(id)) return

    const promise = Promise.resolve()
      .then(() => this.executeTask(id))
      .catch(async (err) => {
        const message = err instanceof Error ? err.message : String(err)
        log.error({ event: 'task.crashed', taskId: id, err: message }, 'task-runner crashed')
        // 崩在认领之后就由本进程那次认领收尾；认领之前崩的行没人写，留给回收扫描。
        await failCrashedExecution(id, `Worker 执行异常：${message}`)
      })
      .finally(() => active.delete(id))
    active.set(id, promise)
  }

  private async abortTasksCancelledInDatabase(): Promise<void> {
    const ids = runningTaskIds()
    if (ids.length === 0) return

    const rows = await db
      .select({ id: schema.tasks.id, status: schema.tasks.status })
      .from(schema.tasks)
      .where(inArray(schema.tasks.id, ids))
    const statuses = new Map<string, TaskStatus>(rows.map((row) => [row.id, row.status]))

    for (const id of ids) {
      if (statuses.get(id) === 'in_progress') continue
      if (abortRunningTask(id)) {
        log.info({ event: 'task.cancel_observed', taskId: id }, 'worker observed cancellation')
      }
    }
  }
}
