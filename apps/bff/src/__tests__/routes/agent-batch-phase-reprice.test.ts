import { afterAll, expect, it } from 'bun:test'
import { resolve } from 'node:path'
import { resetTestDatabase } from '@image-playground/db/testing'
import { eq } from 'drizzle-orm'
import { InMemoryObjectStore } from '../helpers/inMemoryObjectStore'
import { installRecordingTaskHooks } from '../helpers/privateOverlayStub'
import { fixturePng } from '../helpers/rasterFixture'

process.env.DATABASE_URL = await resetTestDatabase('analysis_phase_reprice')
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
const { confirmAgentBatch } = await import('../../lib/agent/batch-execution')
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

it('keeps phase authorization and quotes only unaccepted work when a phase price changes', async () => {
  const operator = config.operator
  config.operator = {
    ...operator,
    capabilities: { ...operator.capabilities, 'agent:batch-analysis': true },
    quotas: { ...operator.quotas, 'agent:batch-dispatch-window': 2 },
  }
  const id = 'analysis-followup-version'
  const now = Date.now()
  try {
    billing.answer = { kind: 'reserved', credits: 7 }
    billing.settledCredits = 1
    await db.insert(schema.users).values({
      id,
      username: id,
      password_hash: 'fixture',
      status: 'active',
      created_at: now,
      updated_at: now,
    })
    await db
      .insert(schema.agent_conversations)
      .values({ id, user_id: id, title: 'inspect', created_at: now, updated_at: now })
    const media = await storeMedia(id, await fixturePng('#abcdef'), 'image/png')
    const inputs = [{ imageId: 'image-first', mediaId: media.id }]
    const prepared = await prepareAnalysisTask({
      userId: id,
      model: config.agent.model,
      prompt: 'inspect original colors',
      inputs,
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
      title: 'inspect',
      rule: 'report colors',
      digest: 'a'.repeat(64),
      item_count: 1,
      estimate_snapshot: {
        analysis: {
          status: 'available',
          estimatedCredits: 7,
          estimatedChargeCredits: 7,
          snapshots: [{ ...quote.pricing, itemKey: 'first' }],
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
    await db.insert(schema.agent_batch_items).values({
      batch_id: id,
      version: 1,
      key: 'first',
      ordinal: 0,
      kind: 'analysis',
      inputs,
      prompt: prepared.prompt,
      params: {
        model: prepared.model,
        estimatedInputTokens: prepared.estimatedInputTokens,
        evidence: prepared.evidence,
      },
      dependencies: [],
    })
    await confirmAgentBatch(id, id, {
      commandId: 'confirm-v1',
      expectedVersion: 1,
      expectedDigest: 'a'.repeat(64),
      deviceId: 'fixture',
    })
    const [originalAttempt] = await db
      .select()
      .from(schema.agent_batch_attempts)
      .where(eq(schema.agent_batch_attempts.batch_id, id))
    if (!originalAttempt) throw new Error('original analysis was not reserved')
    const originalPlans = await db
      .select()
      .from(schema.agent_batch_plans)
      .where(eq(schema.agent_batch_plans.batch_id, id))
    const originalItems = await db
      .select()
      .from(schema.agent_batch_items)
      .where(eq(schema.agent_batch_items.batch_id, id))
    const originalAnalysis = await db
      .select()
      .from(schema.analysis_tasks)
      .where(eq(schema.analysis_tasks.batch_id, id))
    const { createUserSession, USER_SESSION_COOKIE } = await import('../../lib/user-session')
    const cookie = `${USER_SESSION_COOKIE}=${await db.transaction((tx) => createUserSession(id, tx))}`
    const { app } = await import('../../app')
    const request = (suffix: string, body: unknown) =>
      app.handle(
        new Request(`http://localhost/api/agent/batches/${id}${suffix}`, {
          method: 'POST',
          headers: { cookie, 'content-type': 'application/json' },
          body: JSON.stringify(body),
        }),
      )
    const proposalBody = {
      commandId: 'add-detail-inspection',
      expectedVersion: 1,
      items: [
        {
          key: 'detail',
          inputs,
          prompt: 'inspect fine texture after original colors',
          dependencies: ['first'],
          params: { model: config.agent.model, intent: 'inspection' },
        },
      ],
    }
    const proposal = await request('/analysis-proposal', proposalBody)
    expect(proposal.status).toBe(200)
    const page = await proposal.json()
    expect(page.batch).toMatchObject({
      version: 2,
      status: 'paused',
      confirmationRequired: true,
      confirmation: { phase: 'analysis', itemKeys: ['detail'] },
      estimate: {
        analysis: { estimatedChargeCredits: 7 },
        generation: { estimatedChargeCredits: 0 },
      },
    })
    expect(page.items).toHaveLength(2)
    expect(page.items.find((item: { key: string }) => item.key === 'detail')).toMatchObject({
      kind: 'analysis',
      prompt: 'inspect fine texture after original colors',
      dependencies: ['first'],
      progress: 'pending',
    })
    expect((await request('/analysis-proposal', proposalBody)).status).toBe(200)
    expect(
      await db.select().from(schema.analysis_tasks).where(eq(schema.analysis_tasks.batch_id, id)),
    ).toEqual(originalAnalysis)
    expect(
      (
        await db
          .select()
          .from(schema.agent_batch_plans)
          .where(eq(schema.agent_batch_plans.batch_id, id))
      ).filter((one) => one.version === 1),
    ).toEqual(originalPlans)
    expect(
      (
        await db
          .select()
          .from(schema.agent_batch_items)
          .where(eq(schema.agent_batch_items.batch_id, id))
      ).filter((one) => one.version === 1),
    ).toEqual(originalItems)
    expect(billing.reservations).toHaveLength(1)
    expect(billing.settlements).toHaveLength(0)
    let calls = 0
    setChatFetchForTesting(async () => {
      calls++
      return Response.json({
        choices: [
          {
            message: {
              content: JSON.stringify({
                findings: [{ imageId: 'image-first', text: 'observed texture and color' }],
              }),
            },
          },
        ],
        usage: { prompt_tokens: 100, completion_tokens: 20 },
      })
    })
    await runAnalysisTask(originalAttempt.task_id)
    const { advanceAgentBatches } = await import('../../lib/agent/batch-execution')
    await advanceAgentBatches(null, () => true)
    expect(billing.reservations).toHaveLength(1)
    expect(calls).toBe(1)
    expect(
      (
        await request('/confirm', {
          commandId: 'stale-confirm',
          expectedVersion: 1,
          expectedDigest: 'a'.repeat(64),
          deviceId: 'fixture',
        })
      ).status,
    ).toBe(409)
    const active = await loadPrivateBffOverlay()
    _setPrivateBffOverlayForTesting({
      ...active,
      taskHooks: {
        ...active.taskHooks,
        async quoteTokenTask({ model, estimatedInputTokens }) {
          return {
            estimatedCredits: 9,
            pricing: {
              model,
              unit: 'kilo_token',
              quantity: 1,
              unitMultiplier: 1,
              baseUnitCredits: 9,
              outputPriceRatio: 1,
              cachedInputPriceRatio: 0,
              inputEstimateTokens: estimatedInputTokens,
              outputReserveTokens: 1000,
              exemption: 'none',
              pricingVersion: 'changed-analysis-price',
              quotedAt: 2,
              validUntil: null,
            },
          }
        },
      },
    })
    const paused = await request('/confirm', {
      commandId: 'confirm-v2',
      expectedVersion: 2,
      expectedDigest: page.batch.digest,
      deviceId: 'fixture',
    })
    expect(paused.status).toBe(200)
    expect((await paused.json()).batch).toMatchObject({
      status: 'paused',
      pauseReason: 'price_changed',
    })
    expect(billing.reservations).toHaveLength(1)
    const repriced = await request('/reprice', { commandId: 'reprice-phase', expectedVersion: 2 })
    expect(repriced.status).toBe(200)
    const renewed = await repriced.json()
    expect(renewed.batch).toMatchObject({
      version: 3,
      confirmationRequired: true,
      confirmation: { phase: 'analysis', itemKeys: ['detail'], requiresResume: false },
      estimate: {
        analysis: { estimatedCredits: 9, estimatedChargeCredits: 9 },
        generation: { estimatedChargeCredits: 0 },
      },
    })
    expect(
      renewed.items.find((item: { key: string }) => item.key === 'first').execution.taskId,
    ).toBe(originalAttempt.task_id)
    expect(billing.reservations).toHaveLength(1)
    billing.answer = { kind: 'reserved', credits: 9 }
    const confirmation = {
      commandId: 'confirm-v3',
      expectedVersion: 3,
      expectedDigest: renewed.batch.digest,
      deviceId: 'fixture',
    }
    expect((await request('/confirm', confirmation)).status).toBe(200)
    expect((await request('/confirm', confirmation)).status).toBe(200)
    const attempts = await db
      .select()
      .from(schema.agent_batch_attempts)
      .where(eq(schema.agent_batch_attempts.batch_id, id))
    expect(attempts).toHaveLength(2)
    expect(attempts.find((one) => one.item_key === 'first')).toMatchObject({
      task_id: originalAttempt.task_id,
      attempt: 1,
    })
    const followup = attempts.find((one) => one.item_key === 'detail')
    if (!followup) throw new Error('follow-up was not admitted after explicit confirmation')
    await runAnalysisTask(followup.task_id)
    expect(billing.reservations).toHaveLength(2)
    expect(billing.settlements).toHaveLength(2)
    expect(calls).toBe(2)
    const result = await app.handle(
      new Request(`http://localhost/api/agent/batches/${id}`, { headers: { cookie } }),
    )
    expect((await result.json()).analysisSummary).toMatchObject({
      complete: true,
      inspectionComplete: true,
      unresolvedItemKeys: [],
    })
    expect(await db.select().from(schema.tasks).where(eq(schema.tasks.kind, 'queue'))).toHaveLength(
      0,
    )
  } finally {
    config.operator = operator
  }
})
