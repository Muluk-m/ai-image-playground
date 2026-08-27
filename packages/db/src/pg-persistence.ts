import { randomUUID } from 'node:crypto'
import { DAILY_QUOTA_LIMIT, type QueueProvider, type TaskStatus } from '@image-playground/shared'
import { and, asc, eq, inArray, isNotNull, isNull, lt, lte, ne, or, sql } from 'drizzle-orm'
import { type PgliteDatabase } from 'drizzle-orm/pglite'
import { drizzle as drizzlePostgres } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { runPgMigrations } from './pg-migrate'
import * as schema from './pg-schema'
import { daily_quota, task_blobs, tasks } from './pg-schema'
import { currentQuotaDate, nextResetISO, type QuotaConsumeResult } from './quota'
import type { Task } from './schema'
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

type PgDb = PgliteDatabase<typeof schema>

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
    data: Buffer.isBuffer(row.data) ? row.data : Buffer.from(row.data),
    createdAt: Number(row.created_at),
  }
}

function toTask(row: typeof tasks.$inferSelect): Task {
  return {
    ...row,
    submitted_at: Number(row.submitted_at),
    started_at: row.started_at == null ? null : Number(row.started_at),
    completed_at: row.completed_at == null ? null : Number(row.completed_at),
    next_retry_at: row.next_retry_at == null ? null : Number(row.next_retry_at),
    result_payload: row.result_payload as Task['result_payload'],
  }
}

async function consumeQuota(
  db: Pick<PgDb, 'insert' | 'select'>,
  deviceId: string,
  n: number,
): Promise<QuotaConsumeResult> {
  const date = currentQuotaDate()
  const rows = await db
    .insert(daily_quota)
    .values({ device_id: deviceId, date, count: n })
    .onConflictDoUpdate({
      target: [daily_quota.device_id, daily_quota.date],
      set: { count: sql`${daily_quota.count} + ${n}` },
      setWhere: sql`${daily_quota.count} + ${n} <= ${DAILY_QUOTA_LIMIT}`,
    })
    .returning({ count: daily_quota.count })

  if (rows.length === 0) {
    const [existing] = await db
      .select({ count: daily_quota.count })
      .from(daily_quota)
      .where(and(eq(daily_quota.device_id, deviceId), eq(daily_quota.date, date)))
      .limit(1)
    return {
      ok: false,
      count: existing?.count ?? DAILY_QUOTA_LIMIT,
      reset_at: nextResetISO(),
    }
  }

  return { ok: true, count: rows[0]!.count, reset_at: nextResetISO() }
}

class PgTaskStore implements TaskStore {
  constructor(private readonly db: PgDb) {}

  async getById(id: string): Promise<Task | undefined> {
    const [row] = await this.db.select().from(tasks).where(eq(tasks.id, id)).limit(1)
    return row ? toTask(row) : undefined
  }

  async cancelFrom(id: string, from: 'queued' | 'in_progress'): Promise<boolean> {
    const cancelled = await this.db
      .update(tasks)
      .set({ status: 'cancelled', completed_at: Date.now() })
      .where(and(eq(tasks.id, id), eq(tasks.status, from)))
      .returning({ id: tasks.id })
    return cancelled.length > 0
  }

  async claim(id: string, now: number): Promise<boolean> {
    const claimed = await this.db
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
    return claimed.length > 0
  }

  async scheduleRetry(
    id: string,
    attemptJustFailed: number,
    nextRetryAt: number,
  ): Promise<boolean> {
    const updated = await this.db
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
    return updated.length > 0
  }

  async complete(id: string, resultPayload: unknown, completedAt: number): Promise<boolean> {
    const updated = await this.db
      .update(tasks)
      .set({
        status: 'completed',
        result_payload: resultPayload,
        completed_at: completedAt,
      })
      .where(and(eq(tasks.id, id), eq(tasks.status, 'in_progress')))
      .returning({ id: tasks.id })
    return updated.length > 0
  }

  async fail(id: string, patch: TaskFailPatch): Promise<boolean> {
    const updated = await this.db
      .update(tasks)
      .set({ status: 'failed', ...patch })
      .where(and(eq(tasks.id, id), eq(tasks.status, 'in_progress')))
      .returning({ id: tasks.id })
    return updated.length > 0
  }

  async recoverInterrupted(now: number): Promise<number> {
    const failed = await this.db
      .update(tasks)
      .set({
        status: 'failed',
        error_message: '任务 worker 重启时中断',
        error_type: 'interrupted',
        completed_at: now,
      })
      .where(eq(tasks.status, 'in_progress'))
      .returning({ id: tasks.id })
    return failed.length
  }

  async listDueIds(provider: QueueProvider, now: number, limit: number): Promise<string[]> {
    const rows = await this.db
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
    return rows.map((row) => row.id)
  }

  async getStatuses(ids: readonly string[]): Promise<Array<{ id: string; status: TaskStatus }>> {
    if (ids.length === 0) return []
    return this.db
      .select({ id: tasks.id, status: tasks.status })
      .from(tasks)
      .where(inArray(tasks.id, [...ids]))
  }

