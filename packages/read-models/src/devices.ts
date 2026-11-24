import { sql } from 'drizzle-orm'
import {
  decodeCursor,
  encodeCursor,
  extractTaskPrompt,
  ilikeContains,
  type ReadModelsDbHandle,
  type Row,
  rangeMs,
  taskSourceSql,
  todayDate,
  toEpochMs,
} from './sql-helpers'
import type {
  DeviceDetailResult,
  DeviceListOptions,
  DeviceRow,
  ListDevicesResult,
  Range,
  SortKey,
  TaskListItem,
} from './types'

const PAGE_SIZE = 100

export async function listDevices(
  handle: ReadModelsDbHandle,
  range: Range,
  sort: SortKey,
  options: DeviceListOptions = {},
): Promise<ListDevicesResult> {
  const { db } = handle
  const pageSize = options.pageSize === 100 ? 100 : 50
  const page = Math.min(Math.max(options.page ?? 1, 1), 10_000)
  const offset = (page - 1) * pageSize
  const since = options.from !== undefined ? options.from : Date.now() - rangeMs(range)
  const until =
    options.to !== undefined ? sql`AND t.submitted_at <= ${new Date(options.to)}` : sql``
  const q = options.q?.trim() ?? ''
  const deviceFilter = q
    ? sql`AND (t.device_id = ${q} OR t.device_id ILIKE ${ilikeContains(q)} ESCAPE '\\')`
    : sql``
  const today = todayDate()
  const orderBy =
    sort === 'last_seen'
      ? sql`MAX(submitted_at) DESC`
      : sort === 'total_count'
        ? sql`COUNT(*) DESC`
        : sql`today_count DESC`

  // One aggregate query avoids N+1. PostgreSQL returns distinct models as a native array.
  // device_id 等值走 idx_tasks_admin_device_time；子串 ILIKE 留在 submitted_at 窗口内。
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
    FROM queue_tasks t
    LEFT JOIN daily_quota q ON q.device_id = t.device_id AND q.date = ${today}
    WHERE t.submitted_at >= ${new Date(since)} AND t.device_id IS NOT NULL
      ${until}
      ${deviceFilter}
    GROUP BY t.device_id, q.count
    ORDER BY ${orderBy}
    LIMIT ${pageSize} OFFSET ${offset}
  `)) as unknown as Row[]
  const countRows = (await db.execute(sql`
    SELECT COUNT(*)::int AS total FROM (
      SELECT t.device_id
      FROM queue_tasks t
      WHERE t.submitted_at >= ${new Date(since)} AND t.device_id IS NOT NULL
        ${until}
        ${deviceFilter}
      GROUP BY t.device_id
    ) devices
  `)) as unknown as Row[]

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
  const total = Number(countRows[0]?.total ?? 0)
  return {
    devices: list,
    total,
    page,
    pageSize,
    truncated: offset + list.length < total,
  }
}

export async function getDeviceDetail(
  handle: ReadModelsDbHandle,
  deviceId: string,
  range: Range,
  cursor?: string,
): Promise<DeviceDetailResult> {
  const { db, schema } = handle
  const since = Date.now() - rangeMs(range)
  const today = todayDate()
  const c = decodeCursor(cursor)

  // keyset 分页：按 (submitted_at DESC, id DESC) 稳定排序。cursor 存在时取严格小于游标的下一页。
  const keyset = c
    ? sql`AND (submitted_at < ${new Date(c.ts)} OR (submitted_at = ${new Date(c.ts)} AND id < ${c.id}))`
    : sql``

  // 设备聚合卡片仅首页查；翻页时跳过，省一次全量聚合扫描。
  const devicePromise: Promise<Row[]> = c
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
        FROM queue_tasks t
        LEFT JOIN daily_quota q ON q.device_id = t.device_id AND q.date = ${today}
        WHERE t.device_id = ${deviceId} AND t.submitted_at >= ${new Date(since)}
        GROUP BY t.device_id, q.count
      `) as unknown as Promise<Row[]>)

  // Select only list fields. request_payload is read to derive prompt/n and is discarded before
  // the response; result_payload is never selected.
  const tasksPromise = db
    .select({
      id: schema.queue_tasks.id,
      agent_conversation_id: schema.queue_tasks.agent_conversation_id,
      source: taskSourceSql(schema.queue_tasks.id, schema.queue_tasks.agent_conversation_id),
      provider: schema.queue_tasks.provider,
      model: schema.queue_tasks.model,
      status: schema.queue_tasks.status,
      submitted_at: schema.queue_tasks.submitted_at,
      started_at: schema.queue_tasks.started_at,
      completed_at: schema.queue_tasks.completed_at,
      error_type: schema.queue_tasks.error_type,
      upstream_status: schema.queue_tasks.upstream_status,
      gpt_route: schema.queue_tasks.gpt_route,
      gpt_key_fingerprint: schema.queue_tasks.gpt_key_fingerprint,
      request_payload: schema.queue_tasks.request_payload,
      attempt_count: schema.queue_tasks.attempt_count,
      upstream_invocation_count: schema.queue_tasks.upstream_invocation_count,
    })
    .from(schema.queue_tasks)
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
    source: r.source,
    provider: r.provider,
    model: r.model,
    status: r.status,
    submitted_at: r.submitted_at,
    started_at: r.started_at,
    completed_at: r.completed_at,
    error_type: r.error_type,
    upstream_status: r.upstream_status,
    gpt_route: r.gpt_route,
    gpt_key_fingerprint: r.gpt_key_fingerprint,
    prompt: extractTaskPrompt(r.request_payload),
    upstream_invocation_count: Number(r.upstream_invocation_count),
    attempt_count: r.attempt_count,
  }))
  const last = pageRows[pageRows.length - 1]
  const nextCursor = hasMore && last ? encodeCursor(last.submitted_at, last.id) : null

  return { device, tasks, nextCursor }
}
