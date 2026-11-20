/**
 * 概览错误面板与错误恢复判定的服务端日志来源（ADR 0033 P3-3，#1937）。
 *
 * 分类规则（任务是否恢复、cloudflared 是否重连、关联请求里的原因）原本是一段读 `server_logs` 的 SQL，
 * 和任务、前端错误、恢复记录一起在 PostgreSQL 里关联。日志搬到 OpenObserve 之后，这里把那段 SQL
 * 用得到的日志行从 OpenObserve 取出来，转成 `server_logs` 的行形状，以同名 CTE 交给原来的 SQL：
 * 规则一行不改，只换了日志从哪来。
 *
 * 取哪些行：时间段内的 ERROR/FATAL；cloudflared 的注册、断开与 Serve tunnel error（重连判定用）；
 * 与这些错误同一请求的、带原因字段的行（展示原因用）。
 */
import type { ObsClient, ObsRecord } from '@image-playground/node-kit'
import { sqlString } from '@image-playground/shared'
import { type SQL, sql } from 'drizzle-orm'
import type { ServerLogAvailability } from '../../contracts'
import { logFields, logSql, obsClientOrNull, toEntry } from './server-logs'

type LogSql = ReturnType<typeof logSql>

/** `server_logs` 一行，SQL 用得到的列。 */
export interface LegacyLogRow {
  id: string
  at: string
  service: string
  instance: string
  version: string
  level: string
  event: string | null
  group_key: string
  message: string
  request_id: string | null
  task_id: string | null
  fields: Record<string, unknown>
}

/**
 * 日志读得全不全：`truncated` 是错误多到被截断（总数是下限），`unavailable` 是这次没读到
 * OpenObserve，`off` 是这个部署没开观测。后两种的服务端错误都不是「没有」，是「不知道」。
 */
export type LogAvailability = ServerLogAvailability

export interface ServerLogBatch {
  rows: LegacyLogRow[]
  availability: LogAvailability
}

export interface ServerLogSource {
  /**
   * 这段时间（毫秒）里分类要用的行：ERROR/FATAL，加上 cloudflared 的重连证据。
   * `errorsOnly` 只要错误（概览动态只列最新几条，用不上隧道行）。
   */
  logs(from: number, to: number, options?: { errorsOnly?: boolean }): Promise<ServerLogBatch>
  /** 这些请求里带原因字段的行，只给面板上实际展示的错误补查。 */
  causes(requestIds: readonly string[], from: number, to: number): Promise<LegacyLogRow[]>
}

/** 一次最多取这么多条错误：再多也只展示最新的 10 条，总数会偏小，但不至于拖垮概览。 */
const MAX_PAGES = 5
const REQUEST_CHUNK = 100
/** 原因字段：旧 SQL 用 `fields ? 'errorCode' / 'reason' / 'err' / 'error'` 判断。 */
const CAUSE_FIELDS = ['errorcode', 'reason', 'err', 'err_message', 'error', 'error_message']

let override: ServerLogSource | undefined
/** 仅供测试：注入来源（例如直接读 `server_logs` 表）。 */
export function _setServerLogSourceForTesting(source: ServerLogSource | undefined): void {
  override = source
}

const EMPTY: ServerLogSource = {
  async logs() {
    return { rows: [], availability: 'off' }
  },
  async causes() {
    return []
  },
}

/**
 * 当前的来源。没开 OpenObserve 的部署读不到服务端日志；OpenObserve 一时读不到时标成
 * `unavailable`：概览里的任务、用户和前端错误只依赖 PostgreSQL，不能被日志拖垮，但也不能把
 * 「没读到」显示成「没有错误」。
 */
export function serverLogSource(): ServerLogSource {
  if (override) return override
  const client = obsClientOrNull()
  if (!client) return EMPTY
  const source = obsServerLogSource(client)
  return {
    async logs(from, to, options) {
      try {
        return await source.logs(from, to, options)
      } catch (error) {
        console.error('[overview] server logs unavailable from OpenObserve', error)
        return { rows: [], availability: 'unavailable' }
      }
    },
    async causes(requestIds, from, to) {
      try {
        return await source.causes(requestIds, from, to)
      } catch (error) {
        console.error('[overview] cause lines unavailable from OpenObserve', error)
        return []
      }
    },
  }
}

/** PostgreSQL 的 text 与 jsonb 都存不了 NUL：容器吐出的二进制会让整个 `::jsonb` 失败。 */
function withoutNul(value: unknown): unknown {
  if (typeof value === 'string') return value.split('\u0000').join('')
  if (Array.isArray(value)) return value.map(withoutNul)
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([key, inner]) => [
        key.split('\u0000').join(''),
        withoutNul(inner),
      ]),
    )
  return value
}

