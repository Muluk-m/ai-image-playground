import { afterAll, expect, it } from 'bun:test'
import { resolve } from 'node:path'
import { resetTestDatabase } from '@image-playground/db/testing'
import { eq } from 'drizzle-orm'
import { InMemoryObjectStore } from '../helpers/inMemoryObjectStore'
import { installRecordingTaskHooks } from '../helpers/privateOverlayStub'
import { fixturePng } from '../helpers/rasterFixture'

process.env.DATABASE_URL = await resetTestDatabase('analysis_batch_auth')
process.env.PORT = '0'
process.env.UPSTREAM_BASE_URL = 'http://gateway.test'
process.env.UPSTREAM_API_KEY = 'fixture'
process.env.AGENT_CHAT_MODEL = 'analysis-auth-model'
process.env.OPERATOR_CONFIG_FILE = resolve(
  import.meta.dir,
  '../batch-execution-operator-config.json',
)
const billing = installRecordingTaskHooks()
const { db, schema, close } = await import('../../db/client')
const { config } = await import('../../config')
const { loadPrivateBffOverlay, _setPrivateBffOverlayForTesting } = await import(
  '../../lib/private-overlay'
)
const overlay = await loadPrivateBffOverlay()
_setPrivateBffOverlayForTesting({
  ...overlay,
  taskHooks: {
    ...overlay.taskHooks,
    async quoteTokenTask({ model, estimatedInputTokens }) {
      return {
        estimatedCredits: 7,
        pricing: {
          model,
          unit: 'kilo_token',
          quantity: 1,
          unitMultiplier: 1,
          baseUnitCredits: 7,
          outputPriceRatio: 1,
          cachedInputPriceRatio: 0,
          inputEstimateTokens: estimatedInputTokens,
          outputReserveTokens: 1000,
          exemption: 'none',
          pricingVersion: 'auth-quote-v1',
          quotedAt: 1,
          validUntil: null,
        },
      }
    },
  },
})
const { prepareAnalysisTask, quoteAnalysisTask } = await import('../../lib/analysis-tasks')
const { confirmAgentBatch, advanceAgentBatches, controlAgentBatch } = await import(
  '../../lib/agent/batch-execution'
)
const { runAnalysisTask } = await import('../../workers/analysis-runner')
const { setChatFetchForTesting } = await import('../../lib/chatCompletion')
const { setDurableMediaStoreForTesting } = await import('../../lib/durableMediaStore')
const { storeMedia } = await import('../../lib/projectMedia')
setDurableMediaStoreForTesting(
  Object.assign(new InMemoryObjectStore(), { sign: (key: string) => `http://media.test/${key}` }),
)
afterAll(async () => {
  setChatFetchForTesting()
  setDurableMediaStoreForTesting()
  _setPrivateBffOverlayForTesting()
  await close()
})

