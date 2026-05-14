import { Elysia, t } from 'elysia'
import { eq } from 'drizzle-orm'
import type { QueueProvider } from '@image-playground/shared'
import { db, schema } from '../db/client'
import { spawnTask } from '../workers/task-runner'

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

    // 幂等去重靠 SQLite 唯一索引 + ON CONFLICT DO NOTHING 兜底，避免 SELECT-then-INSERT
    // 在并发同 client_request_id 提交时的竞争（两个 INSERT 一个抛 500）。冲突时
    // returning 为空，再 SELECT 回 existing 行返回原 request_id。
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
        client_request_id: body.client_request_id ?? null,
      })
      .onConflictDoNothing()
      .returning({ id: schema.tasks.id, submitted_at: schema.tasks.submitted_at })

    if (inserted.length === 0 && body.client_request_id) {
      const [existing] = await db
        .select({ id: schema.tasks.id, submitted_at: schema.tasks.submitted_at })
        .from(schema.tasks)
        .where(eq(schema.tasks.client_request_id, body.client_request_id))
        .limit(1)
      if (existing) return { request_id: existing.id, status: 'queued', submitted_at: existing.submitted_at }
    }

    spawnTask(id, 'submit')

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
