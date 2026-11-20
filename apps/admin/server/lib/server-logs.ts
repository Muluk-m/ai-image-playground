/**
 * 运营后台「服务端日志」页的读取（ADR 0033 P3-2，#1937）：经 obs-proxy 查 OpenObserve，接口形状不变。
 *
 * OpenObserve 里的字段名是小写下划线：`taskid`、`requestid`、`userid`、`mediaid`、`source`（输出流）、
 * `body`（消息）、`severity_number`（OTel 级别）。没有 `server_logs` 那样的行 id 和分组键：
 * 行 id 由时间戳、实例和正文摘要拼成，能据此取上下文；分组按 `event`，没有 event 的按正文前 120 字。
 */
import { createHash } from 'node:crypto'
import {
  createObsClient,
  type ObsClient,
  type ObsRecord,
  obsConnectionFromEnv,
} from '@image-playground/node-kit'
import type {
  ServerLogEntry,
  ServerLogFilters,
  ServerLogLevel,
  ServerLogPage,
  ServerLogService,
  ServerLogsResult,
} from '@image-playground/shared'
import {
  formatTrace,
  OBS_STREAM,
  SERVER_LOG_LEVELS,
  SERVER_LOG_SERVICES,
  sqlString,
  traceSql,
} from '@image-playground/shared'
import { sql } from 'drizzle-orm'
import { getDbHandle } from './db'

const MAX_WINDOW = 7 * 86400_000
const PAGE_SIZE = 100
const CONTEXT_LINES = 50
const epoch = (value: unknown) =>
  value instanceof Date ? value.getTime() : Date.parse(String(value))

/**
 * Legacy `server_logs` 的有效级别（旧采集器把单独的 `at ...` 堆栈行误标成 ERROR）。今日错误与错误恢复
 * 还在读 `server_logs`，迁过去之前保留。
 */
export const effectiveLogLevel = sql`CASE WHEN level = 'error' AND event IS NULL
  AND message ~ '^[[:space:]]*at[[:space:]]' AND strpos(message, chr(10)) = 0
  THEN CASE WHEN fields->>'stream' = 'stderr' THEN 'warn' ELSE 'info' END ELSE level END`

export class LogQueryError extends Error {}
/** 这个部署没开 OpenObserve（测试环境）：页面说明原因，而不是当成读取失败。 */
export class LogsUnavailableError extends Error {}

let obsClient: ObsClient | null | undefined
function defaultClient(): ObsClient {
  if (obsClient === undefined) {
    const connection = obsConnectionFromEnv()
    obsClient = connection ? createObsClient(connection, { timeoutMs: 20_000 }) : null
  }
  if (!obsClient) throw new LogsUnavailableError('这个部署没有开 OpenObserve，日志查询不可用')
  return obsClient
}

/** 仅供测试。 */
export function _setObsClientForTesting(client: ObsClient | null | undefined): void {
  obsClient = client
}

const SEVERITY_FLOOR: Record<ServerLogLevel, number> = {
  trace: 1,
  debug: 5,
  info: 9,
  warn: 13,
  error: 17,
  fatal: 21,
}
/** 纯文本行可能没有级别：按 info 算，和 Collector 的默认一致。 */
const SEVERITY = 'COALESCE(severity_number, 9)'
const LEVEL = `CASE WHEN ${SEVERITY} >= 21 THEN 'fatal' WHEN ${SEVERITY} >= 17 THEN 'error' WHEN ${SEVERITY} >= 13 THEN 'warn' WHEN ${SEVERITY} >= 9 THEN 'info' WHEN ${SEVERITY} >= 5 THEN 'debug' ELSE 'trace' END`
const GROUP = 'COALESCE(event, substr(body, 1, 120))'
const KNOWN_SERVICES = SERVER_LOG_SERVICES.filter((service) => service !== 'other')

