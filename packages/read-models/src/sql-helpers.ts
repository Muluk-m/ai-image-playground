import type { DbHandle } from '@image-playground/db'
import { TASK_STATUSES, type TaskStatus } from '@image-playground/shared'
import { type SQL, type SQLWrapper, sql } from 'drizzle-orm'
import type {
  GenerationTaskItem,
  Range,
  TaskListItem,
  TaskSource,
  TaskVolumeBucket,
  VolumeBucketUnit,
} from './types'

export type ReadModelsDb = DbHandle['db']
export type ReadModelsTransaction = Parameters<Parameters<ReadModelsDb['transaction']>[0]>[0]
export type ReadModelsQueryExecutor = ReadModelsDb | ReadModelsTransaction
export type ReadModelsDbHandle = Pick<DbHandle, 'db' | 'schema'>

export type Row = Record<string, unknown>

export function rangeMs(range: Range): number {
  return range === '1d' ? 24 * 3600_000 : range === '7d' ? 7 * 24 * 3600_000 : 30 * 24 * 3600_000
}

export function todayDate(): string {
  return new Date().toISOString().slice(0, 10)
}

export function volumeBucketUnit(range: Range): VolumeBucketUnit {
  return range === '1d' ? 'hour' : 'day'
}

/**
 * 趋势图的分桶：1 天按小时 24 格，其余按天，最后一格是 `at` 所在的那个小时或那一天。
 * 同一次请求的所有查询传同一个 `at`：各自取 NOW() 的话，跨整点或午夜时会错开一格。
 */
export function volumeBuckets(range: Range, at: Date) {
  const now = sql`${at}::timestamptz`
  return {
    now,
    unit: range === '1d' ? sql`'hour'` : sql`'day'`,
    step: range === '1d' ? sql`INTERVAL '1 hour'` : sql`INTERVAL '1 day'`,
    start:
      range === '1d'
        ? sql`DATE_TRUNC('hour', ${now}) - INTERVAL '23 hours'`
        : range === '7d'
          ? sql`DATE_TRUNC('day', ${now}) - INTERVAL '6 days'`
          : sql`DATE_TRUNC('day', ${now}) - INTERVAL '29 days'`,
  }
}

/** keyset 分页游标：编码 (ts, id)。ts 是数字（不含 '_'），取第一个 '_' 之前为 ts、之后为 id。 */
export function encodeCursor(ts: number, id: string): string {
  return `${ts}_${id}`
}

export function decodeCursor(raw: string | undefined): { ts: number; id: string } | null {
  if (!raw) return null
  const i = raw.indexOf('_')
  if (i <= 0) return null
  const ts = Number(raw.slice(0, i))
  const id = raw.slice(i + 1)
  if (!Number.isFinite(ts) || !id) return null
  return { ts, id }
}

export function ilikeContains(value: string): string {
  return `%${value.replace(/[\\%_]/g, (char) => `\\${char}`)}%`
}

export function sqlTextIn(column: SQL, values: readonly string[]) {
  return sql`${column} IN (${sql.join(
    values.map((value) => sql`${value}`),
    sql`, `,
  )})`
}

export function toEpochMs(value: unknown): number {
  if (value instanceof Date) return value.getTime()
  if (typeof value === 'number') return value
  const parsed = Date.parse(String(value))
  return Number.isNaN(parsed) ? 0 : parsed
}

export function nullableEpochMs(value: unknown): number | null {
  return value === null || value === undefined ? null : toEpochMs(value)
}

export function nullableNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

export function nullableText(value: unknown): string | null {
  return value == null ? null : String(value)
}

export function nullableMs(value: unknown): number | null {
  if (value === null || value === undefined) return null
  const num = Number(value)
  return Number.isFinite(num) ? Math.round(num) : null
}

export function parsePercentilePair(value: unknown): [number | null, number | null] {
  if (Array.isArray(value)) return [nullableMs(value[0]), nullableMs(value[1])]
  if (typeof value === 'string') {
    const trimmed = value.replace(/^\{|\}$/g, '')
    if (!trimmed) return [null, null]
    const parts = trimmed.split(',').map((part) => (part === 'NULL' ? null : nullableMs(part)))
    return [parts[0] ?? null, parts[1] ?? null]
  }
  return [null, null]
}

export function taskStatus(value: unknown): TaskStatus {
  if (typeof value === 'string' && (TASK_STATUSES as readonly string[]).includes(value)) {
    return value as TaskStatus
  }
  throw new Error(`Unknown task status: ${String(value)}`)
}

export function taskSourceSql(taskId: SQLWrapper, conversationId: SQLWrapper) {
  return sql<TaskSource>`CASE
    WHEN EXISTS (SELECT 1 FROM cli_jobs WHERE cli_jobs.task_id = ${taskId}) THEN 'cli'
    WHEN ${conversationId} IS NOT NULL THEN 'chat'
    ELSE 'manual'
  END`
}

