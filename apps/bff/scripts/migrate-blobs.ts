import { Database } from 'bun:sqlite'
import { Buffer } from 'node:buffer'
import { randomUUID } from 'node:crypto'
import { runMigrations } from '@image-playground/db'
import type { QueueProvider } from '@image-playground/shared'
import sharp from 'sharp'
import {
  isBlobRef,
  OUTPUT_BLOB_RETENTION_MS,
  parseDataUrl,
  type TaskBlobInput,
} from '../src/lib/blobStore'
import { externalizeResultImages, markResultImagesDropped } from '../src/lib/extractImages'

const BATCH_SIZE = 50
const PAGE_COLUMNS =
  'id, provider, status, request_payload, result_payload, submitted_at, completed_at'
const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled'])

interface TaskRow {
  id: string
  provider: QueueProvider
  status: string
  request_payload: string
  result_payload: string | null
  submitted_at: number
  completed_at: number | null
}

interface TaskChange {
  taskId: string
  requestPayload?: string
  resultPayload?: string
  blobs: TaskBlobInput[]
}

export interface MigrationStats {
  scannedTaskCount: number
  changedTaskCount: number
  inputImageCount: number
  outputImageCount: number
  droppedOutputImageCount: number
  blobCount: number
  encodedByteEstimate: number
  decodedByteEstimate: number
}

export interface MigrationLog {
  event: 'warning' | 'batch' | 'complete'
  [key: string]: unknown
}

export interface MigrationOptions {
  dryRun?: boolean
  now?: number
  log?: (entry: MigrationLog) => void
}