it('pauses later batch admissions on an analysis authentication failure while retaining the unknown call and reservation', async () => {
  const operator = config.operator
  config.operator = {
    ...operator,
    capabilities: { ...operator.capabilities, 'agent:batch-analysis': true },
    quotas: { ...operator.quotas, 'agent:batch-dispatch-window': 1 },
  }
  const id = 'analysis-auth-batch'
  const now = Date.now()
  try {
    billing.answer = { kind: 'reserved', credits: 7 }
    await db
      .insert(schema.users)
      .values({ id, username: id, password_hash: 'fixture', created_at: now, updated_at: now })
    await db
      .insert(schema.agent_conversations)
      .values({ id, user_id: id, title: 'analysis', created_at: now, updated_at: now })
    const media = await storeMedia(id, await fixturePng('#abcdef'), 'image/png')
    const prepared = await prepareAnalysisTask({
      userId: id,
      model: config.agent.model,
      prompt: 'inspect',
      inputs: [{ imageId: 'original', mediaId: media.id }],
    })
    const quote = await db.transaction((tx) =>
      quoteAnalysisTask({
        tx,
        userId: id,
        model: prepared.model,
        estimatedInputTokens: prepared.estimatedInputTokens,
      }),
    )
    if (!quote) throw new Error('fixture quote missing')
    await db.insert(schema.agent_batches).values({
      id,
      user_id: id,
      conversation_id: id,
      origin_turn_id: 'settled-turn',
      tool_call_id: 'analysis-plan',
      experience: 'chat',
      created_at: now,
      updated_at: now,
    })
    await db.insert(schema.agent_batch_plans).values({
      batch_id: id,
      version: 1,
      title: 'analysis',
      rule: 'inspect',
      digest: 'fixture-digest',
      item_count: 2,
      estimate_snapshot: {
        analysis: {
          status: 'available',
          estimatedCredits: 14,
          estimatedChargeCredits: 14,
          snapshots: ['first', 'second'].map((itemKey) => ({ ...quote.pricing, itemKey })),
        },
        generation: {
          status: 'available',
          estimatedCredits: 0,
          estimatedChargeCredits: 0,
          snapshots: [],
        },
      },
      created_at: now,
    })
    await db.insert(schema.agent_batch_items).values(
      ['first', 'second'].map((key, ordinal) => ({
        batch_id: id,
        version: 1,
        key,
        ordinal,
        kind: 'analysis' as const,
        inputs: prepared.inputs,
        prompt: prepared.prompt,
        params: {
          model: prepared.model,
          estimatedInputTokens: prepared.estimatedInputTokens,
          evidence: prepared.evidence,
        },
        dependencies: [],
      })),
    )
    await confirmAgentBatch(id, id, {
      commandId: 'confirm',
      expectedVersion: 1,
      expectedDigest: 'fixture-digest',
      deviceId: 'fixture',
    })
    const [first] = await db
      .select()
      .from(schema.agent_batch_attempts)
      .where(eq(schema.agent_batch_attempts.batch_id, id))
    if (!first) throw new Error('fixture first dispatch missing')
    expect(billing.reservations).toHaveLength(1)
    let calls = 0
    setChatFetchForTesting(async () => {
      calls++
      return Response.json({ error: 'invalid API credential' }, { status: 401 })
    })
    await runAnalysisTask(first.task_id)
    expect(
      (
        await db
          .select()
          .from(schema.analysis_tasks)
          .where(eq(schema.analysis_tasks.task_id, first.task_id))
      )[0]?.status,
    ).toBe('reconciling')
    await advanceAgentBatches(null, () => true)
    expect(
      (await db.select().from(schema.agent_batches).where(eq(schema.agent_batches.id, id)))[0],
    ).toMatchObject({ status: 'paused', pause_reason: 'upstream_auth' })
    expect(
      await db
        .select()
        .from(schema.agent_batch_attempts)
        .where(eq(schema.agent_batch_attempts.batch_id, id)),
    ).toHaveLength(1)
    expect(billing.reservations).toHaveLength(1)
    expect(billing.settlements).toHaveLength(0)
    expect(calls).toBe(1)
    expect(
      (await db.select().from(schema.tasks).where(eq(schema.tasks.id, first.task_id)))[0],
    ).toMatchObject({ status: 'reconciling', upstream_status: 401 })
    config.operator = {
      ...config.operator,
      quotas: { ...config.operator.quotas, 'agent:batch-dispatch-window': 2 },
    }
    await controlAgentBatch(id, id, 'resume', {
      commandId: 'resume-after-credential-fix',
      expectedVersion: 1,
      expectedDigest: 'fixture-digest',
    })
    await advanceAgentBatches(null, () => true)
    expect(
      (await db.select().from(schema.agent_batches).where(eq(schema.agent_batches.id, id)))[0],
    ).toMatchObject({ status: 'running', pause_reason: null })
    expect(
      await db
        .select()
        .from(schema.agent_batch_attempts)
        .where(eq(schema.agent_batch_attempts.batch_id, id)),
    ).toHaveLength(2)
    expect(billing.reservations).toHaveLength(2)
    expect(billing.settlements).toHaveLength(0)
    expect(calls).toBe(1)
  } finally {
    config.operator = operator
  }
})
