import { sql } from 'drizzle-orm'
import {
  decodeCursor,
  encodeCursor,
  type ReadModelsDbHandle,
  type Row,
  toEpochMs,
} from './sql-helpers'
import type { ListAuditsResult, ListOperatorAuditsOptions, OperatorAuditRow } from './types'

// 审计列表一页多少条。一行就是一句话（谁、什么时候、对谁做了什么），比任务列表轻得多，
// 所以默认页大一点；上限压在 100，别让一个 limit=100000 把整张表拉出来。
const AUDIT_PAGE_SIZE = 50
const AUDIT_PAGE_MAX = 100

/**
 * 运营审计流，从新到旧。分页按 (created_at, id) 做 keyset：同一毫秒里写进去好几条时
 * OFFSET 会漏行，而 `idx_operator_audits_created_at` 正好给这个排序兜底。
 */
export async function listOperatorAudits(
  handle: ReadModelsDbHandle,
  options: ListOperatorAuditsOptions,
): Promise<ListAuditsResult> {
  const { db } = handle
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
  const settingKeyFilter = options.settingKey
    ? sql`AND a.target_type = 'operator_config'
        AND (a.target_id = ${options.settingKey} OR a.details->>'settingKey' = ${options.settingKey})`
    : sql``
  const targetFilter = options.targetId ? sql`AND a.target_id = ${options.targetId}` : sql``
  const operatorFilter = options.operatorId ? sql`AND a.operator_id = ${options.operatorId}` : sql``
  const fromFilter =
    options.from !== undefined ? sql`AND a.created_at >= ${new Date(options.from)}` : sql``
  const toFilter =
    options.to !== undefined ? sql`AND a.created_at <= ${new Date(options.to)}` : sql``

  const rows = (await db.execute(sql`
    SELECT a.id, a.operator_id, a.action, a.target_type, a.target_id, a.details, a.created_at
    FROM operator_audits a
    WHERE TRUE
      ${actionFilter}
      ${settingKeyFilter}
      ${targetFilter}
      ${operatorFilter}
      ${fromFilter}
      ${toFilter}
      ${keyset}
    ORDER BY a.created_at DESC, a.id DESC
    LIMIT ${limit + 1}
  `)) as unknown as Row[]

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
