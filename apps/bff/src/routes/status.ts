import {
  IMAGE26_DEGRADE_KINDS,
  type Image26DegradeKind,
  type StatusResponse,
  type TaskErrorType,
} from '@image-playground/shared'
import { Elysia, t } from 'elysia'
import { extractMeta } from '../lib/extractImages'
import { readGeneration } from '../lib/generations'
import { publicTaskErrorMessage } from '../lib/public-task-error'
import { asQueueProvider } from '../lib/queueProvider'
import { taskProgressPhase } from '../lib/task-progress'
import { partialFailureField } from '../lib/upstream/partial'
import { requireUserOrService } from '../lib/user-auth'
import { findAccessibleTaskStatus } from '../modules/execution'

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
    const task = await findAccessibleTaskStatus(params.id, authUser?.id ?? null, serviceIdentity)

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
      ...(task.status === 'queued' || task.status === 'in_progress' || task.status === 'reconciling'
        ? { phase: taskProgressPhase(task) }
        : {}),
      submitted_at: task.submitted_at,
      ...(task.started_at != null ? { started_at: task.started_at } : {}),
      ...(task.completed_at != null ? { completed_at: task.completed_at } : {}),
    }

    if (task.status === 'failed' && task.error_message) {
      base.error = {
        message: publicTaskErrorMessage(task.error_message),
        type: (task.error_type ?? 'unknown') as TaskErrorType,
      }
    }

    if (task.status === 'completed') {
      const provider = asQueueProvider(task.provider)
      if (provider) {
        const meta = extractMeta(provider, task.result_payload)
        const degrade = task.request_payload.image26_degrade?.kind
        const degradeNotice = (IMAGE26_DEGRADE_KINDS as readonly string[]).includes(degrade ?? '')
          ? (degrade as Image26DegradeKind)
          : undefined
        base.result = {
          images: meta.images,
          ...(meta.actual_params ? { actual_params: meta.actual_params } : {}),
          ...(meta.raw_image_urls ? { raw_image_urls: meta.raw_image_urls } : {}),
          ...partialFailureField(task.result_payload),
          ...(degradeNotice ? { degrade_notice: degradeNotice } : {}),
        }
      }
    }

    return base
  },
  { params: t.Object({ id: t.String() }) },
)

export { taskProgressPhase }