/**
 * 从 request_payload 抽列表需要的小字段。逻辑与前端 src/lib/request-helpers.ts 保持一致：
 * 列表只需要 prompt 文本 + 张数 n，绝不把整个 request_payload（含 input_images base64）回传给浏览器。
 */
export function extractTaskPrompt(payload: unknown): string {
  if (!payload || typeof payload !== 'object') return ''
  const req = payload as Record<string, unknown>
  if (typeof req.prompt === 'string') return req.prompt
  // gemini-style: contents[].parts[].text 顺序拼接
  const contents = req.contents as Array<{ parts?: Array<{ text?: string }> }> | undefined
  if (!Array.isArray(contents)) return ''
  return contents
    .flatMap((c) => c.parts ?? [])
    .map((p) => p?.text ?? '')
    .filter(Boolean)
    .join('\n')
}

/** 最小实现：从原始 result_payload 抽 image meta（index + mime），不解 base64 */
export function extractTaskImagesMeta(
  provider: string,
  payload: unknown,
): Array<{ index: number; mime: string }> {
  if (!payload || typeof payload !== 'object') return []

  // Externalized result payloads carry authoritative image metadata because their
  // provider-specific base64 pixel fields have been stripped.
  const externalizedMeta = (payload as { _image_meta?: unknown })._image_meta
  if (Array.isArray(externalizedMeta)) {
    const images: Array<{ index: number; mime: string }> = []
    for (const item of externalizedMeta) {
      if (!item || typeof item !== 'object') continue
      const { index, mime } = item as { index?: unknown; mime?: unknown }
      if (typeof index !== 'number' || !Number.isInteger(index) || index < 0) continue
      if (typeof mime !== 'string' || mime.length === 0) continue
      images.push({ index, mime })
    }
    return images
  }

  if (provider === 'openai-compat') {
    const data = (payload as { data?: unknown[] }).data
    if (!Array.isArray(data)) return []
    return data.map((item, index) => ({
      index,
      mime:
        item && typeof item === 'object' && 'mime' in item && typeof item.mime === 'string'
          ? item.mime
          : 'image/png',
    }))
  }
  if (provider === 'gemini') {
    const candidates = (payload as { candidates?: unknown[] }).candidates
    if (!Array.isArray(candidates)) return []
    const parts = (candidates[0] as { content?: { parts?: unknown[] } } | undefined)?.content?.parts
    if (!Array.isArray(parts)) return []
    const imgs: Array<{ index: number; mime: string }> = []
    let idx = 0
    for (const p of parts) {
      const inlineData = (p as { inlineData?: { mimeType?: string } } | undefined)?.inlineData
      if (inlineData?.mimeType) imgs.push({ index: idx++, mime: inlineData.mimeType })
    }
    return imgs
  }
  return []
}

/** 提示词不建 trigram。调用方必须先用 submitted_at 窗口把扫描圈住，再对这段文本做 ILIKE。 */
export const PROMPT_TEXT_SQL = sql`COALESCE(t.request_payload->>'prompt', (
  SELECT string_agg(part #>> '{}', E'\\n' ORDER BY position)
  FROM jsonb_array_elements(jsonb_path_query_array(t.request_payload, '$.contents[*].parts[*].text'))
    WITH ORDINALITY AS texts(part, position)
  WHERE jsonb_typeof(part) = 'string' AND part #>> '{}' <> ''
), '')`

export const TASK_LIST_COLUMNS = sql`
  t.id,
  t.provider,
  t.model,
  t.status,
  t.submitted_at,
  t.started_at,
  t.completed_at,
  t.error_type,
  t.upstream_status,
  t.gpt_route,
  t.gpt_key_fingerprint,
  t.request_payload,
  t.attempt_count,
  t.upstream_invocation_count,
  t.agent_conversation_id,
  ${taskSourceSql(sql`t.id`, sql`t.agent_conversation_id`)} AS source
`

export const TASK_SELECT_SQL = sql`
  SELECT t.id, t.provider, t.model, t.status, t.submitted_at, t.started_at, t.completed_at,
    t.error_type, t.upstream_status, t.gpt_route, t.gpt_key_fingerprint,
    t.attempt_count, t.upstream_invocation_count,
    ${PROMPT_TEXT_SQL} AS prompt,
    t.user_id, t.device_id, t.agent_conversation_id, u.username,
    ${taskSourceSql(sql`t.id`, sql`t.agent_conversation_id`)} AS source
  FROM queue_tasks t LEFT JOIN users u ON u.id = t.user_id
`