function levelOf(severity: unknown): ServerLogLevel {
  const value = Number(severity ?? 9)
  if (value >= 21) return 'fatal'
  if (value >= 17) return 'error'
  if (value >= 13) return 'warn'
  if (value >= 9) return 'info'
  if (value >= 5) return 'debug'
  return 'trace'
}

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
  for (const key of ['deployment', 'stream'] as const) {
    if (query[key] === undefined || query[key] === '') continue
    const allowed = key === 'stream' ? ['stdout', 'stderr'] : ['paid', 'test']
    if (!allowed.includes(query[key] as string)) throw new LogQueryError('无效的部署或输出流')
    Object.assign(filters, { [key]: query[key] })
  }
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
    'traceId',
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
  let offset = 0
  if (query.cursor) {
    try {
      if (typeof query.cursor !== 'string' || query.cursor.length > 300) throw new Error()
      const parsed = JSON.parse(Buffer.from(query.cursor, 'base64url').toString())
      if (!Number.isSafeInteger(parsed.offset) || parsed.offset <= 0 || parsed.offset > 100_000)
        throw new Error()
      offset = parsed.offset
    } catch {
      throw new LogQueryError('无效的日志游标')
    }
  }
  return { filters, offset }
}

/** 筛选条件拼成 OpenObserve SQL 的 WHERE；级别单独返回，级别分面要不带它再算一遍。 */
export function logWhere(filters: ServerLogFilters): { base: string[]; level: string | null } {
  const base: string[] = []
  const equals = (field: string, value: string | undefined) => {
    if (value) base.push(`${field} = ${sqlString(value)}`)
  }
  if (filters.service === 'other')
    base.push(`(service IS NULL OR service NOT IN (${KNOWN_SERVICES.map(sqlString).join(', ')}))`)
  else equals('service', filters.service)
  if (filters.deployment)
    equals('deployment_environment_name', `image-playground-${filters.deployment}`)
  equals('source', filters.stream)
  equals('requestid', filters.requestId)
  equals('taskid', filters.taskId)
  equals('trace_id', filters.traceId)
  equals('userid', filters.userId)
  equals('mediaid', filters.mediaId)
  equals('instance', filters.instance)
  equals('version', filters.version)
  if (filters.group) base.push(`${GROUP} = ${sqlString(filters.group)}`)
  if (filters.q) {
    const q = sqlString(filters.q)
    base.push(
      `(str_match_ignore_case(body, ${q}) OR str_match_ignore_case(event, ${q}) OR requestid = ${q} OR taskid = ${q} OR trace_id = ${q})`,
    )
  }
  const floor = filters.level ? SEVERITY_FLOOR[filters.level] : null
  const level = floor === null ? null : `${SEVERITY} >= ${floor} AND ${SEVERITY} < ${floor + 4}`
  return { base, level }
}

const where = (clauses: readonly string[]) =>
  clauses.length ? ` WHERE ${clauses.join(' AND ')}` : ''

/** 一行的 id：时间戳（微秒）、实例、正文摘要。上下文按前两样定位，摘要只用来区分同一微秒的多行。 */
function entryId(timestampUs: number, instance: string, body: string): string {
  const digest = createHash('sha256').update(`${timestampUs}\u0000${instance}\u0000${body}`)
  return `${timestampUs}-${Buffer.from(instance).toString('base64url')}-${digest.digest('hex').slice(0, 8)}`
}

function parseEntryId(id: string): { timestampUs: number; instance: string } {
  const match = /^(\d{1,20})-([A-Za-z0-9_-]{0,200})-[0-9a-f]{8}$/.exec(id)
  const timestampUs = Number(match?.[1])
  if (!match || !Number.isSafeInteger(timestampUs)) throw new LogQueryError('无效的日志 ID')
  return { timestampUs, instance: Buffer.from(match[2]!, 'base64url').toString() }
}

/** 排版时单独显示、不进 fields 的列，以及 OpenObserve 和 Collector 自己加的元数据。 */
const OMITTED = new Set([
  '_timestamp',
  'body',
  'service',
  'instance',
  'version',
  'event',
  'requestid',
  'taskid',
  'severity',
  'severity_number',
  'container_id',
  'container_name',
  'fluent_tag',
  'dropped_attributes_count',
  'deployment_environment_name',
  'flags',
  'time',
])

const FIELD_NAMES: Record<string, string> = { userid: 'userId', mediaid: 'mediaId' }

