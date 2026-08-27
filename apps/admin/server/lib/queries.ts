import { sql } from 'drizzle-orm'
import { getAdminRead } from './handle'
import { modelsAggregateSql } from './sql-dialect'

export type Range = '1d' | '7d' | '30d'
export type SortKey = 'last_seen' | 'today_count' | 'total_count'

function rangeMs(range: Range): number {
  return range === '1d' ? 24 * 3600_000 : range === '7d' ? 7 * 24 * 3600_000 : 30 * 24 * 3600_000
}

function todayDate(): string {
  return new Date().toISOString().slice(0, 10)
}

// 任务详情页一页拉多少条。列表项已瘦身（只含 prompt+n，不含 input_images base64），
// 单条几 KB，100/页在「响应体积」与「往返次数」之间折中。
const PAGE_SIZE = 100

// keyset 分页游标：编码 (submitted_at, id)。submitted_at 是数字（不含 '_'），
// 取第一个 '_' 之前为 ts、之后为 id，避免 id 内含 '_' 时被拆错。
function encodeCursor(ts: number, id: string): string {
  return `${ts}_${id}`
}
function decodeCursor(raw: string | undefined): { ts: number; id: string } | null {
  if (!raw) return null
  const i = raw.indexOf('_')
  if (i <= 0) return null
  const ts = Number(raw.slice(0, i))
  const id = raw.slice(i + 1)
  if (!Number.isFinite(ts) || !id) return null
  return { ts, id }
}

// 从 request_payload 抽列表需要的小字段。逻辑与前端 src/lib/request-helpers.ts 保持一致：
// 列表只需要 prompt 文本 + 张数 n，绝不把整个 request_payload（含 input_images base64）回传给浏览器。
function asPayload(payload: unknown): Record<string, unknown> | null {
  if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
    return payload as Record<string, unknown>
  }
  if (typeof payload === 'string') {
    try {
      const parsed = JSON.parse(payload) as unknown
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>
      }
    } catch {
      return null
    }
  }
  return null
}

