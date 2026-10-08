import type { ServerLogFilters, ServerLogPage, ServerLogsResult } from '@image-playground/shared'
import { SERVER_LOG_LEVELS, SERVER_LOG_SERVICES } from '@image-playground/shared'
import { sql } from 'drizzle-orm'
import { getDbHandle } from './db'

const MAX_WINDOW = 7 * 86400_000
const PAGE_SIZE = 100
const epoch = (value: unknown) =>
  value instanceof Date ? value.getTime() : Date.parse(String(value))
export class LogQueryError extends Error {}

export function parseLogQuery(query: Record<string, unknown>, now = Date.now()) {
  const from = query.from === undefined ? now - 3600_000 : Number(query.from)
  const to = query.to === undefined ? now : Number(query.to)
  if (
    !Number.isSafeInteger(from) ||
    !Number.isSafeInteger(to) ||
    from < 0 ||
    to <= from ||
    to - from > MAX_WINDOW ||
    to > now + 60_000
  ) {
    throw new LogQueryError('时间范围须有效且不超过 7 天')
  }
  const filters: ServerLogFilters = { from, to }
  if (query.service) {
    if (!SERVER_LOG_SERVICES.includes(query.service as never)) throw new LogQueryError('无效的服务')
    filters.service = query.service as ServerLogFilters['service']
  }
  if (query.level) {
    if (!SERVER_LOG_LEVELS.includes(query.level as never)) throw new LogQueryError('无效的日志级别')
    filters.level = query.level as ServerLogFilters['level']
  }
  for (const key of [
    'q',
    'requestId',
    'taskId',
    'userId',
    'mediaId',
    'instance',
    'version',
    'group',
  ] as const) {
    if (query[key] === undefined || query[key] === '') continue
    if (typeof query[key] !== 'string' || query[key].length > 400)
      throw new LogQueryError('筛选条件过长')
    filters[key] = query[key]
  }
  let cursor: { at: number; id: string } | undefined
  if (query.cursor) {
    try {
      if (typeof query.cursor !== 'string' || query.cursor.length > 300) throw new Error()
      const parsed = JSON.parse(Buffer.from(query.cursor, 'base64url').toString())
      if (
        !Number.isSafeInteger(parsed.at) ||
        parsed.at < from ||
        parsed.at > to ||
        typeof parsed.id !== 'string' ||
        !/^[a-zA-Z0-9-]{1,100}$/.test(parsed.id)
      )
        throw new Error()
      cursor = { at: parsed.at, id: parsed.id }
    } catch {
      throw new LogQueryError('无效的日志游标')
    }
  }
  return { filters, cursor }
}

