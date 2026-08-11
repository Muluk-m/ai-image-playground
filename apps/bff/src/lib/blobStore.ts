import { Buffer } from 'node:buffer'
import { randomUUID } from 'node:crypto'
import {
  type ImagePlaygroundDatabase,
  type NewTask,
  type NewTaskBlob,
  type TaskBlob,
  task_blobs,
  tasks,
} from '@image-playground/db'
import type { TaskBlobRef } from '@image-playground/shared'
import { and, asc, eq, lt } from 'drizzle-orm'
import sharp from 'sharp'
import { log } from './logger'

/** 输出像素的保留期：过期后只清 task_blobs，任务元信息保留。 */
export const OUTPUT_BLOB_RETENTION_MS = 7 * 24 * 60 * 60 * 1000

export type TaskBlobKind = 'input' | 'output'

export type BlobRef = TaskBlobRef
export type InputImageRef = string | BlobRef

export interface TaskBlobInput {
  kind: TaskBlobKind
  idx: number
  mime: string
  data: Buffer
  createdAt?: number
}

export interface ParsedDataUrl {
  mime: string
  data: Buffer
}

export interface RewrittenInputImages {
  refs: InputImageRef[]
  blobs: TaskBlobInput[]
}

export interface InputTranscodeResult {
  transcoded: number
  failed: number
}

export type BlobDatabase = Pick<ImagePlaygroundDatabase, 'delete' | 'insert' | 'select' | 'update'>

export interface BlobStoreLogger {
  error(details: Record<string, unknown>, message: string): void
}

export function parseDataUrl(value: string): ParsedDataUrl {
  const prefix = 'data:'
  const separator = ';base64,'
  const separatorAt = value.indexOf(separator)
  if (!value.startsWith(prefix) || separatorAt < prefix.length) {
    throw new Error('expected a base64 data URL')
  }

  return {
    mime: value.slice(prefix.length, separatorAt),
    data: Buffer.from(value.slice(separatorAt + separator.length), 'base64'),
  }
}

export function buildDataUrl(mime: string, data: Uint8Array): string {
  const base64 = Buffer.isBuffer(data)
    ? data.toString('base64')
    : Buffer.from(data).toString('base64')
  return `data:${mime};base64,${base64}`
}

export function isBlobRef(value: unknown): value is BlobRef {
  if (typeof value !== 'object' || value === null || !('$blob' in value)) return false
  const idx = (value as { $blob?: unknown }).$blob
  return Number.isInteger(idx) && Number(idx) >= 0
}

export function rewriteInputDataUrls(inputImages: readonly unknown[]): RewrittenInputImages {
  const refs: InputImageRef[] = []
  const blobs: TaskBlobInput[] = []

  for (const [idx, inputImage] of inputImages.entries()) {
    if (isBlobRef(inputImage)) {
      refs.push(inputImage)
      continue
    }
    if (typeof inputImage !== 'string') {
      throw new Error(`input image ${idx} is neither a data URL nor a blob ref`)
    }

    const parsed = parseDataUrl(inputImage)
    refs.push({ $blob: idx })
    blobs.push({ kind: 'input', idx, ...parsed })
  }

  return { refs, blobs }
}

function taskBlobRows(taskId: string, blobs: readonly TaskBlobInput[]): NewTaskBlob[] {
  const now = Date.now()
  return blobs.map((blob) => ({
    id: randomUUID(),
    task_id: taskId,
    kind: blob.kind,
    idx: blob.idx,
    mime: blob.mime,
    data: blob.data,
    created_at: blob.createdAt ?? now,
  }))
}

/** 同步写入：Bun SQLite 的 `.run()` 是同步的，因此本函数可在 transaction 回调里直接调用。 */
export function insertTaskBlobs(
  taskId: string,
  blobs: readonly TaskBlobInput[],
  database: BlobDatabase,
): void {
  if (blobs.length === 0) return
  database.insert(task_blobs).values(taskBlobRows(taskId, blobs)).run()
}

