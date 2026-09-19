import type { StatusResponse, TaskErrorType } from '@image-playground/shared'
import { Elysia, t } from 'elysia'
import { db, schema } from '../db/client'
import { extractMeta } from '../lib/extractImages'
import { readGeneration } from '../lib/generations'
import { asQueueProvider } from '../lib/queueProvider'
import { taskAccessWhere } from '../lib/task-access'
import { taskProgressPhase } from '../lib/task-progress'
import { requireUserOrService } from '../lib/user-auth'

/**
 * GET /v1/queue/requests/:id/status
 *
 * completed 时把 result 元信息（images, actual_params, raw_image_urls）也塞进
 * 同一份响应。前端 poll 拿到 completed 就直接拿到图列表，省一次 GET /requests/:id。
 * 二进制还是 GET /image/{index} 单拉，不放进 JSON。
 */
export const statusRoutes = new Elysia().use(requireUserOrService).get(
  '/v1/queue/requests/:id/status',
  async ({ params, status, authUser, serviceIdentity }) => {
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
        result_payload: schema.tasks.result_payload,
        archive_payload: schema.tasks.archive_payload,
        upstream_task_ids: schema.tasks.upstream_task_ids,
        lease_expires_at: schema.tasks.lease_expires_at,
      })
      .from(schema.tasks)
      .where(taskAccessWhere(params.id, authUser?.id ?? null, serviceIdentity))
      .limit(1)

    if (!task) {
      const generation = authUser && (await readGeneration(authUser.id, params.id))
      if (!generation) return status(404, { error: 'task_not_found' })
      return {
        request_id: generation.id,
        status: generation.status,
        submitted_at: generation.createdAt,
        ...(generation.startedAt != null ? { started_at: generation.startedAt } : {}),
        ...(generation.completedAt != null ? { completed_at: generation.completedAt } : {}),
        ...(generation.status === 'completed'
          ? {
              result: {
                images: generation.outputs.map((image) => ({
                  index: image.index,
                  mime: image.contentType,
                })),
                actual_params: generation.actualParameters,
              },
            }
          : {}),
      } satisfies StatusResponse
    }

    const base: StatusResponse = {
      request_id: task.id,
      status: task.status,
      ...(task.status === 'queued' || task.status === 'in_progress'
        ? { phase: taskProgressPhase(task) }
        : {}),
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

export { taskProgressPhase }
