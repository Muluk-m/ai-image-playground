import type {
  PersistedSubmitRequest,
  PersistedVideoRequest,
  StoredImageRef,
  VideoRequest,
} from '@image-playground/shared'
import {
  validateVideoPrompt,
  validateVideoRequest,
  videoRateMultiplier,
} from '@image-playground/shared'
import { and, eq, isNull } from 'drizzle-orm'
import { Elysia, t } from 'elysia'
import { config } from '../config'
import { db, schema } from '../db/client'
import { isCapabilityEnabled } from '../lib/capabilities'
import { resolveModelMedia } from '../lib/channels'
import { resolveImageBytesRef } from '../lib/extractImages'
import { deviceIdSchema } from '../lib/http'
import { archiveInputImages, ObjectStorageError } from '../lib/imageArchive'
import { objectStore } from '../lib/objectStore'
import { loadPrivateBffOverlay } from '../lib/private-overlay'
import { asQueueProvider } from '../lib/queueProvider'
import { tryConsumeQuotaInTransaction } from '../lib/quota'
import { taskAccessWhere } from '../lib/task-access'
import { requireUser } from '../lib/user-auth'

const submitBodySchema = t.Object({
  prompt: t.String({ minLength: 1 }),
  size: t.Optional(t.String()),
  quality: t.Optional(t.String()),
  output_format: t.Optional(t.String()),
  output_compression: t.Optional(t.Number({ minimum: 0, maximum: 100 })),
  moderation: t.Optional(t.String()),
  aspect_ratio: t.Optional(t.String()),
  image_size: t.Optional(t.String()),
  thinking_level: t.Optional(t.String()),
  n: t.Optional(t.Number({ minimum: 1, maximum: 16, multipleOf: 1 })),
  input_images: t.Optional(t.Array(t.String())),
  mask: t.Optional(t.String()),
  /** 档位合法性由 shared 的 validateVideoRequest 兜底，这里只做形状白名单。 */
  video: t.Optional(
    t.Object({
      duration_seconds: t.Number(),
      aspect_ratio: t.String(),
      resolution: t.String(),
      first_frame_index: t.Optional(t.Number({ minimum: 0 })),
      last_frame_index: t.Optional(t.Number({ minimum: 0 })),
      mode: t.Optional(t.String()),
      source_task_id: t.Optional(t.String({ minLength: 1, maxLength: 64 })),
      source_output_index: t.Optional(t.Number({ minimum: 0 })),
    }),
  ),
  extra: t.Optional(t.Record(t.String(), t.Any())),
  /**
   * 幂等键：前端在 submitTask 时为每个任务生成 UUID。同一 ID 二次 submit
   * 直接返回原 request_id，避免页面刷新窗口期重复消耗上游配额。
   */
  client_request_id: t.Optional(t.String({ minLength: 8, maxLength: 64 })),
  /**
   * 浏览器持久化的设备 ID。BFF 用于按设备每日配额计数。前端 submitTask 时
   * 统一带；缺失或太短返回 400。BYOK profile 不走 BFF，无需此字段。
   */
  device_id: deviceIdSchema(),
})

async function findTaskByIdempotencyKey(clientRequestId: string, userId: string | null) {
  const ownerCondition = userId ? eq(schema.tasks.user_id, userId) : isNull(schema.tasks.user_id)
  const [task] = await db
    .select({ id: schema.tasks.id, submitted_at: schema.tasks.submitted_at })
    .from(schema.tasks)
    .where(and(eq(schema.tasks.client_request_id, clientRequestId), ownerCondition))
    .limit(1)
  return task
}

/** 只落引用，字节留在源任务的 object storage 里，worker 取的时候才读。 */
async function resolveSourceVideo(
  video: VideoRequest,
  userId: string | null,
): Promise<{ ref: StoredImageRef } | { reason: string }> {
  const [task] = await db
    .select({
      status: schema.tasks.status,
      provider: schema.tasks.provider,
      result_payload: schema.tasks.result_payload,
    })
    .from(schema.tasks)
    .where(taskAccessWhere(video.source_task_id ?? '', userId))
    .limit(1)
  if (!task) return { reason: '源视频不存在或不属于你' }
  if (task.status !== 'completed') return { reason: '源视频还没生成完成' }

  const provider = asQueueProvider(task.provider)
  const ref = provider
    ? resolveImageBytesRef(provider, task.result_payload, video.source_output_index ?? 0)
    : null
  // 归档跑在 completed 之前，所以完成任务的输出一定已经落到对象存储。
  if (!ref || ref.kind !== 'object' || !ref.mime.startsWith('video/'))
    return { reason: '源任务的这一条输出不是视频' }
  return { ref: { object: ref.data, mime: ref.mime } }
}

