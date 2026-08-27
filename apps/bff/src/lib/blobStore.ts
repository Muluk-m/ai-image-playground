import { Buffer } from 'node:buffer'
import type { NewPixelObject, PixelStore, QueuePersistence } from '@image-playground/db'
import type { TaskBlobRef } from '@image-playground/shared'
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

function asPixels(blobs: readonly TaskBlobInput[]): NewPixelObject[] {
  return blobs.map((blob) => ({
    kind: blob.kind,
    idx: blob.idx,
    mime: blob.mime,
    data: blob.data,
    createdAt: blob.createdAt,
  }))
}

export async function insertTaskBlobs(
  taskId: string,
  blobs: readonly TaskBlobInput[],
  pixels: PixelStore,
): Promise<void> {
  await pixels.putMany(taskId, asPixels(blobs))
}

export async function completeTaskWithBlobs(
  taskId: string,
  blobs: readonly TaskBlobInput[],
  resultPayload: unknown,
  completedAt: number,
  queue: QueuePersistence,
): Promise<boolean> {
  return queue.completeWithPixels(taskId, resultPayload, asPixels(blobs), completedAt)
}

export async function getTaskBlob(
  taskId: string,
  kind: TaskBlobKind,
  idx: number,
  pixels: PixelStore,
) {
  return pixels.get(taskId, kind, idx)
}

export async function listTaskBlobs(taskId: string, kind: TaskBlobKind, pixels: PixelStore) {
  return pixels.list(taskId, kind)
}

export async function resolveInputDataUrls(
  taskId: string,
  inputImages: readonly unknown[],
  pixels: PixelStore,
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
    (await listTaskBlobs(taskId, 'input', pixels)).map((blob) => [blob.idx, blob]),
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
  pixels: PixelStore,
  logger: BlobStoreLogger = log,
): Promise<InputTranscodeResult> {
  const blobs = await listTaskBlobs(taskId, 'input', pixels)
  let transcoded = 0
  let failed = 0

  for (const blob of blobs) {
    if (blob.mime === 'image/webp') continue

    try {
      const data = await sharp(blob.data).webp({ quality: 90 }).toBuffer()
      await pixels.replaceBytes(taskId, 'input', blob.idx, 'image/webp', data)
      transcoded += 1
    } catch (error) {
      failed += 1
      logger.error(
        { event: 'task_blob.input_transcode_failed', taskId, idx: blob.idx, error },
        'failed to transcode input blob; retaining original bytes',
      )
    }
  }

  return { transcoded, failed }
}

export async function deleteOutputBlobsOlderThan(
  cutoff: number,
  pixels: PixelStore,
): Promise<number> {
  return pixels.deleteOutputsOlderThan(cutoff)
}
