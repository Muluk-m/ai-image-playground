import {
  resolvedTaskArchivePayload,
  resolvedTaskRequestPayload,
  resolvedTaskResultPayload,
} from '@image-playground/db'
import { and, eq, isNull, or } from 'drizzle-orm'
import { db, schema } from '../../db/client'

/**
 * Ownership is a row fact, not a deployment switch. Anonymous rows remain public; an owned row
 * requires the matching user even if account login is later disabled. The Admin service identity
 * bypasses only ownership and still preserves the task-ID predicate.
 */
export function taskAccessWhere(taskId: string, userId: string | null, serviceIdentity = false) {
  // 对话轮的 task id 就是 turnId，前端本来就拿着它；不挡住，取消端点会替它再结算一次。
  const queueTask = and(eq(schema.tasks.id, taskId), eq(schema.tasks.kind, 'queue'))
  if (serviceIdentity) return queueTask
  return and(
    queueTask,
    userId === null
      ? isNull(schema.tasks.user_id)
      : or(isNull(schema.tasks.user_id), eq(schema.tasks.user_id, userId)),
  )
}

export async function findAccessibleTaskState(taskId: string, userId: string | null) {
  const [task] = await db
    .select({ id: schema.tasks.id, status: schema.tasks.status })
    .from(schema.tasks)
    .where(taskAccessWhere(taskId, userId))
    .limit(1)
  return task ?? null
}

export async function findAccessibleTaskStatus(
  taskId: string,
  userId: string | null,
  serviceIdentity = false,
) {
  const [task] = await db
    .select({
      id: schema.tasks.id,
      status: schema.tasks.status,
      submitted_at: schema.tasks.submitted_at,
      started_at: schema.tasks.started_at,
      completed_at: schema.tasks.completed_at,
      error_message: schema.tasks.error_message,
      error_type: schema.tasks.error_type,
      provider: schema.tasks.provider,
      request_payload: resolvedTaskRequestPayload,
      result_payload: resolvedTaskResultPayload,
      archive_payload: resolvedTaskArchivePayload,
      upstream_task_ids: schema.tasks.upstream_task_ids,
      lease_expires_at: schema.tasks.lease_expires_at,
    })
    .from(schema.tasks)
    .leftJoin(schema.task_payloads, eq(schema.task_payloads.task_id, schema.tasks.id))
    .where(taskAccessWhere(taskId, userId, serviceIdentity))
    .limit(1)
  return task ?? null
}

export async function findAccessibleTaskResult(
  taskId: string,
  userId: string | null,
  serviceIdentity = false,
) {
  const [task] = await db
    .select({
      id: schema.tasks.id,
      status: schema.tasks.status,
      provider: schema.tasks.provider,
      request_payload: resolvedTaskRequestPayload,
      result_payload: resolvedTaskResultPayload,
      error_message: schema.tasks.error_message,
      error_type: schema.tasks.error_type,
    })
    .from(schema.tasks)
    .leftJoin(schema.task_payloads, eq(schema.task_payloads.task_id, schema.tasks.id))
    .where(taskAccessWhere(taskId, userId, serviceIdentity))
    .limit(1)
  return task ?? null
}

export async function findAccessibleTaskInput(
  taskId: string,
  userId: string | null,
  serviceIdentity = false,
) {
  const [task] = await db
    .select({
      provider: schema.tasks.provider,
      request_payload: resolvedTaskRequestPayload,
      user_id: schema.tasks.user_id,
    })
    .from(schema.tasks)
    .leftJoin(schema.task_payloads, eq(schema.task_payloads.task_id, schema.tasks.id))
    .where(taskAccessWhere(taskId, userId, serviceIdentity))
    .limit(1)
  return task ?? null
}

export async function findAccessibleTaskOutput(
  taskId: string,
  userId: string | null,
  serviceIdentity = false,
) {
  const [task] = await db
    .select({
      id: schema.tasks.id,
      status: schema.tasks.status,
      provider: schema.tasks.provider,
      result_payload: resolvedTaskResultPayload,
      user_id: schema.tasks.user_id,
    })
    .from(schema.tasks)
    .leftJoin(schema.task_payloads, eq(schema.task_payloads.task_id, schema.tasks.id))
    .where(taskAccessWhere(taskId, userId, serviceIdentity))
    .limit(1)
  return task ?? null
}

export async function findAccessibleTaskSourceVideo(taskId: string, userId: string | null) {
  const [task] = await db
    .select({
      status: schema.tasks.status,
      provider: schema.tasks.provider,
      result_payload: resolvedTaskResultPayload,
    })
    .from(schema.tasks)
    .leftJoin(schema.task_payloads, eq(schema.task_payloads.task_id, schema.tasks.id))
    .where(taskAccessWhere(taskId, userId))
    .limit(1)
  return task ?? null
}
