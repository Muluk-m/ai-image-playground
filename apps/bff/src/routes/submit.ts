import { Elysia, t } from 'elysia'
import { eq } from 'drizzle-orm'
import type { QueueProvider } from '@image-playground/shared'
import { db, schema } from '../db/client'
import { runTask } from '../workers/task-runner'

const submitBodySchema = t.Object({
  prompt: t.String({ minLength: 1 }),
  size: t.Optional(t.String()),
  quality: t.Optional(t.String()),
  n: t.Optional(t.Number({ minimum: 1, maximum: 16 })),
  input_images: t.Optional(t.Array(t.String())),
  extra: t.Optional(t.Record(t.String(), t.Any())),
  /**
   * 幂等键：前端在 submitTask 时为每个任务生成 UUID。同一 ID 二次 submit
   * 直接返回原 request_id，避免页面刷新窗口期重复消耗上游配额。
   */
  client_request_id: t.Optional(t.String({ minLength: 8, maxLength: 64 })),
})

function isQueueProvider(value: string): value is QueueProvider {
  return value === 'openai-compat' || value === 'gemini'
}

export const submitRoutes = new Elysia().post(
  '/v1/queue/:provider/:model/submit',
  async ({ params, body, status }) => {
    const { provider, model } = params
    if (!isQueueProvider(provider)) {
      return status(400, { error: `unsupported provider: ${provider}` })
    }

    // 幂等去重：同 client_request_id 直接返已有 request_id。worker 已经在跑
    // （或已经跑完），不重复 enqueue。
    if (body.client_request_id) {
      const existing = await db
        .select({ id: schema.tasks.id, submitted_at: schema.tasks.submitted_at })
        .from(schema.tasks)
        .where(eq(schema.tasks.client_request_id, body.client_request_id))
        .limit(1)
      if (existing.length > 0) {
        const t0 = existing[0]
        return { request_id: t0.id, status: 'queued', submitted_at: t0.submitted_at }
      }
    }

    const id = crypto.randomUUID()
    const now = Date.now()
    await db.insert(schema.tasks).values({
      id,
      provider,
      model,
      status: 'queued',
      request_payload: body,
      submitted_at: now,
      client_request_id: body.client_request_id ?? null,
    })

    // fire-and-forget；worker 写状态时 status 转换错时不抛
    runTask(id).catch((err) => console.error(`[task-runner ${id}] crashed`, err))

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
