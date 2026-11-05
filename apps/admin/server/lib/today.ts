import { CLIENT_ERROR_RECOVERY_OPERATIONS } from '@image-playground/shared'
import { sql } from 'drizzle-orm'
import {
  type ErrorRecoveryState,
  type ErrorWindow,
  type GenerationActor,
  type GenerationTaskFilters,
  type GenerationTasksResult,
  type GenerationUsersOverview,
  type OverviewActivityResult,
  type TimeWindow,
  type TodayErrorItem,
  type TodayErrorsResult,
  type TodayModelFailure,
  type TodayModelStat,
  type TodayOverviewResult,
  todayWindow,
} from '../../contracts'
import { getDbHandle } from './db'
import { errorRecoveryJoins, tunnelRecoveryEvents } from './error-recovery'
import { mapTaskListItem } from './queries'
import { effectiveLogLevel } from './server-logs'

type Row = Record<string, unknown>
const epoch = (value: unknown) =>
  value instanceof Date ? value.getTime() : Date.parse(String(value))
const nullableText = (value: unknown) => (value == null ? null : String(value))
const ACTOR_LIMIT = 500

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
  return getGenerationOverview(todayWindow(now))
}

export async function getGenerationOverview(window: TimeWindow): Promise<TodayOverviewResult> {
  const from = new Date(window.from)
  const to = new Date(window.to)
  const [overview, modelRows, failureRows] = await Promise.all([
    getGenerationUsers(window),
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
  const failuresByModel = modelFailures(failureRows as unknown as Row[])
  return {
    ...overview,
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
  }
}

export async function getGenerationUsers(window: TimeWindow): Promise<GenerationUsersOverview> {
  const from = new Date(window.from)
  const to = new Date(window.to)
  const actorRows = await getDbHandle().db.execute(sql`
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
  `)
  const rows = actorRows as unknown as Row[]
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
  if (value.operation === 'project.catalog' && Array.isArray(value.causes)) {
    const cause = value.causes.at(-1)
    const message = logText(cause, 'message')
    if (message) return [logText(cause, 'name'), message].filter(Boolean).join(': ')
  }
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
    WITH ${tunnelRecoveryEvents(scanFrom, now)}, errors AS (
      SELECT 'server' AS source, id, at, service, instance, event, message, task_id, request_id, group_key AS "group",
        COALESCE(fields->>'stack', fields->'err'->>'stack') AS stack, fields, NULL::text AS device_id, NULL::text AS user_id
      FROM server_logs
      WHERE at >= ${scanFrom} AND at <= ${new Date(now)}
        AND ${effectiveLogLevel} IN ('error', 'fatal')
      UNION ALL
      SELECT 'client' AS source, id, received_at AS at, '前端' AS service, NULL::text AS instance, NULL::text AS event,
        CASE WHEN name IS NULL THEN message ELSE name || ': ' || message END AS message,
        NULL::text AS task_id, NULL::text AS request_id, fingerprint AS "group", stack, COALESCE(context, '{}'::jsonb) AS fields, device_id, user_id
      FROM client_errors
      WHERE received_at >= ${scanFrom} AND received_at <= ${new Date(now)}
    ), classified AS (
      SELECT errors.*,
        CASE WHEN client_recovered.at IS NOT NULL OR reconnected.at IS NOT NULL OR task.status = 'completed' THEN 'recovered'
          WHEN task.status = 'failed' THEN 'unresolved' ELSE 'unknown' END AS recovery_state,
        CASE WHEN client_recovered.at IS NOT NULL THEN '同一页面、账号的同一操作重试已成功（浏览器上报）'
          WHEN reconnected.at IS NOT NULL THEN '同一隧道连接已重新注册成功'
          WHEN task.status = 'completed' THEN '关联任务已完成'
          WHEN task.status = 'failed' THEN '关联任务仍为失败状态'
          WHEN errors.service = 'cloudflared' THEN '尚无可准确关联的重连成功记录'
          WHEN errors.source = 'client' AND errors.fields->>'incidentId' IS NULL THEN '此条前端错误未记录恢复标识，无法自动确认'
          ELSE '暂无可关联的恢复证据' END AS recovery_reason,
        COALESCE(CASE WHEN client_recovered.at IS NOT NULL THEN GREATEST(client_recovered.at, errors.at) END, reconnected.at, CASE WHEN task.status = 'completed' THEN task.completed_at END) AS recovered_at
      FROM errors
      ${errorRecoveryJoins(now)}
      LEFT JOIN LATERAL (
        SELECT MIN(recovery.received_at) AS at FROM client_error_recoveries recovery
        WHERE errors.source = 'client'
          AND recovery.incident_id = errors.fields->>'incidentId'
          AND recovery.operation IN (${sql.join(
            CLIENT_ERROR_RECOVERY_OPERATIONS.map((operation) => sql`${operation}`),
            sql`, `,
          )})
          AND errors.fields->>'operation' = recovery.operation
          AND recovery.device_id = errors.device_id
          AND recovery.user_id IS NOT DISTINCT FROM errors.user_id
          AND recovery.received_at <= ${new Date(now)}
      ) client_recovered ON true
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

const CURSOR_PAGE_SIZE = 100
const EXPORT_CAP = 10_000

/** 提示词不建 trigram。调用方必须先用 submitted_at 窗口把扫描圈住，再对这段文本做 ILIKE。 */
const promptText = sql`COALESCE(t.request_payload->>'prompt', (
  SELECT string_agg(part #>> '{}', E'\\n' ORDER BY position)
  FROM jsonb_array_elements(jsonb_path_query_array(t.request_payload, '$.contents[*].parts[*].text'))
    WITH ORDINALITY AS texts(part, position)
  WHERE jsonb_typeof(part) = 'string' AND part #>> '{}' <> ''
), '')`

function ilikeContains(value: string): string {
  return `%${value.replace(/[\\%_]/g, (char) => `\\${char}`)}%`
}

function sqlTextIn(column: ReturnType<typeof sql>, values: readonly string[]) {
  return sql`${column} IN (${sql.join(
    values.map((value) => sql`${value}`),
    sql`, `,
  )})`
}

function taskWindow(filters: GenerationTaskFilters): TimeWindow {
  return filters.from !== undefined && filters.to !== undefined
    ? { from: filters.from, to: filters.to }
    : todayWindow()
}

function taskConditions(filters: GenerationTaskFilters, window: TimeWindow, cursor?: string) {
  const conditions = [
    sql`t.submitted_at >= ${new Date(window.from)} AND t.submitted_at <= ${new Date(window.to)}`,
  ]
  if (filters.userId) conditions.push(sql`t.user_id = ${filters.userId}`)
  if (filters.deviceId)
    conditions.push(sql`t.user_id IS NULL AND t.device_id = ${filters.deviceId}`)
  if (filters.unassigned) conditions.push(sql`t.user_id IS NULL AND t.device_id IS NULL`)
  if (filters.status) conditions.push(sql`t.status = ${filters.status}`)
  if (filters.source)
    conditions.push(
      filters.source === 'chat'
        ? sql`t.agent_conversation_id IS NOT NULL`
        : sql`t.agent_conversation_id IS NULL`,
    )
  const models = [
    ...new Set([...(filters.model ? [filters.model] : []), ...(filters.models ?? [])]),
  ]
  if (models.length === 1) conditions.push(sql`t.model = ${models[0]}`)
  else if (models.length > 1) conditions.push(sqlTextIn(sql`t.model`, models))
  if (filters.providers?.length === 1) conditions.push(sql`t.provider = ${filters.providers[0]}`)
  else if (filters.providers && filters.providers.length > 1)
    conditions.push(sqlTextIn(sql`t.provider`, filters.providers))
  if (filters.errorTypes?.length) {
    const known = filters.errorTypes.filter((value) => value !== 'unknown')
    const unknown = filters.errorTypes.includes('unknown')
    const parts = []
    if (known.length === 1) parts.push(sql`t.error_type = ${known[0]}`)
    else if (known.length > 1) parts.push(sqlTextIn(sql`t.error_type`, known))
    if (unknown) parts.push(sql`t.error_type IS NULL`)
    if (parts.length === 1) conditions.push(parts[0]!)
    else if (parts.length > 1) conditions.push(sql`(${sql.join(parts, sql` OR `)})`)
  }
  if (filters.minDurationSec)
    conditions.push(
      sql`t.started_at IS NOT NULL AND t.completed_at IS NOT NULL AND EXTRACT(EPOCH FROM (t.completed_at - t.started_at)) > ${filters.minDurationSec}`,
    )
  if (filters.q) {
    const pattern = ilikeContains(filters.q)
    conditions.push(
      sql`(t.id = ${filters.q} OR u.username ILIKE ${pattern} ESCAPE '\\' OR ${promptText} ILIKE ${pattern} ESCAPE '\\')`,
    )
  }
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
  return conditions
}

const taskSelect = sql`
  SELECT t.id, t.provider, t.model, t.status, t.submitted_at, t.started_at, t.completed_at,
    t.error_type, t.upstream_status, t.attempt_count, t.upstream_invocation_count,
    ${promptText} AS prompt,
    t.user_id, t.device_id, t.agent_conversation_id, u.username
  FROM queue_tasks t LEFT JOIN users u ON u.id = t.user_id
`

function mapGenerationTask(row: Row) {
  return {
    ...mapTaskListItem(row),
    user_id: nullableText(row.user_id),
    device_id: nullableText(row.device_id),
    username: nullableText(row.username),
  }
}

export async function getOverviewActivity(window: TimeWindow): Promise<OverviewActivityResult> {
  const from = new Date(window.from)
  const to = new Date(window.to)
  const db = getDbHandle().db
  const [tasks, server, client] = await Promise.all([
    db.execute(sql`
      ${taskSelect}
      WHERE t.submitted_at >= ${from} AND t.submitted_at <= ${to}
      ORDER BY t.submitted_at DESC, t.id DESC LIMIT 10
    `),
    db.execute(sql`
      SELECT id, at, service, message, task_id, request_id, instance,
        COALESCE(fields->>'stack', fields->'err'->>'stack') AS stack,
        COUNT(*) OVER() AS total
      FROM server_logs
      WHERE at >= ${from} AND at <= ${to}
        AND ${effectiveLogLevel} IN ('error', 'fatal')
      ORDER BY at DESC, id DESC LIMIT 5
    `),
    db.execute(sql`
      SELECT e.id, e.received_at AS at, e.fingerprint, e.stack, e.user_id, e.device_id, u.username,
        CASE WHEN e.name IS NULL THEN e.message ELSE e.name || ': ' || e.message END AS message,
        COUNT(*) OVER() AS total
      FROM client_errors e LEFT JOIN users u ON u.id = e.user_id
      WHERE e.received_at >= ${from} AND e.received_at <= ${to}
      ORDER BY e.received_at DESC, e.id DESC LIMIT 5
    `),
  ])
  const taskRows = tasks as unknown as Row[]
  const serverRows = server as unknown as Row[]
  const clientRows = client as unknown as Row[]
  return {
    window,
    tasks: taskRows.map(mapGenerationTask),
    server: {
      total: Number(serverRows[0]?.total ?? 0),
      entries: serverRows.map((row) => ({
        id: String(row.id),
        at: epoch(row.at),
        message: String(row.message),
        stack: nullableText(row.stack),
        service: String(row.service),
        task_id: nullableText(row.task_id),
        request_id: nullableText(row.request_id),
        instance: nullableText(row.instance),
      })),
    },
    client: {
      total: Number(clientRows[0]?.total ?? 0),
      entries: clientRows.map((row) => ({
        id: String(row.id),
        at: epoch(row.at),
        message: String(row.message),
        stack: nullableText(row.stack),
        fingerprint: String(row.fingerprint),
        user_id: nullableText(row.user_id),
        device_id: nullableText(row.device_id),
        username: nullableText(row.username),
      })),
    },
  }
}

export async function getGenerationTasks(
  filters: GenerationTaskFilters,
  cursor?: string,
): Promise<GenerationTasksResult> {
  const window = taskWindow(filters)
  const paged = filters.page !== undefined
  const pageSize = filters.pageSize ?? (paged ? 50 : CURSOR_PAGE_SIZE)
  const page = filters.page ?? 1
  const conditions = taskConditions(filters, window, paged ? undefined : cursor)
  const where = sql.join(conditions, sql` AND `)
  const db = getDbHandle().db
  if (paged) {
    const offset = (page - 1) * pageSize
    const [rows, countRows] = await Promise.all([
      db.execute(sql`
        ${taskSelect}
        WHERE ${where}
        ORDER BY t.submitted_at DESC, t.id DESC
        LIMIT ${pageSize} OFFSET ${offset}
      `) as Promise<unknown> as Promise<Row[]>,
      db.execute(sql`
        SELECT COUNT(*)::int AS total
        FROM queue_tasks t LEFT JOIN users u ON u.id = t.user_id
        WHERE ${where}
      `) as Promise<unknown> as Promise<Row[]>,
    ])
    const total = Number(countRows[0]?.total ?? 0)
    const tasks = rows.map(mapGenerationTask)
    const last = tasks[tasks.length - 1]
    return {
      window,
      tasks,
      total,
      page,
      pageSize,
      nextCursor: offset + tasks.length < total && last ? `${last.submitted_at}_${last.id}` : null,
    }
  }
  const rows = (await db.execute(sql`
    ${taskSelect}
    WHERE ${where}
    ORDER BY t.submitted_at DESC, t.id DESC LIMIT ${CURSOR_PAGE_SIZE + 1}
  `)) as unknown as Row[]
  const tasks = rows.slice(0, CURSOR_PAGE_SIZE).map(mapGenerationTask)
  const last = tasks[tasks.length - 1]
  return {
    window,
    tasks,
    nextCursor: rows.length > CURSOR_PAGE_SIZE && last ? `${last.submitted_at}_${last.id}` : null,
  }
}

export async function exportGenerationTasks(filters: GenerationTaskFilters): Promise<{
  window: TimeWindow
  tasks: ReturnType<typeof mapGenerationTask>[]
  truncated: boolean
}> {
  const window = taskWindow(filters)
  const rows = (await getDbHandle().db.execute(sql`
    ${taskSelect}
    WHERE ${sql.join(taskConditions(filters, window), sql` AND `)}
    ORDER BY t.submitted_at DESC, t.id DESC
    LIMIT ${EXPORT_CAP + 1}
  `)) as unknown as Row[]
  return {
    window,
    tasks: rows.slice(0, EXPORT_CAP).map(mapGenerationTask),
    truncated: rows.length > EXPORT_CAP,
  }
}

export function generationTasksCsv(
  tasks: ReadonlyArray<ReturnType<typeof mapGenerationTask>>,
): string {
  const header = [
    'id',
    'submitted_at',
    'username',
    'user_id',
    'status',
    'error_type',
    'source',
    'provider',
    'model',
    'duration_seconds',
    'prompt',
  ]
  const cell = (value: string) => {
    const safe = /^[=+\-@]/.test(value) ? `'${value}` : value
    return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe
  }
  const lines = tasks.map((task) => {
    const duration =
      task.started_at != null && task.completed_at != null
        ? ((task.completed_at - task.started_at) / 1000).toFixed(3)
        : ''
    return [
      task.id,
      new Date(task.submitted_at).toISOString(),
      task.username ?? '',
      task.user_id ?? '',
      task.status,
      task.error_type ?? '',
      task.source,
      task.provider,
      task.model,
      duration,
      task.prompt,
    ]
      .map((value) => cell(value))
      .join(',')
  })
  return `\uFEFF${[header.join(','), ...lines].join('\n')}\n`
}
