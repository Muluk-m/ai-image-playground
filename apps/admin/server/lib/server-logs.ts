/**
 * 运营后台「服务端日志」页的读取（ADR 0033 P3-2，#1937）：经 obs-proxy 查 OpenObserve，接口形状不变。
 *
 * OpenObserve 里的字段名是小写下划线：`taskid`、`requestid`、`userid`、`mediaid`、`source`（输出流）、
 * `body`（消息）、`severity_number`（OTel 级别）。schema 里没有的字段一引用就报错，所以 SQL 只按流里
 * 现有的字段拼（`streamFields`，缓存 5 分钟），缺的当 NULL。
 *
 * 没有 `server_logs` 那样的行 id：排序键是（时间戳，实例，正文与请求、任务的 md5），行 id、翻页游标和
 * 上下文都按这个键定位，同一时刻再多的行也不重不漏。
 */
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
const SCHEMA_TTL_MS = 5 * 60_000
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
let schemaCache: { fields: Set<string>; at: number } | undefined
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
  schemaCache = undefined
}

async function logFields(client: ObsClient, now = Date.now()): Promise<Set<string>> {
  if (schemaCache && now - schemaCache.at < SCHEMA_TTL_MS) return schemaCache.fields
  const fields = await client.streamFields(OBS_STREAM, 'logs')
  schemaCache = { fields, at: now }
  return fields
}

/** 按 schema 拼 SQL 的表达式。字段不在流里时一律当 NULL：新部署还没出现过的字段不会让查询报错。 */
export function logSql(fields: ReadonlySet<string>) {
  const col = (name: string) => (fields.has(name) ? name : 'NULL')
  const severity = `COALESCE(${col('severity_number')}, 9)`
  const known = SERVER_LOG_SERVICES.filter((service) => service !== 'other')
  /**
   * 服务名对照旧的 `containerService()`：Collector 把发布路由容器记成 `release-router`；固定名单外的
   * 都归 other。分组、筛选和返回值用同一个表达式，点开一组就是这一组的记录。
   */
  const service = `CASE WHEN ${col('service')} = 'release-router' THEN 'router' WHEN ${col('service')} IN (${known.map(sqlString).join(', ')}) THEN ${col('service')} ELSE 'other' END`
  /**
   * 分组键：有 event 用 event；没有的（cloudflared、备份脚本这类纯文本行）去掉行首时间戳，把 UUID、
   * 长十六进制和数字换成占位符再取前 120 字。规则对照旧的 `container-logs.ts`；DataFusion 的正则
   * 不支持后行断言，数字前不再排除字母。
   */
  const group = String.raw`COALESCE(${col('event')}, substr(regexp_replace(regexp_replace(regexp_replace(regexp_replace(${col('body')}, '^\S*\d{4}-\d{2}-\d{2}[T ][\d:.]+Z?\s*', ''), '(?i)\b[0-9a-f]{8}-[0-9a-f-]{27,}\b', '<id>', 'g'), '(?i)\b[0-9a-f]{12,}\b', '<hex>', 'g'), '\d+(\.\d+)*', '<n>', 'g'), 1, 120))`
  /** pino 行带 instance；纯文本行只有容器名，用它代替，「同实例」和上下文才查得到。 */
  const instance = `COALESCE(${col('instance')}, ${col('container_name')})`
  /** 同一实例同一时刻的行靠它排开：正文相同、请求或任务不同也分得开。 */
  const key = `md5(concat(${col('body')}, '|', ${col('requestid')}, '|', ${col('taskid')}))`
  const level = `CASE WHEN ${severity} >= 21 THEN 'fatal' WHEN ${severity} >= 17 THEN 'error' WHEN ${severity} >= 13 THEN 'warn' WHEN ${severity} >= 9 THEN 'info' WHEN ${severity} >= 5 THEN 'debug' ELSE 'trace' END`
  return {
    col,
    severity,
    service,
    group,
    instance,
    key,
    level,
    record: `SELECT *, ${group} AS log_group, ${instance} AS log_instance, ${key} AS log_key, ${service} AS log_service FROM "${OBS_STREAM}"`,
  }
}
type LogSql = ReturnType<typeof logSql>

