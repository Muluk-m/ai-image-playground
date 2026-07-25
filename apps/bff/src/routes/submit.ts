import type { QueueProvider } from '@image-playground/shared'
import { DAILY_QUOTA_LIMIT } from '@image-playground/shared'
import { and, eq, isNull } from 'drizzle-orm'
import { Elysia, t } from 'elysia'
import { config } from '../config'
import { db, schema } from '../db/client'
import { tryConsumeQuota } from '../lib/quota'
import { requireUser } from '../lib/user-auth'

const submitBodySchema = t.Object({
  prompt: t.String({ minLength: 1 }),
  size: t.Optional(t.String()),
  quality: t.Optional(t.String()),
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

      // 配额扣减：先扣后建。失败 → 429，不写 tasks。
      const n = body.n ?? 1
      const quota = await tryConsumeQuota(body.device_id, n)
      if (!quota.ok) {
        return status(429, {
          error: 'daily_quota_exceeded',
          limit: DAILY_QUOTA_LIMIT,
          used: quota.count,
          reset_at: quota.reset_at,
        })
      }

      const id = crypto.randomUUID()
      const now = Date.now()
      const inserted = await db
        .insert(schema.tasks)
        .values({
          id,
          provider,
          model,
          status: 'queued',
          request_payload: body,
          submitted_at: now,
          user_id: authUser?.id ?? null,
          client_request_id: body.client_request_id ?? null,
        })
        .onConflictDoNothing()
        .returning({ id: schema.tasks.id, submitted_at: schema.tasks.submitted_at })

      if (inserted.length === 0 && body.client_request_id) {
        // 极端并发：上面 SELECT 没命中但 INSERT 冲突——重查兜底
        const ownerCondition = config.auth.enabled
          ? eq(schema.tasks.user_id, authUser!.id)
          : isNull(schema.tasks.user_id)
        const [existing] = await db
          .select({ id: schema.tasks.id, submitted_at: schema.tasks.submitted_at })
          .from(schema.tasks)
          .where(and(eq(schema.tasks.client_request_id, body.client_request_id), ownerCondition))
          .limit(1)
        if (existing)
          return { request_id: existing.id, status: 'queued', submitted_at: existing.submitted_at }
        return status(409, { error: 'idempotency_key_conflict' })
      }

      return { request_id: id, status: 'queued', submitted_at: now }
    },
    {
      params: t.Object({
        provider: t.String(),
        model: t.String(),
      }),
      body: submitBodySchema,
    },
  )
