import { sql } from 'drizzle-orm'
import {
  type GenerationActor,
  type GenerationTaskFilters,
  type GenerationTasksResult,
  type TimeWindow,
  type TodayErrorItem,
  type TodayErrorsResult,
  type TodayOverviewResult,
  todayWindow,
} from '../../contracts'
import { getDbHandle } from './db'
import { mapTaskListItem } from './queries'
import { effectiveLogLevel } from './server-logs'

type Row = Record<string, unknown>
const epoch = (value: unknown) =>
  value instanceof Date ? value.getTime() : Date.parse(String(value))
const nullableText = (value: unknown) => (value == null ? null : String(value))
const ACTOR_LIMIT = 500
const PAGE_SIZE = 100

export async function getTodayOverview(now = Date.now()): Promise<TodayOverviewResult> {
  const window = todayWindow(now)
  const rows = (await getDbHandle().db.execute(sql`
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
      WHERE submitted_at >= ${new Date(window.from)} AND submitted_at <= ${new Date(window.to)}
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
  `)) as unknown as Row[]
  const totals = rows[0] ?? {}
  return {
    window,
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
      SELECT 'server' AS source, id, at, service, instance, message, task_id, request_id, group_key AS "group",
        COALESCE(fields->>'stack', fields->'err'->>'stack') AS stack, fields
      FROM server_logs
      WHERE at >= ${scanFrom} AND at <= ${new Date(now)}
        AND ${effectiveLogLevel} IN ('error', 'fatal')
      UNION ALL
      SELECT 'client' AS source, id, received_at AS at, '前端' AS service, NULL::text AS instance,
        CASE WHEN name IS NULL THEN message ELSE name || ': ' || message END AS message,
        NULL::text AS task_id, NULL::text AS request_id, fingerprint AS "group", stack, '{}'::jsonb AS fields
      FROM client_errors
      WHERE received_at >= ${scanFrom} AND received_at <= ${new Date(now)}
    ), latest AS (
      SELECT *, COUNT(*) FILTER (WHERE at >= ${new Date(window.from)}) OVER() AS total,
        COUNT(*) FILTER (WHERE at >= ${new Date(recentWindow.from)}) OVER() AS recent_total
      FROM errors ORDER BY at DESC, source, id DESC LIMIT 10
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
  return {
    window,
    total: Number(rows[0]?.total ?? 0),
    entries: entries.filter((entry) => entry.at >= window.from),
    recent: {
      window: recentWindow,
      total: Number(rows[0]?.recent_total ?? 0),
      entries: entries.filter((entry) => entry.at >= recentWindow.from),
    },
  }
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