export function toEntry(hit: ObsRecord): ServerLogEntry {
  const timestampUs = Number(hit._timestamp)
  const instance = String(hit.instance ?? '')
  const message = String(hit.body ?? '')
  const event = typeof hit.event === 'string' && hit.event ? hit.event : null
  const service = SERVER_LOG_SERVICES.includes(hit.service as never)
    ? (hit.service as ServerLogService)
    : 'other'
  const fields = Object.fromEntries(
    Object.entries(hit)
      .filter(([key, value]) => !OMITTED.has(key) && value !== null)
      // 页面按 pino 原名找用户和图片；OpenObserve 把字段名转成了小写。
      .map(([key, value]) => [FIELD_NAMES[key] ?? key, value]),
  )
  // `other` 归不进固定的服务名单：原名留在 fields 里，排查时看得到是哪个容器。
  if (service === 'other' && hit.service) fields.service = hit.service
  return {
    id: entryId(timestampUs, instance, message),
    at: Math.floor(timestampUs / 1_000),
    service,
    instance,
    version: String(hit.version ?? ''),
    level: levelOf(hit.severity_number),
    event,
    group_key: event ?? message.slice(0, 120),
    message,
    request_id: typeof hit.requestid === 'string' ? hit.requestid : null,
    task_id: typeof hit.taskid === 'string' ? hit.taskid : null,
    fields,
  }
}

export async function readServerLogs(
  query: ReturnType<typeof parseLogQuery>,
  client: ObsClient = defaultClient(),
): Promise<ServerLogPage | ServerLogsResult> {
  const { filters, offset } = query
  const { base, level } = logWhere(filters)
  const all = level ? [...base, level] : base
  const range = { type: 'logs' as const, startMs: filters.from, endMs: filters.to }
  const select = (statement: string, size = 1_000) =>
    client.search({ ...range, sql: statement, size })

  async function readPage(): Promise<ServerLogPage> {
    // 同一微秒的多行按实例和正文排开，偏移分页不重不漏。
    const hits = await client.search({
      ...range,
      sql: `SELECT * FROM "${OBS_STREAM}"${where(all)} ORDER BY _timestamp DESC, instance, body`,
      from: offset,
      size: PAGE_SIZE + 1,
    })
    const entries = hits.slice(0, PAGE_SIZE).map(toEntry)
    const nextCursor =
      hits.length > PAGE_SIZE
        ? Buffer.from(JSON.stringify({ offset: offset + PAGE_SIZE })).toString('base64url')
        : null
    return { entries, nextCursor }
  }
  // 后面的页只要记录，整段统计只在第一页给。
  if (offset > 0) return readPage()

  const bucket_ms = Math.max(60_000, Math.ceil((filters.to - filters.from) / 60 / 60_000) * 60_000)
  const bucketUs = bucket_ms * 1_000
  const errors = `SUM(CASE WHEN ${SEVERITY} >= 17 THEN 1 ELSE 0 END)`
  const warnings = `SUM(CASE WHEN ${SEVERITY} >= 13 AND ${SEVERITY} < 17 THEN 1 ELSE 0 END)`
  const [records, totals, groups, points, levels, collectors] = await Promise.all([
    readPage(),
    select(
      `SELECT COUNT(*) AS total, ${errors} AS errors, ${warnings} AS warnings FROM "${OBS_STREAM}"${where(all)}`,
      1,
    ),
    select(
      `SELECT service, ${LEVEL} AS level, ${GROUP} AS key, COUNT(*) AS count, MIN(_timestamp) AS first_at, MAX(_timestamp) AS last_at FROM "${OBS_STREAM}"${where(all)} GROUP BY service, ${LEVEL}, ${GROUP} ORDER BY count DESC, last_at DESC LIMIT 30`,
      30,
    ),
    select(
      `SELECT CAST(_timestamp / ${bucketUs} AS BIGINT) * ${bucketUs} AS bucket, COUNT(*) AS count, ${errors} AS errors, ${warnings} AS warnings FROM "${OBS_STREAM}"${where(all)} GROUP BY CAST(_timestamp / ${bucketUs} AS BIGINT) * ${bucketUs} ORDER BY bucket`,
      2_000,
    ),
    select(
      `SELECT ${LEVEL} AS level, COUNT(*) AS count FROM "${OBS_STREAM}"${where(base)} GROUP BY ${LEVEL}`,
      10,
    ),
    readCollectors(),
  ])
  const pointMap = new Map(
    points.map((row) => {
      const at = Math.floor(Number(row.bucket) / 1_000)
      return [
        at,
        {
          at,
          count: Number(row.count ?? 0),
          errors: Number(row.errors ?? 0),
          warnings: Number(row.warnings ?? 0),
        },
      ]
    }),
  )
  const trend: ServerLogsResult['trend'] = []
  for (
    let at = Math.floor(filters.from / bucket_ms) * bucket_ms;
    at <= filters.to;
    at += bucket_ms
  ) {
    trend.push(pointMap.get(at) ?? { at, count: 0, errors: 0, warnings: 0 })
  }
  const total = totals[0] ?? {}
  return {
    ...records,
    levelCounts: Object.fromEntries(levels.map((row) => [String(row.level), Number(row.count)])),
    summary: {
      total: Number(total.total ?? 0),
      errors: Number(total.errors ?? 0),
      warnings: Number(total.warnings ?? 0),
    },
    groups: groups.map((row) => ({
      service: SERVER_LOG_SERVICES.includes(row.service as never)
        ? (row.service as ServerLogService)
        : 'other',
      level: SERVER_LOG_LEVELS.includes(row.level as never)
        ? (row.level as ServerLogLevel)
        : 'info',
      key: String(row.key ?? ''),
      count: Number(row.count ?? 0),
      first_at: Math.floor(Number(row.first_at) / 1_000),
      last_at: Math.floor(Number(row.last_at) / 1_000),
    })),
    trend,
    bucket_ms,
    collectors,
  }
}