export const submitRoutes = new Elysia()
  .use(requireUser)
  // Elysia 默认对 body schema 校验失败返 422；规范要求 400，统一在路由作用域拦截。
  .onError({ as: 'scoped' }, ({ code, error, set }) => {
    if (code === 'VALIDATION') {
      set.status = 400
      return { error: 'invalid_request', message: error.message }
    }
  })
  .post(
    '/v1/queue/:provider/:model/submit',
    async ({ params, body, status, authUser }) => {
      const { provider, model } = params
      const queueProvider = asQueueProvider(provider)
      if (!queueProvider) {
        return status(400, { error: `unsupported provider: ${provider}` })
      }

      const video = body.video as VideoRequest | undefined
      const media = resolveModelMedia(model)
      if (video && media !== 'video') {
        return status(400, { error: 'video_not_supported', message: '该模型不支持视频生成' })
      }
      if (!video && media === 'video') {
        return status(400, { error: 'video_params_required', message: '视频任务缺少视频参数' })
      }
      let persistedVideo: PersistedVideoRequest | undefined
      if (video) {
        for (const check of [
          validateVideoRequest(model, video, body.input_images?.length ?? 0),
          validateVideoPrompt(model, body.prompt),
        ]) {
          if (!check.ok)
            return status(400, { error: 'invalid_video_request', message: check.reason })
        }
        // 客户端塞进来的 source_video 不能变成任意对象读取，只认下面校验出来的那个。
        const { source_video: _clientSupplied, ...wireVideo } = video as PersistedVideoRequest
        persistedVideo = wireVideo
        if (video.mode && video.mode !== 'generate') {
          const source = await resolveSourceVideo(video, authUser?.id ?? null)
          if ('reason' in source)
            return status(400, { error: 'invalid_video_source', message: source.reason })
          persistedVideo.source_video = source.ref
        }
      }

      // 幂等命中（client_request_id 已存在）走优先返回，避免重复扣配额。
      if (body.client_request_id) {
        const existing = await findTaskByIdempotencyKey(
          body.client_request_id,
          authUser?.id ?? null,
        )
        if (existing) {
          return { request_id: existing.id, status: 'queued', submitted_at: existing.submitted_at }
        }
      }

      const id = crypto.randomUUID()
      let requestPayload: PersistedSubmitRequest
      try {
        const { video: _rawVideo, ...rest } = body
        requestPayload = {
          ...(await archiveInputImages(id, rest)),
          ...(persistedVideo ? { video: persistedVideo } : {}),
        }
      } catch (error) {
        try {
          await objectStore().deletePrefix(`${id}/in/`)
        } catch {
          // No task row references this prefix. Bucket lifecycle cleanup removes any orphan.
        }
        if (error instanceof TypeError) {
          return status(400, { error: 'invalid_input_image', message: error.message })
        }
        const message =
          error instanceof ObjectStorageError
            ? error.message
            : 'Object storage input archive failed'
        return status(503, { error: 'object_storage_error', message })
      }

      const n = body.n ?? 1
      // 免费部署的每日配额按输出计数：一条视频算一次，不按秒数放大。
      const quotaUnits = video ? 1 : n
      const now = Date.now()
      const taskHooks = (await loadPrivateBffOverlay()).taskHooks
      const dailyQuotaEnabled = isCapabilityEnabled('quota:daily')
      const dailyImageQuota = config.operator.quotas['generation:daily-images']
      const outcome = await db.transaction(async (tx) => {
        const inserted = await tx
          .insert(schema.tasks)
          .values({
            id,
            provider: queueProvider,
            model,
            status: 'queued',
            request_payload: requestPayload,
            submitted_at: now,
            user_id: authUser?.id ?? null,
            client_request_id: body.client_request_id ?? null,
          })
          .onConflictDoNothing()
          .returning({ id: schema.tasks.id, submitted_at: schema.tasks.submitted_at })

        if (inserted.length === 0) return { kind: 'idempotency_conflict' as const }

        if (isCapabilityEnabled('billing:credits')) {
          if (!authUser) {
            await tx.delete(schema.tasks).where(eq(schema.tasks.id, id))
            return { kind: 'authentication_required' as const }
          }
          const reservation = await taskHooks.reserveTask({
            tx,
            taskId: id,
            userId: authUser.id,
            model,
            quantity: video ? video.duration_seconds : n,
            unitMultiplier: video ? videoRateMultiplier(model, video.resolution) : 1,
          })
          if (reservation.kind !== 'reserved') {
            await tx.delete(schema.tasks).where(eq(schema.tasks.id, id))
            return reservation
          }
        } else if (dailyQuotaEnabled) {
          const quota = await tryConsumeQuotaInTransaction(
            tx,
            body.device_id,
            quotaUnits,
            dailyImageQuota,
          )
          if (!quota.ok) {
            await tx.delete(schema.tasks).where(eq(schema.tasks.id, id))
            return { kind: 'quota_exceeded' as const, quota }
          }
        }
        return { kind: 'inserted' as const, task: inserted[0]! }
      })

      if (outcome.kind !== 'inserted') {
        try {
          await objectStore().deletePrefix(`${id}/in/`)
        } catch {
          // The losing task has no row. Any undeleted prefix is a harmless lifecycle orphan.
        }
      }

      if (outcome.kind === 'insufficient_credits') {
        return status(402, {
          error: 'insufficient_credits',
          required: outcome.required,
          available: outcome.available,
        })
      }

      if (outcome.kind === 'price_unavailable') {
        return status(422, { error: 'model_price_unavailable', model: outcome.model })
      }

      if (outcome.kind === 'authentication_required') {
        return status(401, { error: 'unauthorized' })
      }
      if (outcome.kind === 'quota_exceeded') {
        const quota = outcome.quota
        return status(429, {
          error: 'daily_quota_exceeded',
          quota: quota.quota,
          used: quota.count,
          reset_at: quota.reset_at,
        })
      }

      if (outcome.kind === 'idempotency_conflict') {
        if (body.client_request_id) {
          const existing = await findTaskByIdempotencyKey(
            body.client_request_id,
            authUser?.id ?? null,
          )
          if (existing) {
            return {
              request_id: existing.id,
              status: 'queued',
              submitted_at: existing.submitted_at,
            }
          }
        }
        return status(409, { error: 'idempotency_key_conflict' })
      }

      return {
        request_id: outcome.task.id,
        status: 'queued',
        submitted_at: outcome.task.submitted_at,
      }
    },
    {
      params: t.Object({
        provider: t.String(),
        model: t.String(),
      }),
      body: submitBodySchema,
    },
  )
