import { sql } from 'drizzle-orm'
import {
  type ErrorRecoveryState,
  type ErrorWindow,
  type GenerationActor,
  type GenerationTaskFilters,
  type GenerationTasksResult,
  type TimeWindow,
  type TodayErrorItem,
  type TodayErrorsResult,
  type TodayModelFailure,
  type TodayModelStat,
  type TodayOverviewResult,
  todayWindow,
} from '../../contracts'
import { getDbHandle } from './db'
import { errorRecoveryJoins } from './error-recovery'
import { mapTaskListItem } from './queries'
import { effectiveLogLevel } from './server-logs'

type Row = Record<string, unknown>
const epoch = (value: unknown) =>
  value instanceof Date ? value.getTime() : Date.parse(String(value))
const nullableText = (value: unknown) => (value == null ? null : String(value))
const ACTOR_LIMIT = 500
const PAGE_SIZE = 100

function modelFailures(rows: Row[]): Map<string, TodayModelFailure[]> {
  const grouped = new Map<string, TodayModelFailure[]>()
  for (const row of rows) {
    const model = String(row.model)
    const failures = grouped.get(model) ?? []
    failures.push({ error_type: String(row.error_type), count: Number(row.count) })
    grouped.set(model, failures)
  }
  for (const failures of grouped.values()) {
    failures.sort((left, right) => {
      if (right.count !== left.count) return right.count - left.count
      if (left.error_type < right.error_type) return -1
      if (left.error_type > right.error_type) return 1
      return 0
    })
  }
  return grouped
}

export async function getTodayOverview(now = Date.now()): Promise<TodayOverviewResult> {
  const window = todayWindow(now)
  const from = new Date(window.from)
  const to = new Date(window.to)
  const [actorRows, modelRows, failureRows] = await Promise.all([
    getDbHandle().db.execute(sql`
    WITH actors AS (
      SELECT CASE WHEN t.user_id IS NOT NULL THEN 'user'
        WHEN t.device_id IS NOT NULL THEN 'device' ELSE 'unassigned' END AS kind,
        COALESCE(t.user_id, t.device_id) AS actor_id,
        COUNT(*) AS tasks,
        COUNT(*) FILTER (WHERE status = 'completed') AS completed,
        COUNT(*) FILTER (WHERE status = 'failed') AS failed,
        COUNT(*) FILTER (WHERE status = 'in_progress') AS in_progress,
        COUNT(*) FILTER (WHERE status = 'queued') AS queued,
        COUNT(*) FILTER (WHERE status = 'reconciling') AS reconciling,
        MAX(submitted_at) AS last_submitted_at
      FROM queue_tasks t
      WHERE submitted_at >= ${from} AND submitted_at <= ${to}
      GROUP BY 1, 2
    )
    SELECT a.*, u.username, n.note, COUNT(*) OVER() AS actor_count,
      COUNT(*) FILTER (WHERE a.kind = 'user') OVER() AS users,
      COUNT(*) FILTER (WHERE a.kind = 'device') OVER() AS devices,
      SUM(a.tasks) OVER() AS total_tasks, SUM(a.completed) OVER() AS total_completed,
      SUM(a.failed) OVER() AS total_failed, SUM(a.in_progress) OVER() AS total_in_progress,
      SUM(a.queued) OVER() AS total_queued, SUM(a.reconciling) OVER() AS total_reconciling
    FROM actors a
    LEFT JOIN users u ON a.kind = 'user' AND u.id = a.actor_id
    LEFT JOIN admin_user_notes n ON n.user_id = u.id
    ORDER BY a.last_submitted_at DESC, a.kind, a.actor_id
    LIMIT ${ACTOR_LIMIT}
  `),
    getDbHandle().db.execute(sql`
      SELECT model,
        COUNT(*) AS tasks,
        COUNT(*) FILTER (WHERE status = 'completed') AS completed,
        COUNT(*) FILTER (WHERE status = 'failed') AS failed,
        COALESCE(SUM(upstream_invocation_count), 0) AS upstream_invocations
      FROM queue_tasks
      WHERE submitted_at >= ${from} AND submitted_at <= ${to}
      GROUP BY model
      ORDER BY COUNT(*) DESC, model
    `),
    getDbHandle().db.execute(sql`
      SELECT model,
        COALESCE(error_type, 'unknown') AS error_type,
        COUNT(*) AS count
      FROM queue_tasks
      WHERE submitted_at >= ${from} AND submitted_at <= ${to}
        AND status = 'failed'
      GROUP BY model, COALESCE(error_type, 'unknown')
    `),
  ])
  const rows = actorRows as unknown as Row[]
  const totals = rows[0] ?? {}
  const failuresByModel = modelFailures(failureRows as unknown as Row[])
  return {
    window,
    models: (modelRows as unknown as Row[]).map(
      (row): TodayModelStat => ({
        model: String(row.model),
        tasks: Number(row.tasks),
        completed: Number(row.completed),
        failed: Number(row.failed),
        upstream_invocations: Number(row.upstream_invocations),
        failures: failuresByModel.get(String(row.model)) ?? [],
      }),
    ),
    summary: {
      users: Number(totals.users ?? 0),
      devices: Number(totals.devices ?? 0),
      tasks: Number(totals.total_tasks ?? 0),
      completed: Number(totals.total_completed ?? 0),
      failed: Number(totals.total_failed ?? 0),
      in_progress: Number(totals.total_in_progress ?? 0),
      queued: Number(totals.total_queued ?? 0),
      reconciling: Number(totals.total_reconciling ?? 0),
    },
    truncated: Number(totals.actor_count ?? 0) > ACTOR_LIMIT,
    actors: rows.map(
      (row): GenerationActor => ({
        kind: row.kind as GenerationActor['kind'],
        id: nullableText(row.actor_id),
        username: nullableText(row.username),
        note: nullableText(row.note),
        tasks: Number(row.tasks),
        completed: Number(row.completed),
        failed: Number(row.failed),
        in_progress: Number(row.in_progress),
        queued: Number(row.queued),
        reconciling: Number(row.reconciling),
        last_submitted_at: epoch(row.last_submitted_at),
      }),
    ),
  }
}

