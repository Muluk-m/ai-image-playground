import {
  DAILY_QUOTA_LIMIT,
  type PersistedSubmitRequest,
  type QueueProvider,
} from '@image-playground/shared'
import { and, eq, isNull } from 'drizzle-orm'
import { Elysia, t } from 'elysia'
import { config } from '../config'
import { db, schema } from '../db/client'
import { archiveInputImages, ObjectStorageError } from '../lib/imageArchive'
import { objectStore } from '../lib/objectStore'
import { tryConsumeQuotaInTransaction } from '../lib/quota'
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
      if (!isQueueProvider(provider)) {
        return status(400, { error: `unsupported provider: ${provider}` })
      }

      // 幂等命中（client_request_id 已存在）走优先返回，避免重复扣配额。
      if (body.client_request_id) {
        const ownerCondition = config.auth.enabled
          ? eq(schema.tasks.user_id, authUser!.id)
          : isNull(schema.tasks.user_id)
        const [existing] = await db
          .select({ id: schema.tasks.id, submitted_at: schema.tasks.submitted_at })
          .from(schema.tasks)
          .where(and(eq(schema.tasks.client_request_id, body.client_request_id), ownerCondition))
          .limit(1)
        if (existing) {
          return { request_id: existing.id, status: 'queued', submitted_at: existing.submitted_at }
        }
      }

      const id = crypto.randomUUID()
      let requestPayload: PersistedSubmitRequest
      try {
        requestPayload = await archiveInputImages(id, body)
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
      const now = Date.now()
      const outcome = await db.transaction(async (tx) => {
        const inserted = await tx
          .insert(schema.tasks)
          .values({
            id,
            provider,
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

        const quota = await tryConsumeQuotaInTransaction(tx, body.device_id, n)
        if (!quota.ok) {
          await tx.delete(schema.tasks).where(eq(schema.tasks.id, id))
          return { kind: 'quota_exceeded' as const, quota }
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

      if (outcome.kind === 'quota_exceeded') {
        const quota = outcome.quota
        return status(429, {
          error: 'daily_quota_exceeded',
          limit: DAILY_QUOTA_LIMIT,
          used: quota.count,
          reset_at: quota.reset_at,
        })
      }

      if (outcome.kind === 'idempotency_conflict') {
        if (body.client_request_id) {
          const ownerCondition = config.auth.enabled
            ? eq(schema.tasks.user_id, authUser!.id)
            : isNull(schema.tasks.user_id)
          const [existing] = await db
            .select({ id: schema.tasks.id, submitted_at: schema.tasks.submitted_at })
            .from(schema.tasks)
            .where(and(eq(schema.tasks.client_request_id, body.client_request_id), ownerCondition))
            .limit(1)
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
