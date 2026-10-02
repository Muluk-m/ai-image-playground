import { createHash, randomUUID } from 'node:crypto'
import {
  CLIENT_ERROR_KINDS,
  CLIENT_ERROR_LIMITS,
  type ClientErrorKind,
  type ClientErrorReport,
} from '@image-playground/shared'
import { inArray, lt } from 'drizzle-orm'
import { db, schema } from '../db/client'

export const CLIENT_ERROR_RETENTION_MS = 30 * 24 * 60 * 60 * 1000

export interface ParsedClientErrorBatch {
  deviceId: string | null
  errors: ClientErrorReport[]
}

const KINDS = new Set<string>(CLIENT_ERROR_KINDS)

// PostgreSQL 的 text 与 jsonb 都存不了 NUL；留着它，一条坏数据会让整批 INSERT 失败。
function clip(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.replaceAll('\0', '').trim()
  return trimmed ? trimmed.slice(0, max) : undefined
}

function clipContext(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  try {
    // NUL 在序列化结果里是转义序列；剔掉它再解析，键名与嵌套字符串一并干净。
    const serialized = JSON.stringify(value).replaceAll('\\u0000', '')
    return serialized.length <= CLIENT_ERROR_LIMITS.context
      ? (JSON.parse(serialized) as Record<string, unknown>)
      : undefined
  } catch {
    return undefined
  }
}

/**
 * 请求体是发送方随手拼的 JSON，逐字段截断，认不出的条目直接跳过。整体不是 JSON 或没有
 * `errors` 数组才算坏请求。
 */
export function parseClientErrorBatch(raw: string): ParsedClientErrorBatch | null {
  let body: unknown
  try {
    body = JSON.parse(raw)
  } catch {
    return null
  }
  if (!body || typeof body !== 'object') return null
  const { deviceId, errors } = body as { deviceId?: unknown; errors?: unknown }
  if (!Array.isArray(errors)) return null
  const device = typeof deviceId === 'string' && /^[\w-]{8,64}$/.test(deviceId) ? deviceId : null
  const parsed: ClientErrorReport[] = []
  for (const item of errors.slice(0, CLIENT_ERROR_LIMITS.batch)) {
    if (!item || typeof item !== 'object') continue
    const entry = item as Record<string, unknown>
    const message = clip(entry.message, CLIENT_ERROR_LIMITS.message)
    if (typeof entry.kind !== 'string' || !KINDS.has(entry.kind) || !message) continue
    parsed.push({
      kind: entry.kind as ClientErrorKind,
      message,
      name: clip(entry.name, CLIENT_ERROR_LIMITS.name),
      stack: clip(entry.stack, CLIENT_ERROR_LIMITS.stack),
      url: clip(entry.url, CLIENT_ERROR_LIMITS.url),
      release: clip(entry.release, CLIENT_ERROR_LIMITS.release),
      context: clipContext(entry.context),
    })
  }
  return { deviceId: device, errors: parsed }
}

/** 把每次都会变的部分（数字、ID、地址）换成占位符，同一类错误才能落进同一组。 */
function normalizeMessage(message: string): string {
  return message
    .replace(/https?:\/\/\S+/g, '<url>')
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<id>')
    .replace(/\b[0-9a-f]{12,}\b/gi, '<hex>')
    .replace(/\d+/g, '<n>')
}

/**
 * 栈顶第一帧去掉行列号与 vite 的文件名哈希（`index-BxY12z.js` → `index.js`）：
 * 换一次构建哈希与行号都会变，留着它们同一个 bug 每次发版都会变成新问题。
 */
function topFrame(stack: string | undefined): string {
  if (!stack) return ''
  const frame = stack
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.startsWith('at ') || line.includes('@'))
  if (!frame) return ''
  return frame
    .replace(/https?:\/\/[^/\s)]+/g, '')
    .replace(/-[\w-]{8}\.(m?js)/g, '.$1')
    .replace(/:\d+(:\d+)?\)?$/, '')
}

export function clientErrorFingerprint(report: ClientErrorReport): string {
  // 启动失败的 message 只是原因（timeout / resource / preload），按原因分组即可。
  const parts =
    report.kind === 'boot'
      ? [report.kind, report.message]
      : [report.kind, report.name ?? '', normalizeMessage(report.message), topFrame(report.stack)]
  return createHash('sha256').update(parts.join('\u0000')).digest('hex').slice(0, 16)
}

export interface ClientErrorMeta {
  deviceId: string | null
  userId: string | null
  userAgent: string | null
}

export async function recordClientErrors(
  reports: readonly ClientErrorReport[],
  meta: ClientErrorMeta,
  now = Date.now(),
): Promise<void> {
  if (reports.length === 0) return
  const userAgent = meta.userAgent?.slice(0, CLIENT_ERROR_LIMITS.userAgent) ?? null
  await db.insert(schema.client_errors).values(
    reports.map((report) => ({
      id: randomUUID(),
      received_at: now,
      kind: report.kind,
      fingerprint: clientErrorFingerprint(report),
      name: report.name ?? null,
      message: report.message,
      stack: report.stack ?? null,
      url: report.url ?? null,
      release: report.release ?? null,
      device_id: meta.deviceId,
      user_id: meta.userId,
      user_agent: userAgent,
      context: report.context ?? null,
    })),
  )
}

const PURGE_BATCH = 5000
/** 一轮最多删这么多批，积压留给下一轮，不拖住同一维护循环里的其他步骤。 */
const PURGE_BATCHES_PER_ROUND = 10

export async function purgeOldClientErrors(
  retentionMs = CLIENT_ERROR_RETENTION_MS,
  now = Date.now(),
): Promise<number> {
  const expired = db
    .select({ id: schema.client_errors.id })
    .from(schema.client_errors)
    .where(lt(schema.client_errors.received_at, now - retentionMs))
    .limit(PURGE_BATCH)
  let removed = 0
  for (let round = 0; round < PURGE_BATCHES_PER_ROUND; round += 1) {
    const rows = await db
      .delete(schema.client_errors)
      .where(inArray(schema.client_errors.id, expired))
      .returning({ id: schema.client_errors.id })
    removed += rows.length
    if (rows.length < PURGE_BATCH) break
  }
  return removed
}