export function mapTaskListItem(row: Row): TaskListItem {
  return {
    id: String(row.id),
    kind: row.kind === 'analysis' ? 'analysis' : 'queue',
    source: row.source === 'cli' ? 'cli' : row.agent_conversation_id != null ? 'chat' : 'manual',
    provider: String(row.provider),
    model: String(row.model),
    status: taskStatus(row.status),
    submitted_at: toEpochMs(row.submitted_at),
    started_at: nullableEpochMs(row.started_at),
    completed_at: nullableEpochMs(row.completed_at),
    error_type: row.error_type === null ? null : String(row.error_type),
    upstream_status: nullableNumber(row.upstream_status),
    gpt_route: row.gpt_route === 'direct' || row.gpt_route === 'sub2api' ? row.gpt_route : null,
    gpt_key_fingerprint:
      typeof row.gpt_key_fingerprint === 'string' ? row.gpt_key_fingerprint : null,
    prompt: typeof row.prompt === 'string' ? row.prompt : extractTaskPrompt(row.request_payload),
    upstream_invocation_count: Number(row.upstream_invocation_count),
    attempt_count: Number(row.attempt_count),
  }
}

export function mapGenerationTask(row: Row): GenerationTaskItem {
  return {
    ...mapTaskListItem(row),
    user_id: nullableText(row.user_id),
    device_id: nullableText(row.device_id),
    username: nullableText(row.username),
  }
}

/**
 * 张数。`n` 缺省、是小数，或 GIF/SVG 等任务里根本不是数字时，按 1 张。
 * 直接 `(request_payload->>'n')::integer` 遇到这些值会让整页概览 500。
 */
export const requestedImageCountSql = sql`GREATEST(COALESCE(
  CASE
    WHEN btrim(request_payload->>'n') ~ '^[0-9]{1,9}([.][0-9]{1,6})?$'
    THEN trunc(btrim(request_payload->>'n')::numeric)::integer
    ELSE NULL
  END,
  1), 1)`

/**
 * 模型调用上报的输入 token。整数照常累加，小数保留；非数字与科学计数跳过，不抛转换错误。
 */
export const reportedInputTokensSql = sql`(
  CASE
    WHEN btrim(usage->>'inputTokens') ~ '^[0-9]{1,15}([.][0-9]{1,12})?$'
    THEN btrim(usage->>'inputTokens')::numeric
    ELSE NULL
  END
)`

export async function getTaskVolume(
  handle: ReadModelsDbHandle,
  range: Range,
  userId?: string,
  at: Date = new Date(),
): Promise<TaskVolumeBucket[]> {
  const { db } = handle
  const { now, unit: bucketUnit, step: bucketStep, start: bucketStart } = volumeBuckets(range, at)
  const ownerCondition = userId ? sql`AND t.user_id = ${userId}` : sql``
  const rows = await db.execute(sql`
    WITH buckets AS (
      SELECT GENERATE_SERIES(${bucketStart}, DATE_TRUNC(${bucketUnit}, ${now}), ${bucketStep}) AS bucket
    )
    SELECT
      EXTRACT(EPOCH FROM b.bucket) * 1000 AS bucket_at,
      COUNT(t.id) AS total,
      COUNT(t.id) FILTER (WHERE t.status = 'completed') AS completed,
      COUNT(t.id) FILTER (WHERE t.status = 'failed') AS failed
    FROM buckets b
    LEFT JOIN queue_tasks t
      ON t.submitted_at >= b.bucket
     AND t.submitted_at < b.bucket + ${bucketStep}
     ${ownerCondition}
    GROUP BY b.bucket
    ORDER BY b.bucket
  `)
  return (rows as unknown as Row[]).map((row) => ({
    bucket_at: Number(row.bucket_at),
    total: Number(row.total),
    completed: Number(row.completed),
    failed: Number(row.failed),
  }))
}

export async function getTaskVolumeBetween(
  handle: ReadModelsDbHandle,
  since: Date,
  at: Date,
  unit: VolumeBucketUnit,
): Promise<TaskVolumeBucket[]> {
  const { db } = handle
  const bucketUnit = unit === 'hour' ? sql`'hour'` : sql`'day'`
  const bucketStep = unit === 'hour' ? sql`INTERVAL '1 hour'` : sql`INTERVAL '1 day'`
  const bucketStart = sql`DATE_TRUNC(${bucketUnit}, ${since}::timestamptz)`
  const now = sql`${at}::timestamptz`
  const rows = await db.execute(sql`
    WITH buckets AS (
      SELECT GENERATE_SERIES(${bucketStart}, DATE_TRUNC(${bucketUnit}, ${now}), ${bucketStep}) AS bucket
    )
    SELECT
      EXTRACT(EPOCH FROM b.bucket) * 1000 AS bucket_at,
      COUNT(t.id) AS total,
      COUNT(t.id) FILTER (WHERE t.status = 'completed') AS completed,
      COUNT(t.id) FILTER (WHERE t.status = 'failed') AS failed
    FROM buckets b
    LEFT JOIN queue_tasks t
      ON t.submitted_at >= b.bucket
     AND t.submitted_at < b.bucket + ${bucketStep}
     AND t.submitted_at >= ${since}
     AND t.submitted_at <= ${at}
    GROUP BY b.bucket
    ORDER BY b.bucket
  `)
  return (rows as unknown as Row[]).map((row) => ({
    bucket_at: Number(row.bucket_at),
    total: Number(row.total),
    completed: Number(row.completed),
    failed: Number(row.failed),
  }))
}
