import type { ServerLogEntry, ServerLogLevel, ServerLogService } from '@image-playground/shared'

const LEVELS: Record<number, ServerLogLevel> = {
  10: 'trace',
  20: 'debug',
  30: 'info',
  40: 'warn',
  50: 'error',
  60: 'fatal',
}
// Exclude raw user content and credentials, including nested error/request objects.
const PRIVATE_FIELD =
  /^(?:authorization|cookie|set-cookie|headers|.*(?:password|secret|token|api[_-]?key)|body|payload|payloadPreview|responseBody|errorBody|request_payload|prompt|content|contents|parts|messages|image|images|data|input|output)$/i

function looksStructured(value: string, cursor: number, arrayPayload: Uint8Array): boolean {
  const opener = value[cursor]
  let next = cursor + 1
  while (next < value.length && /\s/.test(value[next]!)) next++
  const char = value[next]
  if (char === '"' || char === "'") return true
  if (opener === '{') {
    return char === '}' || /^[a-z0-9_$][\w$.-]*\s*:/i.test(value.slice(next))
  }
  return (
    arrayPayload[cursor + 1] === 1 ||
    char === ']' ||
    char === '{' ||
    char === '[' ||
    (char !== undefined && /[0-9-]/.test(char)) ||
    /^(?:true|false|null|undefined|NaN|[+-]?Infinity)(?=[\s,\]])/i.test(value.slice(next))
  )
}

/** A plain diagnostic can still carry a labeled secret, outside any JSON fragment. */
function privateAssignment(value: string): number | null {
  const keys = /\b([a-z_$][\w$-]*)["']?\s*[:=]/gi
  for (const match of value.matchAll(keys)) {
    if (PRIVATE_FIELD.test(match[1]!)) return match.index
  }
  return null
}

/** Single pass, quote-aware JSON fragment scanning; malformed fragments fail closed. */
function redactStructuredText(value: string, depth: number): string {
  // Detect list separators/quoted values before the next closing bracket in linear time.
  // This also catches non-JSON arrays without mistaking [worker] or [as run] for payloads.
  const arrayPayload = new Uint8Array(value.length + 1)
  let evidence = 0
  for (let index = value.length - 1; index >= 0; index--) {
    const char = value[index]
    if (char === ']') evidence = 0
    else if (char === ',' || char === '"' || char === "'") evidence = 1
    arrayPayload[index] = evidence
  }
  const chunks: string[] = []
  let plainStart = 0
  let cursor = 0
  while (cursor < value.length) {
    const opener = value[cursor]
    if ((opener !== '{' && opener !== '[') || !looksStructured(value, cursor, arrayPayload)) {
      cursor++
      continue
    }
    const plain = value.slice(plainStart, cursor)
    const sensitive = privateAssignment(plain)
    if (sensitive !== null)
      return chunks.join('') + plain.slice(0, sensitive) + '[REDACTED PAYLOAD]'
    chunks.push(plain)
    const start = cursor++
    const stack = [opener]
    let quote: string | null = null
    let escaped = false
    while (cursor < value.length && stack.length) {
      const char = value[cursor++]
      if (quote !== null) {
        if (escaped) escaped = false
        else if (char === '\\') escaped = true
        else if (char === quote) quote = null
      } else if (char === '"' || char === "'") quote = char
      else if (char === '{' || char === '[') stack.push(char)
      else if (char === '}' || char === ']') {
        const opening = stack.pop()
        if ((opening === '{' && char !== '}') || (opening === '[' && char !== ']')) {
          // A broken fragment has no trustworthy end boundary; hide its entire remainder.
          cursor = value.length
          stack.push('{')
        }
      }
    }
    if (stack.length) chunks.push('[REDACTED PAYLOAD]')
    else {
      try {
        chunks.push(JSON.stringify(sanitize(JSON.parse(value.slice(start, cursor)), depth + 1)))
      } catch {
        chunks.push('[REDACTED PAYLOAD]')
        cursor = value.length
      }
    }
    plainStart = cursor
  }
  const plain = value.slice(plainStart)
  const sensitive = privateAssignment(plain)
  chunks.push(sensitive === null ? plain : plain.slice(0, sensitive) + '[REDACTED PAYLOAD]')
  return chunks.join('')
}

export function redactLogText(value: string, depth = 0): string {
  if (depth > 5 || value.length > 16_000) return '[TRUNCATED LOG TEXT]'
  const withoutNul = value
    .replace(/\u0000/g, '')
    .replace(/data:[^;\s]+;base64,[a-z0-9+/=]+/gi, '[BINARY REDACTED]')
  const structured = redactStructuredText(withoutNul, depth)
  return structured
    .replace(/\b(Bearer|Basic)\s+[^\s"'<>]+/gi, '$1 [REDACTED]')
    .replace(/\b(?:sk-[a-z0-9_-]{8,}|AIza[a-z0-9_-]{15,})\b/gi, '[REDACTED]')
    .replace(
      /((?:api[_-]?key|token|password|secret|signature|credential)["']?\s*[:=]\s*["']?)[^\s&#"',}]+/gi,
      '$1[REDACTED]',
    )
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[REDACTED]@')
    .replace(/data:[^;\s]+;base64,[a-z0-9+/=]+/gi, '[BINARY REDACTED]')
    .slice(0, 4000)
}

function sanitize(value: unknown, depth = 0): unknown {
  if (depth > 5) return '[TRUNCATED]'
  if (typeof value === 'string') return redactLogText(value, depth)
  if (Array.isArray(value)) return value.slice(0, 30).map((one) => sanitize(one, depth + 1))
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .slice(0, 60)
        .map(([key, one]) => {
          const cleanedKey = key.replace(/\u0000/g, '')
          return [
            cleanedKey.slice(0, 200),
            PRIVATE_FIELD.test(cleanedKey) ? '[REDACTED]' : sanitize(one, depth + 1),
          ]
        }),
    )
  }
  return value
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
    const cleaned = sanitize(raw) as Record<string, unknown>
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
