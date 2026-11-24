import { sql } from 'drizzle-orm'
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
  `)
}
