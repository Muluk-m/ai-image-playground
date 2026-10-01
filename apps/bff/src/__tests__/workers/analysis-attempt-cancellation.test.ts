import { afterAll, expect, it } from 'bun:test'
import { resetTestDatabase } from '@image-playground/db/testing'
import { eq } from 'drizzle-orm'
import type { ChatAttempt } from '../../lib/chatCompletion'

process.env.DATABASE_URL = await resetTestDatabase('analysis_attempt_cancel')
process.env.PORT = '0'
process.env.OPERATOR_CONFIG_FILE = ''
const { installRecordingTaskHooks } = await import('../helpers/privateOverlayStub')
const billing = installRecordingTaskHooks()
const { db, schema, close } = await import('../../db/client')
const { cancelAnalysisTasks, recordAnalysisAttempt, refreshAnalysisTaskCosts } = await import(
  '../../lib/analysis-tasks'
)
afterAll(close)

it('settles a cancelled dispatch intent when its original executor proves zero HTTP dispatch, once', async () => {
  const id = 'cancelled-intent'
  const now = Date.now()
  await db
    .insert(schema.users)
    .values({ id, username: id, password_hash: 'fixture', created_at: now, updated_at: now })
  await db.insert(schema.tasks).values({
    id,
    user_id: id,
    kind: 'analysis',
    provider: 'openai-compat',
    model: 'model',
    status: 'in_progress',
    reconciliation_required: true,
    execution_token: 'original',
    lease_expires_at: now + 60_000,
    upstream_invocation_count: 1,
    submitted_at: now,
    request_payload: { device_id: 'device', prompt: '' },
  })
  await db.insert(schema.analysis_tasks).values({
    task_id: id,
    user_id: id,
    device_id: 'device',
    batch_id: id,
    plan_version: 1,
    item_key: 'inspect',
    attempt: 1,
    origin_turn_id: 'origin',
    model: 'model',
    status: 'in_progress',
    input_snapshot: {
      model: 'model',
      prompt: '',
      inputs: [],
      evidence: [],
      estimatedInputTokens: 1,
    },
    price_snapshot: {
      model: 'model',
      unit: 'kilo_token',
      quantity: 1,
      unitMultiplier: 1,
      baseUnitCredits: 7,
      outputPriceRatio: 1,
      cachedInputPriceRatio: 0,
      inputEstimateTokens: 1,
      outputReserveTokens: 100,
      exemption: 'none',
      pricingVersion: 'v1',
      quotedAt: now,
      validUntil: null,
    },
    reserved_credits: 7,
    created_at: now,
  })
  await db.insert(schema.analysis_model_calls).values({
    id,
    task_id: id,
    execution_token: 'original',
    model: 'model',
    status: 'dispatched',
    http_dispatch_count: 1,
    started_at: now,
    dispatched_at: now,
  })
  expect(await cancelAnalysisTasks(eq(schema.tasks.id, id))).toBe(1)
  expect((await db.select().from(schema.tasks).where(eq(schema.tasks.id, id)))[0]?.status).toBe(
    'reconciling',
  )
  expect(billing.settlements).toHaveLength(0)
  const zero: ChatAttempt = {
    id,
    model: 'model',
    startedAt: now,
    finishedAt: now + 1,
    status: 'failed',
    httpDispatchCount: 0,
    usage: { inputTokens: 0, outputTokens: 0 },
  }
  await recordAnalysisAttempt(id, id, 'original', zero, true)
  await recordAnalysisAttempt(id, id, 'original', zero, true)
  await refreshAnalysisTaskCosts([id])
  expect((await db.select().from(schema.tasks).where(eq(schema.tasks.id, id)))[0]).toMatchObject({
    status: 'cancelled',
    reconciliation_required: false,
    upstream_invocation_count: 0,
  })
  expect(
    (await db.select().from(schema.analysis_tasks).where(eq(schema.analysis_tasks.task_id, id)))[0],
  ).toMatchObject({ status: 'cancelled', actual_credits: 0 })
  expect(billing.settlements).toMatchObject([
    { taskId: id, outcome: 'cancelled', upstreamInvocationCount: 0 },
  ])
  expect(billing.settlements).toHaveLength(1)
  await db
    .update(schema.analysis_model_calls)
    .set({
      execution_token: 'later',
      status: 'completed',
      http_dispatch_count: 1,
      usage: { inputTokens: 3, outputTokens: 2 },
    })
    .where(eq(schema.analysis_model_calls.id, id))
  await recordAnalysisAttempt(id, id, 'original', zero, true)
  expect(
    (
      await db
        .select()
        .from(schema.analysis_model_calls)
        .where(eq(schema.analysis_model_calls.id, id))
    )[0],
  ).toMatchObject({
    status: 'completed',
    http_dispatch_count: 1,
    usage: { inputTokens: 3, outputTokens: 2 },
  })
  await recordAnalysisAttempt(id, id, 'later', zero, true)
  expect(
    (
      await db
        .select()
        .from(schema.analysis_model_calls)
        .where(eq(schema.analysis_model_calls.id, id))
    )[0],
  ).toMatchObject({ status: 'completed', http_dispatch_count: 1 })
  expect(billing.settlements).toHaveLength(1)
})
