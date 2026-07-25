import type { StatusResponse, TaskErrorType } from '@image-playground/shared'
import { Elysia, t } from 'elysia'
import { db, schema } from '../db/client'
import { extractMeta } from '../lib/extractImages'
import { asQueueProvider } from '../lib/queueProvider'
import { taskAccessWhere } from '../lib/task-access'
import { requireUser } from '../lib/user-auth'

/**
 * GET /v1/queue/requests/:id/status
 *
 * completed 时把 result 元信息（images, actual_params, raw_image_urls）也塞进
 * 同一份响应。前端 poll 拿到 completed 就直接拿到图列表，省一次 GET /requests/:id。
 * 二进制还是 GET /image/{index} 单拉，不放进 JSON。
 */
export const statusRoutes = new Elysia().use(requireUser).get(
  '/v1/queue/requests/:id/status',
  async ({ params, status, authUser }) => {
    const [task] = await db
      .select()
      .from(schema.tasks)
      .where(taskAccessWhere(params.id, authUser?.id ?? null))
      .limit(1)

    if (!task) return status(404, { error: 'task_not_found' })

    const base: StatusResponse = {
      request_id: task.id,
      status: task.status,
      submitted_at: task.submitted_at,
      ...(task.started_at != null ? { started_at: task.started_at } : {}),
      ...(task.completed_at != null ? { completed_at: task.completed_at } : {}),
    }

    if (task.status === 'failed' && task.error_message) {
      base.error = {
        message: task.error_message,
        type: (task.error_type ?? 'unknown') as TaskErrorType,
      }
    }

    if (task.status === 'completed') {
      const provider = asQueueProvider(task.provider)
      if (provider) {
        const meta = extractMeta(provider, task.result_payload)
        base.result = {
          images: meta.images,
          ...(meta.actual_params ? { actual_params: meta.actual_params } : {}),
          ...(meta.raw_image_urls ? { raw_image_urls: meta.raw_image_urls } : {}),
        }
      }
    }

    return base
  },
  { params: t.Object({ id: t.String() }) },
)
