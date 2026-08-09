import type {
  AdminUserRow,
  DeviceDetailResult,
  DeviceRow,
  ListDevicesResult,
  ListUsersResult,
  OverviewResult,
  Range,
  SortKey,
  TaskDetail,
  TaskListItem,
  TaskVolumeBucket,
  UserDetailResult,
} from '../../contracts'

export type { Range, SortKey } from '../../contracts'

import { eq, sql } from 'drizzle-orm'
import { getDbHandle as getHandle } from './db'

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
function extractPrompt(payload: unknown): string {
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
function toEpochMs(value: unknown): number {
  if (value instanceof Date) return value.getTime()
  if (typeof value === 'number') return value
  const parsed = Date.parse(String(value))
  return Number.isNaN(parsed) ? 0 : parsed
}
function nullableNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
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

  // One aggregate query avoids N+1. PostgreSQL returns distinct models as a native array.
  const rows = (await db.execute(sql`
    SELECT
      t.device_id AS device_id,
      MIN(t.submitted_at) AS first_seen,
      MAX(t.submitted_at) AS last_seen,
      COUNT(*) AS total,
      SUM(CASE WHEN t.status='completed' THEN 1 ELSE 0 END) AS ok_count,
      SUM(CASE WHEN t.status='failed' THEN 1 ELSE 0 END) AS fail_count,
      ARRAY_AGG(DISTINCT t.model) AS models,
      COALESCE(q.count, 0) AS today_count
    FROM tasks t
    LEFT JOIN daily_quota q ON q.device_id = t.device_id AND q.date = ${today}
    WHERE t.submitted_at >= ${new Date(since)} AND t.device_id IS NOT NULL
    GROUP BY t.device_id, q.count
    ORDER BY ${orderBy}
    LIMIT ${LIST_LIMIT + 1}
  `)) as unknown as Array<Record<string, unknown>>

  const list = rows.map(
    (r): DeviceRow => ({
      device_id: String(r.device_id),
      first_seen: toEpochMs(r.first_seen),
      last_seen: toEpochMs(r.last_seen),
      total: Number(r.total),
      ok_count: Number(r.ok_count),
      fail_count: Number(r.fail_count),
      models: Array.isArray(r.models) ? r.models.map(String) : [],
      today_count: Number(r.today_count),
    }),
  )

  const truncated = list.length > LIST_LIMIT
  return { devices: list.slice(0, LIST_LIMIT), truncated }
}

function nullableEpochMs(value: unknown): number | null {
  return value === null || value === undefined ? null : toEpochMs(value)
}

function mapAdminUser(row: Record<string, unknown>): AdminUserRow {
  return {
    id: String(row.id),
    username: String(row.username),
    status: row.status === 'disabled' ? 'disabled' : 'active',
    created_at: toEpochMs(row.created_at),
    updated_at: toEpochMs(row.updated_at),
    last_login_at: nullableEpochMs(row.last_login_at),
    last_task_at: nullableEpochMs(row.last_task_at),
    last_activity_at: nullableEpochMs(row.last_activity_at),
    active_sessions: Number(row.active_sessions),
    task_count: Number(row.task_count),
  }
}
const ADMIN_USER_PROJECTION = sql`
  u.id,
  u.username,
  u.status,
  u.created_at,
  u.updated_at,
  u.last_login_at,
  task_stats.last_task_at,
  GREATEST(u.last_login_at, task_stats.last_task_at) AS last_activity_at,
  COALESCE(session_stats.active_sessions, 0) AS active_sessions,
  COALESCE(task_stats.task_count, 0) AS task_count
`
const ACTIVE_SESSION_JOIN = sql`
  LEFT JOIN LATERAL (
    SELECT COUNT(*) AS active_sessions
    FROM user_sessions s
    WHERE s.user_id = u.id AND s.expires_at > NOW()
  ) session_stats ON TRUE
`

const USER_LIST_LIMIT = 1000