function logText(fields: unknown, key: string): string | null {
  if (!fields || typeof fields !== 'object') return null
  const value = (fields as Record<string, unknown>)[key]
  return typeof value === 'string' && value.trim() ? value : null
}

function logReason(fields: unknown): string | null {
  if (!fields || typeof fields !== 'object') return null
  const value = fields as Record<string, unknown>
  return (
    logText(fields, 'reason') ??
    logText(fields, 'err') ??
    logText(value.err, 'message') ??
    logText(fields, 'error') ??
    logText(value.error, 'message')
  )
}

export async function getTodayErrors(now = Date.now()): Promise<TodayErrorsResult> {
  const window = todayWindow(now)
  const recentWindow = { from: now - 15 * 60_000, to: now }
  const scanFrom = new Date(Math.min(window.from, recentWindow.from))
  const rows = (await getDbHandle().db.execute(sql`
    WITH errors AS (
      SELECT 'server' AS source, id, at, service, instance, event, message, task_id, request_id, group_key AS "group",
        COALESCE(fields->>'stack', fields->'err'->>'stack') AS stack, fields
      FROM server_logs
      WHERE at >= ${scanFrom} AND at <= ${new Date(now)}
        AND ${effectiveLogLevel} IN ('error', 'fatal')
      UNION ALL
      SELECT 'client' AS source, id, received_at AS at, '前端' AS service, NULL::text AS instance, NULL::text AS event,
        CASE WHEN name IS NULL THEN message ELSE name || ': ' || message END AS message,
        NULL::text AS task_id, NULL::text AS request_id, fingerprint AS "group", stack, '{}'::jsonb AS fields
      FROM client_errors
      WHERE received_at >= ${scanFrom} AND received_at <= ${new Date(now)}
    ), classified AS (
      SELECT errors.*,
        CASE WHEN reconnected.at IS NOT NULL OR task.status = 'completed' THEN 'recovered'
          WHEN task.status = 'failed' THEN 'unresolved' ELSE 'unknown' END AS recovery_state,
        CASE WHEN reconnected.at IS NOT NULL THEN '同一隧道连接已重新注册成功'
          WHEN task.status = 'completed' THEN '关联任务已完成'
          WHEN task.status = 'failed' THEN '关联任务仍为失败状态'
          WHEN errors.service = 'cloudflared' THEN '尚无可准确关联的重连成功记录'
          ELSE '暂无可关联的恢复证据' END AS recovery_reason,
        COALESCE(reconnected.at, CASE WHEN task.status = 'completed' THEN task.completed_at END) AS recovered_at
      FROM errors
      ${errorRecoveryJoins(now)}
    ), ranked AS (
      SELECT *, COUNT(*) FILTER (WHERE at >= ${new Date(window.from)}) OVER() AS total,
        COUNT(*) FILTER (WHERE at >= ${new Date(recentWindow.from)}) OVER() AS recent_total,
        COUNT(*) FILTER (WHERE at >= ${new Date(window.from)}) OVER (PARTITION BY recovery_state) AS state_total,
        COUNT(*) FILTER (WHERE at >= ${new Date(recentWindow.from)}) OVER (PARTITION BY recovery_state) AS state_recent_total,
        ROW_NUMBER() OVER (ORDER BY at DESC, source, id DESC) AS rank,
        ROW_NUMBER() OVER (PARTITION BY recovery_state ORDER BY at DESC, source, id DESC) AS state_rank
      FROM classified
    ), latest AS (
      SELECT * FROM ranked WHERE rank <= 10 OR state_rank <= 10
    )
    SELECT latest.*, cause.fields AS cause_fields FROM latest
    LEFT JOIN LATERAL (
      SELECT fields FROM server_logs related
      WHERE latest.source = 'server' AND latest.request_id IS NOT NULL
        AND related.request_id = latest.request_id AND related.id <> latest.id
        AND related.service = latest.service AND related.instance = latest.instance
        AND related.at BETWEEN latest.at - interval '1 minute' AND latest.at + interval '1 minute'
        AND related.at <= ${new Date(now)}
        AND (fields ? 'errorCode' OR fields ? 'reason' OR fields ? 'err' OR fields ? 'error')
      ORDER BY (fields ? 'reason') DESC, (fields ? 'errorCode') DESC, at DESC, id DESC LIMIT 1
    ) cause ON true
    ORDER BY latest.at DESC, latest.source, latest.id DESC
  `)) as unknown as Row[]
  const entries = rows.map((row): TodayErrorItem => {
    const fields = row.fields as Record<string, unknown> | null
    const status = Number(fields?.status)
    return {
      recovery: {
        state: row.recovery_state as ErrorRecoveryState,
        reason: String(row.recovery_reason),
        recoveredAt: row.recovered_at == null ? null : epoch(row.recovered_at),
      },
      source: row.source as TodayErrorItem['source'],
      id: String(row.id),
      at: epoch(row.at),
      service: String(row.service),
      instance: nullableText(row.instance),
      message: String(row.message),
      task_id: nullableText(row.task_id),
      request_id: nullableText(row.request_id),
      group: nullableText(row.group),
      stack: nullableText(row.stack),
      route: logText(fields, 'route'),
      status: Number.isInteger(status) && status >= 100 && status <= 599 ? status : null,
      errorCode: logText(fields, 'errorCode') ?? logText(row.cause_fields, 'errorCode'),
      reason: logReason(fields) ?? logReason(row.cause_fields),
    }
  })
  const resultWindow = (window: TimeWindow, recent: boolean): ErrorWindow => {
    const inWindow = entries.filter((entry) => entry.at >= window.from)
    const group = (state: ErrorRecoveryState) => ({
      total: Number(
        rows.find((row) => row.recovery_state === state)?.[
          recent ? 'state_recent_total' : 'state_total'
        ] ?? 0,
      ),
      entries: inWindow.filter((entry) => entry.recovery?.state === state).slice(0, 10),
    })
    return {
      window,
      total: Number(rows[0]?.[recent ? 'recent_total' : 'total'] ?? 0),
      entries: inWindow.slice(0, 10),
      recovery: {
        unresolved: group('unresolved'),
        unknown: group('unknown'),
        recovered: group('recovered'),
      },
    }
  }
  return { ...resultWindow(window, false), recent: resultWindow(recentWindow, true) }
}