  async purgeOldTasks(threshold: number): Promise<number> {
    const deleted = await this.db
      .delete(tasks)
      .where(
        and(
          inArray(tasks.status, ['completed', 'failed', 'cancelled']),
          isNotNull(tasks.completed_at),
          lt(tasks.completed_at, threshold),
        ),
      )
      .returning({ id: tasks.id })
    return deleted.length
  }

  async listTerminalIdsWithNonWebpInputs(): Promise<string[]> {
    const rows = await this.db
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
    return rows.map((row) => row.id)
  }
}

class PgPixelStore implements PixelStore {
  constructor(private readonly db: PgDb) {}

  async putMany(taskId: string, pixels: readonly NewPixelObject[]): Promise<void> {
    if (pixels.length === 0) return
    await this.db.insert(task_blobs).values(pixelRows(taskId, pixels))
  }

  async get(taskId: string, kind: PixelKind, idx: number): Promise<PixelObject | undefined> {
    const [row] = await this.db
      .select()
      .from(task_blobs)
      .where(
        and(eq(task_blobs.task_id, taskId), eq(task_blobs.kind, kind), eq(task_blobs.idx, idx)),
      )
      .limit(1)
    return row ? toPixel(row) : undefined
  }

  async list(taskId: string, kind: PixelKind): Promise<PixelObject[]> {
    const rows = await this.db
      .select()
      .from(task_blobs)
      .where(and(eq(task_blobs.task_id, taskId), eq(task_blobs.kind, kind)))
      .orderBy(asc(task_blobs.idx))
    return rows.map(toPixel)
  }

  async replaceBytes(
    taskId: string,
    kind: PixelKind,
    idx: number,
    mime: string,
    data: Buffer,
  ): Promise<void> {
    await this.db
      .update(task_blobs)
      .set({ mime, data })
      .where(
        and(eq(task_blobs.task_id, taskId), eq(task_blobs.kind, kind), eq(task_blobs.idx, idx)),
      )
  }

  async deleteOutputsOlderThan(cutoff: number): Promise<number> {
    const deleted = await this.db
      .delete(task_blobs)
      .where(and(eq(task_blobs.kind, 'output'), lt(task_blobs.created_at, cutoff)))
      .returning({ id: task_blobs.id })
    return deleted.length
  }
}

export class PgQueuePersistence implements QueuePersistence {
  readonly tasks: TaskStore
  readonly pixels: PixelStore

  constructor(private readonly db: PgDb) {
    this.tasks = new PgTaskStore(db)
    this.pixels = new PgPixelStore(db)
  }

  async submit(command: SubmitCommand): Promise<SubmitOutcome> {
    return this.db.transaction(async (tx) => {
      if (command.clientRequestId) {
        const [existing] = await tx
          .select({ id: tasks.id, submitted_at: tasks.submitted_at })
          .from(tasks)
          .where(eq(tasks.client_request_id, command.clientRequestId))
          .limit(1)
        if (existing) {
          return {
            kind: 'replay' as const,
            id: existing.id,
            submitted_at: Number(existing.submitted_at),
          }
        }
      }

      const quota = await consumeQuota(tx, command.deviceId, command.n)
      if (!quota.ok) {
        return { kind: 'quota_rejected' as const, count: quota.count, reset_at: quota.reset_at }
      }

      const id = randomUUID()
      const submitted_at = Date.now()
      await tx.insert(tasks).values({
        id,
        provider: command.provider,
        model: command.model,
        status: 'queued',
        request_payload: command.request,
        submitted_at,
        client_request_id: command.clientRequestId,
      })
      if (command.pixels.length > 0) {
        await tx.insert(task_blobs).values(pixelRows(id, command.pixels))
      }
      return { kind: 'created' as const, id, submitted_at }
    })
  }

  async completeWithPixels(
    id: string,
    resultPayload: unknown,
    pixels: readonly NewPixelObject[],
    completedAt: number,
  ): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      const completed = await tx
        .update(tasks)
        .set({
          status: 'completed',
          result_payload: resultPayload,
          completed_at: completedAt,
        })
        .where(and(eq(tasks.id, id), eq(tasks.status, 'in_progress')))
        .returning({ id: tasks.id })
      if (completed.length === 0) return false
      if (pixels.length > 0) {
        await tx.insert(task_blobs).values(pixelRows(id, pixels))
      }
      return true
    })
  }
}

export async function createPostgresPersistence(databaseUrl: string): Promise<QueuePersistence> {
  if (!/^postgres(ql)?:\/\//.test(databaseUrl)) {
    throw new Error('Postgres Task store requires a postgres:// DATABASE_URL')
  }
  const client = postgres(databaseUrl)
  await runPgMigrations((sql) => client.unsafe(sql))
  const db = drizzlePostgres(client, { schema }) as unknown as PgDb
  return new PgQueuePersistence(db)
}
