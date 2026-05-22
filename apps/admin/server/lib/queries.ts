import { createDb } from '@image-playground/db'
import { eq, sql } from 'drizzle-orm'
import { config } from '../config'

// 懒初始化 readonly 句柄：第一次调用时根据当时的 DATABASE_URL 打开。
// 不在 module 顶层 createDb，避免「import 链路上 config 先于 test setEnv 被 evaluate」
// 导致多个测试文件共享同一指向首次 DB 的句柄（bun:test 同进程 module cache 单例）。
// 同时按 url 缓存，让不同 test 文件切换 DATABASE_URL 时也能重开新 handle。
type Handle = ReturnType<typeof createDb>
const _handles = new Map<string, Handle>()
function getHandle(): Handle {
  const url = process.env.DATABASE_URL?.trim() || config.databaseUrl
  let h = _handles.get(url)
  if (!h) {
    h = createDb(url, { readonly: true })
    _handles.set(url, h)
  }
  return h
}

export type Range = '1d' | '7d' | '30d'
export type SortKey = 'last_seen' | 'today_count' | 'total_count'

function rangeMs(range: Range): number {
  return range === '1d' ? 24 * 3600_000 : range === '7d' ? 7 * 24 * 3600_000 : 30 * 24 * 3600_000
}

function todayDate(): string {
  return new Date().toISOString().slice(0, 10)
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
  const { db } = getHandle()
  const since = Date.now() - rangeMs(range)
  const today = todayDate()
  const orderBy =
    sort === 'last_seen'
      ? sql`MAX(submitted_at) DESC`
      : sort === 'total_count'
        ? sql`COUNT(*) DESC`
        : sql`today_count DESC`

  // 单条聚合 SQL：避免 N+1。LEFT JOIN daily_quota 拿今日 count；GROUP_CONCAT 模型 chip。
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
      GROUP_CONCAT(DISTINCT t.model) AS models_csv,
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
  /** request_payload JSON（含 prompt / device_id 等）；体积可控 */
  request_payload: unknown
  /** 含首次的总尝试次数；>1 即发生过自动重试。详细见 apps/bff/src/lib/retry.ts */
  attempt_count: number
}

export interface DeviceDetailResult {
  device: DeviceRow | null
  tasks: TaskListItem[]
  truncated: boolean
}

export async function getDeviceDetail(deviceId: string, range: Range): Promise<DeviceDetailResult> {
  const { db, schema } = getHandle()
  const since = Date.now() - rangeMs(range)
  const today = todayDate()

  const [deviceRowsRaw, taskRows] = await Promise.all([
    db.all(sql`
      SELECT
        t.device_id AS device_id,
        MIN(t.submitted_at) AS first_seen,
        MAX(t.submitted_at) AS last_seen,
        COUNT(*) AS total,
        SUM(CASE WHEN t.status='completed' THEN 1 ELSE 0 END) AS ok_count,
        SUM(CASE WHEN t.status='failed' THEN 1 ELSE 0 END) AS fail_count,
        GROUP_CONCAT(DISTINCT t.model) AS models_csv,
        COALESCE(q.count, 0) AS today_count
      FROM tasks t
      LEFT JOIN daily_quota q ON q.device_id = t.device_id AND q.date = ${today}
      WHERE t.device_id = ${deviceId} AND t.submitted_at >= ${since}
      GROUP BY t.device_id
    `) as unknown as Promise<Array<Record<string, unknown>>>,
    // task 列表：select 字段白名单（**不取 result_payload**，5-10MB 字段）。
    // where 子句用 raw sql 模板：device_id 是 VIRTUAL 列，drizzle schema 没声明，
    // 不能用 schema.tasks.device_id 引用；但 raw sql 字面列名 + bind param 安全。
    // Drizzle 仍负责 select 字段的 mode:'json' 解码（request_payload 自动 parse）。
    db
      .select({
        id: schema.tasks.id,
        provider: schema.tasks.provider,
        model: schema.tasks.model,
        status: schema.tasks.status,
        submitted_at: schema.tasks.submitted_at,
        started_at: schema.tasks.started_at,
        completed_at: schema.tasks.completed_at,
        error_type: schema.tasks.error_type,
        request_payload: schema.tasks.request_payload,
        attempt_count: schema.tasks.attempt_count,
      })
      .from(schema.tasks)
      .where(sql`device_id = ${deviceId} AND submitted_at >= ${since}`)
      .orderBy(sql`submitted_at DESC`)
      .limit(LIST_LIMIT + 1),
  ])

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

  const truncated = taskRows.length > LIST_LIMIT
  return {
    device,
    tasks: taskRows.slice(0, LIST_LIMIT) as TaskListItem[],
    truncated,
  }
}

export interface TaskDetail extends TaskListItem {
  result_meta: { images: Array<{ index: number; mime: string }>; raw_image_urls?: string[] }
  error_message: string | null
  /** VIRTUAL 生成列：json_extract(request_payload, '$.device_id')；schema 没声明，靠 raw sql 取。 */
  device_id: string | null
  /** 仅在 status='queued' 且 attempt_count>0 时有值——等待下一次重试的目标时间戳。 */
  next_retry_at: number | null
}

export async function getTask(taskId: string): Promise<TaskDetail | null> {
  const { db, schema } = getHandle()
  // device_id 是 VIRTUAL 列，schema 没声明 → drizzle select 拿不到；用 raw sql 单独查一次。
  // Promise.all 并发减少一次往返。
  const [rows, deviceRows] = await Promise.all([
    db.select().from(schema.tasks).where(eq(schema.tasks.id, taskId)).limit(1),
    db.all(sql`SELECT device_id FROM tasks WHERE id = ${taskId} LIMIT 1`) as unknown as Promise<
      Array<{ device_id: unknown }>
    >,
  ])
  const task = rows[0]
  if (!task) return null

  // 最小实现：从原始 result_payload 抽 image meta（index + mime），不解 base64
  const images = extractImagesMeta(task.provider, task.result_payload)

  const { result_payload: _result_payload, ...rest } = task as unknown as Record<string, unknown>
  void _result_payload
  const rawDevice = deviceRows[0]?.device_id
  const device_id =
    rawDevice === null || rawDevice === undefined || rawDevice === '' ? null : String(rawDevice)
  return {
    ...(rest as unknown as TaskListItem),
    error_message: (task as Record<string, unknown>).error_message as string | null,
    result_meta: { images },
    device_id,
    next_retry_at: (task as Record<string, unknown>).next_retry_at as number | null,
  }
}

/** 最小实现：从原始 result_payload 抽 image meta（index + mime），不解 base64 */
function extractImagesMeta(
  provider: string,
  payload: unknown,
): Array<{ index: number; mime: string }> {
  if (!payload || typeof payload !== 'object') return []
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