function extractPrompt(payload: unknown): string {
  const req = asPayload(payload)
  if (!req) return ''
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
function extractN(payload: unknown): number | null {
  const n = asPayload(payload)?.n
  return typeof n === 'number' ? n : null
}

export interface DeviceRow {
  device_id: string
  first_seen: number
  last_seen: number
  total: number
  ok_count: number
  fail_count: number
  models: string[]
  today_count: number
}

export interface ListDevicesResult {
  devices: DeviceRow[]
  truncated: boolean
}

const LIST_LIMIT = 500

export async function listDevices(range: Range, sort: SortKey): Promise<ListDevicesResult> {
  const db = await getAdminRead()
  const since = Date.now() - rangeMs(range)
  const today = todayDate()
  const orderBy =
    sort === 'last_seen'
      ? sql`MAX(submitted_at) DESC`
      : sort === 'total_count'
        ? sql`COUNT(*) DESC`
        : sql`today_count DESC`

  // 单条聚合 SQL：避免 N+1。LEFT JOIN daily_quota 拿今日 count；模型 chip 走 modelsAggregateSql。
  // 注意：device_id 是 VIRTUAL 生成列，drizzle schema 没声明，只能 raw sql 访问。
  // db.all(sql`...`) 返回 unknown[]（每行一个 plain object，列名 = property key）
  const rows = (await db.all(sql`
    SELECT
      t.device_id AS device_id,
      MIN(t.submitted_at) AS first_seen,
      MAX(t.submitted_at) AS last_seen,
      COUNT(*) AS total,
      SUM(CASE WHEN t.status='completed' THEN 1 ELSE 0 END) AS ok_count,
      SUM(CASE WHEN t.status='failed' THEN 1 ELSE 0 END) AS fail_count,
      ${modelsAggregateSql()} AS models_csv,
      COALESCE(q.count, 0) AS today_count
    FROM tasks t
    LEFT JOIN daily_quota q ON q.device_id = t.device_id AND q.date = ${today}
    WHERE t.submitted_at >= ${since} AND t.device_id IS NOT NULL
    GROUP BY t.device_id
    ORDER BY ${orderBy}
    LIMIT ${LIST_LIMIT + 1}
  `)) as unknown as Array<Record<string, unknown>>

  const list = rows.map(
    (r): DeviceRow => ({
      device_id: String(r.device_id),
      first_seen: Number(r.first_seen),
      last_seen: Number(r.last_seen),
      total: Number(r.total),
      ok_count: Number(r.ok_count),
      fail_count: Number(r.fail_count),
      models: String(r.models_csv ?? '')
        .split(',')
        .filter(Boolean),
      today_count: Number(r.today_count),
    }),
  )

  const truncated = list.length > LIST_LIMIT
  return { devices: list.slice(0, LIST_LIMIT), truncated }
}

export interface TaskListItem {
  id: string
  provider: string
  model: string
  status: string
  submitted_at: number
  started_at: number | null
  completed_at: number | null
  error_type: string | null
  /** 上游 HTTP 状态码；仅 HTTP 层失败有值。5xx = 上游挂了，4xx = 请求本身有问题。 */
  upstream_status: number | null
  /** 服务端从 request_payload 预抽的 prompt 文本。列表不再回传整个 request_payload，
   *  避免 input_images base64 把响应撑到几百 MB（这是 admin 卡死/拉取慢的根因）。 */
  prompt: string
  /** 请求张数 n（openai 风格 payload）；无则 null */
  n: number | null
  /** 含首次的总尝试次数；>1 即发生过自动重试。详细见 apps/bff/src/lib/retry.ts */
  attempt_count: number
}

export interface DeviceDetailResult {
  /** 仅首页（cursor 为空）返回设备聚合卡片；翻页时为 null（省一次聚合扫描）。 */
  device: DeviceRow | null
  tasks: TaskListItem[]
  /** 下一页游标；null 表示已到末页。 */
  nextCursor: string | null
}

export async function getDeviceDetail(
  deviceId: string,
  range: Range,
  cursor?: string,
): Promise<DeviceDetailResult> {
  const db = await getAdminRead()
  const since = Date.now() - rangeMs(range)
  const today = todayDate()
  const c = decodeCursor(cursor)

  const keyset = c
    ? sql`AND (submitted_at < ${c.ts} OR (submitted_at = ${c.ts} AND id < ${c.id}))`
    : sql``

  const devicePromise: Promise<Array<Record<string, unknown>>> = c
    ? Promise.resolve([])
    : db.all(sql`
        SELECT
          t.device_id AS device_id,
          MIN(t.submitted_at) AS first_seen,
          MAX(t.submitted_at) AS last_seen,
          COUNT(*) AS total,
          SUM(CASE WHEN t.status='completed' THEN 1 ELSE 0 END) AS ok_count,
          SUM(CASE WHEN t.status='failed' THEN 1 ELSE 0 END) AS fail_count,
          ${modelsAggregateSql()} AS models_csv,
          COALESCE(q.count, 0) AS today_count
        FROM tasks t
        LEFT JOIN daily_quota q ON q.device_id = t.device_id AND q.date = ${today}
        WHERE t.device_id = ${deviceId} AND t.submitted_at >= ${since}
        GROUP BY t.device_id
      `)

  const tasksPromise = db.all(sql`
    SELECT
      id, provider, model, status, submitted_at, started_at, completed_at,
      error_type, upstream_status, request_payload, attempt_count
    FROM tasks
    WHERE device_id = ${deviceId} AND submitted_at >= ${since} ${keyset}
    ORDER BY submitted_at DESC, id DESC
    LIMIT ${PAGE_SIZE + 1}
  `)

  const [deviceRowsRaw, taskRowsRaw] = await Promise.all([devicePromise, tasksPromise])

  const drow = deviceRowsRaw[0]
  const device: DeviceRow | null = drow
    ? {
        device_id: String(drow.device_id),
        first_seen: Number(drow.first_seen),
        last_seen: Number(drow.last_seen),
        total: Number(drow.total),
        ok_count: Number(drow.ok_count),
        fail_count: Number(drow.fail_count),
        models: String(drow.models_csv ?? '')
          .split(',')
          .filter(Boolean),
        today_count: Number(drow.today_count),
      }
    : null

  const hasMore = taskRowsRaw.length > PAGE_SIZE
  const pageRows = taskRowsRaw.slice(0, PAGE_SIZE)
  const tasks: TaskListItem[] = pageRows.map((r) => ({
    id: String(r.id),
    provider: String(r.provider),
    model: String(r.model),
    status: String(r.status),
    submitted_at: Number(r.submitted_at),
    started_at: r.started_at == null ? null : Number(r.started_at),
    completed_at: r.completed_at == null ? null : Number(r.completed_at),
    error_type: r.error_type == null ? null : String(r.error_type),
    upstream_status: r.upstream_status == null ? null : Number(r.upstream_status),
    prompt: extractPrompt(r.request_payload),
    n: extractN(r.request_payload),
    attempt_count: Number(r.attempt_count ?? 0),
  }))
  const last = pageRows[pageRows.length - 1]
  const nextCursor =
    hasMore && last ? encodeCursor(Number(last.submitted_at), String(last.id)) : null

  return { device, tasks, nextCursor }
}

export interface TaskDetail extends TaskListItem {
  /** 完整请求体：详情页 / 灯箱用它统计输入图数量、展示完整 prompt。列表项没有这个字段。 */
  request_payload: unknown
  result_meta: { images: Array<{ index: number; mime: string }>; raw_image_urls?: string[] }
  error_message: string | null
  /** 上游错误响应体原文（BFF 侧已截断）。error_message 提取不到的 error.code 在这里。 */
  upstream_body: string | null
  /** VIRTUAL 生成列：json_extract(request_payload, '$.device_id')；schema 没声明，靠 raw sql 取。 */
  device_id: string | null
  /** 仅在 status='queued' 且 attempt_count>0 时有值——等待下一次重试的目标时间戳。 */
  next_retry_at: number | null
}

export async function getTask(taskId: string): Promise<TaskDetail | null> {
  const db = await getAdminRead()
  const rows = await db.all(sql`
    SELECT
      id, provider, model, status, submitted_at, started_at, completed_at,
      error_type, request_payload, result_payload, error_message,
      upstream_status, upstream_body, attempt_count, next_retry_at, device_id
    FROM tasks
    WHERE id = ${taskId}
    LIMIT 1
  `)
  const task = rows[0]
  if (!task) return null

  const images = extractImagesMeta(
    String(task.provider),
    asPayload(task.result_payload) ?? task.result_payload,
  )
  const rawDevice = task.device_id
  const device_id =
    rawDevice === null || rawDevice === undefined || rawDevice === '' ? null : String(rawDevice)
  return {
    id: String(task.id),
    provider: String(task.provider),
    model: String(task.model),
    status: String(task.status),
    submitted_at: Number(task.submitted_at),
    started_at: task.started_at == null ? null : Number(task.started_at),
    completed_at: task.completed_at == null ? null : Number(task.completed_at),
    error_type: task.error_type == null ? null : String(task.error_type),
    prompt: extractPrompt(task.request_payload),
    n: extractN(task.request_payload),
    attempt_count: Number(task.attempt_count ?? 0),
    request_payload: asPayload(task.request_payload) ?? task.request_payload,
    result_meta: { images },
    error_message: task.error_message == null ? null : String(task.error_message),
    upstream_status: task.upstream_status == null ? null : Number(task.upstream_status),
    upstream_body: task.upstream_body == null ? null : String(task.upstream_body),
    device_id,
    next_retry_at: task.next_retry_at == null ? null : Number(task.next_retry_at),
  }
}

/** 最小实现：从原始 result_payload 抽 image meta（index + mime），不解 base64 */
function extractImagesMeta(
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
    return data.map((_d, i) => ({ index: i, mime: 'image/png' }))
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
