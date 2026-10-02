import { afterAll, expect, it } from 'bun:test'
import { createDb } from '@image-playground/db'
import { resetTestDatabase } from '@image-playground/db/testing'
import { eq } from 'drizzle-orm'

const url = await resetTestDatabase('admin_analysis_task_query')
process.env.ADMIN_PASSWORD = 'test-password'
process.env.ADMIN_COOKIE_SECRET = 'test-secret-32-bytes-minimum-value'
process.env.DATABASE_URL = url
const writer = createDb(url)
const { getTask, getUserTasks } = await import('../../../../server/lib/queries')
const { getDbHandle } = await import('../../../../server/lib/db')
afterAll(async () => {
  await getDbHandle().close()
  await writer.close()
})

it('reads durable analysis findings and costs after transient task cleanup without exposing image output', async () => {
  const now = Date.now()
  const taskId = 'analysis-admin-detail'
  await writer.db.insert(writer.schema.tasks).values({
    id: taskId,
    kind: 'analysis',
    provider: 'openai-compat',
    model: 'vision-model',
    status: 'completed',
    request_payload: { prompt: '', device_id: 'device' },
    submitted_at: now,
    completed_at: now + 100,
    upstream_invocation_count: 1,
  })
  await writer.db.insert(writer.schema.analysis_tasks).values({
    task_id: taskId,
    user_id: 'owner',
    device_id: 'device',
    batch_id: 'batch',
    plan_version: 1,
    item_key: 'inspect',
    attempt: 1,
    origin_turn_id: 'settled-turn',
    model: 'vision-model',
    input_snapshot: {
      model: 'vision-model',
      prompt: '比较颜色',
      inputs: [{ imageId: 'image-1', mediaId: 'media-1' }],
      estimatedInputTokens: 100,
      evidence: [],
    },
    price_snapshot: {
      unit: 'kilo_token',
      quantity: 1,
      unitMultiplier: 1,
      pricingVersion: 'price-v1',
      quotedAt: now,
      validUntil: null,
      model: 'vision-model',
      baseUnitCredits: 6,
      outputPriceRatio: 5,
      cachedInputPriceRatio: 0.1,
      inputEstimateTokens: 100,
      outputReserveTokens: 1000,
      exemption: 'none',
    },
    reserved_credits: 31,
    actual_credits: 1,
    status: 'completed',
    findings: [{ imageId: 'image-1', text: '颜色均匀' }],
    coverage: { requiredImageIds: ['image-1'], reviewedImageIds: ['image-1'], missingImageIds: [] },
    evidence: [],
    created_at: now,
    completed_at: now + 100,
  })
  await writer.db.insert(writer.schema.analysis_model_calls).values({
    id: 'analysis-call',
    task_id: taskId,
    model: 'vision-model',
    status: 'completed',
    http_dispatch_count: 1,
    usage: { inputTokens: 100, outputTokens: 20, cachedInputTokens: 80 },
    started_at: now,
    finished_at: now + 100,
  })
  const expected = {
    id: taskId,
    kind: 'analysis',
    status: 'completed',
    prompt: '比较颜色',
    result_meta: { images: [] },
    upstream_invocation_count: 1,
    analysis: {
      reservedCredits: 31,
      actualCredits: 1,
      findings: [{ imageId: 'image-1', text: '颜色均匀' }],
      coverage: {
        requiredImageIds: ['image-1'],
        reviewedImageIds: ['image-1'],
        missingImageIds: [],
      },
      usage: { inputTokens: 100, outputTokens: 20, cachedInputTokens: 80 },
    },
  }
  expect(await getTask(taskId)).toMatchObject(expected)
  expect(await getUserTasks('owner', 'all')).toMatchObject({
    tasks: [{ id: taskId, kind: 'analysis', prompt: '比较颜色' }],
  })
  await writer.db.delete(writer.schema.tasks).where(eq(writer.schema.tasks.id, taskId))
  expect(await getTask(taskId)).toMatchObject(expected)
  expect(await getUserTasks('owner', 'all')).toMatchObject({
    tasks: [{ id: taskId, kind: 'analysis', prompt: '比较颜色' }],
  })
})