export async function readServerLogs(
  query: ReturnType<typeof parseLogQuery>,
): Promise<ServerLogPage | ServerLogsResult> {
  const { filters, cursor } = query
  const db = getDbHandle().db
  const conditions = [sql`at >= ${new Date(filters.from)} AND at <= ${new Date(filters.to)}`]
  if (filters.service) conditions.push(sql`service = ${filters.service}`)
  if (filters.level) conditions.push(sql`level = ${filters.level}`)
  if (filters.requestId) conditions.push(sql`request_id = ${filters.requestId}`)
  if (filters.taskId) conditions.push(sql`task_id = ${filters.taskId}`)
  if (filters.group) conditions.push(sql`group_key = ${filters.group}`)
  if (filters.instance) conditions.push(sql`instance = ${filters.instance}`)
  if (filters.version) conditions.push(sql`version = ${filters.version}`)
  if (filters.userId) conditions.push(sql`fields->>'userId' = ${filters.userId}`)
  if (filters.mediaId) conditions.push(sql`fields->>'mediaId' = ${filters.mediaId}`)
  // strpos is a literal case-insensitive substring, so %, _ and quotes have no query syntax.
  if (filters.q)
    conditions.push(
      sql`strpos(lower(concat_ws(' ', message, event, request_id, task_id, fields::text)), lower(${filters.q})) > 0`,
    )
  const where = sql.join(conditions, sql` AND `)
  const page = cursor ? sql`${where} AND (at, id) < (${new Date(cursor.at)}, ${cursor.id})` : where
  const bucket_ms = Math.max(60_000, Math.ceil((filters.to - filters.from) / 60 / 60_000) * 60_000)
  async function readPage(): Promise<ServerLogPage> {
    const rows = await db.execute(
      sql`SELECT * FROM server_logs WHERE ${page} ORDER BY at DESC, id DESC LIMIT ${PAGE_SIZE + 1}`,
    )
    const entries = (rows as unknown as Array<Record<string, unknown>>)
      .slice(0, PAGE_SIZE)
      .map((row) => ({
        ...row,
        at: epoch(row.at),
      })) as unknown as ServerLogsResult['entries']
    const last = entries.at(-1)
    const nextCursor =
      rows.length > PAGE_SIZE && last
        ? Buffer.from(JSON.stringify({ at: last.at, id: last.id })).toString('base64url')
        : null
    return { entries, nextCursor }
  }
  // Later pages only need records. Full-window statistics remain on page one.
  if (cursor) return readPage()
  const [records, totals, groups, points, collectors, coverage] = await Promise.all([
    readPage(),
    db.execute(sql`SELECT count(*)::int AS total,
      count(*) FILTER (WHERE level IN ('error', 'fatal'))::int AS errors,
      count(*) FILTER (WHERE level = 'warn')::int AS warnings FROM server_logs WHERE ${where}`),
    db.execute(sql`SELECT service, level, group_key AS key, count(*)::int AS count,
      min(at) AS first_at, max(at) AS last_at FROM server_logs WHERE ${where}
      GROUP BY service, level, group_key ORDER BY count DESC, max(at) DESC, service, level, group_key LIMIT 30`),
    db.execute(sql`SELECT floor(extract(epoch FROM at) * 1000 / ${bucket_ms}) * ${bucket_ms} AS at,
      count(*)::int AS count, count(*) FILTER (WHERE level IN ('error', 'fatal'))::int AS errors
      FROM server_logs WHERE ${where} GROUP BY 1 ORDER BY 1`),
    db.execute(sql`WITH beats AS (
      SELECT service, instance, last_seen_at, detail->'logs' AS logs,
        row_number() OVER (PARTITION BY service ORDER BY last_seen_at DESC) AS latest
      FROM service_heartbeats WHERE detail->'logs' IS NOT NULL
    ) SELECT service, instance, last_seen_at, logs FROM beats
      WHERE last_seen_at >= ${new Date(Date.now() - 120_000)} OR latest = 1
      ORDER BY last_seen_at DESC LIMIT 10`),
    db.execute(sql`SELECT
      (SELECT at FROM server_logs ORDER BY at ASC, id ASC LIMIT 1) AS first_at,
      (SELECT at FROM server_logs ORDER BY at DESC, id DESC LIMIT 1) AS last_at`),
  ])
  const pointMap = new Map(
    (points as unknown as Array<Record<string, unknown>>).map((row) => [
      Number(row.at),
      { at: Number(row.at), count: Number(row.count), errors: Number(row.errors) },
    ]),
  )
  const trend: ServerLogsResult['trend'] = []
  for (
    let at = Math.floor(filters.from / bucket_ms) * bucket_ms;
    at <= filters.to;
    at += bucket_ms
  ) {
    trend.push(pointMap.get(at) ?? { at, count: 0, errors: 0 })
  }
  return {
    ...records,
    coverage: {
      first_at: coverage[0]?.first_at == null ? null : epoch(coverage[0].first_at),
      last_at: coverage[0]?.last_at == null ? null : epoch(coverage[0].last_at),
    },
    summary: totals[0] as ServerLogsResult['summary'],
    groups: (groups as unknown as Array<Record<string, unknown>>).map((row) => ({
      ...row,
      first_at: epoch(row.first_at),
      last_at: epoch(row.last_at),
    })) as unknown as ServerLogsResult['groups'],
    trend,
    bucket_ms,
    collectors: (
      collectors as unknown as Array<{
        service: 'bff' | 'worker'
        instance: string
        last_seen_at: unknown
        logs: { pending: number; dropped: number; failures: number; last_written_at: number | null }
      }>
    ).map((row) => ({
      service: row.service,
      instance: row.instance,
      last_seen_at: epoch(row.last_seen_at),
      ...row.logs,
    })),
  }
}
