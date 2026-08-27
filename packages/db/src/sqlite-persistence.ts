import { randomUUID } from 'node:crypto'
import type { QueueProvider, TaskStatus } from '@image-playground/shared'
import { and, asc, eq, inArray, isNotNull, isNull, lt, lte, ne, or } from 'drizzle-orm'
import { type CreateDbOptions, createDb, type ImagePlaygroundDatabase } from './client'
import { tryConsumeQuotaSync } from './quota'
import { type Task, task_blobs, tasks } from './schema'
import type {
  NewPixelObject,
  PixelKind,
  PixelObject,
  PixelStore,
  QueuePersistence,
  SubmitCommand,
  SubmitOutcome,
  TaskFailPatch,
  TaskStore,
} from './stores'

function pixelRows(taskId: string, pixels: readonly NewPixelObject[]) {
  const now = Date.now()
  return pixels.map((pixel) => ({
    id: randomUUID(),
    task_id: taskId,
    kind: pixel.kind,
    idx: pixel.idx,
    mime: pixel.mime,
    data: pixel.data,
    created_at: pixel.createdAt ?? now,
  }))
}

function toPixel(row: typeof task_blobs.$inferSelect): PixelObject {
  return {
    taskId: row.task_id,
    kind: row.kind,
    idx: row.idx,
    mime: row.mime,
    data: row.data,
    createdAt: row.created_at,
  }
}

type PixelWriter = Pick<ImagePlaygroundDatabase, 'insert'>

function insertPixels(db: PixelWriter, taskId: string, pixels: readonly NewPixelObject[]): void {
  if (pixels.length === 0) return
  db.insert(task_blobs).values(pixelRows(taskId, pixels)).run()
}

class SqliteTaskStore implements TaskStore {
  constructor(private readonly db: ImagePlaygroundDatabase) {}

  async getById(id: string): Promise<Task | undefined> {
    const [row] = this.db.select().from(tasks).where(eq(tasks.id, id)).limit(1).all()
    return row
  }

  async cancelFrom(id: string, from: 'queued' | 'in_progress'): Promise<boolean> {
    const cancelled = this.db
      .update(tasks)
      .set({ status: 'cancelled', completed_at: Date.now() })
      .where(and(eq(tasks.id, id), eq(tasks.status, from)))
      .returning({ id: tasks.id })
      .all()
    return cancelled.length > 0
  }

  async claim(id: string, now: number): Promise<boolean> {
    const claimed = this.db
      .update(tasks)
      .set({ status: 'in_progress', started_at: now })
      .where(
        and(
          eq(tasks.id, id),
          eq(tasks.status, 'queued'),
          or(isNull(tasks.next_retry_at), lte(tasks.next_retry_at, now)),
        ),
      )
      .returning({ id: tasks.id })
      .all()
    return claimed.length > 0
  }

  async scheduleRetry(
    id: string,
    attemptJustFailed: number,
    nextRetryAt: number,
  ): Promise<boolean> {
    const updated = this.db
      .update(tasks)
      .set({
        status: 'queued',
        attempt_count: attemptJustFailed,
        next_retry_at: nextRetryAt,
        error_message: null,
        error_type: null,
        result_payload: null,
        upstream_status: null,
        upstream_body: null,
      })
      .where(and(eq(tasks.id, id), eq(tasks.status, 'in_progress')))
      .returning({ id: tasks.id })
      .all()
    return updated.length > 0
  }

  async complete(id: string, resultPayload: unknown, completedAt: number): Promise<boolean> {
    const updated = this.db
      .update(tasks)
      .set({
        status: 'completed',
        result_payload: resultPayload,
        completed_at: completedAt,
      })
      .where(and(eq(tasks.id, id), eq(tasks.status, 'in_progress')))
      .returning({ id: tasks.id })
      .all()
    return updated.length > 0
  }

  async fail(id: string, patch: TaskFailPatch): Promise<boolean> {
    const updated = this.db
      .update(tasks)
      .set({ status: 'failed', ...patch })
      .where(and(eq(tasks.id, id), eq(tasks.status, 'in_progress')))
      .returning({ id: tasks.id })
      .all()
    return updated.length > 0
  }

  async recoverInterrupted(now: number): Promise<number> {
    const failed = this.db
      .update(tasks)
      .set({
        status: 'failed',
        error_message: '任务 worker 重启时中断',
        error_type: 'interrupted' as const,
        completed_at: now,
      })
      .where(eq(tasks.status, 'in_progress'))
      .returning({ id: tasks.id })
      .all()
    return failed.length
  }

  async listDueIds(provider: QueueProvider, now: number, limit: number): Promise<string[]> {
    const rows = this.db
      .select({ id: tasks.id })
      .from(tasks)
      .where(
        and(
          eq(tasks.provider, provider),
          eq(tasks.status, 'queued'),
          or(isNull(tasks.next_retry_at), lte(tasks.next_retry_at, now)),
        ),
      )
      .orderBy(asc(tasks.submitted_at))
      .limit(limit)
      .all()
    return rows.map((row) => row.id)
  }

  async getStatuses(ids: readonly string[]): Promise<Array<{ id: string; status: TaskStatus }>> {
    if (ids.length === 0) return []
    return this.db
      .select({ id: tasks.id, status: tasks.status })
      .from(tasks)
      .where(inArray(tasks.id, [...ids]))
      .all()
  }

