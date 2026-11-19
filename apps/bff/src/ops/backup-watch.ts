import { OPS_THRESHOLDS, type OpsBackups, type OpsRestoreDrill } from '@image-playground/shared'
/**
 * 还没到下一次列出时间，并且没有可复用的成功结果。
 * 告警这一轮跳过该块：既不触发、也不算失明、更不当成已恢复。
 */
export class BackupWatchDeferred extends Error {
  readonly name = 'BackupWatchDeferred'

  constructor() {
    super('backup watch deferred')
  }
}

export function isBackupWatchDeferred(error: unknown): error is BackupWatchDeferred {
  return error instanceof BackupWatchDeferred
}

interface BackupWatchOptions {
  intervalMs?: number
  readBackups: () => Promise<OpsBackups>
  readRestoreDrill: () => Promise<OpsRestoreDrill | null>
}

interface ThrottledRead<T> {
  (now: number): Promise<T>
}

function createThrottledRead<T>(read: () => Promise<T>, intervalMs: number): ThrottledRead<T> {
  let lastAttemptAt: number | undefined
  let lastSucceeded = false
  let cache: { value: T } | undefined
  let inflight: Promise<T> | undefined

  return async (now: number): Promise<T> => {
    if (inflight) return inflight
    if (lastAttemptAt !== undefined && now - lastAttemptAt < intervalMs) {
      if (lastSucceeded && cache) return cache.value
      throw new BackupWatchDeferred()
    }
    lastAttemptAt = now
    inflight = (async () => {
      try {
        const value = await read()
        cache = { value }
        lastSucceeded = true
        return value
      } catch (error) {
        lastSucceeded = false
        throw error
      } finally {
        inflight = undefined
      }
    })()
    return inflight
  }
}

/**
 * 把备份和演练的对象列出节流到 intervalMs。成功之后、下一次列出之前复用结果，
 * 好让过期判断仍按墙钟算。列出失败后不再沿用旧缓存，等到间隔到了再列，
 * 以免一次成功的缓存把失明计数清掉。
 */
export function createBackupWatch(options: BackupWatchOptions): {
  readBackups: ThrottledRead<OpsBackups>
  readRestoreDrill: ThrottledRead<OpsRestoreDrill | null>
} {
  const intervalMs = options.intervalMs ?? OPS_THRESHOLDS.BACKUP_WATCH_INTERVAL_MS
  return {
    readBackups: createThrottledRead(options.readBackups, intervalMs),
    readRestoreDrill: createThrottledRead(options.readRestoreDrill, intervalMs),
  }
}
