import { OAUTH_ONLY_PASSWORD_HASH } from '@image-playground/db'
import { TASK_STATUSES } from '@image-playground/shared'

import type {
  AdminUserRow,
  DeviceDetailResult,
  DeviceRow,
  ListAuditsResult,
  ListDevicesResult,
  ListUsersResult,
  OperatorAuditRow,
  OverviewPulseBucket,
  OverviewPulseWindow,
  OverviewResult,
  Range,
  SortKey,
  TaskDetail,
  TaskListItem,
  TaskStatus,
  TaskVolumeBucket,
  UserDetailResult,
  UserTasksResult,
  VolumeBucketUnit,
} from '../../contracts'

export type { Range, SortKey } from '../../contracts'

import { and, eq, sql } from 'drizzle-orm'
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
function taskStatus(value: unknown): TaskStatus {
  if (typeof value === 'string' && (TASK_STATUSES as readonly string[]).includes(value)) {
    return value as TaskStatus
  }
  throw new Error(`Unknown task status: ${String(value)}`)
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
    FROM queue_tasks t
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
    note: typeof row.note === 'string' ? row.note : null,
    status: row.status === 'disabled' ? 'disabled' : 'active',
    created_at: toEpochMs(row.created_at),
    updated_at: toEpochMs(row.updated_at),
    last_login_at: nullableEpochMs(row.last_login_at),
    login_methods: Array.isArray(row.login_methods) ? row.login_methods.map(String) : [],
    last_task_at: nullableEpochMs(row.last_task_at),
    last_activity_at: nullableEpochMs(row.last_activity_at),
    active_sessions: Number(row.active_sessions),
    task_count: Number(row.task_count),
  }
}
const ADMIN_USER_PROJECTION = sql`
  u.id,
  u.username,
  n.note,
  u.status,
  u.created_at,
  u.updated_at,
  u.last_login_at,
  ARRAY(
    SELECT method
    FROM (
      SELECT 'password'::text AS method, 0 AS sort
      WHERE u.password_hash <> ${OAUTH_ONLY_PASSWORD_HASH}
      UNION
      SELECT i.provider AS method, 1 AS sort
      FROM user_identities i
      WHERE i.user_id = u.id
    ) methods
    ORDER BY sort, method
  ) AS login_methods,
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
    LEFT JOIN admin_user_notes n ON n.user_id = u.id
    ${ACTIVE_SESSION_JOIN}
    LEFT JOIN LATERAL (
      SELECT COUNT(*) AS task_count, MAX(t.submitted_at) AS last_task_at
      FROM queue_tasks t
      WHERE t.user_id = u.id
    ) task_stats ON TRUE
    WHERE ${term} = ''
       OR POSITION(${term} IN LOWER(u.username)) > 0
       OR POSITION(${term} IN LOWER(u.id)) > 0
       OR POSITION(${term} IN LOWER(n.note)) > 0
    ORDER BY last_activity_at DESC NULLS LAST, u.created_at DESC, u.id DESC
    LIMIT ${USER_LIST_LIMIT + 1}
  `)
  const kpiRowsPromise = db.execute(sql`
    WITH user_activity AS (
      SELECT u.id, GREATEST(u.last_login_at, MAX(t.submitted_at)) AS last_activity_at
      FROM users u
      LEFT JOIN queue_tasks t ON t.user_id = u.id
      GROUP BY u.id
    ),
    recent_tasks AS (
      SELECT
        COUNT(*) AS submissions,
        COUNT(*) FILTER (WHERE status = 'failed') AS failures
      FROM queue_tasks
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

export function volumeBucketUnit(range: Range): VolumeBucketUnit {
  return range === '1d' ? 'hour' : 'day'
}

/**
 * 趋势图的分桶：1 天按小时 24 格，其余按天，最后一格是 `at` 所在的那个小时或那一天。
 * 同一次请求的所有查询传同一个 `at`：各自取 NOW() 的话，跨整点或午夜时会错开一格。
 */
function volumeBuckets(range: Range, at: Date) {
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

async function getTaskVolume(
  range: Range,
  userId?: string,
  at: Date = new Date(),
): Promise<TaskVolumeBucket[]> {
  const { db } = getHandle()
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
  return (rows as unknown as Array<Record<string, unknown>>).map((row) => ({
    bucket_at: Number(row.bucket_at),
    total: Number(row.total),
    completed: Number(row.completed),
    failed: Number(row.failed),
  }))
}

type Row = Record<string, unknown>

const EMPTY_PULSE_BUCKET: Omit<OverviewPulseBucket, 'bucket_at'> = {
  tasks: 0,
  images: 0,
  active: 0,
  signups: 0,
  agent_completed: 0,
  agent_failed: 0,
  agent_aborted: 0,
}

/**
 * 概览的环比与走势。当前窗与上一个同长度窗口各数一遍；走势与任务量图同一套分桶。
 * 「活跃」把账号与匿名设备一起数：两类入口都在用，只数账号会把匿名用量整块漏掉。
 */
async function getPulse(
  range: Range,
  bucketAts: readonly number[],
  at: Date,
): Promise<OverviewResult['pulse']> {
  const { db } = getHandle()
  const now = at.getTime()
  const current = new Date(now - rangeMs(range))
  const previous = new Date(now - 2 * rangeMs(range))
  const { unit, start } = volumeBuckets(range, at)
  // 走势的首格可能早于当前窗起点（按整点或整天对齐），取数下界取两者更早的那个。
  const floor = sql`LEAST(${previous}::timestamptz, ${start})`
  // 视频任务也走这个队列，不算出图。
  const images = sql`CASE WHEN request_payload->'video' IS NULL
    THEN GREATEST(COALESCE((request_payload->>'n')::integer, 1), 1) ELSE 0 END`
  const actors = sql`
    SELECT submitted_at AS at, COALESCE(user_id, device_id) AS actor
    FROM queue_tasks
    WHERE submitted_at >= ${floor}
    UNION ALL
    SELECT t.created_at, COALESCE(c.user_id, c.device_id)
    FROM agent_turns t
    JOIN agent_conversations c ON c.id = t.conversation_id
    WHERE t.created_at >= ${floor}
  `

  const [taskRows, actorRows, signupRows, agentRows, seriesRows] = await Promise.all([
    db.execute(sql`
      SELECT
        COUNT(*) FILTER (WHERE submitted_at >= ${current}) AS tasks_cur,
        COUNT(*) FILTER (WHERE submitted_at < ${current}) AS tasks_prev,
        COUNT(*) FILTER (WHERE status = 'completed' AND submitted_at >= ${current}) AS completed_cur,
        COUNT(*) FILTER (WHERE status = 'completed' AND submitted_at < ${current}) AS completed_prev,
        COUNT(*) FILTER (WHERE status = 'failed' AND submitted_at >= ${current}) AS failed_cur,
        COUNT(*) FILTER (WHERE status = 'failed' AND submitted_at < ${current}) AS failed_prev,
        COALESCE(SUM(${images}) FILTER (WHERE status = 'completed' AND submitted_at >= ${current}), 0) AS images_cur,
        COALESCE(SUM(${images}) FILTER (WHERE status = 'completed' AND submitted_at < ${current}), 0) AS images_prev
      FROM queue_tasks
      WHERE submitted_at >= ${previous}
    `),
    db.execute(sql`
      SELECT
        COUNT(DISTINCT actor) FILTER (WHERE at >= ${current}) AS active_cur,
        COUNT(DISTINCT actor) FILTER (WHERE at >= ${previous} AND at < ${current}) AS active_prev
      FROM (${actors}) a
      WHERE actor IS NOT NULL
    `),
    db.execute(sql`
      SELECT
        COUNT(*) FILTER (WHERE created_at >= ${current}) AS signups_cur,
        COUNT(*) FILTER (WHERE created_at < ${current}) AS signups_prev
      FROM users
      WHERE created_at >= ${previous}
    `),
    db.execute(sql`
      SELECT
        COUNT(*) FILTER (WHERE created_at >= ${current}) AS turns_cur,
        COUNT(*) FILTER (WHERE created_at < ${current}) AS turns_prev,
        COUNT(*) FILTER (WHERE stop_reason = 'failed' AND created_at >= ${current}) AS failed_cur,
        COUNT(*) FILTER (WHERE stop_reason = 'failed' AND created_at < ${current}) AS failed_prev,
        COUNT(*) FILTER (WHERE stop_reason = 'aborted' AND created_at >= ${current}) AS aborted_cur,
        COUNT(*) FILTER (WHERE stop_reason = 'aborted' AND created_at < ${current}) AS aborted_prev
      FROM agent_turns
      WHERE created_at >= ${previous}
    `),
    db.execute(sql`
      WITH
        tasks_by AS (
          SELECT DATE_TRUNC(${unit}, submitted_at) AS bucket,
                 COUNT(*) AS tasks,
                 COALESCE(SUM(${images}) FILTER (WHERE status = 'completed'), 0) AS images
          FROM queue_tasks WHERE submitted_at >= ${start} GROUP BY 1
        ),
        actors_by AS (
          SELECT DATE_TRUNC(${unit}, at) AS bucket, COUNT(DISTINCT actor) AS active
          FROM (${actors}) a WHERE actor IS NOT NULL AND at >= ${start} GROUP BY 1
        ),
        signups_by AS (
          SELECT DATE_TRUNC(${unit}, created_at) AS bucket, COUNT(*) AS signups
          FROM users WHERE created_at >= ${start} GROUP BY 1
        ),
        agent_by AS (
          SELECT DATE_TRUNC(${unit}, created_at) AS bucket,
                 COUNT(*) FILTER (WHERE stop_reason = 'completed') AS agent_completed,
                 COUNT(*) FILTER (WHERE stop_reason = 'failed') AS agent_failed,
                 COUNT(*) FILTER (WHERE stop_reason = 'aborted') AS agent_aborted
          FROM agent_turns WHERE created_at >= ${start} GROUP BY 1
        ),
        keys AS (
          SELECT bucket FROM tasks_by UNION SELECT bucket FROM actors_by
          UNION SELECT bucket FROM signups_by UNION SELECT bucket FROM agent_by
        )
      SELECT
        EXTRACT(EPOCH FROM k.bucket) * 1000 AS bucket_at,
        COALESCE(t.tasks, 0) AS tasks,
        COALESCE(t.images, 0) AS images,
        COALESCE(a.active, 0) AS active,
        COALESCE(s.signups, 0) AS signups,
        COALESCE(g.agent_completed, 0) AS agent_completed,
        COALESCE(g.agent_failed, 0) AS agent_failed,
        COALESCE(g.agent_aborted, 0) AS agent_aborted
      FROM keys k
      LEFT JOIN tasks_by t ON t.bucket = k.bucket
      LEFT JOIN actors_by a ON a.bucket = k.bucket
      LEFT JOIN signups_by s ON s.bucket = k.bucket
      LEFT JOIN agent_by g ON g.bucket = k.bucket
    `),
  ])

  const t = (taskRows as unknown as Row[])[0] ?? {}
  const a = (actorRows as unknown as Row[])[0] ?? {}
  const u = (signupRows as unknown as Row[])[0] ?? {}
  const g = (agentRows as unknown as Row[])[0] ?? {}
  const window = (suffix: 'cur' | 'prev'): OverviewPulseWindow => ({
    tasks: Number(t[`tasks_${suffix}`] ?? 0),
    completed: Number(t[`completed_${suffix}`] ?? 0),
    failed: Number(t[`failed_${suffix}`] ?? 0),
    images: Number(t[`images_${suffix}`] ?? 0),
    active: Number(a[`active_${suffix}`] ?? 0),
    signups: Number(u[`signups_${suffix}`] ?? 0),
    agent_turns: Number(g[`turns_${suffix}`] ?? 0),
    agent_failed: Number(g[`failed_${suffix}`] ?? 0),
    agent_aborted: Number(g[`aborted_${suffix}`] ?? 0),
  })
  const byBucket = new Map(
    (seriesRows as unknown as Row[]).map((row) => [
      Number(row.bucket_at),
      {
        tasks: Number(row.tasks),
        images: Number(row.images),
        active: Number(row.active),
        signups: Number(row.signups),
        agent_completed: Number(row.agent_completed),
        agent_failed: Number(row.agent_failed),
        agent_aborted: Number(row.agent_aborted),
      },
    ]),
  )
  return {
    current: window('cur'),
    previous: window('prev'),
    series: bucketAts.map((bucket_at) => ({
      bucket_at,
      ...(byBucket.get(bucket_at) ?? EMPTY_PULSE_BUCKET),
    })),
  }
}

export async function getOverview(range: Range): Promise<OverviewResult> {
  const { db } = getHandle()
  // 整个请求只取一次「现在」：窗口、上期与分桶都从它算，彼此对得上。
  const at = new Date()
  const since = new Date(at.getTime() - rangeMs(range))
  const previousSince = new Date(at.getTime() - 2 * rangeMs(range))

  const [summaryRowsRaw, volume, failureRowsRaw, modelRowsRaw, cacheRowsRaw, phaseRowsRaw] =
    await Promise.all([
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
        COALESCE(SUM(upstream_invocation_count), 0) AS upstream_invocations,
        PERCENTILE_DISC(0.5) WITHIN GROUP (
          ORDER BY EXTRACT(EPOCH FROM (started_at - submitted_at)) * 1000
        ) FILTER (WHERE started_at IS NOT NULL) AS queue_p50_ms
      FROM queue_tasks
      WHERE submitted_at >= ${since}
    `),
      getTaskVolume(range, undefined, at),
      db.execute(sql`
      SELECT
        COALESCE(error_type, 'unknown') AS error_type,
        COUNT(*) FILTER (WHERE submitted_at >= ${since}) AS count,
        COUNT(*) FILTER (WHERE submitted_at < ${since}) AS previous_count
      FROM queue_tasks
      WHERE submitted_at >= ${previousSince} AND status = 'failed'
      GROUP BY COALESCE(error_type, 'unknown')
      HAVING COUNT(*) FILTER (WHERE submitted_at >= ${since}) > 0
      ORDER BY count DESC, error_type
    `),
      db.execute(sql`
      SELECT
        model,
        COUNT(*) AS count,
        COALESCE(SUM(upstream_invocation_count), 0) AS upstream_invocations,
        AVG(
          upstream_invocation_count::double precision
            / GREATEST(COALESCE((request_payload->>'n')::integer, 1), 1)
        ) FILTER (WHERE status IN ('completed', 'failed', 'cancelled')) AS average_multiplier,
        COUNT(*) FILTER (WHERE status = 'completed') AS completed,
        COUNT(*) FILTER (WHERE status = 'failed') AS failed,
        PERCENTILE_DISC(0.5) WITHIN GROUP (
          ORDER BY EXTRACT(EPOCH FROM (started_at - submitted_at)) * 1000
        ) FILTER (WHERE started_at IS NOT NULL) AS queue_p50_ms,
        PERCENTILE_DISC(0.95) WITHIN GROUP (
          ORDER BY EXTRACT(EPOCH FROM (completed_at - started_at)) * 1000
        ) FILTER (WHERE status = 'completed' AND started_at IS NOT NULL) AS run_p95_ms
      FROM queue_tasks
      WHERE submitted_at >= ${since}
      GROUP BY model
      ORDER BY count DESC, model
    `),
      db.execute(sql`
      SELECT
        model,
        COUNT(*) AS calls,
        SUM((usage->>'inputTokens')::bigint) AS input_tokens,
        SUM(cache_read_tokens) AS cache_read_tokens
      FROM agent_model_calls
      WHERE started_at >= ${since}
        AND purpose = 'conversation'
        AND usage IS NOT NULL
        AND cache_read_tokens IS NOT NULL
        AND (usage->>'inputTokens')::bigint > 0
      GROUP BY model
      ORDER BY input_tokens DESC, model
    `),
      // 首调按整轮排序，窗口之前的早先调用也算；未派发、本地拒绝或没报用量的尝试不占首调位。
      db.execute(sql`
      WITH ranked AS (
        SELECT
          started_at,
          (usage->>'inputTokens')::bigint AS input_tokens,
          cache_read_tokens,
          ROW_NUMBER() OVER (
            PARTITION BY conversation_id, turn_id ORDER BY started_at, id
          ) = 1 AS first_call
        FROM agent_model_calls
        WHERE purpose = 'conversation'
          AND usage IS NOT NULL
          AND (usage->>'inputTokens')::bigint > 0
          AND local_rejection IS NULL
          AND COALESCE(http_dispatch_count, 1) > 0
          AND (conversation_id, turn_id) IN (
            SELECT conversation_id, turn_id FROM agent_model_calls
            WHERE started_at >= ${since} AND purpose = 'conversation'
          )
      )
      SELECT
        first_call,
        COUNT(*) AS calls,
        SUM(input_tokens) AS input_tokens,
        SUM(cache_read_tokens) AS cache_read_tokens
      FROM ranked
      WHERE started_at >= ${since} AND cache_read_tokens IS NOT NULL
      GROUP BY first_call
    `),
    ])

  const pulse = await getPulse(
    range,
    volume.map((bucket) => bucket.bucket_at),
    at,
  )
  const summary = (summaryRowsRaw as unknown as Array<Record<string, unknown>>)[0] ?? {}
  const agentCacheModels = (cacheRowsRaw as unknown as Array<Record<string, unknown>>).map(
    (row) => ({
      model: String(row.model),
      calls: Number(row.calls),
      input_tokens: Number(row.input_tokens),
      cache_read_tokens: Number(row.cache_read_tokens),
    }),
  )
  const phaseRows = phaseRowsRaw as unknown as Array<Record<string, unknown>>
  const cachePhase = (first: boolean) => {
    const row = phaseRows.find((one) => one.first_call === first)
    return {
      calls: Number(row?.calls ?? 0),
      input_tokens: Number(row?.input_tokens ?? 0),
      cache_read_tokens: Number(row?.cache_read_tokens ?? 0),
    }
  }
  const firstCall = cachePhase(true)
  const continuation = cachePhase(false)
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
      queue_p50_ms: nullableNumber(summary.queue_p50_ms),
    },
    pulse,
    volume,
    volume_bucket: volumeBucketUnit(range),
    failures: (failureRowsRaw as unknown as Array<Record<string, unknown>>).map((row) => ({
      error_type: String(row.error_type),
      count: Number(row.count),
      previous_count: Number(row.previous_count),
    })),
    agent_cache: {
      calls: firstCall.calls + continuation.calls,
      input_tokens: firstCall.input_tokens + continuation.input_tokens,
      cache_read_tokens: firstCall.cache_read_tokens + continuation.cache_read_tokens,
      first_call: firstCall,
      continuation,
      models: agentCacheModels,
    },
    models: (modelRowsRaw as unknown as Array<Record<string, unknown>>).map((row) => ({
      model: String(row.model),
      count: Number(row.count),
      upstream_invocations: Number(row.upstream_invocations),
      average_multiplier: nullableNumber(row.average_multiplier),
      completed: Number(row.completed),
      failed: Number(row.failed),
      queue_p50_ms: nullableNumber(row.queue_p50_ms),
      run_p95_ms: nullableNumber(row.run_p95_ms),
    })),
  }
}

