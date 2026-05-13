import { Elysia, t } from 'elysia'
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

    const id = crypto.randomUUID()
    const now = Date.now()
    await db.insert(schema.tasks).values({
      id,
      provider,
      model,
      status: 'queued',
      request_payload: body,
      submitted_at: now,
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
