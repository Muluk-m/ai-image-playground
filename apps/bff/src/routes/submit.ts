import type { QueueProvider } from '@image-playground/shared'
import { DAILY_QUOTA_LIMIT } from '@image-playground/shared'
import { Elysia, t } from 'elysia'
import { persistence } from '../db/client'
import { rewriteInputDataUrls } from '../lib/blobStore'

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
  n: t.Optional(t.Number({ minimum: 1, maximum: 16 })),
  input_images: t.Optional(t.Array(t.String())),
  mask: t.Optional(t.String()),
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
  device_id: t.String({ minLength: 8, maxLength: 64 }),
})

function isQueueProvider(value: string): value is QueueProvider {
  return value === 'openai-compat' || value === 'gemini'
}

export const submitRoutes = new Elysia()
  // Elysia 默认对 body schema 校验失败返 422；规范要求 400，统一在路由作用域拦截。
  .onError({ as: 'scoped' }, ({ code, error, set }) => {
    if (code === 'VALIDATION') {
      set.status = 400
      return { error: 'invalid_request', message: error.message }
    }
  })
  .post(
    '/v1/queue/:provider/:model/submit',
    async ({ params, body, status }) => {
      const { provider, model } = params
      if (!isQueueProvider(provider)) {
        return status(400, { error: `unsupported provider: ${provider}` })
      }

      const rewrittenImages = rewriteInputDataUrls(body.input_images ?? [])
      const requestPayload = body.input_images
        ? { ...body, input_images: rewrittenImages.refs }
        : body
      const n = body.n ?? 1

      const outcome = await persistence.submit({
        provider,
        model,
        request: requestPayload,
        clientRequestId: body.client_request_id ?? null,
        deviceId: body.device_id,
        n,
        pixels: rewrittenImages.blobs,
      })

      if (outcome.kind === 'quota_rejected') {
        return status(429, {
          error: 'daily_quota_exceeded',
          limit: DAILY_QUOTA_LIMIT,
          used: outcome.count,
          reset_at: outcome.reset_at,
        })
      }

      return {
        request_id: outcome.id,
        status: 'queued',
        submitted_at: outcome.submitted_at,
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