interface PreparedTask {
  change: TaskChange | null
  inputImageCount: number
  outputImageCount: number
  droppedOutputImageCount: number
  encodedBytes: number
  decodedBytes: number
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function encodedDataUrlBytes(value: string): number {
  const marker = ';base64,'
  const at = value.indexOf(marker)
  return at < 0 ? 0 : Buffer.byteLength(value.slice(at + marker.length))
}

function resultBase64Values(provider: QueueProvider, payload: Record<string, unknown>): string[] {
  if (provider === 'openai-compat') {
    const data = Array.isArray(payload.data) ? payload.data : []
    return data.flatMap((item) => {
      if (!isRecord(item) || typeof item.b64_json !== 'string' || !item.b64_json) return []
      return [item.b64_json]
    })
  }

  const candidates = Array.isArray(payload.candidates) ? payload.candidates : []
  const values: string[] = []
  for (const candidate of candidates) {
    if (!isRecord(candidate) || !isRecord(candidate.content)) continue
    const parts = Array.isArray(candidate.content.parts) ? candidate.content.parts : []
    for (const part of parts) {
      if (!isRecord(part) || !isRecord(part.inlineData)) continue
      if (typeof part.inlineData.data === 'string' && part.inlineData.data) {
        values.push(part.inlineData.data)
      }
    }
  }
  return values
}

async function prepareTask(
  row: TaskRow,
  cutoff: number,
  log: (entry: MigrationLog) => void,
): Promise<PreparedTask> {
  const request = JSON.parse(row.request_payload) as unknown
  if (!isRecord(request)) {
    throw new Error(`task ${row.id} request_payload must remain a JSON object`)
  }

  let requestPayload: string | undefined
  const inputBlobs: TaskBlobInput[] = []
  let inputImageCount = 0
  let encodedBytes = 0
  let decodedBytes = 0
  if (Array.isArray(request.input_images)) {
    const inputImages = [...request.input_images]
    for (const [idx, image] of inputImages.entries()) {
      if (isBlobRef(image) || typeof image !== 'string' || !image.startsWith('data:')) continue

      const parsed = parseDataUrl(image)
      encodedBytes += encodedDataUrlBytes(image)
      decodedBytes += parsed.data.length
      inputImageCount += 1

      let blob: TaskBlobInput = {
        kind: 'input',
        idx,
        mime: parsed.mime,
        data: parsed.data,
        createdAt: row.submitted_at,
      }
      if (TERMINAL_STATUSES.has(row.status)) {
        try {
          blob = {
            ...blob,
            mime: 'image/webp',
            data: await sharp(parsed.data).webp({ quality: 90 }).toBuffer(),
          }
        } catch (error) {
          log({
            event: 'warning',
            taskId: row.id,
            inputIndex: idx,
            message: error instanceof Error ? error.message : String(error),
          })
        }
      }
      inputBlobs.push(blob)
      inputImages[idx] = { $blob: idx }
    }

    if (inputImageCount > 0) {
      requestPayload = JSON.stringify({ ...request, input_images: inputImages })
    }
  }

  let resultPayload: string | undefined
  let outputBlobs: TaskBlobInput[] = []
  let outputImageCount = 0
  let droppedOutputImageCount = 0
  if (row.result_payload !== null) {
    const result = JSON.parse(row.result_payload) as unknown
    if (isRecord(result)) {
      const base64Values = resultBase64Values(row.provider, result)
      const externalized = externalizeResultImages(row.provider, result)
      outputImageCount = externalized.blobs.length
      for (const value of base64Values) encodedBytes += Buffer.byteLength(value)
      for (const blob of externalized.blobs) decodedBytes += blob.data.length

      if (outputImageCount > 0) {
        const outputCreatedAt = row.completed_at ?? row.submitted_at
        if (outputCreatedAt < cutoff) {
          droppedOutputImageCount = outputImageCount
          resultPayload = JSON.stringify(markResultImagesDropped(externalized.payload))
        } else {
          outputBlobs = externalized.blobs.map((blob) => ({
            ...blob,
            createdAt: outputCreatedAt,
          }))
          resultPayload = JSON.stringify(externalized.payload)
        }
      }
    }
  }

  const blobs = [...inputBlobs, ...outputBlobs]
  return {
    change:
      requestPayload === undefined && resultPayload === undefined
        ? null
        : { taskId: row.id, requestPayload, resultPayload, blobs },
    inputImageCount,
    outputImageCount,
    droppedOutputImageCount,
    encodedBytes,
    decodedBytes,
  }
}

function defaultLog(entry: MigrationLog): void {
  console.log(JSON.stringify({ migration: 'task-blobs', ...entry }))
}

export async function migrateBlobs(
  dbPath: string,
  options: MigrationOptions = {},
): Promise<MigrationStats> {
  const dryRun = options.dryRun ?? false
  if (!dryRun) runMigrations(dbPath)

  const now = options.now ?? Date.now()
  const cutoff = now - OUTPUT_BLOB_RETENTION_MS
  const log = options.log ?? defaultLog
  const stats: MigrationStats = {
    scannedTaskCount: 0,
    changedTaskCount: 0,
    inputImageCount: 0,
    outputImageCount: 0,
    droppedOutputImageCount: 0,
    blobCount: 0,
    encodedByteEstimate: 0,
    decodedByteEstimate: 0,
  }

  const sqlite = dryRun ? new Database(dbPath, { readonly: true }) : new Database(dbPath)
  sqlite.exec('PRAGMA busy_timeout = 60000;')
  if (!dryRun) sqlite.exec('PRAGMA journal_mode = WAL;')
  const firstPage = sqlite.query<TaskRow, [number]>(
    `SELECT ${PAGE_COLUMNS} FROM tasks ORDER BY id LIMIT ?`,
  )
  const nextPage = sqlite.query<TaskRow, [string, number]>(
    `SELECT ${PAGE_COLUMNS} FROM tasks WHERE id > ? ORDER BY id LIMIT ?`,
  )
  let applyBatch: ((changes: TaskChange[]) => void) | null = null
  if (!dryRun) {
    const insertBlob = sqlite.prepare(`
      INSERT INTO task_blobs (id, task_id, kind, idx, mime, data, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(task_id, kind, idx) DO NOTHING
    `)
    const updateRequest = sqlite.prepare('UPDATE tasks SET request_payload = ? WHERE id = ?')
    const updateResult = sqlite.prepare('UPDATE tasks SET result_payload = ? WHERE id = ?')
    applyBatch = sqlite.transaction((changes: TaskChange[]) => {
      for (const change of changes) {
        for (const blob of change.blobs) {
          insertBlob.run(
            randomUUID(),
            change.taskId,
            blob.kind,
            blob.idx,
            blob.mime,
            blob.data,
            blob.createdAt ?? now,
          )
        }
        if (change.requestPayload !== undefined) {
          updateRequest.run(change.requestPayload, change.taskId)
        }
        if (change.resultPayload !== undefined) {
          updateResult.run(change.resultPayload, change.taskId)
        }
      }
    })
  }

  let lastId: string | null = null
  let batchNumber = 0
  try {
    while (true) {
      const rows: TaskRow[] =
        lastId === null ? firstPage.all(BATCH_SIZE) : nextPage.all(lastId, BATCH_SIZE)
      if (rows.length === 0) break

      const prepared: PreparedTask[] = []
      for (const row of rows) prepared.push(await prepareTask(row, cutoff, log))
      const changes = prepared.flatMap((item) => (item.change === null ? [] : [item.change]))
      stats.scannedTaskCount += rows.length
      stats.changedTaskCount += changes.length
      for (const item of prepared) {
        stats.inputImageCount += item.inputImageCount
        stats.outputImageCount += item.outputImageCount
        stats.droppedOutputImageCount += item.droppedOutputImageCount
        stats.encodedByteEstimate += item.encodedBytes
        stats.decodedByteEstimate += item.decodedBytes
      }
      stats.blobCount += changes.reduce((count, change) => count + change.blobs.length, 0)

      if (applyBatch && changes.length > 0) {
        applyBatch(changes)
        sqlite.exec('PRAGMA wal_checkpoint(PASSIVE);')
      }

      lastId = rows.at(-1)!.id
      batchNumber += 1
      log({
        event: 'batch',
        batch: batchNumber,
        lastId,
        scannedTasks: stats.scannedTaskCount,
        changedTasks: stats.changedTaskCount,
        inputImages: stats.inputImageCount,
        outputImages: stats.outputImageCount,
        droppedOutputImages: stats.droppedOutputImageCount,
        dryRun,
      })
    }
  } finally {
    sqlite.close()
  }

  log({
    event: 'complete',
    ...stats,
    encodedMiBEstimate: stats.encodedByteEstimate / 1024 / 1024,
    decodedMiBEstimate: stats.decodedByteEstimate / 1024 / 1024,
    dryRun,
  })
  return stats
}

function parseCliArgs(args: string[]): { dbPath: string; dryRun: boolean } {
  const unknownFlags = args.filter((arg) => arg.startsWith('-') && arg !== '--dry-run')
  const positional = args.filter((arg) => !arg.startsWith('-'))
  if (unknownFlags.length > 0 || positional.length !== 1) {
    throw new Error('usage: bun run apps/bff/scripts/migrate-blobs.ts <db-path> [--dry-run]')
  }
  return { dbPath: positional[0]!, dryRun: args.includes('--dry-run') }
}

if (import.meta.main) {
  try {
    const { dbPath, dryRun } = parseCliArgs(Bun.argv.slice(2))
    await migrateBlobs(dbPath, { dryRun })
  } catch (error) {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  }
}