export async function listUsers(search = ''): Promise<ListUsersResult> {
  const { db } = getHandle()
  const term = search.trim().toLowerCase()
  const userRowsPromise = db.execute(sql`
    SELECT ${ADMIN_USER_PROJECTION}
    FROM users u
    ${ACTIVE_SESSION_JOIN}
    LEFT JOIN LATERAL (
      SELECT COUNT(*) AS task_count, MAX(t.submitted_at) AS last_task_at
      FROM tasks t
      WHERE t.user_id = u.id
    ) task_stats ON TRUE
    WHERE ${term} = ''
       OR POSITION(${term} IN LOWER(u.username)) > 0
       OR POSITION(${term} IN LOWER(u.id)) > 0
    ORDER BY last_activity_at DESC NULLS LAST, u.created_at DESC, u.id DESC
    LIMIT ${USER_LIST_LIMIT + 1}
  `)
  const kpiRowsPromise = db.execute(sql`
    WITH user_activity AS (
      SELECT u.id, GREATEST(u.last_login_at, MAX(t.submitted_at)) AS last_activity_at
      FROM users u
      LEFT JOIN tasks t ON t.user_id = u.id
      GROUP BY u.id
    ),
    recent_tasks AS (
      SELECT
        COUNT(*) AS submissions,
        COUNT(*) FILTER (WHERE status = 'failed') AS failures
      FROM tasks
      WHERE submitted_at >= NOW() - INTERVAL '24 hours'
    )
    SELECT
      (SELECT COUNT(*) FROM users) AS total_users,
      (SELECT COUNT(*) FROM user_activity
       WHERE last_activity_at >= NOW() - INTERVAL '7 days') AS active_users_7d,
      recent_tasks.submissions AS submissions_24h,
      CASE
        WHEN recent_tasks.submissions = 0 THEN 0
        ELSE recent_tasks.failures::double precision / recent_tasks.submissions::double precision
      END AS failure_rate_24h
    FROM recent_tasks
  `)

  const [userRowsRaw, kpiRowsRaw] = await Promise.all([userRowsPromise, kpiRowsPromise])
  const userRows = userRowsRaw as unknown as Array<Record<string, unknown>>
  const kpi = (kpiRowsRaw as unknown as Array<Record<string, unknown>>)[0] ?? {}
  return {
    users: userRows.slice(0, USER_LIST_LIMIT).map(mapAdminUser),
    truncated: userRows.length > USER_LIST_LIMIT,
    kpis: {
      total_users: Number(kpi.total_users ?? 0),
      active_users_7d: Number(kpi.active_users_7d ?? 0),
      submissions_24h: Number(kpi.submissions_24h ?? 0),
      failure_rate_24h: Number(kpi.failure_rate_24h ?? 0),
    },
  }
}

async function getTaskVolume(range: Range, userId?: string): Promise<TaskVolumeBucket[]> {
  const { db } = getHandle()
  const bucketUnit = range === '1d' ? sql`'hour'` : sql`'day'`
  const bucketStep = range === '1d' ? sql`INTERVAL '1 hour'` : sql`INTERVAL '1 day'`
  const bucketStart =
    range === '1d'
      ? sql`DATE_TRUNC('hour', NOW()) - INTERVAL '23 hours'`
      : range === '7d'
        ? sql`DATE_TRUNC('day', NOW()) - INTERVAL '6 days'`
        : sql`DATE_TRUNC('day', NOW()) - INTERVAL '29 days'`
  const ownerCondition = userId ? sql`AND t.user_id = ${userId}` : sql``
  const rows = await db.execute(sql`
    WITH buckets AS (
      SELECT GENERATE_SERIES(${bucketStart}, DATE_TRUNC(${bucketUnit}, NOW()), ${bucketStep}) AS bucket
    )
    SELECT
      EXTRACT(EPOCH FROM b.bucket) * 1000 AS bucket_at,
      COUNT(t.id) AS total,
      COUNT(t.id) FILTER (WHERE t.status = 'completed') AS completed,
      COUNT(t.id) FILTER (WHERE t.status = 'failed') AS failed
    FROM buckets b
    LEFT JOIN tasks t
      ON t.submitted_at >= b.bucket
     AND t.submitted_at < b.bucket + ${bucketStep}
     ${ownerCondition}
    GROUP BY b.bucket
    ORDER BY b.bucket
  `)
  return (rows as unknown as Array<Record<string, unknown>>).map((row) => ({
    bucket_at: Number(row.bucket_at),
    total: Number(row.total),
    completed: Number(row.completed),
    failed: Number(row.failed),
  }))
}

