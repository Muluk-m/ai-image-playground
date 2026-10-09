// Intended destination: apps/bff/src/__tests__/routes/agent-batch-analysis-summary.test.ts
import { afterAll, expect, it } from 'bun:test'
import { resolve } from 'node:path'
import { resetTestDatabase } from '@image-playground/db/testing'
import { eq } from 'drizzle-orm'
import { InMemoryObjectStore } from '../helpers/inMemoryObjectStore'
import { installRecordingTaskHooks } from '../helpers/privateOverlayStub'
import { fixturePng } from '../helpers/rasterFixture'

process.env.DATABASE_URL = await resetTestDatabase('analysis_batch_coverage')
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

it('reports only current successful image evidence and exposes unknown coverage without another summary call', async () => {
  const operator = config.operator
  config.operator = {
    ...operator,
    capabilities: { ...operator.capabilities, 'agent:batch-analysis': true },
    quotas: { ...operator.quotas, 'agent:batch-dispatch-window': 2 },
  }
  const id = 'analysis-coverage-batch'
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
      .values({ id, user_id: id, title: 'inspect both', created_at: now, updated_at: now })
    const items = []
    const snapshots = []
    for (const [ordinal, key] of ['first', 'second'].entries()) {
      const media = await storeMedia(
        id,
        await fixturePng(ordinal ? '#123456' : '#abcdef'),
        'image/png',
      )
      const prepared = await prepareAnalysisTask({
        userId: id,
        model: config.agent.model,
        prompt: `inspect-${key}`,
        inputs: [{ imageId: `image-${key}`, mediaId: media.id }],
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
      items.push({
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
      })
      snapshots.push({ ...quote.pricing, itemKey: key })
    }
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
      title: 'inspect both',
      rule: 'report each image',
      digest: 'fixture-digest',
      item_count: 2,
      estimate_snapshot: {
        analysis: {
          status: 'available',
          estimatedCredits: 14,
          estimatedChargeCredits: 14,
          snapshots,
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
    await db.insert(schema.agent_batch_items).values(items)
    await confirmAgentBatch(id, id, {
      commandId: 'confirm',
      expectedVersion: 1,
      expectedDigest: 'fixture-digest',
      deviceId: 'fixture',
    })
    const attempts = await db
      .select()
      .from(schema.agent_batch_attempts)
      .where(eq(schema.agent_batch_attempts.batch_id, id))
    expect(attempts).toHaveLength(2)
    let calls = 0
    setChatFetchForTesting(async (_input, init) => {
      calls++
      if (String(init?.body).includes('inspect-second'))
        throw new Error('accepted response disconnected')
      return Response.json({
        choices: [
          {
            message: {
              content: JSON.stringify({
                findings: [{ imageId: 'image-first', text: 'first image has uniform color' }],
              }),
            },
          },
        ],
        usage: { prompt_tokens: 100, completion_tokens: 20 },
      })
    })
    for (const attempt of attempts) await runAnalysisTask(attempt.task_id)
    const { createUserSession, USER_SESSION_COOKIE } = await import('../../lib/user-session')
    const cookie = `${USER_SESSION_COOKIE}=${await db.transaction((tx) => createUserSession(id, tx))}`
    const { app } = await import('../../app')
    const read = () =>
      app.handle(
        new Request(`http://localhost/api/agent/batches/${id}?limit=1`, { headers: { cookie } }),
      )
    const response = await read()
    expect(response.status).toBe(200)
    const page = await response.json()
    expect(page.analysisSummary).toMatchObject({
      complete: false,
      requiredImageIds: ['image-first', 'image-second'],
      successfulImageIds: ['image-first'],
      missingImageIds: ['image-second'],
      unresolvedItemKeys: ['second'],
    })
    expect(page.analysisSummary.findings).toEqual([
      expect.objectContaining({
        imageId: 'image-first',
        text: 'first image has uniform color',
        itemKey: 'first',
        attempt: 1,
        taskId: attempts.find((one) => one.item_key === 'first')!.task_id,
        evidence: [expect.objectContaining({ imageId: 'image-first', representation: 'preview' })],
      }),
    ])
    const { recoverAnalysisTasks } = await import('../../lib/analysis-tasks')
    await recoverAnalysisTasks()
    expect((await (await read()).json()).analysisSummary).toEqual(page.analysisSummary)
    expect(calls).toBe(2)
    expect(billing.reservations).toHaveLength(2)
    expect(billing.settlements).toHaveLength(1)
    expect(await db.select().from(schema.generation_records)).toHaveLength(0)
  } finally {
    config.operator = operator
  }
})