const SEVERITY_FLOOR: Record<ServerLogLevel, number> = {
  trace: 1,
  debug: 5,
  info: 9,
  warn: 13,
  error: 17,
  fatal: 21,
}
/**
 * 关键词不区分大小写、按子串匹配消息和这些常用字段（旧版搜全部结构化字段；OpenObserve 的字段有上百个，
 * 逐列匹配太慢，挑排障常用的）。不在流里的跳过。
 */
const SEARCH_FIELDS = [
  'body',
  'event',
  'requestid',
  'taskid',
  'trace_id',
  'userid',
  'mediaid',
  'route',
  'path',
  'reason',
  'errorcode',
  'error',
  'err_message',
  'err_stack',
  'error_message',
  'error_stack',
  'container_name',
]

function levelOf(severity: unknown): ServerLogLevel {
  const value = Number(severity ?? 9)
  if (value >= 21) return 'fatal'
  if (value >= 17) return 'error'
  if (value >= 13) return 'warn'
  if (value >= 9) return 'info'
  if (value >= 5) return 'debug'
  return 'trace'
}

interface SortKey {
  readonly timestampUs: number
  readonly instance: string
  readonly key: string
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
  let cursor: SortKey | undefined
  if (query.cursor) {
    try {
      if (typeof query.cursor !== 'string' || query.cursor.length > 1_000) throw new Error()
      cursor = decodeSortKey(query.cursor)
      if (cursor.timestampUs < from * 1_000 || cursor.timestampUs > to * 1_000 + 999)
        throw new Error()
    } catch {
      throw new LogQueryError('无效的日志游标')
    }
  }
  return { filters, cursor }
}

/** 游标和行 id 用同一种编码：时间戳、base64url 的实例、32 位十六进制排序键。 */
function encodeSortKey({ timestampUs, instance, key }: SortKey): string {
  return `${timestampUs}-${Buffer.from(instance).toString('base64url')}-${key}`
}

function decodeSortKey(value: string): SortKey {
  const match = /^(\d{1,20})-([A-Za-z0-9_-]{0,600})-([0-9a-f]{32})$/.exec(value)
  const timestampUs = Number(match?.[1])
  if (!match || !Number.isSafeInteger(timestampUs)) throw new LogQueryError('无效的日志 ID')
  return {
    timestampUs,
    instance: Buffer.from(match[2]!, 'base64url').toString(),
    key: match[3]!,
  }
}

/**
 * 按排序键（时间戳倒序，再按实例、排序键正序）比某行更「旧」或更「新」的条件。
 * `older` 用于翻页和取前面的上下文，`newer` 取后面的上下文。
 */
function beyond(exprs: LogSql, at: SortKey, direction: 'older' | 'newer'): string {
  const ts = at.timestampUs
  const instance = sqlString(at.instance)
  const key = sqlString(at.key)
  const [time, tie] = direction === 'older' ? ['<', '>'] : ['>', '<']
  return `(_timestamp ${time} ${ts} OR (_timestamp = ${ts} AND (${exprs.instance} ${tie} ${instance} OR (${exprs.instance} = ${instance} AND ${exprs.key} ${tie} ${key}))))`
}

/** 筛选条件拼成 OpenObserve SQL 的 WHERE；级别单独返回，级别分面要不带它再算一遍。 */
export function logWhere(
  filters: ServerLogFilters,
  exprs: LogSql,
): { base: string[]; level: string | null } {
  const base: string[] = []
  const equals = (expression: string, value: string | undefined) => {
    // 字段不在流里，等值条件必然不成立。
    if (value) base.push(expression === 'NULL' ? '1 = 0' : `${expression} = ${sqlString(value)}`)
  }
  equals(exprs.service, filters.service)
  if (filters.deployment)
    equals(exprs.col('deployment_environment_name'), `image-playground-${filters.deployment}`)
  equals(exprs.col('source'), filters.stream)
  equals(exprs.col('requestid'), filters.requestId)
  equals(exprs.col('taskid'), filters.taskId)
  equals(exprs.col('trace_id'), filters.traceId)
  equals(exprs.col('userid'), filters.userId)
  equals(exprs.col('mediaid'), filters.mediaId)
  equals(exprs.instance, filters.instance)
  equals(exprs.col('version'), filters.version)
  equals(exprs.group, filters.group)
  if (filters.q) {
    const q = sqlString(filters.q)
    const columns = SEARCH_FIELDS.map(exprs.col).filter((column) => column !== 'NULL')
    base.push(
      columns.length
        ? `(${columns.map((column) => `str_match_ignore_case(${column}, ${q})`).join(' OR ')})`
        : '1 = 0',
    )
  }
  const floor = filters.level ? SEVERITY_FLOOR[filters.level] : null
  const level =
    floor === null ? null : `${exprs.severity} >= ${floor} AND ${exprs.severity} < ${floor + 4}`
  return { base, level }
}

