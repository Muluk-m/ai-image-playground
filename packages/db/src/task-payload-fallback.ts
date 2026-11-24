import type { PersistedSubmitRequest } from '@image-playground/shared'
import { sql } from 'drizzle-orm'
import { type TaskMeteringSnapshot, task_payloads, tasks } from './schemas/execution'

/**
 * Expand/Switch-Read 兼容投影（ADR 0034 Phase 5 / PR-5.3a）：
 * 只要 `task_payloads` 行存在就以冷表为准（包括显式清空为 NULL 的字段），
 * 仅当 `task_payloads` 尚未回填时回落到 `tasks` 旧列。
 * 使用前必须对 `schema.task_payloads` 做 `LEFT JOIN`（`eq(task_payloads.task_id, tasks.id)`）。
 */
export const resolvedTaskRequestPayload = sql<PersistedSubmitRequest>`(CASE WHEN ${task_payloads.task_id} IS NOT NULL THEN ${task_payloads.request_payload} ELSE ${tasks.request_payload} END)`

export const resolvedTaskMetering = sql<TaskMeteringSnapshot | null>`(CASE WHEN ${task_payloads.task_id} IS NOT NULL THEN ${task_payloads.metering} ELSE ${tasks.metering} END)`

export const resolvedTaskResultPayload = sql<unknown>`(CASE WHEN ${task_payloads.task_id} IS NOT NULL THEN ${task_payloads.result_payload} ELSE ${tasks.result_payload} END)`

export const resolvedTaskArchivePayload = sql<unknown>`(CASE WHEN ${task_payloads.task_id} IS NOT NULL THEN ${task_payloads.archive_payload} ELSE ${tasks.archive_payload} END)`

export const resolvedTaskUpstreamBody = sql<
  string | null
>`(CASE WHEN ${task_payloads.task_id} IS NOT NULL THEN ${task_payloads.upstream_body} ELSE ${tasks.upstream_body} END)`

/**
 * 无需 LEFT JOIN 的相关子查询版 `request_payload`（用于 `DELETE`/`UPDATE` 或 `FOR UPDATE` 锁行语句）。
 * `task_payloads.request_payload` 为 `NOT NULL`，因此仅在冷表缺行时回落到 `tasks.request_payload`。
 */
export const taskRequestPayloadSubquerySql = sql<PersistedSubmitRequest>`COALESCE((SELECT ${task_payloads.request_payload} FROM ${task_payloads} WHERE ${task_payloads.task_id} = ${tasks.id}), ${tasks.request_payload})`

/**
 * 无需 LEFT JOIN 的 `archive_payload IS NOT NULL` 判定（优先看 `task_payloads`，缺行才回落 `tasks`）。
 * 子查询返回 `boolean`（行存在时恒为 true/false 非 NULL），确保冷表已清空为 NULL 时不会误回落到旧列。
 */
export const taskHasArchivePayloadSql = sql<boolean>`COALESCE((SELECT ${task_payloads.archive_payload} IS NOT NULL FROM ${task_payloads} WHERE ${task_payloads.task_id} = ${tasks.id}), ${tasks.archive_payload} IS NOT NULL)`

/**
 * 带显式 `tasks` 表别名的 `archive_payload IS NOT NULL` 判定（如 `retryHoldsSlot(alias, now)`）。
 */
export function taskHasArchivePayloadSqlForAlias(alias: string) {
  const t = sql.identifier(alias)
  return sql<boolean>`COALESCE((SELECT tp.archive_payload IS NOT NULL FROM ${task_payloads} tp WHERE tp.task_id = ${t}.id), ${t}.archive_payload IS NOT NULL)`
}