export async function getOverview(range: Range): Promise<OverviewResult> {
  const { db } = getHandle()
  const since = new Date(Date.now() - rangeMs(range))

  const [summaryRowsRaw, volume, failureRowsRaw, modelRowsRaw] = await Promise.all([
    db.execute(sql`
      SELECT
        COUNT(*) AS total,
        COUNT(*) FILTER (WHERE status = 'completed') AS completed,
        COUNT(*) FILTER (WHERE status = 'failed') AS failed,
        PERCENTILE_DISC(0.5) WITHIN GROUP (
          ORDER BY EXTRACT(EPOCH FROM (completed_at - started_at)) * 1000
        ) FILTER (WHERE started_at IS NOT NULL AND completed_at IS NOT NULL) AS p50_duration_ms,
        PERCENTILE_DISC(0.95) WITHIN GROUP (
          ORDER BY EXTRACT(EPOCH FROM (completed_at - started_at)) * 1000
        ) FILTER (WHERE started_at IS NOT NULL AND completed_at IS NOT NULL) AS p95_duration_ms,
        COALESCE(SUM(upstream_invocation_count), 0) AS upstream_invocations
      FROM tasks
      WHERE submitted_at >= ${since}
    `),
    getTaskVolume(range),
    db.execute(sql`
      SELECT COALESCE(error_type, 'unknown') AS error_type, COUNT(*) AS count
      FROM tasks
      WHERE submitted_at >= ${since} AND status = 'failed'
      GROUP BY COALESCE(error_type, 'unknown')
      ORDER BY count DESC, error_type
    `),
    db.execute(sql`
      SELECT
        model,
        COUNT(*) AS count,
        COALESCE(SUM(upstream_invocation_count), 0) AS upstream_invocations,
        AVG(upstream_invocation_count::double precision)
          FILTER (WHERE status IN ('completed', 'failed', 'cancelled')) AS average_multiplier
      FROM tasks
      WHERE submitted_at >= ${since}
      GROUP BY model
      ORDER BY count DESC, model
    `),
  ])

  const summary = (summaryRowsRaw as unknown as Array<Record<string, unknown>>)[0] ?? {}
  const completed = Number(summary.completed ?? 0)
  const failed = Number(summary.failed ?? 0)
  const terminal = completed + failed
  return {
    summary: {
      total: Number(summary.total ?? 0),
      completed,
      failed,
      success_rate: terminal === 0 ? 0 : completed / terminal,
      p50_duration_ms: nullableNumber(summary.p50_duration_ms),
      p95_duration_ms: nullableNumber(summary.p95_duration_ms),
      upstream_invocations: Number(summary.upstream_invocations ?? 0),
    },
    volume,
    failures: (failureRowsRaw as unknown as Array<Record<string, unknown>>).map((row) => ({
      error_type: String(row.error_type),
      count: Number(row.count),
    })),
    models: (modelRowsRaw as unknown as Array<Record<string, unknown>>).map((row) => ({
      model: String(row.model),
      count: Number(row.count),
      upstream_invocations: Number(row.upstream_invocations),
      average_multiplier: nullableNumber(row.average_multiplier),
    })),
  }
}