/** 旧 BFF 内存缓冲的心跳计数，仍从数据库读（页面「采集容器状态」）。 */
async function readCollectors(): Promise<ServerLogsResult['collectors']> {
  const rows = await getDbHandle().db.execute(sql`WITH beats AS (
      SELECT service, instance, last_seen_at, detail->'logs' AS logs,
        row_number() OVER (PARTITION BY service ORDER BY last_seen_at DESC) AS latest
      FROM service_heartbeats WHERE detail->'logs' IS NOT NULL
    ) SELECT service, instance, last_seen_at, logs FROM beats
      WHERE last_seen_at >= ${new Date(Date.now() - 120_000)} OR latest = 1
      ORDER BY last_seen_at DESC LIMIT 10`)
  return (
    rows as unknown as Array<{
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
  }))
}

/** 同一容器前后各 50 行，与当前筛选无关。 */
export async function readLogContext(
  id: string,
  client: ObsClient = defaultClient(),
): Promise<ServerLogEntry[]> {
  const { timestampUs, instance } = parseEntryId(id)
  const at = timestampUs / 1_000
  // 一天的窗口足够取到前后 50 行，又不让查询扫太多分区。
  const range = { type: 'logs' as const, startMs: at - 86_400_000, endMs: at + 86_400_000 }
  const scope = `instance = ${sqlString(instance)}`
  const [before, same, after] = await Promise.all([
    client.search({
      ...range,
      sql: `SELECT * FROM "${OBS_STREAM}" WHERE ${scope} AND _timestamp < ${timestampUs} ORDER BY _timestamp DESC, body`,
      size: CONTEXT_LINES,
    }),
    client.search({
      ...range,
      sql: `SELECT * FROM "${OBS_STREAM}" WHERE ${scope} AND _timestamp = ${timestampUs} ORDER BY body`,
      size: CONTEXT_LINES,
    }),
    client.search({
      ...range,
      sql: `SELECT * FROM "${OBS_STREAM}" WHERE ${scope} AND _timestamp > ${timestampUs} ORDER BY _timestamp, body`,
      size: CONTEXT_LINES,
    }),
  ])
  return [...before.reverse(), ...same, ...after].map(toEntry)
}

export interface TraceView {
  /** 缩进的 span 树，和 `bun scripts/obs.ts trace` 的输出一样。 */
  tree: string
  spans: number
  truncated: boolean
}

/** 一条链路的 span 树。链路保留期跟日志一样，查最近 7 天。 */
export async function readTrace(
  traceId: string,
  client: ObsClient = defaultClient(),
  now = Date.now(),
): Promise<TraceView> {
  if (!/^[0-9a-f]{32}$/.test(traceId)) throw new LogQueryError('无效的 trace id')
  const { records, truncated } = await client.searchAll({
    sql: traceSql(traceId),
    type: 'traces',
    startMs: now - MAX_WINDOW,
    endMs: now + 60_000,
  })
  return { tree: formatTrace(records), spans: records.length, truncated }
}
