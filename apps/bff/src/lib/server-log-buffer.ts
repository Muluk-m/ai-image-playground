import {
  redactLogText,
  type ServerLogEntry,
  type ServerLogLevel,
  type ServerLogService,
  sanitizeLogValue,
} from '@image-playground/shared'

export { redactLogText } from '@image-playground/shared'

const LEVELS: Record<number, ServerLogLevel> = {
  10: 'trace',
  20: 'debug',
  30: 'info',
  40: 'warn',
  50: 'error',
  60: 'fatal',
}

export function parseServerLog(
  line: string,
  identity: { service: ServerLogService; instance: string; version: string },
): ServerLogEntry | null {
  try {
    const raw = JSON.parse(line) as Record<string, unknown>
    const level = LEVELS[Number(raw.level)]
    const at = typeof raw.time === 'number' ? raw.time : Date.parse(String(raw.time))
    if (!level || !Number.isFinite(at)) return null
    const cleaned = sanitizeLogValue(raw) as Record<string, unknown>
    const message = redactLogText(String(raw.msg ?? ''))
    const text = (key: string) =>
      typeof cleaned[key] === 'string' ? String(cleaned[key]).slice(0, 200) : null
    const event = text('event')
    for (const key of ['level', 'time', 'msg', 'service']) delete cleaned[key]
    const fields = JSON.stringify(cleaned).length > 12_000 ? { truncated: true, event } : cleaned
    return {
      id: crypto.randomUUID(),
      at,
      ...identity,
      level,
      event,
      group_key:
        event ??
        message
          .replace(/\b[0-9a-f]{8}-[0-9a-f-]{27,}\b/gi, '<id>')
          .replace(/\b\d+\b/g, '<n>')
          .slice(0, 400),
      message,
      request_id: text('requestId'),
      task_id: text('taskId') ?? text('task_id'),
      fields,
    }
  } catch {
    return null
  }
}

/** Bounded, retryable batches. Writer failure never escapes into business requests. */
export function createServerLogBuffer(options: {
  write: (entries: ServerLogEntry[]) => Promise<void>
  onFailure: (error: unknown) => void
  maxEntries?: number
  batchSize?: number
}) {
  const queue: ServerLogEntry[] = []
  const maxEntries = options.maxEntries ?? 500
  const batchSize = options.batchSize ?? 100
  let pending: Promise<void> | undefined
  let stopped = false
  let dropped = 0
  let failures = 0
  let lastWrittenAt: number | null = null
  function enqueue(entry: ServerLogEntry) {
    if (stopped) return
    if (queue.length >= maxEntries) {
      dropped++
      return
    }
    queue.push(entry)
  }
  function flush(): Promise<void> {
    if (pending) return pending
    if (!queue.length) return Promise.resolve()
    const batch = queue.slice(0, batchSize)
    pending = Promise.resolve()
      .then(() => options.write(batch))
      .then(() => {
        queue.splice(0, batch.length)
        lastWrittenAt = Date.now()
      })
      .catch((error: unknown) => {
        failures++
        options.onFailure(error)
      })
      .finally(() => {
        pending = undefined
      })
    return pending
  }
  async function pump(maxBatches = 20) {
    for (let batch = 0; batch < maxBatches && queue.length && !stopped; batch++) {
      const failuresBefore = failures
      await flush()
      if (failures !== failuresBefore) break
    }
  }
  async function drain(timeoutMs = 2000) {
    const deadline = Date.now() + timeoutMs
    let expired = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const work = async () => {
      while (queue.length && !expired && Date.now() < deadline) {
        const failuresBefore = failures
        await flush()
        if (failures !== failuresBefore) break
      }
    }
    try {
      await Promise.race([
        work(),
        new Promise<void>((resolve) => {
          timer = setTimeout(() => {
            expired = true
            resolve()
          }, timeoutMs)
        }),
      ])
    } finally {
      clearTimeout(timer)
    }
  }
  return {
    enqueue,
    flush,
    pump,
    drain,
    stop: () => {
      stopped = true
    },
    stats: () => ({ pending: queue.length, dropped, failures, last_written_at: lastWrittenAt }),
  }
}