/**
 * OpenObserve 的记录转成 `server_logs` 的行。字段名还原成 pino 原名：Collector 把嵌套字段展平、
 * 名字转小写（`err.stack` → `err_stack`，`errorCode` → `errorcode`），旧 SQL 和页面按原名读。
 */
export function legacyRow(hit: ObsRecord): LegacyLogRow {
  const entry = toEntry(withoutNul(hit) as ObsRecord)
  const raw = entry.fields
  const fields: Record<string, unknown> = { ...raw }
  const text = (key: string) =>
    typeof raw[key] === 'string' && raw[key] !== '' ? (raw[key] as string) : undefined
  const stack = text('stack') ?? text('err_stack') ?? text('error_stack')
  if (stack) fields.stack = stack
  if (text('err_message') || text('err_stack'))
    fields.err = { message: text('err_message'), stack: text('err_stack'), name: text('err_name') }
  if (!text('error') && text('error_message')) fields.error = { message: text('error_message') }
  if (text('errorcode')) fields.errorCode = text('errorcode')
  if (text('source')) fields.stream = text('source')
  return {
    id: entry.id,
    at: new Date(entry.at).toISOString(),
    service: entry.service,
    instance: entry.instance,
    version: entry.version,
    level: entry.level,
    event: entry.event,
    group_key: entry.group_key,
    message: entry.message,
    request_id: entry.request_id,
    task_id: entry.task_id,
    fields,
  }
}

export function obsServerLogSource(client: ObsClient): ServerLogSource {
  async function query(from: number, to: number, where: (exprs: LogSql) => string) {
    const exprs = logSql(await logFields(client))
    return client.searchAll(
      {
        type: 'logs',
        startMs: from,
        endMs: to,
        sql: `${exprs.record} WHERE ${where(exprs)} ORDER BY _timestamp DESC, log_instance, log_key`,
      },
      { maxPages: MAX_PAGES },
    )
  }
  return {
    async logs(from, to, options = {}) {
      const errors = await query(from, to, (exprs) => `${exprs.severity} >= 17`)
      // 截掉的是最旧的行：总数是下限，较早的错误可能缺恢复证据而判成「待确认」。
      const availability: LogAvailability = errors.truncated ? 'truncated' : 'complete'
      if (options.errorsOnly) return { rows: errors.records.map(legacyRow), availability }
      const tunnels = await query(from, to, (exprs) => {
        const body = exprs.col('body')
        const lines = [
          'Registered tunnel connection',
          'Serve tunnel error',
          'Lost connection with the edge',
        ]
          .map((text) => `str_match(${body}, ${sqlString(text)})`)
          .join(' OR ')
        return `${exprs.service} = 'cloudflared' AND (${lines})`
      })
      if (tunnels.truncated)
        console.warn(`[overview] tunnel lines truncated at ${tunnels.records.length} rows`)
      return { rows: unique([...errors.records, ...tunnels.records]), availability }
    },
    async causes(requestIds, from, to) {
      const exprs = logSql(await logFields(client))
      const requestColumn = exprs.col('requestid')
      const causeColumns = CAUSE_FIELDS.map(exprs.col).filter((column) => column !== 'NULL')
      if (requestColumn === 'NULL' || causeColumns.length === 0 || requestIds.length === 0)
        return []
      const found: ObsRecord[] = []
      for (let index = 0; index < requestIds.length; index += REQUEST_CHUNK) {
        const ids = requestIds
          .slice(index, index + REQUEST_CHUNK)
          .map(sqlString)
          .join(', ')
        const { records } = await query(
          from,
          to,
          () =>
            `${requestColumn} IN (${ids}) AND (${causeColumns.map((column) => `${column} IS NOT NULL`).join(' OR ')})`,
        )
        found.push(...records)
      }
      return unique(found)
    },
  }
}

function unique(records: readonly ObsRecord[]): LegacyLogRow[] {
  const rows = new Map<string, LegacyLogRow>()
  for (const record of records) {
    const row = legacyRow(record)
    rows.set(row.id, row)
  }
  return [...rows.values()]
}

/** 把来源的行做成名为 `server_logs` 的 CTE，放在原 SQL 的 WITH 里，遮住同名的表。 */
export function serverLogsCte(rows: readonly LegacyLogRow[]): SQL {
  return sql`server_logs AS (
    SELECT * FROM jsonb_to_recordset(${JSON.stringify(rows)}::jsonb) AS rows(
      id text, at timestamptz, service text, instance text, version text, level text, event text,
      group_key text, message text, request_id text, task_id text, fields jsonb
    )
  )`
}
