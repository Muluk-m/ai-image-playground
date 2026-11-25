import type { PersistedSubmitRequest } from '@image-playground/shared'
import { sql } from 'drizzle-orm'
import { type TaskMeteringSnapshot, task_payloads, tasks } from './schemas/execution'

/**
 * `task_payloads` 冷载荷投影（ADR 0034 Contract 1a）：
 * 已全量回填并停写 `tasks` 旧冷列，直接读取 `task_payloads` 且不再引用 `tasks` 的 5 个冷列，
 * 保证 Wave 2 删列零停机。使用前须对 `schema.task_payloads` 做 `LEFT JOIN`。
 */
export const resolvedTaskRequestPayload = sql<PersistedSubmitRequest>`${task_payloads.request_payload}`

export const resolvedTaskMetering = sql<TaskMeteringSnapshot | null>`${task_payloads.metering}`

export const resolvedTaskResultPayload = sql<unknown>`${task_payloads.result_payload}`

export const resolvedTaskArchivePayload = sql<unknown>`${task_payloads.archive_payload}`

export const resolvedTaskUpstreamBody = sql<string | null>`${task_payloads.upstream_body}`

/**
 * 无需 LEFT JOIN 的相关子查询版 `request_payload`（用于 `DELETE`/`UPDATE` 或 `FOR UPDATE` 锁行语句）。
 */
export const taskRequestPayloadSubquerySql = sql<PersistedSubmitRequest>`(SELECT ${task_payloads.request_payload} FROM ${task_payloads} WHERE ${task_payloads.task_id} = ${tasks.id})`

/**
 * 无需 LEFT JOIN 的 `archive_payload IS NOT NULL` 判定（直接查 `task_payloads`，恒返回非空 boolean）。
 */
export const taskHasArchivePayloadSql = sql<boolean>`EXISTS (SELECT 1 FROM ${task_payloads} WHERE ${task_payloads.task_id} = ${tasks.id} AND ${task_payloads.archive_payload} IS NOT NULL)`

/**
 * 带显式 `tasks` 表别名的 `archive_payload IS NOT NULL` 判定（如 `retryHoldsSlot(alias, now)`）。
 */
export function taskHasArchivePayloadSqlForAlias(alias: string) {
  const t = sql.identifier(alias)
  return sql<boolean>`EXISTS (SELECT 1 FROM ${task_payloads} tp WHERE tp.task_id = ${t}.id AND tp.archive_payload IS NOT NULL)`
}
