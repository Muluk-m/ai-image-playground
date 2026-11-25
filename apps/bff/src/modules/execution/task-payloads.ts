import type { NewTaskPayload, TaskPayload } from '@image-playground/db'
import { inArray } from 'drizzle-orm'
import { schema } from '../../db/client'
import type { ExecutionTransaction } from './task-lifecycle-bus'

/**
 * 同事务写入任务冷载荷行（ADR 0034 Contract 1a：新任务不再写 `tasks` 的 5 个冷载荷列）。
 */
export async function insertTaskPayload(
  tx: Pick<ExecutionTransaction, 'insert'>,
  payload: NewTaskPayload,
): Promise<void> {
  await tx.insert(schema.task_payloads).values(payload)
}

/**
 * 按主键批量读取 `task_payloads` 冷载荷行，供 `FOR UPDATE` / `UPDATE ... RETURNING`
 * 这类不能对可空侧做 `LEFT JOIN` 的事务路径在拿锁后读取冷载荷。
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
 * 批量局部更新 `task_payloads` 行（只覆盖本次修改列，保留其余冷列）。
 */
export async function patchTaskPayloads(
  tx: Pick<ExecutionTransaction, 'update'>,
  taskIds: readonly string[],
  patch: Partial<Omit<NewTaskPayload, 'task_id'>>,
): Promise<void> {
  const uniqueIds = [...new Set(taskIds)]
  if (uniqueIds.length === 0 || Object.keys(patch).length === 0) return
  await tx
    .update(schema.task_payloads)
    .set(patch)
    .where(inArray(schema.task_payloads.task_id, uniqueIds))
}

/** 单条任务的局部冷载荷回写便捷封装。 */
export async function patchTaskPayload(
  tx: Pick<ExecutionTransaction, 'update'>,
  taskId: string,
  patch: Partial<Omit<NewTaskPayload, 'task_id'>>,
): Promise<void> {
  await patchTaskPayloads(tx, [taskId], patch)
}