export async function getUserDetail(
  userId: string,
  range: Range,
  statusFilter: string,
  cursor?: string,
): Promise<UserDetailResult | null> {
  const { db, schema } = getHandle()
  const since = Date.now() - rangeMs(range)
  const cursorValue = decodeCursor(cursor)
  const keyset = cursorValue
    ? sql`AND (submitted_at < ${new Date(cursorValue.ts)}
        OR (submitted_at = ${new Date(cursorValue.ts)} AND id < ${cursorValue.id}))`
    : sql``
  const statusCondition =
    statusFilter && statusFilter !== 'all' ? sql`AND status = ${statusFilter}` : sql``

  const volumePromise = cursor ? Promise.resolve(null) : getTaskVolume(range, userId)

  let userRow: Record<string, unknown> | undefined
  let taskRows: Array<Record<string, unknown>>
  if (cursor) {
    taskRows = (await db
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
        upstream_invocation_count: schema.tasks.upstream_invocation_count,
      })
      .from(schema.tasks)
      .where(sql`user_id = ${userId}
        AND submitted_at >= ${new Date(since)}
        ${statusCondition}
        ${keyset}`)
      .orderBy(sql`submitted_at DESC, id DESC`)
      .limit(PAGE_SIZE + 1)) as unknown as Array<Record<string, unknown>>
  } else {
    const detailRowsPromise = db.execute(sql`
      WITH task_stats AS (
        SELECT COUNT(*) AS task_count, MAX(t.submitted_at) AS last_task_at
        FROM tasks t
        WHERE t.user_id = ${userId}
      ),
      task_page AS (
        SELECT
          t.id,
          t.provider,
          t.model,
          t.status,
          t.submitted_at,
          t.started_at,
          t.completed_at,
          t.error_type,
          t.request_payload,
          t.attempt_count,
          t.upstream_invocation_count
        FROM tasks t
        WHERE t.user_id = ${userId}
          AND t.submitted_at >= ${new Date(since)}
          ${statusCondition}
        ORDER BY t.submitted_at DESC, t.id DESC
        LIMIT ${PAGE_SIZE + 1}
      )
      SELECT
        ${ADMIN_USER_PROJECTION},
        p.id AS task_id,
        p.provider AS task_provider,
        p.model AS task_model,
        p.status AS task_status,
        p.submitted_at AS task_submitted_at,
        p.started_at AS task_started_at,
        p.completed_at AS task_completed_at,
        p.error_type AS task_error_type,
        p.request_payload AS task_request_payload,
        p.attempt_count AS task_attempt_count,
        p.upstream_invocation_count AS task_upstream_invocation_count
      FROM users u
      CROSS JOIN task_stats
      ${ACTIVE_SESSION_JOIN}
      LEFT JOIN task_page p ON TRUE
      WHERE u.id = ${userId}
      ORDER BY p.submitted_at DESC NULLS LAST, p.id DESC NULLS LAST
    `)
    const [detailRowsRaw] = await Promise.all([detailRowsPromise, volumePromise])
    const detailRows = detailRowsRaw as unknown as Array<Record<string, unknown>>
    userRow = detailRows[0]
    if (!userRow) return null
    taskRows = detailRows
      .filter((row) => row.task_id !== null && row.task_id !== undefined)
      .map((row) => ({
        id: row.task_id,
        provider: row.task_provider,
        model: row.task_model,
        status: row.task_status,
        submitted_at: row.task_submitted_at,
        started_at: row.task_started_at,
        completed_at: row.task_completed_at,
        error_type: row.task_error_type,
        request_payload: row.task_request_payload,
        attempt_count: row.task_attempt_count,
        upstream_invocation_count: row.task_upstream_invocation_count,
      }))
  }

  const volume = await volumePromise
  const hasMore = taskRows.length > PAGE_SIZE
  const pageRows = taskRows.slice(0, PAGE_SIZE)
  const tasks = pageRows.map((row) => ({
    id: String(row.id),
    provider: String(row.provider),
    model: String(row.model),
    status: String(row.status),
    submitted_at: toEpochMs(row.submitted_at),
    started_at: nullableEpochMs(row.started_at),
    completed_at: nullableEpochMs(row.completed_at),
    error_type: row.error_type === null ? null : String(row.error_type),
    prompt: extractPrompt(row.request_payload),
    upstream_invocation_count: Number(row.upstream_invocation_count),
    attempt_count: Number(row.attempt_count),
  }))
  const last = tasks[tasks.length - 1]
  return {
    user: userRow ? mapAdminUser(userRow) : null,
    tasks,
    nextCursor: hasMore && last ? encodeCursor(last.submitted_at, last.id) : null,
    volume,
  }
}

