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
import { logFields, logSql, obsClientOrNull, toEntry } from './server-logs'

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

/** 给定时间段（毫秒），返回这段时间里分类要用的日志行。 */
export type ServerLogSource = (from: number, to: number) => Promise<LegacyLogRow[]>

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

/** 当前的来源；没开 OpenObserve 的部署没有服务端日志可读，返回空。 */
export function serverLogSource(): ServerLogSource {
  if (override) return override
  const client = obsClientOrNull()
  return client ? obsServerLogSource(client) : async () => []
}

/**
 * OpenObserve 的记录转成 `server_logs` 的行。字段名还原成 pino 原名：Collector 把嵌套字段展平、
 * 名字转小写（`err.stack` → `err_stack`，`errorCode` → `errorcode`），旧 SQL 和页面按原名读。
 */
export function legacyRow(hit: ObsRecord): LegacyLogRow {
  const entry = toEntry(hit)
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
  return async (from, to) => {
    const exprs = logSql(await logFields(client))
    const range = { type: 'logs' as const, startMs: from, endMs: to }
    const all = async (where: string) =>
      (
        await client.searchAll(
          {
            ...range,
            sql: `${exprs.record} WHERE ${where} ORDER BY _timestamp DESC, log_instance, log_key`,
          },
          { maxPages: MAX_PAGES },
        )
      ).records
    const body = exprs.col('body')
    const tunnel = [
      'Registered tunnel connection',
      'Serve tunnel error',
      'Lost connection with the edge',
    ]
      .map((text) => `str_match(${body}, ${sqlString(text)})`)
      .join(' OR ')
    const [errors, tunnels] = await Promise.all([
      all(`${exprs.severity} >= 17`),
      all(`${exprs.service} = 'cloudflared' AND (${tunnel})`),
    ])
    const requestColumn = exprs.col('requestid')
    const causeColumns = CAUSE_FIELDS.map(exprs.col).filter((column) => column !== 'NULL')
    const requestIds = [
      ...new Set(
        errors.map((hit) => hit.requestid).filter((id): id is string => typeof id === 'string'),
      ),
    ]
    const causes: ObsRecord[] = []
    if (requestColumn !== 'NULL' && causeColumns.length > 0) {
      for (let index = 0; index < requestIds.length; index += REQUEST_CHUNK) {
        const ids = requestIds
          .slice(index, index + REQUEST_CHUNK)
          .map(sqlString)
          .join(', ')
        causes.push(
          ...(await all(
            `${requestColumn} IN (${ids}) AND (${causeColumns.map((column) => `${column} IS NOT NULL`).join(' OR ')})`,
          )),
        )
      }
    }
    const rows = new Map<string, LegacyLogRow>()
    for (const hit of [...errors, ...tunnels, ...causes]) {
      const row = legacyRow(hit)
      rows.set(row.id, row)
    }
    return [...rows.values()]
  }
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
