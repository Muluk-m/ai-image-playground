import { afterAll, expect, it } from 'bun:test'
import { resetTestDatabase } from '@image-playground/db/testing'
import { eq } from 'drizzle-orm'
import { installRecordingTaskHooks } from './helpers/privateOverlayStub'

process.env.DATABASE_URL = await resetTestDatabase('analysis_task_consumers')
process.env.PORT = '0'
const billing = installRecordingTaskHooks()
const { db, schema, close } = await import('../db/client')
const { recoverTasksByIds } = await import('../db/maintenance')
const { cancelAgentConversationJobs } = await import('../lib/agent/background-jobs')
afterAll(close)

async function analysisTask(id: string, dispatched: boolean) {
  const now = Date.now()
  await db.insert(schema.tasks).values({
    id,
    kind: 'analysis',
    provider: 'openai-compat',
    model: 'analysis-model',
    status: 'in_progress',
    reconciliation_required: true,
    upstream_invocation_count: dispatched ? 1 : 0,
    execution_token: id,
    lease_expires_at: now - 1000,
    submitted_at: now - 2000,
    started_at: now - 2000,
    agent_conversation_id: id,
    agent_turn_id: null,
    request_payload: { prompt: '', device_id: 'fixture' },
  })
  await db.insert(schema.analysis_tasks).values({
    task_id: id,
    user_id: 'analysis-owner',
    device_id: 'fixture',
    batch_id: id,
    plan_version: 1,
    item_key: 'inspect',
    attempt: 1,
    origin_conversation_id: id,
    origin_turn_id: 'settled-turn',
    model: 'analysis-model',
    input_snapshot: {
      model: 'analysis-model',
      prompt: 'fixture',
      inputs: [],
      estimatedInputTokens: 100,
      evidence: [],
    },
    price_snapshot: {
      model: 'analysis-model',
      unit: 'kilo_token',
      quantity: 1,
      unitMultiplier: 2,
      pricingVersion: 'fixture',
      quotedAt: now,
      validUntil: null,
      baseUnitCredits: 1,
      outputPriceRatio: 1,
      cachedInputPriceRatio: 0,
      inputEstimateTokens: 100,
      outputReserveTokens: 1900,
      exemption: 'none',
    },
    reserved_credits: 2,
    status: 'in_progress',
    created_at: now - 2000,
  })
  await db.insert(schema.analysis_model_calls).values({
    id: `${id}:call`,
    task_id: id,
    execution_token: id,
    model: 'analysis-model',
    status: dispatched ? 'dispatched' : 'prepared',
    http_dispatch_count: dispatched ? 1 : 0,
    started_at: now - 2000,
  })
}

it('leaves independent analysis recovery to its own consumer and cancels before dispatch without generation settlement', async () => {
  const id = 'analysis-before-dispatch'
  await analysisTask(id, false)
  expect(await recoverTasksByIds([id])).toEqual({ requeued: 0, failed: 0, resumedPolling: 0 })
  expect((await db.select().from(schema.tasks).where(eq(schema.tasks.id, id)))[0]?.status).toBe(
    'in_progress',
  )
  await cancelAgentConversationJobs(id)
  expect((await db.select().from(schema.tasks).where(eq(schema.tasks.id, id)))[0]?.status).toBe(
    'cancelled',
  )
  expect(
    (await db.select().from(schema.analysis_tasks).where(eq(schema.analysis_tasks.task_id, id)))[0]
      ?.status,
  ).toBe('cancelled')
  expect(
    (
      await db
        .select()
        .from(schema.analysis_model_calls)
        .where(eq(schema.analysis_model_calls.task_id, id))
    )[0],
  ).toMatchObject({ http_dispatch_count: 0, usage: { inputTokens: 0, outputTokens: 0 } })
  expect(billing.settlements.filter((one) => one.taskId === id)).toHaveLength(1)
  expect(await db.select().from(schema.generation_records)).toHaveLength(0)
})

it('keeps a dispatched analysis unknown on conversation cancellation with no refund or generation record', async () => {
  const id = 'analysis-dispatched'
  await analysisTask(id, true)
  await cancelAgentConversationJobs(id)
  expect((await db.select().from(schema.tasks).where(eq(schema.tasks.id, id)))[0]?.status).toBe(
    'reconciling',
  )
  expect(
    (await db.select().from(schema.analysis_tasks).where(eq(schema.analysis_tasks.task_id, id)))[0]
      ?.status,
  ).toBe('reconciling')
  expect(billing.settlements.filter((one) => one.taskId === id)).toHaveLength(0)
  expect(await db.select().from(schema.generation_records)).toHaveLength(0)
})