export async function createTaskWithBlobs(
  task: NewTask,
  blobs: readonly TaskBlobInput[],
  database: ImagePlaygroundDatabase,
): Promise<Array<{ id: string; submitted_at: number }>> {
  return database.transaction((tx) => {
    const inserted = tx
      .insert(tasks)
      .values(task)
      .onConflictDoNothing()
      .returning({ id: tasks.id, submitted_at: tasks.submitted_at })
      .all()
    if (inserted.length > 0) insertTaskBlobs(task.id, blobs, tx)
    return inserted
  })
}

export async function completeTaskWithBlobs(
  taskId: string,
  blobs: readonly TaskBlobInput[],
  resultPayload: unknown,
  completedAt: number,
  database: ImagePlaygroundDatabase,
): Promise<boolean> {
  return database.transaction((tx) => {
    const completed = tx
      .update(tasks)
      .set({
        status: 'completed',
        result_payload: resultPayload,
        completed_at: completedAt,
      })
      .where(and(eq(tasks.id, taskId), eq(tasks.status, 'in_progress')))
      .returning({ id: tasks.id })
      .all()
    if (completed.length === 0) return false
    insertTaskBlobs(taskId, blobs, tx)
    return true
  })
}

export async function getTaskBlob(
  taskId: string,
  kind: TaskBlobKind,
  idx: number,
  database: BlobDatabase,
): Promise<TaskBlob | undefined> {
  const [blob] = await database
    .select()
    .from(task_blobs)
    .where(and(eq(task_blobs.task_id, taskId), eq(task_blobs.kind, kind), eq(task_blobs.idx, idx)))
    .limit(1)
  return blob
}

export async function listTaskBlobs(
  taskId: string,
  kind: TaskBlobKind,
  database: BlobDatabase,
): Promise<TaskBlob[]> {
  return database
    .select()
    .from(task_blobs)
    .where(and(eq(task_blobs.task_id, taskId), eq(task_blobs.kind, kind)))
    .orderBy(asc(task_blobs.idx))
}

export async function resolveInputDataUrls(
  taskId: string,
  inputImages: readonly unknown[],
  database: BlobDatabase,
): Promise<string[]> {
  if (!inputImages.some(isBlobRef)) {
    return inputImages.map((inputImage, idx) => {
      if (typeof inputImage !== 'string') {
        throw new Error(`input image ${idx} is neither a data URL nor a blob ref`)
      }
      return inputImage
    })
  }

  const blobsByIndex = new Map(
    (await listTaskBlobs(taskId, 'input', database)).map((blob) => [blob.idx, blob]),
  )
  return inputImages.map((inputImage, idx) => {
    if (typeof inputImage === 'string') return inputImage
    if (!isBlobRef(inputImage)) {
      throw new Error(`input image ${idx} is neither a data URL nor a blob ref`)
    }
    const blob = blobsByIndex.get(inputImage.$blob)
    if (!blob) {
      throw new Error(`missing input blob ${inputImage.$blob} for task ${taskId}`)
    }
    return buildDataUrl(blob.mime, blob.data)
  })
}

export async function transcodeInputBlobsToWebp(
  taskId: string,
  database: BlobDatabase,
  logger: BlobStoreLogger = log,
): Promise<InputTranscodeResult> {
  const blobs = await listTaskBlobs(taskId, 'input', database)
  let transcoded = 0
  let failed = 0

  for (const blob of blobs) {
    if (blob.mime === 'image/webp') continue

    try {
      const data = await sharp(blob.data).webp({ quality: 90 }).toBuffer()
      await database
        .update(task_blobs)
        .set({ mime: 'image/webp', data })
        .where(eq(task_blobs.id, blob.id))
      transcoded += 1
    } catch (error) {
      failed += 1
      logger.error(
        { event: 'task_blob.input_transcode_failed', taskId, blobId: blob.id, error },
        'failed to transcode input blob; retaining original bytes',
      )
    }
  }

  return { transcoded, failed }
}

export async function deleteOutputBlobsOlderThan(
  cutoff: number,
  database: BlobDatabase,
): Promise<number> {
  const deleted = await database
    .delete(task_blobs)
    .where(and(eq(task_blobs.kind, 'output'), lt(task_blobs.created_at, cutoff)))
    .returning({ id: task_blobs.id })
  return deleted.length
}