// 用户详情按全量历史统计；只有趋势图固定看近 30 天，不由调用方决定。
const USER_VOLUME_RANGE: Range = '30d'

const TASK_LIST_COLUMNS = sql`
  t.id,
  t.provider,
  t.model,
  t.status,
  t.submitted_at,
  t.started_at,
  t.completed_at,
  t.error_type,
  t.upstream_status,
  t.request_payload,
  t.attempt_count,
  t.upstream_invocation_count
`

function mapTaskListItem(row: Record<string, unknown>): TaskListItem {
  return {
    id: String(row.id),
    kind: row.kind === 'analysis' ? 'analysis' : 'queue',
    provider: String(row.provider),
    model: String(row.model),
    status: taskStatus(row.status),
    submitted_at: toEpochMs(row.submitted_at),
    started_at: nullableEpochMs(row.started_at),
    completed_at: nullableEpochMs(row.completed_at),
    error_type: row.error_type === null ? null : String(row.error_type),
    upstream_status: nullableNumber(row.upstream_status),
    prompt: extractPrompt(row.request_payload),
    upstream_invocation_count: Number(row.upstream_invocation_count),
    attempt_count: Number(row.attempt_count),
  }
}

// asset_bytes 必须和 BFF 校验 `sync:user-asset-bytes` 的分母一致，别改成「活素材引用到的图片」。
const SYNC_FOOTPRINT = sql`
  (SELECT COUNT(*) FROM user_templates WHERE user_id = u.id AND deleted_at IS NULL) AS template_count,
  (SELECT COUNT(*) FROM user_assets WHERE user_id = u.id AND deleted_at IS NULL) AS asset_count,
  (SELECT COALESCE(SUM(bytes), 0) FROM user_asset_objects WHERE user_id = u.id) AS asset_bytes
`