const where = (clauses: readonly string[]) =>
  clauses.length ? ` WHERE ${clauses.join(' AND ')}` : ''

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
  'log_group',
  'log_instance',
  'log_key',
  'log_service',
  'container_id',
  'fluent_tag',
  'dropped_attributes_count',
  'deployment_environment_name',
  'flags',
  'time',
])

const FIELD_NAMES: Record<string, string> = { userid: 'userId', mediaid: 'mediaId' }

/** 记录须由 `logSql().record` 查出：带 log_group、log_instance、log_key、log_service。 */
export function toEntry(hit: ObsRecord): ServerLogEntry {
  const timestampUs = Number(hit._timestamp)
  const instance = String(hit.log_instance ?? hit.instance ?? hit.container_name ?? '')
  const message = String(hit.body ?? '')
  const event = typeof hit.event === 'string' && hit.event ? hit.event : null
  const service = SERVER_LOG_SERVICES.includes(hit.log_service as never)
    ? (hit.log_service as ServerLogService)
    : 'other'
  const fields = Object.fromEntries(
    Object.entries(hit)
      .filter(([key, value]) => !OMITTED.has(key) && value !== null)
      // 页面按 pino 原名找用户和图片；OpenObserve 把字段名转成了小写。
      .map(([key, value]) => [FIELD_NAMES[key] ?? key, value]),
  )
  // 没有链路的行，OTel 可能写全零的 trace id：当作没有，页面不给「同链路」。
  if (typeof fields.trace_id === 'string' && !/^(?!0+$)[0-9a-f]{32}$/.test(fields.trace_id)) {
    delete fields.trace_id
    delete fields.span_id
  }
  // `other` 归不进固定的服务名单：原名留在 fields 里，排查时看得到是哪个容器。
  if (service === 'other' && hit.service) fields.service = hit.service
  return {
    id: encodeSortKey({ timestampUs, instance, key: String(hit.log_key ?? '').padEnd(32, '0') }),
    at: Math.floor(timestampUs / 1_000),
    service,
    instance,
    version: String(hit.version ?? ''),
    level: levelOf(hit.severity_number),
    event,
    group_key: typeof hit.log_group === 'string' ? hit.log_group : (event ?? message.slice(0, 120)),
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
  const { filters, cursor } = query
  const exprs = logSql(await logFields(client))
  const { base, level } = logWhere(filters, exprs)
  const all = level ? [...base, level] : base
  const range = { type: 'logs' as const, startMs: filters.from, endMs: filters.to }
  const select = (statement: string, size = 1_000) =>
    client.search({ ...range, sql: statement, size })

  async function readPage(): Promise<ServerLogPage> {
    // 键集翻页：按上一页最后一行的排序键往后取，期间写进来的新日志不会让下一页重复或漏行。
    const clauses = cursor ? [...all, beyond(exprs, cursor, 'older')] : all
    const hits = await select(
      `${exprs.record}${where(clauses)} ORDER BY _timestamp DESC, log_instance, log_key`,
      PAGE_SIZE + 1,
    )
    const entries = hits.slice(0, PAGE_SIZE).map(toEntry)
    const last = entries.at(-1)
    return { entries, nextCursor: hits.length > PAGE_SIZE && last ? last.id : null }
  }
  // 后面的页只要记录，整段统计只在第一页给。
  if (cursor) return readPage()

  const bucket_ms = Math.max(60_000, Math.ceil((filters.to - filters.from) / 60 / 60_000) * 60_000)
  const bucketUs = bucket_ms * 1_000
  const errors = `SUM(CASE WHEN ${exprs.severity} >= 17 THEN 1 ELSE 0 END)`
  const warnings = `SUM(CASE WHEN ${exprs.severity} >= 13 AND ${exprs.severity} < 17 THEN 1 ELSE 0 END)`
  const bucket = `CAST(_timestamp / ${bucketUs} AS BIGINT) * ${bucketUs}`
  const [records, totals, groups, points, levels, collectors] = await Promise.all([
    readPage(),
    select(
      `SELECT COUNT(*) AS total, ${errors} AS errors, ${warnings} AS warnings FROM "${OBS_STREAM}"${where(all)}`,
      1,
    ),
    select(
      `SELECT ${exprs.service} AS service, ${exprs.level} AS level, ${exprs.group} AS key, COUNT(*) AS count, MIN(_timestamp) AS first_at, MAX(_timestamp) AS last_at FROM "${OBS_STREAM}"${where(all)} GROUP BY ${exprs.service}, ${exprs.level}, ${exprs.group} ORDER BY count DESC, last_at DESC LIMIT 30`,
      30,
    ),
    select(
      `SELECT ${bucket} AS bucket, COUNT(*) AS count, ${errors} AS errors, ${warnings} AS warnings FROM "${OBS_STREAM}"${where(all)} GROUP BY ${bucket} ORDER BY bucket`,
      2_000,
    ),
    select(
      `SELECT ${exprs.level} AS level, COUNT(*) AS count FROM "${OBS_STREAM}"${where(base)} GROUP BY ${exprs.level}`,
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

/** 同一容器按排序键前后各 50 行，加上这一行本身；与当前筛选无关。 */
export async function readLogContext(
  id: string,
  client: ObsClient = defaultClient(),
): Promise<ServerLogEntry[]> {
  const target = decodeSortKey(id)
  const exprs = logSql(await logFields(client))
  const at = target.timestampUs / 1_000
  // 一天的窗口足够取到前后 50 行，又不让查询扫太多分区。
  const range = { type: 'logs' as const, startMs: at - 86_400_000, endMs: at + 86_400_000 }
  const scope = `${exprs.instance} = ${sqlString(target.instance)}`
  const [older, self, newer] = await Promise.all([
    client.search({
      ...range,
      sql: `${exprs.record} WHERE ${scope} AND ${beyond(exprs, target, 'older')} ORDER BY _timestamp DESC, log_instance, log_key`,
      size: CONTEXT_LINES,
    }),
    client.search({
      ...range,
      sql: `${exprs.record} WHERE ${scope} AND _timestamp = ${target.timestampUs} AND ${exprs.key} = ${sqlString(target.key)}`,
      size: 1,
    }),
    client.search({
      ...range,
      sql: `${exprs.record} WHERE ${scope} AND ${beyond(exprs, target, 'newer')} ORDER BY _timestamp, log_instance DESC, log_key DESC`,
      size: CONTEXT_LINES,
    }),
  ])
  // 页面按时间正序展示：最新的在最后。
  return [...newer.reverse(), ...self, ...older].reverse().map(toEntry)
}

export interface TraceView {
  /** 缩进的 span 树，和 `bun scripts/obs.ts trace` 的输出一样。 */
  tree: string
  spans: number
  truncated: boolean
}

/** 链路围绕所选日志的时间查（前后一天）；没给时间就查最近 7 天。 */
export async function readTrace(
  traceId: string,
  at: number | undefined,
  client: ObsClient = defaultClient(),
  now = Date.now(),
): Promise<TraceView> {
  if (!/^(?!0+$)[0-9a-f]{32}$/.test(traceId)) throw new LogQueryError('无效的 trace id')
  if (at !== undefined && (!Number.isSafeInteger(at) || at <= 0 || at > now + 60_000))
    throw new LogQueryError('无效的链路时间')
  const range =
    at === undefined
      ? { startMs: now - MAX_WINDOW, endMs: now + 60_000 }
      : { startMs: at - 86_400_000, endMs: Math.min(at + 86_400_000, now + 60_000) }
  const { records, truncated } = await client.searchAll({
    sql: traceSql(traceId),
    type: 'traces',
    ...range,
  })
  return { tree: formatTrace(records), spans: records.length, truncated }
}