  async purgeOldTasks(threshold: number): Promise<number> {
    const deleted = this.db
      .delete(tasks)
      .where(
        and(
          inArray(tasks.status, ['completed', 'failed', 'cancelled']),
          isNotNull(tasks.completed_at),
          lt(tasks.completed_at, threshold),
        ),
      )
      .returning({ id: tasks.id })
      .all()
    return deleted.length
  }

  async listTerminalIdsWithNonWebpInputs(): Promise<string[]> {
    const rows = this.db
      .selectDistinct({ id: tasks.id })
      .from(tasks)
      .innerJoin(task_blobs, eq(task_blobs.task_id, tasks.id))
      .where(
        and(
          inArray(tasks.status, ['completed', 'failed', 'cancelled']),
          eq(task_blobs.kind, 'input'),
          ne(task_blobs.mime, 'image/webp'),
        ),
      )
      .all()
    return rows.map((row) => row.id)
  }
}

class SqlitePixelStore implements PixelStore {
  constructor(private readonly db: ImagePlaygroundDatabase) {}

  async putMany(taskId: string, pixels: readonly NewPixelObject[]): Promise<void> {
    insertPixels(this.db, taskId, pixels)
  }

  async get(taskId: string, kind: PixelKind, idx: number): Promise<PixelObject | undefined> {
    const [row] = this.db
      .select()
      .from(task_blobs)
      .where(
        and(eq(task_blobs.task_id, taskId), eq(task_blobs.kind, kind), eq(task_blobs.idx, idx)),
      )
      .limit(1)
      .all()
    return row ? toPixel(row) : undefined
  }

  async list(taskId: string, kind: PixelKind): Promise<PixelObject[]> {
    return this.db
      .select()
      .from(task_blobs)
      .where(and(eq(task_blobs.task_id, taskId), eq(task_blobs.kind, kind)))
      .orderBy(asc(task_blobs.idx))
      .all()
      .map(toPixel)
  }

  async replaceBytes(
    taskId: string,
    kind: PixelKind,
    idx: number,
    mime: string,
    data: Buffer,
  ): Promise<void> {
    this.db
      .update(task_blobs)
      .set({ mime, data })
      .where(
        and(eq(task_blobs.task_id, taskId), eq(task_blobs.kind, kind), eq(task_blobs.idx, idx)),
      )
      .run()
  }

  async deleteOutputsOlderThan(cutoff: number): Promise<number> {
    const deleted = this.db
      .delete(task_blobs)
      .where(and(eq(task_blobs.kind, 'output'), lt(task_blobs.created_at, cutoff)))
      .returning({ id: task_blobs.id })
      .all()
    return deleted.length
  }
}

class SqliteQueuePersistence implements QueuePersistence {
  readonly tasks: TaskStore
  readonly pixels: PixelStore

  constructor(private readonly db: ImagePlaygroundDatabase) {
    this.tasks = new SqliteTaskStore(db)
    this.pixels = new SqlitePixelStore(db)
  }

  async submit(command: SubmitCommand): Promise<SubmitOutcome> {
    return this.db.transaction(
      (tx): SubmitOutcome => {
        if (command.clientRequestId) {
          const existing = tx
            .select({ id: tasks.id, submitted_at: tasks.submitted_at })
            .from(tasks)
            .where(eq(tasks.client_request_id, command.clientRequestId))
            .limit(1)
            .get()
          if (existing) return { kind: 'replay', ...existing }
        }

        const quota = tryConsumeQuotaSync(command.deviceId, command.n, tx)
        if (!quota.ok) {
          return { kind: 'quota_rejected', count: quota.count, reset_at: quota.reset_at }
        }

        const id = randomUUID()
        const submitted_at = Date.now()
        tx.insert(tasks)
          .values({
            id,
            provider: command.provider,
            model: command.model,
            status: 'queued',
            request_payload: command.request,
            submitted_at,
            client_request_id: command.clientRequestId,
          })
          .run()
        insertPixels(tx, id, command.pixels)
        return { kind: 'created', id, submitted_at }
      },
      { behavior: 'immediate' },
    )
  }

  async completeWithPixels(
    id: string,
    resultPayload: unknown,
    pixels: readonly NewPixelObject[],
    completedAt: number,
  ): Promise<boolean> {
    return this.db.transaction((tx) => {
      const completed = tx
        .update(tasks)
        .set({
          status: 'completed',
          result_payload: resultPayload,
          completed_at: completedAt,
        })
        .where(and(eq(tasks.id, id), eq(tasks.status, 'in_progress')))
        .returning({ id: tasks.id })
        .all()
      if (completed.length === 0) return false
      insertPixels(tx, id, pixels)
      return true
    })
  }
}

export function persistenceFromDb(db: ImagePlaygroundDatabase): QueuePersistence {
  return new SqliteQueuePersistence(db)
}

export function createSqlitePersistence(databaseUrl: string, options?: CreateDbOptions) {
  const created = createDb(databaseUrl, options)
  const queue = new SqliteQueuePersistence(created.db)
  return {
    tasks: queue.tasks,
    pixels: queue.pixels,
    submit: (command: SubmitCommand) => queue.submit(command),
    completeWithPixels: (
      id: string,
      resultPayload: unknown,
      pixels: readonly NewPixelObject[],
      completedAt: number,
    ) => queue.completeWithPixels(id, resultPayload, pixels, completedAt),
    db: created.db,
    schema: created.schema,
    checkpointWal: created.checkpointWal,
    sqlite: created.sqlite,
  }
}