export async function getUserDetail(userId: string): Promise<UserDetailResult | null> {
  const { db } = getHandle()
  const [userRowsRaw, volume] = await Promise.all([
    db.execute(sql`
      SELECT ${ADMIN_USER_PROJECTION}, ${SYNC_FOOTPRINT}
      FROM users u
      LEFT JOIN admin_user_notes n ON n.user_id = u.id
      CROSS JOIN LATERAL (
        SELECT COUNT(*) AS task_count, MAX(t.submitted_at) AS last_task_at
        FROM queue_tasks t
        WHERE t.user_id = u.id
      ) task_stats
      ${ACTIVE_SESSION_JOIN}
      WHERE u.id = ${userId}
    `),
    getTaskVolume(USER_VOLUME_RANGE, userId),
  ])
  const userRow = (userRowsRaw as unknown as Array<Record<string, unknown>>)[0]
  if (!userRow) return null
  return {
    user: mapAdminUser(userRow),
    volume,
    volume_bucket: volumeBucketUnit(USER_VOLUME_RANGE),
    volume_range: USER_VOLUME_RANGE,
    template_count: Number(userRow.template_count),
    asset_count: Number(userRow.asset_count),
    asset_bytes: Number(userRow.asset_bytes),
  }
}

export async function getUserTasks(
  userId: string,
  statusFilter: string,
  cursor?: string,
): Promise<UserTasksResult> {
  const { db } = getHandle()
  const cursorValue = decodeCursor(cursor)
  const keyset = cursorValue
    ? sql`AND (t.submitted_at < ${new Date(cursorValue.ts)}
        OR (t.submitted_at = ${new Date(cursorValue.ts)} AND t.id < ${cursorValue.id}))`
    : sql``
  const statusCondition =
    statusFilter && statusFilter !== 'all' ? sql`AND t.status = ${statusFilter}` : sql``

  const rows = (await db.execute(sql`
    SELECT t.*
    FROM (
      SELECT ${TASK_LIST_COLUMNS}, 'queue' AS kind
      FROM queue_tasks t
      WHERE t.user_id = ${userId}
      UNION ALL
      SELECT a.task_id AS id, 'openai-compat' AS provider, a.model, a.status,
        a.created_at AS submitted_at, c.dispatched_at AS started_at, a.completed_at,
        a.error_code AS error_type, NULL::integer AS upstream_status,
        jsonb_build_object('prompt', a.input_snapshot->>'prompt') AS request_payload,
        a.attempt AS attempt_count, COALESCE(c.http_dispatch_count, 0) AS upstream_invocation_count,
        'analysis' AS kind
      FROM analysis_tasks a
      LEFT JOIN analysis_model_calls c ON c.task_id = a.task_id
      WHERE a.user_id = ${userId}
    ) t
    WHERE TRUE
      ${statusCondition}
      ${keyset}
    ORDER BY t.submitted_at DESC, t.id DESC
    LIMIT ${PAGE_SIZE + 1}
  `)) as unknown as Array<Record<string, unknown>>

  const hasMore = rows.length > PAGE_SIZE
  const tasks = rows.slice(0, PAGE_SIZE).map(mapTaskListItem)
  const last = tasks[tasks.length - 1]
  return {
    tasks,
    nextCursor: hasMore && last ? encodeCursor(last.submitted_at, last.id) : null,
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
        FROM queue_tasks t
        LEFT JOIN daily_quota q ON q.device_id = t.device_id AND q.date = ${today}
        WHERE t.device_id = ${deviceId} AND t.submitted_at >= ${new Date(since)}
        GROUP BY t.device_id, q.count
      `) as unknown as Promise<Array<Record<string, unknown>>>)

  // Select only list fields. request_payload is read to derive prompt/n and is discarded before
  // the response; result_payload is never selected.
  const tasksPromise = db
    .select({
      id: schema.queue_tasks.id,
      provider: schema.queue_tasks.provider,
      model: schema.queue_tasks.model,
      status: schema.queue_tasks.status,
      submitted_at: schema.queue_tasks.submitted_at,
      started_at: schema.queue_tasks.started_at,
      completed_at: schema.queue_tasks.completed_at,
      error_type: schema.queue_tasks.error_type,
      upstream_status: schema.queue_tasks.upstream_status,
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
    provider: r.provider,
    model: r.model,
    status: r.status,
    submitted_at: r.submitted_at,
    started_at: r.started_at,
    completed_at: r.completed_at,
    error_type: r.error_type,
    upstream_status: r.upstream_status,
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
  const rows = await db
    .select()
    .from(schema.queue_tasks)
    .where(eq(schema.queue_tasks.id, taskId))
    .limit(1)
  const task = rows[0]
  if (!task) return getAnalysisTask(taskId)

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
    result_meta: { images },
    error_message: task.error_message,
    upstream_status: task.upstream_status,
    upstream_body: task.upstream_body,
    device_id,
    next_retry_at: task.next_retry_at,
  }
}

/** Independent analysis facts outlive transient worker rows and never expose image archives. */
async function getAnalysisTask(taskId: string): Promise<TaskDetail | null> {
  const { db, schema } = getHandle()
  const [row] = await db
    .select({ analysis: schema.analysis_tasks, call: schema.analysis_model_calls })
    .from(schema.analysis_tasks)
    .leftJoin(
      schema.analysis_model_calls,
      eq(schema.analysis_model_calls.task_id, schema.analysis_tasks.task_id),
    )
    .where(eq(schema.analysis_tasks.task_id, taskId))
    .limit(1)
  if (!row) return null
  const { analysis, call } = row
  return {
    id: analysis.task_id,
    kind: 'analysis',
    provider: 'openai-compat',
    model: analysis.model,
    status: analysis.status,
    submitted_at: analysis.created_at,
    started_at: call?.dispatched_at ?? null,
    completed_at: analysis.completed_at,
    error_type: analysis.error_code,
    upstream_status: null,
    prompt: analysis.input_snapshot.prompt,
    request_payload: { prompt: analysis.input_snapshot.prompt },
    upstream_invocation_count: call?.http_dispatch_count ?? 0,
    attempt_count: analysis.attempt,
    result_meta: { images: [] },
    error_message: analysis.error_code,
    upstream_body: null,
    device_id: analysis.device_id,
    user_id: analysis.user_id,
    next_retry_at: null,
    analysis: {
      pricing: analysis.price_snapshot,
      reservedCredits: analysis.reserved_credits,
      actualCredits: analysis.actual_credits,
      findings: analysis.findings,
      coverage: analysis.coverage,
      evidence: analysis.evidence,
      usage: call?.usage ?? null,
      upstreamRequestId: call?.upstream_request_id ?? null,
      localRejection: call?.local_rejection ?? null,
    },
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

// 审计列表一页多少条。一行就是一句话（谁、什么时候、对谁做了什么），比任务列表轻得多，
// 所以默认页大一点；上限压在 100，别让一个 limit=100000 把整张表拉出来。
const AUDIT_PAGE_SIZE = 50
const AUDIT_PAGE_MAX = 100

export interface ListOperatorAuditsOptions {
  cursor?: string
  limit?: number
  action?: string
  targetId?: string
}

/**
 * 运营审计流，从新到旧。分页按 (created_at, id) 做 keyset：同一毫秒里写进去好几条时
 * OFFSET 会漏行，而 `idx_operator_audits_created_at` 正好给这个排序兜底。
 */
export async function listOperatorAudits(
  options: ListOperatorAuditsOptions,
): Promise<ListAuditsResult> {
  const { db } = getHandle()
  const requested = Math.trunc(options.limit ?? AUDIT_PAGE_SIZE)
  const limit = Number.isFinite(requested)
    ? Math.min(Math.max(requested, 1), AUDIT_PAGE_MAX)
    : AUDIT_PAGE_SIZE
  const cursorValue = decodeCursor(options.cursor)
  const keyset = cursorValue
    ? sql`AND (a.created_at < ${new Date(cursorValue.ts)}
        OR (a.created_at = ${new Date(cursorValue.ts)} AND a.id < ${cursorValue.id}))`
    : sql``
  const actionFilter = options.action ? sql`AND a.action = ${options.action}` : sql``
  const targetFilter = options.targetId ? sql`AND a.target_id = ${options.targetId}` : sql``

  const rows = (await db.execute(sql`
    SELECT a.id, a.operator_id, a.action, a.target_type, a.target_id, a.details, a.created_at
    FROM operator_audits a
    WHERE TRUE
      ${actionFilter}
      ${targetFilter}
      ${keyset}
    ORDER BY a.created_at DESC, a.id DESC
    LIMIT ${limit + 1}
  `)) as unknown as Array<Record<string, unknown>>

  const hasMore = rows.length > limit
  const audits = rows.slice(0, limit).map(
    (row): OperatorAuditRow => ({
      id: String(row.id),
      operator_id: String(row.operator_id),
      action: String(row.action),
      target_type: String(row.target_type),
      target_id: String(row.target_id),
      // bun:sql 直接把 jsonb 还成对象；老行可能压根没写 details。
      details:
        row.details && typeof row.details === 'object'
          ? (row.details as Record<string, unknown>)
          : {},
      created_at: toEpochMs(row.created_at),
    }),
  )
  const last = audits[audits.length - 1]
  return {
    audits,
    nextCursor: hasMore && last ? encodeCursor(last.created_at, last.id) : null,
  }
}