export async function getDeviceDetail(
  deviceId: string,
  range: Range,
  cursor?: string,
): Promise<DeviceDetailResult> {
  const { db, schema } = getHandle()
  const since = Date.now() - rangeMs(range)
  const today = todayDate()
  const c = decodeCursor(cursor)

  // keyset 分页：按 (submitted_at DESC, id DESC) 稳定排序。cursor 存在时取严格小于游标的下一页。
  const keyset = c
    ? sql`AND (submitted_at < ${new Date(c.ts)} OR (submitted_at = ${new Date(c.ts)} AND id < ${c.id}))`
    : sql``

  // 设备聚合卡片仅首页查；翻页时跳过，省一次全量聚合扫描。
  const devicePromise: Promise<Array<Record<string, unknown>>> = c
    ? Promise.resolve([])
    : (db.execute(sql`
        SELECT
          t.device_id AS device_id,
          MIN(t.submitted_at) AS first_seen,
          MAX(t.submitted_at) AS last_seen,
          COUNT(*) AS total,
          SUM(CASE WHEN t.status='completed' THEN 1 ELSE 0 END) AS ok_count,
          SUM(CASE WHEN t.status='failed' THEN 1 ELSE 0 END) AS fail_count,
          ARRAY_AGG(DISTINCT t.model) AS models,
          COALESCE(q.count, 0) AS today_count
        FROM tasks t
        LEFT JOIN daily_quota q ON q.device_id = t.device_id AND q.date = ${today}
        WHERE t.device_id = ${deviceId} AND t.submitted_at >= ${new Date(since)}
        GROUP BY t.device_id, q.count
      `) as unknown as Promise<Array<Record<string, unknown>>>)

  // Select only list fields. request_payload is read to derive prompt/n and is discarded before
  // the response; result_payload is never selected.
  const tasksPromise = db
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
      upstream_invocation_count: schema.tasks.upstream_invocation_count,
    })
    .from(schema.tasks)
    .where(sql`device_id = ${deviceId} AND submitted_at >= ${new Date(since)} ${keyset}`)
    .orderBy(sql`submitted_at DESC, id DESC`)
    .limit(PAGE_SIZE + 1)

  const [deviceRowsRaw, taskRowsRaw] = await Promise.all([devicePromise, tasksPromise])

  const drow = deviceRowsRaw[0]
  const device: DeviceRow | null = drow
    ? {
        device_id: String(drow.device_id),
        first_seen: toEpochMs(drow.first_seen),
        last_seen: toEpochMs(drow.last_seen),
        total: Number(drow.total),
        ok_count: Number(drow.ok_count),
        fail_count: Number(drow.fail_count),
        models: Array.isArray(drow.models) ? drow.models.map(String) : [],
        today_count: Number(drow.today_count),
      }
    : null

  const hasMore = taskRowsRaw.length > PAGE_SIZE
  const pageRows = taskRowsRaw.slice(0, PAGE_SIZE)
  const tasks: TaskListItem[] = pageRows.map((r) => ({
    id: r.id,
    provider: r.provider,
    model: r.model,
    status: r.status,
    submitted_at: r.submitted_at,
    started_at: r.started_at,
    completed_at: r.completed_at,
    error_type: r.error_type,
    prompt: extractPrompt(r.request_payload),
    upstream_invocation_count: Number(r.upstream_invocation_count),
    attempt_count: r.attempt_count,
  }))
  const last = pageRows[pageRows.length - 1]
  const nextCursor = hasMore && last ? encodeCursor(last.submitted_at, last.id) : null

  return { device, tasks, nextCursor }
}

export async function getTask(taskId: string): Promise<TaskDetail | null> {
  const { db, schema } = getHandle()
  const rows = await db.select().from(schema.tasks).where(eq(schema.tasks.id, taskId)).limit(1)
  const task = rows[0]
  if (!task) return null

  // 最小实现：从原始 result_payload 抽 image meta（index + mime），不解 base64
  const images = extractImagesMeta(task.provider, task.result_payload)

  const { result_payload: _result_payload, ...rest } = task as unknown as Record<string, unknown>
  void _result_payload
  const request_payload = (rest as Record<string, unknown>).request_payload
  const rawDevice = task.device_id
  const device_id =
    rawDevice === null || rawDevice === undefined || rawDevice === '' ? null : String(rawDevice)
  return {
    ...(rest as unknown as Omit<TaskListItem, 'prompt' | 'upstream_invocation_count'>),
    prompt: extractPrompt(request_payload),
    upstream_invocation_count: Number(task.upstream_invocation_count),
    request_payload,
    user_id: task.user_id,
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