export class TaskQueryError extends Error {}

export async function getGenerationTasks(
  filters: GenerationTaskFilters,
  cursor?: string,
): Promise<GenerationTasksResult> {
  const window: TimeWindow =
    filters.from !== undefined && filters.to !== undefined
      ? { from: filters.from, to: filters.to }
      : todayWindow()
  const conditions = [
    sql`t.submitted_at >= ${new Date(window.from)} AND t.submitted_at <= ${new Date(window.to)}`,
  ]
  if (filters.userId) conditions.push(sql`t.user_id = ${filters.userId}`)
  if (filters.deviceId)
    conditions.push(sql`t.user_id IS NULL AND t.device_id = ${filters.deviceId}`)
  if (filters.unassigned) conditions.push(sql`t.user_id IS NULL AND t.device_id IS NULL`)
  if (filters.status) conditions.push(sql`t.status = ${filters.status}`)
  if (filters.model) conditions.push(sql`t.model = ${filters.model}`)
  if (cursor) {
    const separator = cursor.indexOf('_')
    const at = Number(cursor.slice(0, separator))
    const id = cursor.slice(separator + 1)
    if (
      separator < 1 ||
      !Number.isSafeInteger(at) ||
      at < window.from ||
      at > window.to ||
      !id ||
      id.length > 128
    )
      throw new TaskQueryError('无效的任务游标')
    conditions.push(sql`(t.submitted_at, t.id) < (${new Date(at)}, ${id})`)
  }
  const rows = (await getDbHandle().db.execute(sql`
    SELECT t.id, t.provider, t.model, t.status, t.submitted_at, t.started_at, t.completed_at,
      t.error_type, t.upstream_status, t.attempt_count, t.upstream_invocation_count,
      COALESCE(t.request_payload->>'prompt', (
        SELECT string_agg(part #>> '{}', E'\\n' ORDER BY position)
        FROM jsonb_array_elements(jsonb_path_query_array(t.request_payload, '$.contents[*].parts[*].text'))
          WITH ORDINALITY AS texts(part, position)
        WHERE jsonb_typeof(part) = 'string' AND part #>> '{}' <> ''
      ), '') AS prompt,
      t.user_id, t.device_id, u.username
    FROM queue_tasks t LEFT JOIN users u ON u.id = t.user_id
    WHERE ${sql.join(conditions, sql` AND `)}
    ORDER BY t.submitted_at DESC, t.id DESC LIMIT ${PAGE_SIZE + 1}
  `)) as unknown as Row[]
  const tasks = rows.slice(0, PAGE_SIZE).map((row) => ({
    ...mapTaskListItem(row),
    user_id: nullableText(row.user_id),
    device_id: nullableText(row.device_id),
    username: nullableText(row.username),
  }))
  const last = tasks[tasks.length - 1]
  return {
    window,
    tasks,
    nextCursor: rows.length > PAGE_SIZE && last ? `${last.submitted_at}_${last.id}` : null,
  }
}
