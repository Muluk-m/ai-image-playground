import { type QueueProvider, type TaskStatus } from '@image-playground/shared'
import { and, asc, eq, inArray, isNull, lte, or } from 'drizzle-orm'
import { config } from '../config'
import { db, schema } from '../db/client'
import { log } from '../lib/logger'
import { abortRunningTask, runningTaskIds, runTask } from './task-runner'

type ExecuteTask = (id: string) => Promise<void>

export interface TaskSchedulerOptions {
  pollIntervalMs?: number
  concurrency?: Partial<Record<QueueProvider, number>>
  executeTask?: ExecuteTask
}

const PROVIDERS: readonly QueueProvider[] = ['openai-compat', 'gemini']

export class TaskScheduler {
  private readonly pollIntervalMs: number
  private readonly concurrency: Record<QueueProvider, number>
  private readonly executeTask: ExecuteTask
  private readonly active = new Map<QueueProvider, Map<string, Promise<void>>>(
    PROVIDERS.map((provider) => [provider, new Map()]),
  )
  private timer: ReturnType<typeof setInterval> | null = null
  private ticking = false
  private stopped = true

  constructor(options: TaskSchedulerOptions = {}) {
    this.pollIntervalMs = options.pollIntervalMs ?? config.worker.pollIntervalMs
    this.concurrency = {
      'openai-compat':
        options.concurrency?.['openai-compat'] ?? config.worker.concurrency.openaiCompat,
      gemini: options.concurrency?.gemini ?? config.worker.concurrency.gemini,
    }
    this.executeTask = options.executeTask ?? runTask
  }

  start(): void {
    if (this.timer) return
    this.stopped = false
    void this.tick()
    this.timer = setInterval(() => void this.tick(), this.pollIntervalMs)
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

  async waitForIdle(): Promise<void> {
    const promises = Array.from(this.active.values()).flatMap((tasks) => Array.from(tasks.values()))
    await Promise.allSettled(promises)
  }

  async tick(now = Date.now()): Promise<void> {
    if (this.stopped || this.ticking) return
    this.ticking = true
    try {
      await this.abortTasksCancelledInDatabase()
      for (const provider of PROVIDERS) {
        if (this.stopped) return
        const active = this.active.get(provider)!
        const available = this.concurrency[provider] - active.size
        if (available <= 0) continue

        const due = await db
          .select({ id: schema.tasks.id })
          .from(schema.tasks)
          .where(
            and(
              eq(schema.tasks.provider, provider),
              eq(schema.tasks.status, 'queued'),
              or(isNull(schema.tasks.next_retry_at), lte(schema.tasks.next_retry_at, now)),
            ),
          )
          .orderBy(asc(schema.tasks.submitted_at))
          .limit(available)

        if (this.stopped) return
        for (const task of due) this.launch(provider, task.id)
      }
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
        await db
          .update(schema.tasks)
          .set({
            status: 'failed',
            error_message: `Worker 执行异常：${message}`,
            error_type: 'interrupted',
            completed_at: Date.now(),
          })
          .where(and(eq(schema.tasks.id, id), eq(schema.tasks.status, 'in_progress')))
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
