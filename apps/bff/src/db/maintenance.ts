import { QUEUE_TIMEOUTS } from '@image-playground/shared'
import {
  deleteOutputBlobsOlderThan,
  OUTPUT_BLOB_RETENTION_MS,
  transcodeInputBlobsToWebp,
} from '../lib/blobStore'
import { pixelStore, taskStore } from './client'

async function archiveTerminalInputBlobs(): Promise<void> {
  const pending = await taskStore.listTerminalIdsWithNonWebpInputs()
  for (const id of pending) await transcodeInputBlobsToWebp(id, pixelStore)
}

/**
 * worker 启动时跑一次：把上次进程残留的 in_progress 标成终态。
 *
 * queued 任务由数据库轮询 scheduler 自动发现，future next_retry_at 也保留在库中，
 * 不再创建进程内 setTimeout。in_progress 说明旧 worker 可能已经发出 fetch；
 * 上游那边可能在跑，再发一次会重复消耗配额。一律标 failed，由用户决定
 * 是否手动重试。
 */
export async function recoverInterruptedTasks(): Promise<{ failed: number }> {
  const failed = await taskStore.recoverInterrupted(Date.now())

  await archiveTerminalInputBlobs()
  return { failed }
}

/**
 * 删除 30 天前完成的任务（成功 / 失败 / 取消）。不删 queued/in_progress，避免
 * 误清正在跑的；worker 启动时的 recoverInterruptedTasks 会收拾 in_progress。
 */
export async function purgeOldTasks(
  retentionMs = QUEUE_TIMEOUTS.TASK_RETENTION_MS,
): Promise<number> {
  return taskStore.purgeOldTasks(Date.now() - retentionMs)
}

/** Purge archived output pixels after seven days while retaining task metadata. */
export async function purgeOldOutputBlobs(retentionMs = OUTPUT_BLOB_RETENTION_MS): Promise<number> {
  return deleteOutputBlobsOlderThan(Date.now() - retentionMs, pixelStore)
}
