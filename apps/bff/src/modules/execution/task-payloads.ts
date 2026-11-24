import type { NewTaskPayload, TaskPayload } from '@image-playground/db'
import { eq, inArray, sql } from 'drizzle-orm'
import { schema } from '../../db/client'
import type { ExecutionTransaction } from './task-lifecycle-bus'

/**
 * 同事务将 `tasks` 行上的 5 个冷载荷列镜像到 `task_payloads`（ADR 0034 Phase 5 Expand/Dual-Write）。
 * 采用 `INSERT ... SELECT FROM tasks ... ON CONFLICT DO UPDATE`，保证：
 * 1. 新建任务、局部列更新与 SQL 级 JSONB 合并都与 `tasks` 保持严格一致；
 * 2. 滚动发布期间更新回填前的旧 `tasks` 行时，也能一次补齐完整 `task_payloads` 记录。
 */
export async function syncTaskPayloads(
  tx: Pick<ExecutionTransaction, 'execute'>,
  taskIds: readonly string[],
): Promise<void> {
  const uniqueIds = [...new Set(taskIds)]
  if (uniqueIds.length === 0) return
  const idList = sql.join(
    uniqueIds.map((id) => sql`${id}`),
    sql`, `,
  )
  await tx.execute(sql`
    INSERT INTO task_payloads (
      task_id, request_payload, metering, result_payload, archive_payload, upstream_body
    )
    SELECT id, request_payload, metering, result_payload, archive_payload, upstream_body
    FROM tasks
    WHERE id IN (${idList})
    ON CONFLICT (task_id) DO UPDATE SET
      request_payload = EXCLUDED.request_payload,
      metering = EXCLUDED.metering,
      result_payload = EXCLUDED.result_payload,
      archive_payload = EXCLUDED.archive_payload,
      upstream_body = EXCLUDED.upstream_body
    WHERE
      task_payloads.request_payload IS DISTINCT FROM EXCLUDED.request_payload
      OR task_payloads.metering IS DISTINCT FROM EXCLUDED.metering
      OR task_payloads.result_payload IS DISTINCT FROM EXCLUDED.result_payload
      OR task_payloads.archive_payload IS DISTINCT FROM EXCLUDED.archive_payload
      OR task_payloads.upstream_body IS DISTINCT FROM EXCLUDED.upstream_body
  `)
}

/**
 * 按主键批量读取 `task_payloads` 冷载荷行，供 `FOR UPDATE` / `UPDATE ... RETURNING`
 * 这类不能对可空侧做 `LEFT JOIN` 的事务路径在拿锁后覆盖读取，未回填时由调用方回落到 `tasks` 旧列。
 */
export async function readTaskPayloads(
  executor: Pick<ExecutionTransaction, 'select'>,
  taskIds: readonly string[],
): Promise<Map<string, TaskPayload>> {
  const uniqueIds = [...new Set(taskIds)]
  if (uniqueIds.length === 0) return new Map()
  const rows = await executor
    .select()
    .from(schema.task_payloads)
    .where(inArray(schema.task_payloads.task_id, uniqueIds))
  return new Map(rows.map((row) => [row.task_id, row]))
}

/**
 * 局部更新已存在的 `task_payloads` 行（不覆盖未改动列），若冷表尚未回填则回落到全量 `syncTaskPayloads`。
 */
export async function patchTaskPayload(
  tx: Pick<ExecutionTransaction, 'update' | 'execute'>,
  taskId: string,
  patch: Partial<Omit<NewTaskPayload, 'task_id'>>,
): Promise<void> {
  if (Object.keys(patch).length === 0) return
  const updated = await tx
    .update(schema.task_payloads)
    .set(patch)
    .where(eq(schema.task_payloads.task_id, taskId))
    .returning({ taskId: schema.task_payloads.task_id })
  if (updated.length === 0) await syncTaskPayloads(tx, [taskId])
}
